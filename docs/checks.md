# Health Checks Reference

The dashboard runs **19 health checks** grouped into 8 categories. This page documents what each check does, what `oc` commands it runs, and what conditions cause it to pass or fail.

---

## Check Status Values

| Status | Meaning |
|---|---|
| ✅ **Passed** | All conditions are healthy |
| ❌ **Failed** | One or more conditions outside acceptable range |
| ⚠️ **Error** | The check itself could not complete (e.g. `oc` command failed) |
| ⊘ **Skipped** | Check disabled via config or env var |

---

## Control Plane

### Cluster Operators

**Check ID:** `cluster_operators`

Verifies that all ClusterOperators are in a healthy state.

**Command:**
```bash
oc get co --no-headers
```

**Pass condition:** Every operator has `AVAILABLE=True`, `PROGRESSING=False`, `DEGRADED=False`.

**Fail condition:** Any operator has `AVAILABLE=False`, `PROGRESSING=True`, or `DEGRADED=True`.

**Common failures:**
- An operator stuck upgrading (`PROGRESSING=True` for > 20 minutes)
- `authentication` or `console` operator degraded after config change
- Storage operator unavailable due to backend issues

---

### Cluster Version

**Check ID:** `cluster_version`

Checks the overall cluster version and update status.

**Command:**
```bash
oc get clusterversion --no-headers
```

**Pass condition:** `AVAILABLE=True`, `PROGRESSING=False`, `DEGRADED=False`.

**Fail condition:** Cluster update has failed or the version object reports degraded state.

---

### MachineConfigPool

**Check ID:** `machine_config_pool`

Checks that all MachineConfigPools are updated and not degraded.

**Command:**
```bash
oc get mcp --no-headers
```

**Pass condition:** All MCPs show `UPDATED=True`, `UPDATING=False`, `DEGRADED=False`.

**Fail condition:** Any MCP is still updating or has entered a degraded state.

**Note:** During a cluster upgrade, MCPs will temporarily show `UPDATING=True`. This is expected and does not indicate a real failure during a controlled upgrade window.

---

### Etcd Cluster Health

**Check ID:** `etcd_health`

Runs `etcdctl endpoint health` against the etcd cluster via `oc exec`.

**Command:**
```bash
oc exec -n openshift-etcd <etcd-pod> -- \
  etcdctl endpoint health --cluster
```

**Pass condition:** All endpoints report `healthy: true`.

**Fail condition:** Any endpoint is unhealthy or unreachable.

**Note:** Requires the etcd pods to be running in `openshift-etcd`. The check automatically selects the first available etcd pod.

---

### Authentication Pods

**Check ID:** `authentication`

Verifies that OAuth/authentication pods are running.

**Command:**
```bash
oc get pods -n openshift-authentication --no-headers
```

**Pass condition:** All pods are `Running` with `READY` matching `DESIRED`.

**Fail condition:** Any pod is not `Running`, or is in `CrashLoopBackOff`, `Error`, or `Pending`.

---

### Control Plane Pods

**Check ID:** `control_plane_pods`

Checks pods in the four core control plane namespaces.

**Namespaces checked:**
- `openshift-kube-apiserver`
- `openshift-kube-scheduler`
- `openshift-kube-controller-manager`
- `openshift-etcd`

**Command:**
```bash
oc get pods --all-namespaces --no-headers
```

**Pass condition:** All pods in these namespaces are `Running` and ready.

**Fail condition:** Any non-ready pod found. Installer and revision-pruner pods (which are short-lived by design) are automatically excluded from failure evaluation.

---

## Nodes

### Node Readiness

**Check ID:** `node_readiness`

Checks that all nodes are in `Ready` state.

**Command:**
```bash
oc get nodes --no-headers
```

**Pass condition:** All nodes show `STATUS=Ready`.

**Fail condition:** Any node is `NotReady`, `SchedulingDisabled`, or in an unknown state.

---

### Node CPU Usage

**Check ID:** `node_cpu`

Monitors CPU utilisation across all nodes.

**Command:**
```bash
oc adm top nodes --no-headers
```

**Pass condition:** All nodes below the configured threshold (default: 80%).

**Fail condition:** Any node CPU usage exceeds the threshold.

