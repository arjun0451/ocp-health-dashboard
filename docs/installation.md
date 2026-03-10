# Installation Guide

This guide takes you from zero to a running dashboard on your OpenShift cluster.

---

## Table of Contents

- [Prerequisites](#prerequisites)
- [Repository Structure](#repository-structure)
- [Step 1 — Prepare the Image Registry](#step-1--prepare-the-image-registry)
- [Step 2 — Build the Container Image](#step-2--build-the-container-image)
- [Step 3 — Push the Image](#step-3--push-the-image)
- [Step 4 — Configure the Manifests](#step-4--configure-the-manifests)
- [Step 5 — Deploy to OpenShift](#step-5--deploy-to-openshift)
- [Step 6 — Verify the Deployment](#step-6--verify-the-deployment)
- [Step 7 — Open the Dashboard](#step-7--open-the-dashboard)
- [Upgrading](#upgrading)
- [Uninstalling](#uninstalling)

---

## Prerequisites

### Tools Required on Your Workstation

| Tool | Version | Purpose |
|---|---|---|
| `oc` | 4.10+ | OpenShift CLI — must match your cluster version |
| `podman` | 4.0+ | Build and push the container image |
| `git` | any | Clone the repository |

> **Using Docker instead of Podman?**  
> Replace every `podman` command with `docker`. All commands are identical.

### Cluster Requirements

- OpenShift **4.10 or later**
- You are logged in as a user with `cluster-admin` rights (required to create the ClusterRoleBinding)
- The **internal image registry** is exposed, OR you have an external registry the cluster can pull from
- A **StorageClass** that supports `ReadWriteOnce` PVCs (any standard OCP storage class works)

### Verify your login

```bash
oc whoami
oc version
```

Expected output: your username and the cluster version. If these fail, log in first:

```bash
oc login https://api.your-cluster.example.com:6443 \
  --username=admin --password=your-password
# or with token:
oc login https://api.your-cluster.example.com:6443 \
  --token=sha256~your-token-here
```

---

## Repository Structure

```
ocp-health-dashboard/
├── Containerfile              # Multi-stage build (UBI9 Node 18)
├── package.json
├── config/
│   └── checks-config.yaml     # Default check configuration (bundled in image)
├── src/
│   ├── server.js              # Express HTTP server
│   ├── scheduler.js           # node-cron scheduler
│   ├── executor.js            # oc command runner
│   ├── configLoader.js        # YAML config loader
│   ├── artifactStore.js       # Run history persistence
│   ├── reportGenerator.js     # PDF/JSON report builder
│   ├── logger.js
│   ├── checks/                # One module per check category
│   │   ├── controlPlane.js
│   │   ├── nodes.js
│   │   ├── pods.js
│   │   ├── networking.js
│   │   ├── storage.js
│   │   ├── security.js        # SSL certificate check
│   │   ├── pdb.js             # PodDisruptionBudget check
│   │   ├── monitoring.js
│   │   └── checkDocs.js       # Inline documentation text
│   └── routes/
│       ├── api.js             # REST API routes
│       └── artifacts.js       # Static artifact serving
├── public/
│   └── index.html             # Single-page dashboard UI
└── k8s/
    └── manifests.yaml         # All Kubernetes/OCP resources
```

---

## Step 1 — Prepare the Image Registry

### Option A: OpenShift Internal Registry (Recommended)

Expose the internal registry externally so podman on your workstation can push to it:

```bash
# Expose the registry route (if not already exposed)
oc patch configs.imageregistry.operator.openshift.io/cluster \
  --type merge --patch '{"spec":{"defaultRoute":true}}'

# Get the registry hostname
export REGISTRY_HOST=$(oc get route default-route \
  -n openshift-image-registry \
  -o jsonpath='{.spec.host}')

echo "Registry: ${REGISTRY_HOST}"
```

Log podman in to the registry using your cluster token:

```bash
podman login ${REGISTRY_HOST} \
  -u $(oc whoami) \
  -p $(oc whoami -t) \
  --tls-verify=false
```

Set your full image path:

```bash
export IMAGE="${REGISTRY_HOST}/ocp-health-dashboard/ocp-health-dashboard:latest"
```

> **Note:** The namespace `ocp-health-dashboard` must exist before pushing. It is created by `oc apply -f k8s/manifests.yaml` in Step 5. If pushing before applying the manifests, create it first:
> ```bash
> oc new-project ocp-health-dashboard
> ```

### Option B: External Registry (Quay.io, Nexus, Harbor, etc.)

```bash
podman login quay.io -u your-username
export IMAGE="quay.io/your-org/ocp-health-dashboard:latest"
```

If using a private registry, ensure your cluster has a pull secret for it:

```bash
oc create secret docker-registry external-registry \
  --docker-server=your-registry.example.com \
  --docker-username=your-user \
  --docker-password=your-password \
  -n ocp-health-dashboard

oc secrets link default external-registry --for=pull \
  -n ocp-health-dashboard
```

---

## Step 2 — Build the Container Image

The `Containerfile` uses a two-stage build:

- **Stage 1 (builder):** Downloads the `oc` binary for the target OCP version and installs Node.js dependencies
- **Stage 2 (runtime):** Minimal UBI9 Node 18 image with only what is needed to run

```bash
# Set the oc version to match your cluster (check with: oc version)
export OC_VERSION=4.14.0

podman build \
  --build-arg OC_VERSION=${OC_VERSION} \
  --platform linux/amd64 \
  -f Containerfile \
  -t ${IMAGE} \
  .
```

> **Why `--platform linux/amd64`?**  
> OpenShift worker nodes run amd64. If you are building on Apple Silicon (M1/M2/M3) or an arm64 Linux machine, this flag ensures the image runs on your cluster. Omit it if building on an amd64 machine.

Build output to expect:

```
STEP 1/14: FROM registry.access.redhat.com/ubi9/nodejs-18:latest AS builder
...
oc downloaded OK
npm install complete
...
Successfully tagged your-registry/ocp-health-dashboard:latest
```

**Finding your OC version:**

```bash
oc version
# Look for: Server Version: 4.XX.Y
# Use that exact version string for OC_VERSION
```

Available versions: https://mirror.openshift.com/pub/openshift-v4/clients/ocp/

---

## Step 3 — Push the Image

```bash
podman push ${IMAGE}
```

Verify the push succeeded:

```bash
# For internal registry:
oc get imagestreamtag \
  ocp-health-dashboard:latest \
  -n ocp-health-dashboard 2>/dev/null \
  || echo "ImageStream will be created on first apply"

# For external registry: check your registry UI
```

---

## Step 4 — Configure the Manifests

Open `k8s/manifests.yaml` and update the values in the **two ConfigMaps** before deploying.

### 4a. Update `ocp-health-config` (required)

Find the section labelled `# 4. ConfigMap — environment configuration` and set:

```yaml
data:
  # ── REQUIRED: set these to match your cluster ──────────────────
  API_URL:     "https://api.your-cluster.example.com:6443"
  CONSOLE_URL: "https://console-openshift-console.apps.your-cluster.example.com"
  CLUSTER_ID:  "your-cluster-name"        # used as a label in reports

  # ── REQUIRED: update with your actual image path ────────────────
  # (edit the image: field in the Deployment, not here)
```

Also update the `image:` field in the Deployment section:

```yaml
containers:
  - name: dashboard
    image: image-registry.openshift-image-registry.svc:5000/ocp-health-dashboard/ocp-health-dashboard:latest
    #       ^^^^^ change this to your IMAGE value from Step 1
```

> **Tip:** Use `sed` for a quick in-place replacement:
> ```bash
> sed -i 's|image-registry.openshift-image-registry.svc:5000/ocp-health-dashboard/ocp-health-dashboard:latest|'"${IMAGE}"'|g' k8s/manifests.yaml
> ```

### 4b. Update `ocp-health-ssl-config` (optional)

Find the section labelled `# 5b. ConfigMap — SSL namespace filter`.

By default, the following namespaces are **excluded** from SSL certificate checks (they manage their own short-lived certs internally):

```
openshift-compliance
openshift-kube-apiserver
openshift-kube-apiserver-operator
openshift-kube-controller-manager
openshift-kube-controller-manager-operator
openshift-kube-scheduler
openshift-operator-lifecycle-manager
openshift-config-managed
```

To customise:

```yaml
# Remove a namespace from the exclude list so its certs ARE checked:
SSL_EXCLUDE_NAMESPACES: >-
  openshift-compliance,
  openshift-kube-controller-manager,
  openshift-kube-controller-manager-operator,
  openshift-kube-scheduler,
  openshift-operator-lifecycle-manager,
  openshift-config-managed
  # openshift-kube-apiserver removed — it will now be checked

# OR: switch to whitelist mode (check ONLY these namespaces):
SSL_INCLUDE_NAMESPACES: "my-app,production,staging"
```

### 4c. Update `ocp-health-checks-config` (optional)

Find the section labelled `# 5. ConfigMap — checks-config.yaml`.

You can adjust scheduling and disable individual checks:

```yaml
checks-config.yaml: |
  schedule_hours: 6        # run every 6 hours instead of 12
  run_on_startup: true
  artifact_retention_days: 30
  ...
  - id: node_cpu
    name: Node CPU Usage
    category: nodes
    enabled: false         # disable this check
    threshold: 85          # or change the threshold
```

---

## Step 5 — Deploy to OpenShift

Apply the full manifest file. This creates all resources in order:

```bash
oc apply -f k8s/manifests.yaml
```

Expected output:

```
namespace/ocp-health-dashboard created (or unchanged)
serviceaccount/ocp-health-sa created
clusterrolebinding.rbac.authorization.k8s.io/ocp-health-dashboard-cluster-admin created
configmap/ocp-health-config created
configmap/ocp-health-checks-config created
configmap/ocp-health-ssl-config created
persistentvolumeclaim/ocp-health-artifacts created
deployment.apps/ocp-health-dashboard created
service/ocp-health-dashboard created
route.route.openshift.io/ocp-health-dashboard created
```

Wait for the deployment to complete:

```bash
oc rollout status deployment/ocp-health-dashboard \
  -n ocp-health-dashboard \
  --timeout=120s
```

---

## Step 6 — Verify the Deployment

```bash
# Check the pod is running
oc get pods -n ocp-health-dashboard

# Expected:
# NAME                                    READY   STATUS    RESTARTS
# ocp-health-dashboard-7d9f8c6b5-xkzpq   1/1     Running   0

# Check the pod logs for startup messages
oc logs -n ocp-health-dashboard \
  -l app=ocp-health-dashboard \
  --tail=30

# Expected log lines (INFO level):
# Config loaded: 19/19 checks enabled, schedule every 12h
# Server listening on :8080
# [scheduler] Startup run triggered
# [scheduler] Run complete: 19 checks in Xs
```

Check liveness and readiness probes:

```bash
oc describe pod -n ocp-health-dashboard \
  -l app=ocp-health-dashboard \
  | grep -A5 'Liveness\|Readiness'
```

---

## Step 7 — Open the Dashboard

Get the route URL:

```bash
oc get route ocp-health-dashboard \
  -n ocp-health-dashboard \
  -o jsonpath='https://{.spec.host}{"\n"}'
```

Open that URL in your browser. The dashboard loads and shows the latest results. If `RUN_ON_STARTUP=true` (default), the first run completes automatically within ~60 seconds of pod start.

> **Screenshot placeholder:**  
> `[screenshot: dashboard overview tab showing check results by category]`

---

## Upgrading

When you release a new version of the image:

```bash
# 1. Build and push the new image
podman build --build-arg OC_VERSION=${OC_VERSION} \
  --platform linux/amd64 \
  -f Containerfile -t ${IMAGE} . \
  && podman push ${IMAGE}

# 2. Restart the deployment (pulls the new image if tag is :latest)
oc rollout restart deployment/ocp-health-dashboard \
  -n ocp-health-dashboard

# 3. Monitor the rollout
oc rollout status deployment/ocp-health-dashboard \
  -n ocp-health-dashboard
```

To apply ConfigMap changes **without** a rebuild:

```bash
oc apply -f k8s/manifests.yaml
oc rollout restart deployment/ocp-health-dashboard \
  -n ocp-health-dashboard
```

---

## Uninstalling

To remove everything including the PVC (this deletes all run history):

```bash
oc delete -f k8s/manifests.yaml
# The ClusterRoleBinding is cluster-scoped — delete it explicitly if needed:
oc delete clusterrolebinding ocp-health-dashboard-cluster-admin
```

To remove everything **except** the PVC (preserving run history):

```bash
oc delete deployment,service,route,configmap,serviceaccount \
  -l app.kubernetes.io/name=ocp-health-dashboard \
  -n ocp-health-dashboard
oc delete clusterrolebinding ocp-health-dashboard-cluster-admin
```
