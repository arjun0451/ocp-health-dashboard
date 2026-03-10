# Dashboard User Guide

This guide explains how to use the OCP Health Dashboard web interface.

---

## Table of Contents

- [Overview Tab](#overview-tab)
- [SSL Certificates Tab](#ssl-certificates-tab)
- [Node Limits Tab](#node-limits-tab)
- [PDB Analysis Tab](#pdb-analysis-tab)
- [Check Guide](#check-guide)
- [Run History](#run-history)
- [Triggering a Manual Run](#triggering-a-manual-run)
- [Downloading Reports](#downloading-reports)
- [Sorting Tables](#sorting-tables)

---

## Overview Tab

The Overview tab is the landing page of the dashboard. It shows the current status of all health checks grouped by category.
 
![Overview tab screenshot](https://github.com/arjun0451/ocp-health-dashboard/blob/c08d199c24d245ed44a6f1b81d05645edbd13cbd/images/Landingpage.png "Dashboard Overview")

### Header Bar

The header shows:
- **Cluster ID** — the cluster name set in your configuration
- **Last run time** — when the most recent check run completed
- **Overall status badge** — green if all checks passed, red if any failed
- **Run button** — triggers an immediate check run
- **Tabs** — navigate between Overview, SSL, Node Limits, PDB, History

### Category Sections

Checks are grouped into collapsible sections by category:

```
▼ 🖥  Control Plane          ✓ 6
▼ 🔲  Nodes                  ✓ 4
▼ 📦  Pods                   ✓ 2
▼ 🌐  Networking             ✓ 3
▼ 💾  Storage                ✓ 1
▼ 🔒  Security               ✗ 1
▼ 📊  Monitoring             ✓ 1
▼ 🛡  Availability           ✓ 1
```

Clicking the category header collapses or expands it.

### Check Result Row

Each row shows:

| Column | Description |
|---|---|
| # | Check sequence number |
| Check | Check name and **?** guide button |
| Status | `Passed`, `Failed`, `Error`, or `Skipped` badge |
| Detail | Short summary message |
| ms | Time the check took to complete |
| Log | Link to the raw artifact log (📄) if available |

**Clicking a Failed or Error row** expands an inline detail panel showing the raw `oc` output that caused the failure — exact pod names, namespace, error messages, etc.

> ![Overview tab screenshot](https://github.com/arjun0451/ocp-health-dashboard/blob/c0aeecd9687656f68118fbc1d522101d7283f509/images/checkerror.png "Error details")

### Status Badges

| Badge | Colour | Meaning |
|---|---|---|
| Passed | Green | All conditions healthy |
| Failed | Red | One or more conditions unhealthy |
| Error | Orange | Check could not complete |
| Skipped | Grey | Check disabled in config |

---

## SSL Certificates Tab

The SSL Certificates tab displays all `kubernetes.io/tls` secrets found in the cluster with their validity details.
![Overview tab screenshot](https://github.com/arjun0451/ocp-health-dashboard/blob/c0aeecd9687656f68118fbc1d522101d7283f509/images/ssltab.png "SSL details")


### Loading and Refreshing

The tab loads certificate data when you first click it. The data is fetched live from the cluster at that moment — it is not cached from the last scheduled run.

- **↻ Refresh** — re-fetches all certificates from the cluster
- **🔍 Debug** — shows a panel with raw `oc` output samples (useful if you see 0 certs or parse errors)

### Stats Bar

After loading, a stats bar appears above the table:

```
TLS secrets found: 232  │  Parsed OK: 198  │  Checked: 182  │  Excluded: 16
```

| Stat | Meaning |
|---|---|
| TLS secrets found | Total `kubernetes.io/tls` secrets with a `tls.crt` data key |
| Parsed OK | Certs successfully decoded and date-extracted |
| Checked | Non-excluded certs that are actively monitored |
| Excluded | Certs in excluded namespaces (shown separately in the Excluded filter) |
| Parse errors | Certs where the ASN.1 date could not be extracted (shows if > 0) |

### Dropdown Filters

| Filter | Shows |
|---|---|
| **Expiring <30 days** *(default)* | Non-excluded certs expiring within the threshold |
| **All TLS certificates** | Every cert including excluded namespaces |
| **Valid ≥30 days** | Non-excluded certs that are currently healthy |
| **Excluded namespaces only** | Certs in the configured excluded namespaces |

### Text Filter

Type in the filter box to narrow results by namespace or secret name. The filter applies on top of the dropdown selection.

### Table Columns

| Column | Description |
|---|---|
| Namespace | Kubernetes namespace of the secret |
| Secret Name | Name of the TLS secret |
| Start Date | Certificate `notBefore` date (`YYYY-MM-DD`) |
| Expiry Date | Certificate `notAfter` date (`YYYY-MM-DD`) |
| Days Left | Days until expiry (negative = already expired) |
| Status | Colour-coded badge |

### Status Badges

| Badge | Colour | Condition |
|---|---|---|
| 🔴 Expired | Red | `daysLeft < 0` |
| 🟠 Expiring | Orange/Red | `daysLeft < 30` |
| 🟢 Valid | Green | `daysLeft ≥ 30` |
| Excluded | Grey | Cert is in an excluded namespace |

### Fetch Log

A collapsible **Fetch log** section under the toolbar records every fetch attempt with timestamps:

```
[4:21:10 PM] Fetching /api/ssl/certs …
[4:21:14 PM] OK in 3908ms — TLS found: 232  parsed: 198  excluded: 16  checked: 182  expiring<30d: 21
```

If an error occurs it is logged here and shown in the error panel above the table.

### Debug Panel

Click **🔍 Debug** to open the debug panel. It calls `/api/ssl/debug` and shows:

- Number of raw bytes returned by `oc`
- Number of records found (after splitting on the `|||` delimiter)
- The go-template used
- First 5 raw record samples (first 200 chars each)

Use this if `parsed: 0` or `parse errors` appears in the stats bar, to verify what `oc` is actually returning.


---

## Node Limits Tab

The Node Limits tab shows **scheduled resource utilisation** — how much of each node's CPU and memory capacity has been claimed by pod requests and limits.


![Overview tab screenshot](https://github.com/arjun0451/ocp-health-dashboard/blob/c0aeecd9687656f68118fbc1d522101d7283f509/images/nodelimits.png "Nodelimits Overview")


### Summary Cards

Three cards at the top:

| Card | Meaning |
|---|---|
| Total Nodes | Number of nodes in the cluster |
| Over-committed | Nodes where any metric exceeds 100% |
| Within Limits | Nodes where all metrics are ≤ 100% |

### Table Columns

| Column | Meaning |
|---|---|
| Node | Node hostname |
| CPU Req (cores) | Total CPU requests in cores |
| CPU Req % | CPU requests as % of node capacity |
| CPU Lim (cores) | Total CPU limits in cores |
| CPU Lim % | CPU limits as % of node capacity |
| Mem Req (GiB) | Total memory requests |
| Mem Req % | Memory requests as % of node capacity |
| Mem Lim (GiB) | Total memory limits |
| Mem Lim % | Memory limits as % of node capacity |
| Status | `⚠ Over 100%` or `OK` |

### Colour Coding

| Colour | Threshold |
|---|---|
| 🔴 Red, bold | > 100% (over-committed) |
| 🟠 Orange, bold | > 80% (approaching limit) |
| ⚪ Normal | ≤ 80% |

### Live Refresh

Click **↻ Live Refresh** to re-run `oc describe node` for all nodes right now. Normal tab loading uses data cached from the last scheduled check run.

---

## PDB Analysis Tab

The PDB Analysis tab shows the disruption headroom for every PodDisruptionBudget in your application namespaces.


![Overview tab screenshot](https://github.com/arjun0451/ocp-health-dashboard/blob/c0aeecd9687656f68118fbc1d522101d7283f509/images/pdb.png "PDB Overview")

### Warning Banner

If any PDB is fully blocked (🔴), a prominent warning banner appears at the top of the tab:

```
⚠  2 PDB(s) are fully blocked — maintenance on affected nodes is not possible
   without violating disruption budgets.
```

### Summary Cards

| Card | Meaning |
|---|---|
| Total PDBs | All non-system PDBs found |
| 🔴 Blocked | Zero disruptions allowed |
| 🟠 Low HA | < 30% disruption headroom |
| 🟢 Safe | ≥ 30% disruption headroom |
| 🔵 Full Outage | 100% allowed (PDB provides no protection) |

### Table Columns

| Column | Description |
|---|---|
| Namespace | PDB namespace |
| PDB Name | PDB resource name |
| Type | `minAvailable` or `maxUnavailable` |
| Expected | `expectedPods` from PDB status |
| Healthy | `currentHealthy` from PDB status |
| Disruptions | Number of pods that can be taken down |
| % | Disruption headroom as a percentage |
| Status | Colour-coded remark |

### Interpreting Results

**Blocked (🔴):** The PDB currently allows zero disruptions. If you need to drain a node that runs these pods, you must either scale up the deployment first, or temporarily delete and recreate the PDB.

**Low HA (🟠):** Headroom exists but is tight. A single unexpected pod failure would block node drains.

**Safe (🟢):** Normal healthy state. Node maintenance can proceed.

**Full Outage (🔵):** The PDB technically allows 100% disruption — it is not providing any protection. This may be intentional (e.g. a single-replica dev deployment) but should be reviewed for production workloads.

---

## Check Guide

Every row in the Overview tab has a **?** button next to the check name. Clicking it opens an inline guide panel that explains:

- What the check monitors
- Why it matters for cluster health
- The most common causes of failure
- Suggested remediation steps


The guide panel can be closed by clicking the **?** button again or clicking elsewhere on the row.

---

## Run History

Click the **History** tab to see a list of previous check runs.


![Overview tab screenshot](https://github.com/arjun0451/ocp-health-dashboard/blob/c0aeecd9687656f68118fbc1d522101d7283f509/images/history.png "Run history")


Each entry shows:
- Run timestamp
- Run ID
- Overall pass/fail status
- Number of checks passed vs failed
- Links to download the run report in JSON or PDF format

Clicking a run entry loads its results in the Overview tab so you can compare against the current state.

**Retention:** Old runs are automatically deleted after the configured `ARTIFACT_RETENTION_DAYS` (default: 30). The PVC stores all run data so history survives pod restarts.

---

## Triggering a Manual Run

You can trigger a check run at any time without waiting for the schedule:

**From the UI:**  
Click the **▶ Run Now** button in the dashboard header. The button becomes disabled during the run and re-enables when the run completes.

**From the API:**
```bash
ROUTE=$(oc get route ocp-health-dashboard \
  -n ocp-health-dashboard \
  -o jsonpath='{.spec.host}')

curl -s -X POST https://${ROUTE}/api/run | jq .
```

Response:
```json
{ "message": "Run triggered", "triggeredBy": "api" }
```

---

## Downloading Reports

Reports are available in **JSON** and **PDF** formats for every completed run.

**From the UI:** Click the run entry in the History tab, then use the download buttons.

**From the API:**
```bash
ROUTE=$(oc get route ocp-health-dashboard \
  -n ocp-health-dashboard \
  -o jsonpath='{.spec.host}')

# Latest run JSON:
curl -s https://${ROUTE}/api/report/latest/json | jq .

# Latest run PDF:
curl -s -o report.pdf https://${ROUTE}/api/report/latest/pdf

# Specific run by ID:
curl -s https://${ROUTE}/api/report/run-1234567890/json | jq .
```

The PDF report includes:
- Cluster ID and run timestamp
- Overall summary (pass/fail counts per category)
- Full results table for all checks
- Raw output details for failed checks

---

## Sorting Tables

All tables in the SSL, Node Limits, and PDB tabs support column sorting.

Click any **column header** to sort ascending. Click again to sort descending. The active sort column shows an arrow indicator.

Default sort orders when a tab loads:
- **SSL tab:** by `daysLeft` ascending (most critical first)
- **Node Limits tab:** by node name
- **PDB tab:** by colour rank (blocked first)