**Configuration:**
```yaml
- id: node_cpu
  threshold: 80    # percent — change to your desired limit
```

---

### Node Memory Usage

**Check ID:** `node_memory`

Monitors memory utilisation across all nodes.

**Command:**
```bash
oc adm top nodes --no-headers
```

**Pass condition:** All nodes below the configured threshold (default: 80%).

**Fail condition:** Any node memory usage exceeds the threshold.

**Configuration:**
```yaml
- id: node_memory
  threshold: 80    # percent
```

---

### Node Resource Limits

**Check ID:** `node_limits`

Checks the **allocated** resource requests and limits against each node's total capacity. This is different from `node_cpu`/`node_memory` which measure actual current usage — this check measures what is *scheduled*.

**Commands:**
```bash
oc get nodes -o json                     # get node list
oc describe node <node-name>             # for each node, get allocated resources
```

**Metrics collected per node:**

| Metric | Description |
|---|---|
| CPU Requests | Sum of all pod CPU requests as % of node CPU |
| CPU Limits | Sum of all pod CPU limits as % of node CPU |
| Memory Requests | Sum of all pod memory requests as % of node memory |
| Memory Limits | Sum of all pod memory limits as % of node memory |

**Pass condition:** All four metrics are ≤ 100% on all nodes.

**Fail condition:** Any metric exceeds 100% on any node (over-committed).

**Dashboard tab:** Results are also displayed in the **Node Limits** tab with a sortable table and colour-coded percentages (red > 100%, orange > 80%, green ≤ 80%).

> **Screenshot placeholder:**  
> `[screenshot: Node Limits tab showing per-node CPU and memory request/limit percentages]`

---

## Pods

### Platform Namespace Pods

**Check ID:** `platform_pods`

Checks all pods in OpenShift platform namespaces (`openshift-*` and `kube-*`).

**Command:**
```bash
oc get pods --all-namespaces --no-headers
```

Filters for pods in namespaces matching `openshift-*` or `kube-*`.

**Pass condition:** All platform pods are `Running` and ready.

**Fail condition:** Any platform pod is not ready (excluding known short-lived pods like installers and pruners).

---

### Non-Platform Pods

**Check ID:** `non_platform_pods`

Checks pods in all non-platform namespaces (your application workloads).

**Command:**
```bash
oc get pods --all-namespaces --no-headers
```

Filters for pods NOT in `openshift-*`, `kube-*`, or `default`.

**Pass condition:** No pods are in `CrashLoopBackOff`, `Error`, `OOMKilled`, or `Evicted` state.

**Fail condition:** Any application pod is in a failed state.

**Note:** `Pending` pods are reported as a warning but do not cause the check to fail — scheduling delays are not always a health issue.

---

## Networking

### API Server Health

**Check ID:** `api_server`

Performs an HTTPS health probe against the OpenShift API server.

**Probe target:** `${API_URL}/readyz`

**Pass condition:** HTTP 200 response from `/readyz`.

**Fail condition:** Non-200 response, connection refused, or timeout.

---

### Ingress Controller Health

**Check ID:** `ingress_controller`

Checks that the OpenShift ingress controller is responding.

**Probe target:** `${CONSOLE_URL}` (the console URL is always served by the default ingress controller)

**Pass condition:** HTTP 200 or 301/302 redirect response (console redirects to login).

**Fail condition:** Connection error, timeout, or server error (5xx).

---

### Machine Config Server

**Check ID:** `machine_config_server`

Verifies the Machine Config Server (MCS) is operational by checking its pods and ClusterOperator status.

**Commands:**
```bash
oc get pods -n openshift-machine-config-operator --no-headers
oc get co machine-config --no-headers
```

**Pass condition:** MCS pods are running AND the `machine-config` ClusterOperator is available.

**Fail condition:** MCS pods not running or ClusterOperator degraded.

**Note:** The MCS listens on port 22623 and is not externally accessible. This check does not probe that port directly — it uses pod status and the CO status instead.

---

## Storage

### PVC and PV Health

**Check ID:** `pvc_health`

Checks all PersistentVolumeClaims across the cluster.

**Command:**
```bash
oc get pvc --all-namespaces --no-headers
```

