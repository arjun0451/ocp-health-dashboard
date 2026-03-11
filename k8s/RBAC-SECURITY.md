# RBAC Security Analysis — OCP Health Dashboard

## TL;DR

**`cluster-admin` is NOT required.** A custom ClusterRole covering only read operations, plus two narrow namespace-scoped Roles for the two write operations, is fully sufficient.

The custom role eliminates all write access to the cluster and reduces secret exposure to read-only. The attack surface drops from "full cluster takeover on pod compromise" to "read-only visibility into cluster state."

---

## Why `cluster-admin` is Dangerous in Production

`cluster-admin` is a catch-all that grants **every verb on every resource** cluster-wide:

| What cluster-admin can do | Risk if the pod is compromised |
|---|---|
| Create/modify RBAC roles | Attacker creates their own cluster-admin account |
| Delete namespaces and workloads | Full cluster destruction |
| Read all Secrets (every type, every namespace) | Credential harvest: DB passwords, API keys, TLS private keys |
| Modify Deployments and DaemonSets | Inject malicious workloads on every node |
| Exec into any pod | Lateral movement to any running container |
| Modify network policies | Open attack surface for inter-pod traffic |

Any remote code execution in the Node.js/Express process — a dependency vulnerability, a prototype pollution attack, a malicious uploaded file — immediately becomes full cluster compromise.

---

## Complete Permission Audit

Every `oc` command the dashboard runs was traced to its source file:

### Read Operations (GET)

| Resource | API Group | Namespaces | Source | Check |
|---|---|---|---|---|
| `clusteroperators` | `config.openshift.io` | cluster-scoped | `controlPlane.js`, `networking.js` | cluster_operators, machine_config_server |
| `clusterversions` | `config.openshift.io` | cluster-scoped | `controlPlane.js` | cluster_version |
| `machineconfigpools` | `machineconfiguration.openshift.io` | cluster-scoped | `controlPlane.js` | machine_config_pool |
| `nodes` | core | cluster-scoped | `nodes.js` | node_readiness, node_limits |
| `nodes` (metrics) | `metrics.k8s.io` | cluster-scoped | `nodes.js` | node_cpu, node_memory |
| `pods` (metrics) | `metrics.k8s.io` | all | `nodes.js` | node_cpu, node_memory |
| `pods` | core | all namespaces | `pods.js`, `controlPlane.js`, `monitoring.js`, `networking.js` | platform_pods, non_platform_pods, control_plane_pods, authentication, monitoring_stack, machine_config_server |
| `persistentvolumeclaims` | core | all namespaces | `storage.js` | pvc_health |
| `poddisruptionbudgets` | `policy` | all namespaces | `pdb.js` | pdb_health |
| `secrets` | core | all namespaces | `security.js` | ssl_certificates |
| `routes` | `route.openshift.io` | `openshift-monitoring` | `prometheus.js` | metrics (Thanos discovery) |

### Write Operations (CREATE) — only two, both tightly scoped

| Resource | Verb | Namespace | Source | Check |
|---|---|---|---|---|
| `pods/exec` | `create` | `openshift-etcd` only | `controlPlane.js` | etcd_health |
| `serviceaccounts/token` | `create` | `openshift-monitoring` only, SA `prometheus-k8s` only | `prometheus.js` | metrics (Thanos auth) |

**Total write surface: 2 namespaced operations.** Neither can escalate privileges or modify cluster state.

---

## Custom Role Design

The replacement uses **one ClusterRole + three namespace-scoped Roles**:

```
ocp-health-reader         (ClusterRole)
  └── ClusterRoleBinding → ocp-health-sa

ocp-health-etcd-exec      (Role in openshift-etcd)
  └── RoleBinding         → ocp-health-sa

ocp-health-token-creator  (Role in openshift-monitoring)
  └── RoleBinding         → ocp-health-sa
```

### ClusterRole: `ocp-health-reader`

