# Installation Guide

---

## Prerequisites

| Tool | Purpose |
|---|---|
| `oc` 4.10+ | OpenShift CLI — must match your cluster version |
| `podman` 4.0+ (or `docker`) | Build and push the container image |

You must be logged in as a user with `cluster-admin` rights to create the RBAC resources.

---

## Step 1 — Expose the Internal Registry and Log In

```bash
# Expose the registry route if not already done
oc patch configs.imageregistry.operator.openshift.io/cluster \
  --type merge --patch '{"spec":{"defaultRoute":true}}'

export REGISTRY_HOST=$(oc get route default-route \
  -n openshift-image-registry -o jsonpath='{.spec.host}')

podman login ${REGISTRY_HOST} \
  -u $(oc whoami) -p $(oc whoami -t) --tls-verify=false

export IMAGE="${REGISTRY_HOST}/ocp-health-dashboard/ocp-health-dashboard:latest"
```

> Using an external registry (Quay, Nexus, Harbor)? Set `IMAGE` to your registry path and `podman login` accordingly.

---

## Step 2 — Build the Image

```bash
# Use the OC version that matches your cluster (oc version → Server Version)
export OC_VERSION=4.14.0

podman build \
  --build-arg OC_VERSION=${OC_VERSION} \
  --platform linux/amd64 \
  -f Containerfile \
  -t ${IMAGE} .
```

---

## Step 3 — Push the Image

```bash
podman push ${IMAGE}
```

---

## Step 4 — Configure the Manifests

Open `k8s/manifests.yaml` and set the following before deploying.

### Required — update the image reference

Find the `image:` field in the Deployment and replace it with your `${IMAGE}` value:

```yaml
containers:
  - name: dashboard
    image: <your IMAGE value here>
```

### Required — `ocp-health-config` ConfigMap

```yaml
API_URL:     "https://api.your-cluster.example.com:6443"
CONSOLE_URL: "https://console-openshift-console.apps.your-cluster.example.com"
CLUSTER_ID:  "your-cluster-name"
```

### Optional — `ocp-health-ssl-config`

Controls which namespaces are included or excluded from SSL certificate scanning.

```yaml
# Exclude specific namespaces (blacklist mode — default)
SSL_EXCLUDE_NAMESPACES: "openshift-kube-apiserver,openshift-kube-scheduler"

# OR: check only these namespaces (whitelist mode)
SSL_INCLUDE_NAMESPACES: "my-app,production,staging"

# Days before expiry to flag as failing (default: 30)
SSL_CERT_THRESHOLD: "30"
```

### Optional — `ocp-health-metrics-config`

Controls the Metrics tab (Prometheus/Thanos queries). The defaults work for a standard OCP cluster without any changes.

```yaml
THANOS_HOST:            ""      # auto-discovered if blank
PROM_CPU_THRESHOLD:     "90"    # flag pods using ≥ 90% of CPU limit
PROM_MEM_THRESHOLD:     "80"    # flag pods using > 80% of memory limit
PROM_PVC_THRESHOLD:     "70"    # flag PVCs used > 70%
PROM_FS_USED_THRESHOLD: "90"    # flag node root filesystem used > 90%
PROM_ETCD_DB_BYTES:     "8589934592"  # 8 GB
PROM_ETCD_RTT_MS:       "100"
PROM_CACHE_SECS:        "300"   # cache results for 5 minutes
```

### Optional — `ocp-health-rq-config`

Controls the Cluster Allocation tab.

```yaml
# Namespace prefixes to exclude from the ResourceQuota report
RQ_SKIP_NAMESPACES: "openshift-,kube-,default"
```

Storage class columns are **auto-discovered** from your ResourceQuota definitions — no configuration needed. Any storage class found in a quota's `.spec.hard` keys appears as a column automatically.

---

## Step 5 — Deploy

```bash
oc apply -f k8s/manifests.yaml
oc rollout status deployment/ocp-health-dashboard \
  -n ocp-health-dashboard --timeout=120s
```

---

## Step 6 — Verify

```bash
# Pod should be Running
oc get pods -n ocp-health-dashboard

# Check startup logs
oc logs -n ocp-health-dashboard \
  -l app=ocp-health-dashboard --tail=20
```

---

## Step 7 — Open the Dashboard

```bash
oc get route ocp-health-dashboard -n ocp-health-dashboard \
  -o jsonpath='https://{.spec.host}{"\n"}'
```

Open that URL in your browser. The first health check run starts automatically on pod startup.

---

## Upgrading

```bash
# Rebuild and push
podman build --build-arg OC_VERSION=${OC_VERSION} \
  --platform linux/amd64 -f Containerfile -t ${IMAGE} . \
  && podman push ${IMAGE}

# Restart the deployment
oc rollout restart deployment/ocp-health-dashboard \
  -n ocp-health-dashboard
```

To apply ConfigMap changes only (no rebuild needed):

```bash
oc apply -f k8s/manifests.yaml
oc rollout restart deployment/ocp-health-dashboard \
  -n ocp-health-dashboard
```

---

## Uninstalling

```bash
oc delete -f k8s/manifests.yaml
oc delete clusterrolebinding ocp-health-reader-binding
oc delete rolebinding ocp-health-token-creator-binding \
  -n openshift-monitoring
```
