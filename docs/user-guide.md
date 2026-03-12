# Dashboard User Guide

---

## Tabs Overview

| Tab | Description |
|---|---|
| Overview | Health check results by category |
| Metrics | Live Prometheus/Thanos data |
| SSL Certificates | TLS secret expiry across the cluster |
| Node Limits | CPU/memory request and limit % per node |
| PDB Analysis | PodDisruptionBudget disruption headroom |
| **Cluster Allocation** | ResourceQuota report — node capacity and namespace quota breakdown |
| History | Previous runs with PDF/JSON download |
| Check Guide | Inline documentation per check |

---

## Overview Tab

Shows all 19 health checks grouped by category. Each check shows pass ✅, fail ❌, error ⚠, or skipped ⊘. Click a failed check to expand details and raw output.

The **Run Now** button triggers an immediate check run. The header shows the cluster ID, last run time, and overall pass/fail status.

---

## Metrics Tab

Queries Thanos (the OpenShift cluster-internal Prometheus aggregator) and displays the results in four collapsible groups.

> The Metrics tab uses a separate API call to Thanos — it does **not** run as part of the standard health check cycle. Data is cached for 5 minutes. Click **↻ Refresh** to force a live query.

### Groups

**Compute**
- **CPU Usage** — pods using ≥ threshold % of their CPU limit
- **Memory Usage** — pods using > threshold % of their memory limit
- **OOM Kills** — pods that were OOM-killed in the last hour

**Storage**
- **PVC Usage** — PersistentVolumeClaims above the fill threshold
- **Node Filesystem** — root filesystem (`/`) usage per node above threshold

**etcd**
- **etcd DB Size** — etcd database size per member; flags if > 8 GB
- **etcd Peer RTT** — p99 round-trip time between etcd peers; flags if > 100 ms

**Active Alerts**
- All `firing` or `pending` Prometheus alerts with severity `critical` or `warning`

### Thresholds Panel

Click **⚙ Thresholds** to see all active threshold values and the ConfigMap key to change each one. Changes take effect after updating `ocp-health-metrics-config` and restarting the pod.

### Troubleshooting the Metrics Tab

If the tab shows a connection error:
1. Verify the `prometheus-k8s` ServiceAccount exists in `openshift-monitoring`
2. Check the pod logs: `oc logs -l app=ocp-health-dashboard -n ocp-health-dashboard | grep -i thanos`
3. If `THANOS_HOST` is blank the host is auto-discovered via `oc get route thanos-querier -n openshift-monitoring` — confirm that route exists

---

## SSL Certificates Tab

Lists all `kubernetes.io/tls` secrets found across the cluster (subject to namespace filters). Columns: namespace, secret name, expiry date, days remaining.

**Filters:**
- *Expiring < 30 days* (default) — only certs expiring soon
- *All* — every cert found
- *Valid only* — certs not yet expiring
- *Excluded* — namespaces skipped by the SSL filter config

To change which namespaces are scanned, update `ocp-health-ssl-config` in `k8s/manifests.yaml` and restart the pod.

---

## Node Limits Tab

Shows CPU and memory **request %** and **limit %** per node relative to allocatable capacity. Rows where any value exceeds 100% are highlighted — this means the node is over-committed and pods may be evicted or OOM-killed under pressure.

Click **↻ Live Refresh** to re-run the `oc describe node` commands immediately.

---

## PDB Analysis Tab

Shows every PodDisruptionBudget in the cluster alongside its current disruption headroom (how many pods can be taken down right now without violating the PDB).

| Colour | Meaning |
|---|---|
| 🔴 Red | Disruptions are currently blocked (0 allowed) |
| 🟠 Orange | Only 1 disruption allowed — low HA headroom |
| 🟢 Green | Healthy headroom |
| 🔵 Blue | `minAvailable: 0` or `maxUnavailable: 100%` — full disruption allowed |

---

## Cluster Allocation Tab

Provides a three-part resource allocation report across all non-platform namespaces. This is the in-dashboard equivalent of running a resource quota audit script against the cluster.

> Data is cached for 5 minutes. Click **↻ Refresh** to force a live fetch. Click **⬇ Export CSV** to download all three reports as a single CSV file.

### Summary Cards (top)

Shows cluster-wide totals at a glance:

| Card | Description |
|---|---|
| Cluster | Worker + master node count |
| CPU Allocation % | Total CPU requests across all quotas vs total worker allocatable CPU |
| Memory Allocation % | Same for memory |
| Free CPU / Free Memory | Unallocated worker capacity |
| Namespaces | Total checked, how many have a quota, how many don't |
| *Per storage class* | Total storage quota (GiB) + total PVC count — one card per storage class found |

Allocation % cards are colour-coded: green (< 70%), orange (70–89%), red (≥ 90%).

### Report 2 — ResourceQuota Breakdown

A table with one row per ResourceQuota (namespaces with no quota show a single "No ResourceQuota" row). Columns:

- Namespace
- Quota name
- CPU Requests / CPU Limits
- Memory Requests / Memory Limits
- *One column group per storage class* — Storage (GiB) and PVC count

**Storage class columns are auto-discovered.** The dashboard scans all ResourceQuota `.spec.hard` keys for the pattern `<scname>.storageclass.storage.k8s.io/requests.storage`. Every unique storage class found across all namespaces becomes a column group — no configuration required. When a new storage class is added to any quota, it appears on the next refresh.

Use the **namespace filter** (text search) and **quota filter** (dropdown: all / has quota / no quota) to narrow the table. All columns are sortable. A grand total row appears at the bottom.

### Report 1 — Node Capacity

Lists all nodes with role (Master / Worker), status (Ready / NotReady), allocatable CPU (millicores), and allocatable memory. Only Ready workers are counted in the summary totals.

### CSV Export

The exported file contains all three reports in separate sections:
- **REPORT 3** — cluster utilisation summary (matches the summary cards)
- **REPORT 2** — full ResourceQuota breakdown including all storage class columns
- **REPORT 1** — node capacity

Storage class columns in the CSV are dynamically named to match whatever was discovered at fetch time.

---

## History Tab

Lists all previous runs. Click any row to see full results for that run. Use the download buttons to export as JSON or PDF.

---

## Check Guide Tab

Select any check from the sidebar to see a description of what it monitors, the `oc` command it uses, and what to do when it fails.