```yaml
rules:
  # Cluster-scoped reads
  - apiGroups: ["config.openshift.io"]
    resources: ["clusteroperators", "clusterversions"]
    verbs:     ["get", "list", "watch"]

  - apiGroups: ["machineconfiguration.openshift.io"]
    resources: ["machineconfigpools"]
    verbs:     ["get", "list", "watch"]

  - apiGroups: [""]
    resources: ["nodes"]
    verbs:     ["get", "list", "watch"]

  # Metrics subresource (oc adm top nodes)
  - apiGroups: ["metrics.k8s.io"]
    resources: ["nodes", "pods"]
    verbs:     ["get", "list"]

  # Cross-namespace reads
  - apiGroups: [""]
    resources: ["pods", "persistentvolumeclaims", "secrets"]
    verbs:     ["get", "list", "watch"]

  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs:     ["get", "list", "watch"]

  - apiGroups: ["route.openshift.io"]
    resources: ["routes"]
    verbs:     ["get", "list"]
```

### Role: `ocp-health-etcd-exec` (namespace: `openshift-etcd`)

```yaml
rules:
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs:     ["create"]
```

Scoped to one namespace. Cannot exec into pods anywhere else in the cluster.

### Role: `ocp-health-token-creator` (namespace: `openshift-monitoring`)

```yaml
rules:
  - apiGroups: [""]
    resources: ["serviceaccounts/token"]
    verbs:     ["create"]
    resourceNames: ["prometheus-k8s"]  # ← only this one SA
```

The `resourceNames` field is the critical lock. The ServiceAccount can only create tokens for `prometheus-k8s` — it cannot create tokens for `cluster-admin`-level service accounts like `openshift-monitoring/prometheus-operator`.

---

## Comparing the Attack Surface

| Capability | `cluster-admin` | Custom Role |
|---|---|---|
| Read pods (all namespaces) | ✅ | ✅ |
| Read nodes | ✅ | ✅ |
| Read PVCs, PDBs | ✅ | ✅ |
| Read secrets (all namespaces) | ✅ | ✅ (read-only) |
| Exec into etcd pods | ✅ | ✅ (etcd only) |
| Create Thanos token | ✅ | ✅ (prometheus-k8s only) |
| **Create/modify RBAC roles** | ✅ | ❌ |
| **Modify any workload** | ✅ | ❌ |
| **Delete namespaces/nodes** | ✅ | ❌ |
| **Exec into arbitrary pods** | ✅ | ❌ (only openshift-etcd) |
| **Create tokens for any SA** | ✅ | ❌ (only prometheus-k8s) |
| **Write secrets** | ✅ | ❌ |
| **Escalate privileges** | ✅ | ❌ |

---

## The One Remaining Sensitivity: `secrets` Read

The SSL check (`ssl_certificates`) reads `.data.tls.crt` from `kubernetes.io/tls` type secrets. However, Kubernetes RBAC cannot filter secrets by `.type` — granting `get secrets` grants access to **all** secret types in all namespaces including `Opaque` secrets that may hold DB passwords, API keys, and tokens.

This is the single remaining permission that goes beyond pure observability.

### Three options to address it:

**Option A — Namespace-scoped RoleBindings (recommended)**

Instead of a ClusterRoleBinding for the secrets rule, create individual RoleBindings in only the namespaces where you actually want cert monitoring:

```bash
# For each namespace you want to monitor certs in:
oc create rolebinding ocp-health-ssl-reader \
  --clusterrole=ocp-health-reader \
  --serviceaccount=ocp-health-dashboard:ocp-health-sa \
  -n your-namespace
```

Remove `secrets` from the ClusterRole and add a second ClusterRole that covers only secrets, then bind it namespace-by-namespace. This prevents the SA from reading secrets in `openshift-etcd`, `kube-system`, or other sensitive namespaces.

**Option B — Disable SSL check**

If cert monitoring is not required or is covered by another tool:

```yaml
# ocp-health-config ConfigMap:
CHECK_SSL_CERTIFICATES: "false"
```

Then remove the `secrets` rule from the ClusterRole entirely.

**Option C — Accept with audit logging**

