# Health Checks Reference

The dashboard runs **19 scheduled health checks** plus **8 live Prometheus/Thanos metric checks** available in the Metrics tab.

---

## Check Status Values

| Status | Meaning |
|---|---|
| ✅ Passed | All conditions healthy |
| ❌ Failed | One or more conditions outside threshold |
| ⚠️ Error | Check could not complete (e.g. `oc` command failed) |
| ⊘ Skipped | Disabled via config |

---

## Control Plane

### Cluster Operators — `cluster_operators`
Checks that every ClusterOperator is `AVAILABLE=True`, `PROGRESSING=False`, `DEGRADED=False`.

### Cluster Version — `cluster_version`
Checks the overall cluster version object is not degraded or stuck updating.

### MachineConfigPool — `machine_config_pool`
Checks all MCPs are `UPDATED=True`, `UPDATING=False`, `DEGRADED=False`.

### Etcd Health — `etcd_health`
Execs into an etcd pod and runs `etcdctl endpoint health --cluster`. Fails if any member reports unhealthy.

### Authentication — `authentication`
Checks pods in `openshift-authentication` are Running and Ready.

### Control Plane Pods — `control_plane_pods`
Checks static pods in `openshift-kube-apiserver`, `openshift-kube-scheduler`, `openshift-kube-controller-manager`, and `openshift-etcd` are Running.

---

## Nodes

### Node Readiness — `node_readiness`
Checks all nodes report `Ready=True`. Lists any NotReady nodes.

### Node CPU — `node_cpu`
Uses `oc adm top nodes` to check CPU utilisation % against threshold (default: 80%).

### Node Memory — `node_memory`
Uses `oc adm top nodes` to check memory utilisation % against threshold (default: 85%).

### Node Limits — `node_limits`
Parses `oc describe node` for each node to check that CPU and memory requests/limits do not exceed 100% of allocatable capacity (over-commitment check).

---

## Pods

### Platform Pods — `platform_pods`
Checks pods in `openshift-*` and `kube-*` namespaces are Running or Completed. Lists any in CrashLoopBackOff, Error, or Pending state.

### Non-Platform Pods — `non_platform_pods`
Same check for all other (workload) namespaces.

---

## Networking

### API Server — `api_server`
HTTP probe to the cluster API server `/readyz` endpoint.

### Ingress Controller — `ingress_controller`
HTTP probe to the console URL to verify the default ingress router is reachable.

### Machine Config Server — `machine_config_server`
HTTP probe to the MCS endpoint used by nodes during bootstrapping.

---

## Storage

### PVC Health — `pvc_health`
Lists all PVCs across all namespaces. Fails if any are in `Pending` or `Lost` state.

---

## Security

### SSL Certificates — `ssl_certificates`
Scans all `kubernetes.io/tls` secrets and parses the certificate expiry date. Fails if any certificate expires within the configured threshold (default: 30 days). Namespace inclusions/exclusions are configurable.

---

## Monitoring

### Monitoring Stack — `monitoring_stack`
Checks that pods in `openshift-monitoring` are Running. Flags any pod not in a healthy state.

---

## Availability

### PDB Health — `pdb_health`
Lists all PodDisruptionBudgets and checks current disruption allowance. Flags PDBs where zero disruptions are currently permitted (blocks node drains).

---

## Metrics Tab Checks

These checks run **on demand** against Thanos (the OpenShift cluster Prometheus aggregator) — not as part of the scheduled run cycle. Results are cached for 5 minutes.

### CPU Usage — `cpu_usage`
Pods using ≥ `PROM_CPU_THRESHOLD` % (default: 90%) of their CPU limit. Uses `container_cpu_usage_seconds_total` vs `kube_pod_container_resource_limits`.

### Memory Usage — `memory_usage`
Pods using > `PROM_MEM_THRESHOLD` % (default: 80%) of their memory limit. Uses `container_memory_working_set_bytes` vs limits.

### OOM Kills — `oom_killed`
Pods that have been OOM-killed in the last `PROM_OOM_WINDOW` (default: 1 hour). Uses `kube_pod_container_status_last_terminated_reason`.

### PVC Usage — `pvc_usage`
PersistentVolumeClaims with fill level above `PROM_PVC_THRESHOLD` % (default: 70%). Uses `kubelet_volume_stats_used_bytes` / capacity.

### Node Filesystem — `node_filesystem`
Root filesystem (`mountpoint="/"`) usage per node above `PROM_FS_USED_THRESHOLD` % (default: 90%). Excludes `ibmc-s3fs` mounts and read-only filesystems.

### etcd DB Size — `etcd_db_size`
etcd database size per member. Flags members exceeding `PROM_ETCD_DB_BYTES` (default: 8 GB). Uses `etcd_mvcc_db_total_size_in_bytes`. Always shows all members (info mode).

### etcd Peer RTT — `etcd_rtt`
p99 round-trip time between etcd peers. Flags if > `PROM_ETCD_RTT_MS` (default: 100 ms). Uses `etcd_network_peer_round_trip_time_seconds`. Always shows all members.

### Active Alerts — `active_alerts`
All `firing` or `pending` Prometheus alerts with severity matching `PROM_ALERT_SEVERITIES` (default: `critical,warning`).

---

## Cluster Allocation Tab

Not a scheduled check — fetched on demand via `/api/quota`. Scans all non-platform namespaces and reports:

- **Node capacity** — allocatable CPU (m) and memory (MiB) per node, worker vs master
- **ResourceQuota breakdown** — CPU requests/limits, memory requests/limits, and per-storage-class quota (GiB) and PVC count per namespace
- **Cluster summary** — total worker capacity vs total allocated, free capacity, storage totals

Storage class columns are auto-discovered from ResourceQuota `.spec.hard` keys — no config required. Any storage class present in any quota appears as a column.

Namespaces with prefix `openshift-`, `kube-`, or `default` are excluded by default (configurable via `RQ_SKIP_NAMESPACES`).