**Pass condition:** All PVCs are in `Bound` state.

**Fail condition:** Any PVC is `Pending`, `Lost`, or in an unknown state.

**Note:** `Pending` PVCs indicate a provisioning failure — the underlying StorageClass or storage backend cannot fulfil the request.

---

## Security

### SSL Certificate Expiry

**Check ID:** `ssl_certificates`

Scans all `kubernetes.io/tls` secrets in the cluster and checks certificate expiry dates.

**Command:**
```bash
oc get secrets --all-namespaces \
  -o go-template='{{range .items}}
  {{if and (eq .type "kubernetes.io/tls") (index .data "tls.crt")}}
  {{.metadata.namespace}} {{.metadata.name}} {{index .data "tls.crt"}}|||
  {{end}}{{end}}'
```

**Decoding:** Each cert value is `base64(PEM_TEXT)`. The check double-decodes to raw DER bytes, then scans for ASN.1 `UTCTime`/`GeneralizedTime` tags to extract `notBefore` and `notAfter` without requiring `openssl` in the container.

**Pass condition:** No non-excluded certs expiring within the threshold (default: 30 days).

**Fail condition:** One or more non-excluded certs expiring within the threshold.

**Configuration:** See [SSL namespace filtering](configuration.md#configmap-ocp-health-ssl-config).

**Dashboard tab:** The **SSL Certificates** tab shows all certs with sortable columns and four filter modes:
- *Expiring <30 days* (default view)
- *All TLS certificates*
- *Valid ≥30 days*
- *Excluded namespaces only*

> **Screenshot placeholder:**  
> `[screenshot: SSL Certificates tab with expiry filter showing red/orange badges]`

---

## Monitoring

### Monitoring Stack

**Check ID:** `monitoring_stack`

Checks that the core monitoring components are running.

**Command:**
```bash
oc get pods -n openshift-monitoring --no-headers
```

**Key components checked:**
- `prometheus-k8s-0` and `prometheus-k8s-1`
- `alertmanager-main-0` and `alertmanager-main-1`
- `prometheus-operator`
- `thanos-querier`

**Pass condition:** All monitoring pods are `Running` and ready.

**Fail condition:** Any core monitoring pod is not ready.

---

## Availability

### PodDisruptionBudget Health

**Check ID:** `pdb_health`

Analyses all PodDisruptionBudgets (PDBs) to determine disruption headroom — how many pods could be taken down for maintenance without breaching the PDB.

**Command:**
```bash
oc get pdb -A -o json
```

**Namespaces excluded:** All `openshift-*` namespaces (system PDBs are not actionable).

**Disruption calculation:**

For `minAvailable` PDBs:
```
disruptionsAllowed = currentHealthy - minAvailable
```

For `maxUnavailable` PDBs:
```
disruptionsAllowed = maxUnavailable - (expectedPods - currentHealthy)
disruptionsAllowed = max(0, disruptionsAllowed)
```

**Colour classification:**

| Colour | Condition | Meaning |
|---|---|---|
| 🔴 Red | `disruptionsAllowed = 0` AND `expectedPods > 0` | Fully blocked — no maintenance possible |
| 🟠 Orange | `disruptionsPercent < 30%` | Low headroom — proceed with caution |
| 🟢 Green | `disruptionsPercent ≥ 30%` | Healthy headroom |
| 🔵 Blue | `disruptionsPercent = 100%` | Full outage allowed (PDB is not protecting) |

`disruptionsPercent = floor((disruptionsAllowed / expectedPods) × 100)`

**Pass condition:** No PDBs are in blocked (🔴) state.

**Fail condition:** Any application PDB is fully blocked.

**Dashboard tab:** The **PDB Analysis** tab shows summary cards, a warning banner if any PDB is fully blocked, a sortable table per PDB, and a colour legend.

> **Screenshot placeholder:**  
> `[screenshot: PDB Analysis tab showing summary cards and colour-coded table]`

---

## Check Guide (Inline Documentation)

Every check in the dashboard results table has a **?** button that opens an inline Check Guide panel. The panel explains:

- What the check does
- Why it matters
- Common causes of failure
- Suggested remediation steps

The content is served from the server via `GET /api/docs/:checkId` and does not require an internet connection.
