'use strict';
/**
 * checkDocs.js
 * ------------
 * Documentation for every health check: what it covers, what it queries,
 * how to manually verify it, and what to do when it fails.
 * Served at GET /api/docs and shown in the dashboard "Check Guide" panel.
 */

const DOCS = [
  // ── Control Plane ───────────────────────────────────────────────────────────
  {
    id: 'cluster_operators',
    name: 'Cluster Operators',
    category: 'control_plane',
    what: 'Verifies all OpenShift cluster operators are Available=True, Progressing=False, Degraded=False.',
    covers: [
      'kube-apiserver, kube-scheduler, kube-controller-manager operators',
      'console, dns, ingress, monitoring, authentication operators',
      'All other platform-managed operators',
    ],
    ocCommand: 'oc get co',
    manualSteps: [
      '1. Run: oc get co',
      '2. All rows should show: True  False  False  (Available / Progressing / Degraded)',
      '3. For a failing operator: oc describe co <name>',
      '4. Check operator pod logs: oc logs -n openshift-<name>-operator deployment/<name>-operator',
    ],
    passCondition: 'All operators: Available=True, Progressing=False, Degraded=False',
    failAction: 'Run `oc describe co <operator-name>` and check the "Conditions" and "Message" fields for the root cause.',
  },
  {
    id: 'cluster_version',
    name: 'Cluster Version',
    category: 'control_plane',
    what: 'Checks the ClusterVersion object to confirm the cluster upgrade is not failing.',
    covers: ['Current OCP version', 'Upgrade status', 'Release image integrity'],
    ocCommand: 'oc get clusterversion',
    manualSteps: [
      '1. Run: oc get clusterversion',
      '2. Available should be True, Progressing should be False',
      '3. For details: oc describe clusterversion version',
    ],
    passCondition: 'Available=True, Progressing=False',
    failAction: 'Run `oc describe clusterversion version` and review the Conditions section.',
  },
  {
    id: 'machine_config_pool',
    name: 'MachineConfigPool',
    category: 'control_plane',
    what: 'Confirms all MachineConfigPools are Updated and not Degraded.',
    covers: ['master MCP', 'worker MCP', 'any custom MCPs'],
    ocCommand: 'oc get mcp',
    manualSteps: [
      '1. Run: oc get mcp',
      '2. Updated should be True, Degraded should be False',
      '3. For a degraded MCP: oc describe mcp <name>',
      '4. Check for nodes that failed to apply config: oc get nodes',
    ],
    passCondition: 'All MCPs: Updated=True, Degraded=False',
    failAction: 'Run `oc describe mcp <name>`. Look for nodes stuck in config application. Check `oc get nodes` for NotReady nodes.',
  },
  {
    id: 'etcd_health',
    name: 'Etcd Cluster Health',
    category: 'control_plane',
    what: 'Executes `etcdctl endpoint health --cluster` inside a running etcd pod to verify all etcd members are healthy.',
    covers: ['All etcd member endpoints', 'Quorum health', 'Leader election status'],
    ocCommand: 'oc get pods -n openshift-etcd',
    manualSteps: [
      '1. Find a running etcd pod: oc get pods -n openshift-etcd -l app=etcd',
      '2. Exec in: oc exec -n openshift-etcd -c etcdctl <pod-name> -- sh -c "etcdctl endpoint health --cluster"',
      '3. All endpoints should show: is healthy',
      '4. Check etcd logs: oc logs -n openshift-etcd <pod-name> -c etcd',
    ],
    passCondition: 'All etcd endpoints report "is healthy"',
    failAction: 'Check etcd pod logs. Verify all 3 master nodes are Running. Review `oc get co etcd` for operator-level issues.',
  },
  {
    id: 'authentication',
    name: 'Authentication Pods',
    category: 'control_plane',
    what: 'Verifies all OAuth server pods in openshift-authentication are Running.',
    covers: ['OAuth server pods', 'Login/token issuance capability'],
    ocCommand: 'oc get pods -n openshift-authentication',
    manualSteps: [
      '1. Run: oc get pods -n openshift-authentication',
      '2. All oauth-openshift-* pods should be Running',
      '3. Check logs: oc logs -n openshift-authentication <pod-name>',
    ],
    passCondition: 'All pods Running',
    failAction: 'Check pod logs for OAuth configuration errors. Verify the OAuth CR: `oc get oauth cluster -o yaml`.',
  },
  {
    id: 'control_plane_pods',
    name: 'Control Plane Pods',
    category: 'control_plane',
    what: 'Checks pods in kube-apiserver, kube-scheduler, kube-controller-manager, and etcd namespaces. Ignores expected short-lived installer-* and revision-pruner-* job pods.',
    covers: [
      'openshift-kube-apiserver pods',
      'openshift-kube-scheduler pods',
      'openshift-kube-controller-manager pods',
      'openshift-etcd pods',
    ],
    ocCommand: 'oc get pods -n openshift-kube-apiserver\noc get pods -n openshift-kube-scheduler\noc get pods -n openshift-kube-controller-manager\noc get pods -n openshift-etcd',
    manualSteps: [
      '1. Run oc get pods -n <namespace> for each control plane namespace',
      '2. Static pods (kube-apiserver-*, etcd-*) should be Running',
      '3. installer-* pods in Completed or Error state are NORMAL — OCP uses them for rolling updates',
      '4. For any unexpected failures: oc logs -n <namespace> <pod-name>',
    ],
    passCondition: 'All non-installer/non-pruner pods Running. installer-* and revision-pruner-* in any state are ignored.',
    failAction: 'Check static pod logs. Review `oc get co kube-apiserver` and `oc get co etcd` for operator-level context.',
  },

  // ── Nodes ───────────────────────────────────────────────────────────────────
  {
    id: 'node_readiness',
    name: 'Node Readiness',
    category: 'nodes',
    what: 'Checks all cluster nodes have Ready status.',
    covers: ['All master and worker nodes', 'Node kubelet health'],
    ocCommand: 'oc get nodes',
    manualSteps: [
      '1. Run: oc get nodes',
      '2. STATUS column should be Ready for all nodes',
      '3. For a NotReady node: oc describe node <name>',
      '4. Check kubelet: ssh to node, run: systemctl status kubelet',
    ],
    passCondition: 'All nodes in Ready state',
    failAction: 'Run `oc describe node <name>` and look at Conditions and Events. Check if the node has disk or memory pressure.',
  },
  {
    id: 'node_cpu',
    name: 'Node CPU Usage',
    category: 'nodes',
    what: `Checks that no node exceeds the configured CPU usage threshold (default 80%).`,
    covers: ['Real-time CPU utilisation per node via metrics-server'],
    ocCommand: 'oc adm top nodes',
    manualSteps: [
      '1. Run: oc adm top nodes',
      '2. CPU% column should be below threshold for all nodes',
      '3. Find top consumers: oc adm top pods --all-namespaces --sort-by=cpu | head -20',
    ],
    passCondition: 'All nodes CPU% below configured threshold',
    failAction: 'Identify high-CPU pods with `oc adm top pods -A --sort-by=cpu`. Consider node scaling or pod resource limits.',
  },
  {
    id: 'node_memory',
    name: 'Node Memory Usage',
    category: 'nodes',
    what: 'Checks that no node exceeds the configured memory usage threshold (default 80%).',
    covers: ['Real-time memory utilisation per node via metrics-server'],
    ocCommand: 'oc adm top nodes',
    manualSteps: [
      '1. Run: oc adm top nodes',
      '2. MEMORY% column should be below threshold for all nodes',
      '3. Find top consumers: oc adm top pods --all-namespaces --sort-by=memory | head -20',
    ],
    passCondition: 'All nodes memory% below configured threshold',
    failAction: 'Check for memory-heavy pods. Review OOMKilled events: `oc get events -A | grep OOM`.',
  },

  // ── Pods ────────────────────────────────────────────────────────────────────
  {
    id: 'platform_pods',
    name: 'Platform Namespace Pods',
    category: 'pods',
    what: 'Checks all pods in openshift-* and kube-* namespaces are Running or Completed.',
    covers: ['All OCP platform component pods', 'System-level workloads'],
    ocCommand: 'oc get pods --all-namespaces | grep -E "^(openshift-|kube-)"',
    manualSteps: [
      '1. Run: oc get pods -A | grep -Ev "Running|Completed|Succeeded"',
      '2. Filter to platform namespaces: oc get pods -A --field-selector=status.phase!=Running',
      '3. For failing pods: oc describe pod -n <namespace> <pod-name>',
      '4. Check logs: oc logs -n <namespace> <pod-name> --previous',
    ],
    passCondition: 'All platform pods Running or Completed',
    failAction: 'Run `oc describe pod` and `oc logs --previous` on failing pods. Check for image pull errors or resource limits.',
  },
  {
    id: 'non_platform_pods',
    name: 'Non-Platform Pods',
    category: 'pods',
    what: 'Checks all application/workload pods (not in openshift-* or kube-*) are Running or Completed.',
    covers: ['All user workload namespaces', 'Application pods'],
    ocCommand: 'oc get pods --all-namespaces | grep -Ev "^(openshift-|kube-)"',
    manualSteps: [
      '1. Run: oc get pods -A | grep -Ev "(openshift-|kube-|Running|Completed|Succeeded)"',
      '2. For CrashLoopBackOff: oc logs -n <ns> <pod> --previous',
      '3. For ImagePullBackOff: oc describe pod -n <ns> <pod> | grep -A5 Events',
    ],
    passCondition: 'All application pods Running or Completed',
    failAction: 'Review pod logs and describe output. Common causes: image pull errors, OOM kills, missing ConfigMaps/Secrets, failed liveness probes.',
  },

  // ── Networking ──────────────────────────────────────────────────────────────
  {
    id: 'api_server',
    name: 'API Server Health',
    category: 'networking',
    what: 'Calls the /readyz endpoint of the Kubernetes API server to confirm it is serving requests.',
    covers: ['API server HTTP health', 'In-cluster API reachability'],
    ocCommand: 'curl -k https://kubernetes.default.svc/readyz',
    manualSteps: [
      '1. From inside the cluster: curl -k https://kubernetes.default.svc/readyz',
      '2. Should return: ok',
      '3. External: curl -k https://<API_URL>/readyz',
      '4. Check API server pods: oc get pods -n openshift-kube-apiserver',
    ],
    passCondition: '/readyz returns "ok"',
    failAction: 'Check `oc get co kube-apiserver`. Review API server pod logs in openshift-kube-apiserver namespace.',
  },
  {
    id: 'ingress_controller',
    name: 'Ingress Controller Health',
    category: 'networking',
    what: 'Makes an HTTPS request to the OpenShift console URL to verify the ingress router is operational.',
    covers: ['Default ingress router', 'Route-based traffic', 'Console accessibility'],
    ocCommand: 'curl -k -o /dev/null -w "%{http_code}" <CONSOLE_URL>',
    manualSteps: [
      '1. Run: oc get route console -n openshift-console',
      '2. curl -k -I <console-route-url> — should return HTTP 200 or 302',
      '3. Check router pods: oc get pods -n openshift-ingress',
      '4. Check ingress operator: oc get co ingress',
    ],
    passCondition: 'Console URL returns HTTP 200/301/302',
    failAction: 'Check ingress router pods: `oc get pods -n openshift-ingress`. Review `oc get co ingress` and `oc describe ingresscontroller default -n openshift-ingress-operator`.',
  },
  {
    id: 'machine_config_server',
    name: 'Machine Config Server',
    category: 'networking',
    what: 'Verifies the Machine Config Server is healthy by checking its pods and ClusterOperator status. Note: MCS port 22623 is not accessible from inside pods (node-only); this check uses pod/CO status instead.',
    covers: [
      'machine-config-server pods in openshift-machine-config-operator',
      'machine-config ClusterOperator status',
    ],
    ocCommand: 'oc get pods -n openshift-machine-config-operator\noc get co machine-config',
    manualSteps: [
      '1. oc get pods -n openshift-machine-config-operator',
      '2. machine-config-server-* pods should be Running',
      '3. oc get co machine-config — should show True False False',
      '4. From a cluster node only: curl -k https://<api-ip>:22623/config/worker',
    ],
    passCondition: 'MCS pods Running and machine-config CO is Available',
    failAction: 'Check `oc describe co machine-config`. Review MCS pod logs: `oc logs -n openshift-machine-config-operator <mcs-pod>`.',
  },

  // ── Storage ─────────────────────────────────────────────────────────────────
  {
    id: 'pvc_health',
    name: 'PVC and PV Health',
    category: 'storage',
    what: 'Checks all PersistentVolumeClaims across all namespaces are in Bound state.',
    covers: ['All PVCs in all namespaces', 'Storage binding status'],
    ocCommand: 'oc get pvc --all-namespaces',
    manualSteps: [
      '1. Run: oc get pvc -A',
      '2. STATUS should be Bound for all PVCs',
      '3. For Pending PVCs: oc describe pvc -n <ns> <name>',
      '4. Check available PVs: oc get pv',
      '5. Check storage class: oc get storageclass',
    ],
    passCondition: 'All PVCs in Bound state',
    failAction: 'Run `oc describe pvc <name>`. Check StorageClass, PV availability, and CSI driver status.',
  },

  // ── Security ────────────────────────────────────────────────────────────────
  {
    id: 'ssl_certificates',
    name: 'SSL Certificate Expiry',
    category: 'security',
    what: `Scans all kubernetes.io/tls secrets (excluding system namespaces) and flags any certificate expiring within the threshold (default 30 days).`,
    covers: [
      'All TLS secrets in user and platform namespaces',
      'Certificate expiry date extraction via ASN.1 parsing',
      'Excludes: openshift-kube-*, openshift-compliance, openshift-config-managed',
    ],
    ocCommand: "oc get secrets -A -o jsonpath='{range .items[?(@.type==\"kubernetes.io/tls\")]}{.metadata.namespace}{\"\\t\"}{.metadata.name}{\"\\n\"}{end}'",
    manualSteps: [
      '1. List TLS secrets: oc get secrets -A --field-selector=type=kubernetes.io/tls',
      '2. Check a specific cert: oc get secret -n <ns> <name> -o jsonpath=\'{.data.tls\\.crt}\' | base64 -d | openssl x509 -noout -enddate',
      '3. Find expiring certs (bash): for ns in $(oc get ns -o name | cut -d/ -f2); do oc get secrets -n $ns --field-selector=type=kubernetes.io/tls -o name 2>/dev/null; done',
    ],
    passCondition: `No TLS secrets expiring within threshold days`,
    failAction: 'Renew the expiring certificate. For OCP-managed certs, check the relevant operator (e.g., `oc get co`). For user certs, update the secret with a new cert/key pair.',
  },

  // ── Monitoring ──────────────────────────────────────────────────────────────
  {
    id: 'monitoring_stack',
    name: 'Monitoring Stack',
    category: 'monitoring',
    what: 'Verifies Prometheus, Alertmanager, and Thanos Querier pods in openshift-monitoring are Running.',
    covers: [
      'prometheus-k8s pods',
      'alertmanager-main pods',
      'thanos-querier pods',
      'prometheus-operator pods',
    ],
    ocCommand: 'oc get pods -n openshift-monitoring',
    manualSteps: [
      '1. Run: oc get pods -n openshift-monitoring',
      '2. All listed pods should be Running (RESTARTS count does not matter)',
      '3. Check Prometheus targets: open console → Observe → Targets',
      '4. Check Alertmanager: oc exec -n openshift-monitoring alertmanager-main-0 -- amtool alert list',
      '5. Check operator: oc get co monitoring',
    ],
    passCondition: 'All prometheus-k8s, alertmanager-main, thanos-querier, prometheus-operator pods Running',
    failAction: 'Check pod logs: `oc logs -n openshift-monitoring <pod>`. Review `oc get co monitoring`. Check PVC space for prometheus: `oc get pvc -n openshift-monitoring`.',
  },

  // ── Node Resource Limits ─────────────────────────────────────────────────────
  {
    id: 'node_limits',
    name: 'Node Resource Limits',
    category: 'nodes',
    what: 'Parses `oc describe node` for each node to extract CPU and memory request/limit percentages vs actual node capacity. Flags any node where CPU requests, CPU limits, memory requests, OR memory limits exceed 100% — indicating over-commitment that can cause evictions or OOM kills.',
    covers: [
      'CPU requests % of node allocatable CPU',
      'CPU limits % of node allocatable CPU',
      'Memory requests % of node allocatable memory',
      'Memory limits % of node allocatable memory',
    ],
    ocCommand: 'oc get nodes -o json\noc describe node <node-name>',
    manualSteps: [
      '1. Run: oc get nodes -o name | awk -F/ \'{print $2}\'',
      '2. For each node: oc describe node <node-name>',
      '3. Look at the "Allocated resources:" section',
      '4. Check cpu and memory rows — the % values show allocation vs capacity',
      '5. Any % > 100 means the node is over-committed',
      '6. Quick tabular view: oc adm top nodes',
    ],
    passCondition: 'All nodes: CPU req ≤ 100%, CPU lim ≤ 100%, Mem req ≤ 100%, Mem lim ≤ 100%',
    failAction: 'Identify which pods are consuming the most resources: `oc adm top pods -A --sort-by=cpu`. Consider adding nodes, adjusting pod resource requests/limits, or using LimitRange and ResourceQuota to enforce caps.',
  },

  // ── PDB Health ───────────────────────────────────────────────────────────────
  {
    id: 'pdb_health',
    name: 'PodDisruptionBudget Health',
    category: 'availability',
    what: 'Analyses all PodDisruptionBudgets in non-openshift namespaces. Calculates disruptionsAllowed and flags Blocked (0 disruptions) or Low-HA (<30%) PDBs. Mirrors the bash PDB checker script logic exactly.',
    covers: [
      'All PDBs in non-openshift namespaces',
      'minAvailable and maxUnavailable spec types',
      'disruptionsAllowed = currentHealthy - minAvailable (or maxUnavailable formula)',
      'Maintenance safety: how many pods can be disrupted without violating the PDB',
    ],
    ocCommand: 'oc get pdb -A -o json',
    manualSteps: [
      '1. Run: oc get pdb -A',
      '2. Check ALLOWED DISRUPTIONS column — 0 means blocked',
      '3. For detail: oc describe pdb -n <ns> <name>',
      '4. Check pod health: oc get pods -n <ns> -l <selector>',
      '5. minAvailable formula: disruptionsAllowed = currentHealthy - minAvailable',
      '6. maxUnavailable formula: disruptionsAllowed = maxUnavailable - (expectedPods - currentHealthy)',
    ],
    passCondition: 'All PDBs have disruptionsAllowed > 0 and disruptionsPercent >= 30%',
    failAction: 'For Blocked PDBs: check if unhealthy pods are reducing currentHealthy below minAvailable. Fix failing pods first. For Low-HA: consider increasing replica count or loosening the PDB spec.',
  },
];

/**
 * Get docs for a specific check by id, or all docs.
 */
function getDocs(checkId) {
  if (checkId) return DOCS.find(d => d.id === checkId) || null;
  return DOCS;
}

module.exports = { getDocs, DOCS };
