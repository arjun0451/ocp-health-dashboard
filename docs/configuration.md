# Configuration Reference

The dashboard is configured through three ConfigMaps. All changes require a pod restart to take effect unless noted otherwise.

```bash
# Apply changed ConfigMaps and restart:
oc apply -f k8s/manifests.yaml
oc rollout restart deployment/ocp-health-dashboard -n ocp-health-dashboard
```

---

## Table of Contents

- [ConfigMap: ocp-health-config](#configmap-ocp-health-config)
- [ConfigMap: ocp-health-ssl-config](#configmap-ocp-health-ssl-config)
- [ConfigMap: ocp-health-checks-config](#configmap-ocp-health-checks-config)
- [Disabling Individual Checks](#disabling-individual-checks)
- [Scheduling Options](#scheduling-options)
- [Storage Class Configuration](#storage-class-configuration)
- [Log Levels](#log-levels)
- [Mock Mode (Development)](#mock-mode-development)

---

## ConfigMap: `ocp-health-config`

Main runtime configuration. Mounted as environment variables in the container.

| Variable | Default | Required | Description |
|---|---|---|---|
| `API_URL` | — | **Yes** | OpenShift API server URL, e.g. `https://api.cluster.example.com:6443` |
| `CONSOLE_URL` | — | **Yes** | OpenShift console URL, used by the ingress health probe |
| `CLUSTER_ID` | `my-ocp-cluster` | No | Human-readable cluster name, shown in reports and the dashboard header |
| `MCS_URL` | — | No | Machine Config Server URL (not used for connectivity checks — kept for reference) |
| `SCHEDULE_HOURS` | `12` | No | Run checks every N hours. Overridden by `CRON_SCHEDULE` if set |
| `CRON_SCHEDULE` | — | No | Full cron expression, e.g. `0 6,18 * * *`. Takes precedence over `SCHEDULE_HOURS` |
| `RUN_ON_STARTUP` | `true` | No | Run all checks immediately when the pod starts |
| `ARTIFACT_RETENTION_DAYS` | `30` | No | Delete run artifacts older than this many days |
| `LOG_LEVEL` | `info` | No | Logging verbosity: `error`, `warn`, `info`, `debug` |

**Per-check overrides** — disable any check without editing the YAML file:

| Pattern | Example | Effect |
|---|---|---|
| `CHECK_<ID_UPPERCASE>` | `CHECK_NODE_CPU: "false"` | Disables the `node_cpu` check |

All 19 check IDs and their uppercase env key names:

| Check ID | Env Key to Disable |
|---|---|
| `cluster_operators` | `CHECK_CLUSTER_OPERATORS` |
| `cluster_version` | `CHECK_CLUSTER_VERSION` |
| `machine_config_pool` | `CHECK_MACHINE_CONFIG_POOL` |
| `etcd_health` | `CHECK_ETCD_HEALTH` |
| `authentication` | `CHECK_AUTHENTICATION` |
| `control_plane_pods` | `CHECK_CONTROL_PLANE_PODS` |
| `node_readiness` | `CHECK_NODE_READINESS` |
| `node_cpu` | `CHECK_NODE_CPU` |
| `node_memory` | `CHECK_NODE_MEMORY` |
| `node_limits` | `CHECK_NODE_LIMITS` |
| `platform_pods` | `CHECK_PLATFORM_PODS` |
| `non_platform_pods` | `CHECK_NON_PLATFORM_PODS` |
| `api_server` | `CHECK_API_SERVER` |
| `ingress_controller` | `CHECK_INGRESS_CONTROLLER` |
| `machine_config_server` | `CHECK_MACHINE_CONFIG_SERVER` |
| `pvc_health` | `CHECK_PVC_HEALTH` |
| `ssl_certificates` | `CHECK_SSL_CERTIFICATES` |
| `monitoring_stack` | `CHECK_MONITORING_STACK` |
| `pdb_health` | `CHECK_PDB_HEALTH` |

### Example: disable two checks

```yaml
# In the ocp-health-config ConfigMap data section:
data:
  API_URL:     "https://api.cluster.example.com:6443"
  CONSOLE_URL: "https://console-openshift-console.apps.cluster.example.com"
  CLUSTER_ID:  "prod-cluster"
  SCHEDULE_HOURS: "12"
  RUN_ON_STARTUP: "true"
  LOG_LEVEL: "info"
  ARTIFACT_RETENTION_DAYS: "30"
  # Disable these checks:
  CHECK_NODE_CPU:         "false"
  CHECK_NON_PLATFORM_PODS: "false"
```

---

## ConfigMap: `ocp-health-ssl-config`

Controls which namespaces are included or excluded from SSL certificate expiry checks.

| Variable | Default | Description |
|---|---|---|
| `SSL_EXCLUDE_NAMESPACES` | 8 OCP internal namespaces (see below) | Comma-separated namespaces to **skip** (blacklist mode) |
| `SSL_INCLUDE_NAMESPACES` | `""` (empty) | Comma-separated namespaces to **only check** (whitelist mode). When set, `SSL_EXCLUDE_NAMESPACES` is ignored |
| `CERT_THRESHOLD` | `30` | Days before expiry at which a cert is flagged as expiring |

### Default excluded namespaces

These namespaces are excluded by default because OpenShift manages their certificates internally with automatic short-lived rotation. Including them will always produce false-positive "expiring soon" alerts:

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

### Blacklist mode (default)

Check every namespace **except** those in `SSL_EXCLUDE_NAMESPACES`:

```yaml
data:
  SSL_EXCLUDE_NAMESPACES: >-
    openshift-compliance,
    openshift-kube-apiserver,
    openshift-kube-apiserver-operator,
    openshift-kube-controller-manager,
    openshift-kube-controller-manager-operator,
    openshift-kube-scheduler,
    openshift-operator-lifecycle-manager,
    openshift-config-managed
  SSL_INCLUDE_NAMESPACES: ""
  CERT_THRESHOLD: "30"
```

To add `openshift-kube-apiserver` back (check those certs too):

```yaml
  SSL_EXCLUDE_NAMESPACES: >-
    openshift-compliance,
    openshift-kube-controller-manager,
    openshift-kube-controller-manager-operator,
    openshift-kube-scheduler,
    openshift-operator-lifecycle-manager,
    openshift-config-managed
    # openshift-kube-apiserver deliberately omitted — will be checked
```

### Whitelist mode

Check **only** specific namespaces (useful for application teams who only care about their own certs):

```yaml
data:
  SSL_EXCLUDE_NAMESPACES: ""   # ignored when SSL_INCLUDE_NAMESPACES is set
  SSL_INCLUDE_NAMESPACES: "production,staging,my-app,open-cluster-management-hub"
  CERT_THRESHOLD: "30"
```

### How cert data is encoded

Understanding the encoding prevents confusion when debugging:

```
Kubernetes stores .data.tls.crt as:   base64( PEM_TEXT )

PEM_TEXT =
  -----BEGIN CERTIFICATE-----
  <base64 of raw DER bytes, wrapped at 64 chars>
  -----END CERTIFICATE-----

The dashboard decodes in two steps:
  1. base64(PEM_TEXT)  →  PEM_TEXT
  2. Strip headers, decode inner base64  →  raw DER bytes
  3. Scan DER for ASN.1 UTCTime/GeneralizedTime tags  →  expiry dates
```

This approach avoids running `openssl` inside the container and works with all OCP versions.

---

## ConfigMap: `ocp-health-checks-config`

This ConfigMap is **mounted as a file** at `/etc/ocp-health/checks-config.yaml` inside the container, not as environment variables. It controls check ordering, scheduling defaults, and per-check threshold values.

```yaml
checks-config.yaml: |
  schedule_hours: 12           # default schedule (overridden by SCHEDULE_HOURS env var)
  run_on_startup: true
  artifact_retention_days: 30

  categories:                  # display order in the dashboard
    - control_plane
    - nodes
    - pods
    - networking
    - storage
    - security
    - monitoring
    - availability

  checks:
    - id: node_cpu
      name: Node CPU Usage
      category: nodes
      enabled: true
      threshold: 80            # flag above 80% CPU usage

    - id: ssl_certificates
      name: SSL Certificate Expiry
      category: security
      enabled: true
      threshold: 30            # flag certs expiring within 30 days

    # ... all 19 checks
```

### Threshold values

| Check ID | Threshold Meaning | Default |
|---|---|---|
| `node_cpu` | CPU usage % above which a node is flagged | `80` |
| `node_memory` | Memory usage % above which a node is flagged | `80` |
| `ssl_certificates` | Days before cert expiry to raise a warning | `30` |

`node_limits` does not use a threshold value — it flags any node where any metric exceeds 100%.

---

## Disabling Individual Checks

Two ways to disable a check:

**Method 1 — Environment variable** (no YAML file edit needed):

```yaml
# In ocp-health-config ConfigMap:
data:
  CHECK_SSL_CERTIFICATES: "false"
```

**Method 2 — Edit the checks YAML** (in ocp-health-checks-config):

```yaml
- id: ssl_certificates
  name: SSL Certificate Expiry
  category: security
  enabled: false      # ← set to false
```

Both methods require a pod restart. Method 1 is preferred for temporary disabling because you can re-enable without editing the file.

---

## Scheduling Options

### Every N hours (simple)

```yaml
# ocp-health-config:
SCHEDULE_HOURS: "6"     # every 6 hours
```

### Cron expression (advanced)

```yaml
# ocp-health-config:
CRON_SCHEDULE: "0 6,18 * * *"    # 06:00 and 18:00 daily
# CRON_SCHEDULE takes precedence over SCHEDULE_HOURS when both are set
```

Common cron examples:

| Expression | Meaning |
|---|---|
| `0 */6 * * *` | Every 6 hours |
| `0 8 * * 1-5` | Every weekday at 08:00 |
| `0 6,12,18 * * *` | Three times daily |
| `*/30 * * * *` | Every 30 minutes |

### Disable scheduled runs (manual trigger only)

```yaml
SCHEDULE_HOURS: "0"
RUN_ON_STARTUP: "false"
```

Checks can still be triggered manually from the dashboard UI or via `POST /api/run`.

---

## Storage Class Configuration

By default the PVC uses the cluster's default storage class. To specify a class:

```yaml
# In k8s/manifests.yaml — PVC section:
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
  storageClassName: your-storage-class    # ← uncomment and set
```

Common storage class names by platform:

| Platform | Storage Class |
|---|---|
| AWS EBS | `gp3-csi` |
| Azure Disk | `managed-csi` |
| GCP PD | `standard-csi` |
| VMware vSphere | `thin` |
| ODF/OCS | `ocs-storagecluster-ceph-rbd` |
| NFS provisioner | `nfs-client` |

To find available storage classes on your cluster:

```bash
oc get storageclass
```

---

## Log Levels

Set `LOG_LEVEL` in `ocp-health-config`:

| Level | Use case |
|---|---|
| `error` | Production — only failures |
| `warn` | Near-production — failures + warnings |
| `info` | Default — startup messages, run summaries, API calls |
| `debug` | Troubleshooting — every `oc` command, full output, timing |

To temporarily enable debug logging without redeploying:

```bash
oc set env deployment/ocp-health-dashboard \
  LOG_LEVEL=debug \
  -n ocp-health-dashboard
# Returns to normal automatically on next rollout restart
```

---

## Mock Mode (Development)

Mock mode runs the server with canned responses instead of making real `oc` calls. This is useful for developing the UI or testing the server logic without a cluster.

```bash
# Locally (requires Node.js 18+):
npm install
MOCK_MODE=true node src/server.js
# Open http://localhost:8080

# Or with the npm script:
npm run mock
```

In mock mode, the server returns realistic fake data for all checks including SSL certificates, node limits, and PDB analysis. Canned cert data mirrors the encoding used by real Kubernetes secrets so the full parsing path is exercised.

To deploy a mock-mode pod on-cluster for UI development:

```yaml
# Add to the Deployment env section:
env:
  - name: MOCK_MODE
    value: "true"
```
