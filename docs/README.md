# OCP Health Dashboard

A self-hosted OpenShift cluster health monitoring dashboard that runs **inside your cluster**, uses the `oc` CLI with in-cluster credentials, and presents results through a clean web interface.

---

## Documentation Index

| Document | Description |
|---|---|
| [Installation Guide](installation.md) | Build, push, and deploy the dashboard |
| [Configuration Reference](configuration.md) | All ConfigMaps and environment variables |
| [Health Checks Reference](checks.md) | Every check explained |
| [Dashboard User Guide](user-guide.md) | How to use the web interface |
| [API Reference](api.md) | All REST endpoints |
| [Troubleshooting](troubleshooting.md) | Common issues and debug tools |

---

## Architecture at a Glance

```
OpenShift Cluster
└── Namespace: ocp-health-dashboard
    ├── ServiceAccount: ocp-health-sa  (minimum-privilege ClusterRole)
    ├── PVC: ocp-health-artifacts (5Gi)  — run history, PDF reports
    └── Pod: ocp-health-dashboard
        ├── Express HTTP server  :8080
        │   ├── GET  /                   → dashboard UI
        │   ├── GET  /api/results        → latest check results
        │   ├── POST /api/run            → trigger manual run
        │   ├── GET  /api/ssl/certs      → SSL certificate data
        │   ├── GET  /api/nodes/limits   → node resource data
        │   ├── GET  /api/pdb            → PodDisruptionBudget data
        │   ├── GET  /api/metrics        → Thanos/Prometheus metrics
        │   └── GET  /api/quota          → cluster resource allocation
        ├── node-cron scheduler  (default: every 12 hours + on startup)
        └── oc binary  (reads SA token from /var/run/secrets)

Route (TLS edge) → Service → Pod
```

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/your-org/ocp-health-dashboard.git
cd ocp-health-dashboard

# 2. Log in to your cluster
oc login https://api.your-cluster.example.com:6443

# 3. Set your image
export IMAGE="image-registry.openshift-image-registry.svc:5000/ocp-health-dashboard/ocp-health-dashboard:latest"

# 4. Build and push
podman build --build-arg OC_VERSION=4.14.0 -f Containerfile -t ${IMAGE} .
podman push ${IMAGE}

# 5. Edit k8s/manifests.yaml — set API_URL, CONSOLE_URL, CLUSTER_ID and the image reference

# 6. Deploy
oc apply -f k8s/manifests.yaml
oc rollout status deployment/ocp-health-dashboard -n ocp-health-dashboard

# 7. Get the dashboard URL
oc get route ocp-health-dashboard -n ocp-health-dashboard \
  -o jsonpath='https://{.spec.host}{"\n"}'
```

See the [Installation Guide](installation.md) for full details.

---

## Features

| Tab | What it shows |
|---|---|
| **Overview** | 19 health checks across 8 categories — pass/fail with details |
| **Metrics** | Live Prometheus/Thanos queries: CPU, memory, OOM kills, PVC fill, node disk, etcd, alerts |
| **SSL Certificates** | All `kubernetes.io/tls` secrets with expiry dates and days remaining |
| **Node Limits** | CPU/memory request & limit % per node, flags over-committed nodes |
| **PDB Analysis** | PodDisruptionBudget health and disruption headroom per workload |
| **Cluster Allocation** | ResourceQuota breakdown by namespace — node capacity, quota totals, storage classes auto-discovered |
| **History** | Every run saved with PDF/JSON report download |
| **Check Guide** | Inline documentation for every health check |

---

## Requirements

| Requirement | Minimum |
|---|---|
| OpenShift | 4.10+ |
| Container build tool | Podman ≥ 4.0 or Docker ≥ 20 |
| PVC storage | 5 Gi (ReadWriteOnce) |
| Prometheus/Thanos | Standard in OCP 4.x — required only for the Metrics tab |
