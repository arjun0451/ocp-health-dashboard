# OCP Health Dashboard — Documentation

A self-hosted OpenShift cluster health monitoring dashboard that runs **inside your cluster**, uses the `oc` CLI with in-cluster credentials, and presents results through a clean web interface.

---

## Documentation Index

| Document | Description |
|---|---|
| [Installation Guide](installation.md) | Build, push, and deploy the dashboard from scratch |
| [Configuration Reference](configuration.md) | All ConfigMaps, environment variables, and tuning options |
| [Health Checks Reference](checks.md) | Every check explained: what it does, how it works, pass/fail criteria |
| [Dashboard User Guide](user-guide.md) | How to use the web interface — tabs, filters, SSL, PDB, Node Limits |
| [API Reference](api.md) | All REST endpoints, request/response shapes |
| [Troubleshooting](troubleshooting.md) | Common issues, debug tools, log interpretation |

---

## Architecture at a Glance

```
OpenShift Cluster
└── Namespace: ocp-health-dashboard
    ├── ServiceAccount: ocp-health-sa  (bound to cluster-admin)
    ├── PVC: ocp-health-artifacts (5Gi)  — run history, PDF reports
    └── Pod: ocp-health-dashboard
        ├── Express HTTP server  :8080
        │   ├── GET  /              → dashboard UI (single-page app)
        │   ├── GET  /api/status    → current run state
        │   ├── GET  /api/results   → latest check results
        │   ├── POST /api/run       → trigger a manual run
        │   ├── GET  /api/ssl/certs → SSL certificate data (for SSL tab)
        │   ├── GET  /api/pdb       → PodDisruptionBudget analysis
        │   ├── GET  /api/nodes/limits → node resource limit data
        │   └── ...more (see API Reference)
        ├── node-cron scheduler  (default: every 12 hours + on startup)
        └── oc binary  (in-cluster, reads SA token from /var/run/secrets)

Route (TLS edge) → Service → Pod
```

---

## Quick Start (TL;DR)

```bash
# 1. Clone the repository
git clone https://github.com/your-org/ocp-health-dashboard.git
cd ocp-health-dashboard

# 2. Log in and set your image registry
oc login https://api.your-cluster.example.com:6443
export REGISTRY="image-registry.openshift-image-registry.svc:5000/ocp-health-dashboard"

# 3. Build and push
podman build --build-arg OC_VERSION=4.14.0 -f Containerfile \
  -t ${REGISTRY}/ocp-health-dashboard:latest .
podman push ${REGISTRY}/ocp-health-dashboard:latest

# 4. Edit manifests — set your API_URL, CONSOLE_URL, CLUSTER_ID
vi k8s/manifests.yaml

# 5. Deploy
oc apply -f k8s/manifests.yaml
oc rollout status deployment/ocp-health-dashboard -n ocp-health-dashboard

# 6. Open the dashboard
oc get route ocp-health-dashboard -n ocp-health-dashboard \
  -o jsonpath='{.spec.host}' | xargs -I{} echo "https://{}"
```

See the [Installation Guide](installation.md) for full details.

---

## Features

- **19 health checks** across 8 categories: Control Plane, Nodes, Pods, Networking, Storage, Security, Monitoring, Availability
- **Scheduled runs** every N hours with cron support — results persist across pod restarts
- **SSL Certificate tab** — scans all `kubernetes.io/tls` secrets, shows expiry dates, days remaining, configurable namespace exclusions
- **Node Limits tab** — CPU/memory request and limit % per node, flags over-committed nodes
- **PDB Analysis tab** — PodDisruptionBudget health, disruption headroom per workload
- **Run history** — every run saved with PDF report generation
- **Check Guide** — inline documentation for every check accessible from the dashboard
- **Mock mode** — run the server locally without cluster access for development

---

## Requirements

| Requirement | Minimum |
|---|---|
| OpenShift | 4.10+ |
| Container build tool | Podman ≥ 4.0 or Docker ≥ 20 |
| Node.js (build only) | 18+ |
| Image registry | OpenShift internal registry or external |
| PVC storage | 5 Gi (ReadWriteOnce) |

---

*For issues or contributions, see the repository's `CONTRIBUTING.md`.*