Accept the broad secret read, and enable OpenShift audit logging to track every secret read made by the SA:

```bash
# Verify audit is enabled:
oc get apiserver cluster -o yaml | grep -A5 audit

# Watch dashboard SA secret reads:
oc adm audit-logs \
  --user=system:serviceaccount:ocp-health-dashboard:ocp-health-sa \
  --resource=secrets | jq .
```

The SA cannot write, modify, or delete secrets — the blast radius of a compromise is read-only credential exposure rather than active manipulation.

---

## Migration: Replacing `cluster-admin`

### Step 1 — Apply the new RBAC

```bash
oc apply -f k8s/rbac-least-privilege.yaml
```

### Step 2 — Remove the old cluster-admin binding

```bash
oc delete clusterrolebinding ocp-health-dashboard-cluster-admin
```

### Step 3 — Verify the new permissions

```bash
SA="system:serviceaccount:ocp-health-dashboard:ocp-health-sa"

# Should all return "yes":
oc auth can-i get clusteroperators     --as=$SA
oc auth can-i get nodes                --as=$SA
oc auth can-i get pods --all-namespaces --as=$SA
oc auth can-i get secrets --all-namespaces --as=$SA
oc auth can-i get persistentvolumeclaims --all-namespaces --as=$SA
oc auth can-i get poddisruptionbudgets --all-namespaces --as=$SA

# Exec — only in openshift-etcd:
oc auth can-i create pods/exec -n openshift-etcd   --as=$SA  # yes
oc auth can-i create pods/exec -n openshift-ingress --as=$SA  # no ← correct

# Token creation — only prometheus-k8s:
oc auth can-i create serviceaccounts/token \
  -n openshift-monitoring --as=$SA  # yes (for prometheus-k8s)

# Should all return "no":
oc auth can-i delete nodes             --as=$SA
oc auth can-i create clusterroles      --as=$SA
oc auth can-i update deployments --all-namespaces --as=$SA
oc auth can-i delete secrets --all-namespaces --as=$SA
```

### Step 4 — Restart the dashboard pod

```bash
oc rollout restart deployment/ocp-health-dashboard \
  -n ocp-health-dashboard

oc rollout status deployment/ocp-health-dashboard \
  -n ocp-health-dashboard
```

### Step 5 — Run all checks and verify

Trigger a manual run from the dashboard or API and verify all 19 checks pass. If the etcd check shows `Error`, confirm the `RoleBinding` in `openshift-etcd` was applied.

---

## Also Update the manifests.yaml

The `k8s/manifests.yaml` still contains the old `ClusterRoleBinding` (section 3) that uses `cluster-admin`. After migration, either:

- Delete that section and apply `rbac-least-privilege.yaml` separately, or
- Replace section 3 with the contents of `rbac-least-privilege.yaml` so the full deployment remains a single-file apply.

The `k8s/manifests.yaml` in the repository has been updated to reference the new ClusterRole. See the diff below.

---

## Verifying No Capabilities Were Missed

Run the dashboard in mock mode locally, then switch to real mode and trigger a full check run. Any check showing `Error: forbidden` indicates a missing permission. The most common gaps after migration:

| Error message | Missing permission |
|---|---|
| `cannot get resource "clusteroperators"` | ClusterRole not bound yet |
| `cannot exec` in etcd check | `ocp-health-etcd-exec` RoleBinding missing |
| `cannot create token` in metrics tab | `ocp-health-token-creator` RoleBinding missing |
| `cannot get resource "machineconfigpools"` | `machineconfiguration.openshift.io` API group missing from ClusterRole |
| `cannot list nodes/metrics` | `metrics.k8s.io` rule missing |

---

## Summary

`cluster-admin` is not mandatory. The dashboard is almost entirely a read-only observer — the only exceptions are one `exec` and one `token create`, both tightly scoped by namespace and resource name. A custom role reduces the security posture from "compromised pod = root on the cluster" to "compromised pod = read-only view of cluster state."

The custom RBAC is in `k8s/rbac-least-privilege.yaml`.
