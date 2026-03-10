'use strict';

/**
 * executor.js
 * -----------
 * Thin wrapper around the `oc` CLI binary.
 * When MOCK_MODE=true it returns canned responses so the server
 * can be developed and tested without a live cluster.
 *
 * The pod's ServiceAccount token is automatically picked up by `oc`
 * because we set --token and --server from the in-cluster env vars,
 * falling back to the token file at the standard SA mount path.
 */

const { execFile } = require('child_process');
const path = require('path');
const logger = require('./logger');

const MOCK_MODE  = process.env.MOCK_MODE === 'true';
const OC_BIN     = process.env.OC_BIN    || '/usr/local/bin/oc';
const SA_TOKEN   = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_CERT    = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const K8S_HOST   = process.env.KUBERNETES_SERVICE_HOST || 'kubernetes.default.svc';
const K8S_PORT   = process.env.KUBERNETES_SERVICE_PORT || '443';
const API_SERVER = process.env.API_URL || `https://${K8S_HOST}:${K8S_PORT}`;

/**
 * Run an `oc` command and return stdout as a string.
 * @param {string[]} args  – arguments after `oc`, e.g. ['get','nodes','--no-headers']
 * @param {number}   [timeout=30000] – ms before the command is killed
 * @returns {Promise<string>}
 */
/**
 * Run an `oc` command and return stdout as a string.
 * @param {string[]} args        – arguments after `oc`
 * @param {number}   [timeout=30000]    – ms before the command is killed
 * @param {number}   [maxBuffer=10MB]   – max stdout bytes (increase for large outputs)
 */
function run(args, timeout = 30000, maxBuffer = 10 * 1024 * 1024) {
  if (MOCK_MODE) return mockRun(args);

  return new Promise((resolve, reject) => {
    const fs = require('fs');
    let token = '';
    try { token = fs.readFileSync(SA_TOKEN, 'utf8').trim(); } catch (_) {}

    const fullArgs = [
      `--server=${API_SERVER}`,
      `--certificate-authority=${CA_CERT}`,
      ...(token ? [`--token=${token}`] : []),
      ...args
    ];

    logger.debug(`oc ${fullArgs.filter(a => !a.startsWith('--token')).join(' ')}`);

    execFile(OC_BIN, fullArgs, { timeout, maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        logger.warn(`oc error: ${stderr || err.message}`);
        return reject(new Error(stderr || err.message));
      }
      resolve(stdout);
    });
  });
}

// ── Mock responses for local development / CI ─────────────────────────────────
function mockRun(args) {
  const cmd = args.join(' ');
  logger.debug(`[MOCK] oc ${cmd}`);

  const MOCK_DATA = {
    'get co --no-headers': `
authentication                             4.13.0    True        False         False      2d
baremetal                                  4.13.0    True        False         False      2d
cloud-credential                           4.13.0    True        False         False      2d
cluster-autoscaler                         4.13.0    True        False         False      2d
console                                    4.13.0    True        False         False      2d
dns                                        4.13.0    True        False         False      2d
etcd                                       4.13.0    True        False         False      2d
ingress                                    4.13.0    True        False         False      2d
kube-apiserver                             4.13.0    True        False         False      2d
kube-controller-manager                    4.13.0    True        False         False      2d
kube-scheduler                             4.13.0    True        False         False      2d
machine-api                                4.13.0    True        False         False      2d
monitoring                                 4.13.0    True        False         False      2d
network                                    4.13.0    True        False         False      2d
node-tuning                                4.13.0    True        False         False      2d
openshift-apiserver                        4.13.0    True        False         False      2d
openshift-controller-manager              4.13.0    True        False         False      2d
openshift-samples                          4.13.0    True        False         False      2d
operator-lifecycle-manager                 4.13.0    True        False         False      2d
storage                                    4.13.0    True        False         False      2d`.trim(),

    'get nodes --no-headers': `
master-0   Ready    control-plane,master   2d    v1.26.3
master-1   Ready    control-plane,master   2d    v1.26.3
master-2   Ready    control-plane,master   2d    v1.26.3
worker-0   Ready    worker                 2d    v1.26.3
worker-1   Ready    worker                 2d    v1.26.3
worker-2   Ready    worker                 2d    v1.26.3`.trim(),

    'adm top nodes --no-headers': `
master-0   452m    24%    3541Mi   46%
master-1   389m    21%    3120Mi   41%
master-2   412m    22%    3280Mi   43%
worker-0   620m    33%    4200Mi   55%
worker-1   580m    31%    3900Mi   51%
worker-2   540m    29%    3600Mi   47%`.trim(),

    'get mcp --no-headers': `
master   rendered-master-abc   True    False   False   3   3   3     2d
worker   rendered-worker-def   True    False   False   3   3   3     2d`.trim(),

    'get clusterversion --no-headers': `
version   4.13.0   True    False    2d   Cluster version is 4.13.0`.trim(),

    'get pvc --all-namespaces --no-headers': `
monitoring          prometheus-k8s-db-prometheus-k8s-0   Bound    pvc-abc   40Gi       2d
monitoring          prometheus-k8s-db-prometheus-k8s-1   Bound    pvc-def   40Gi       2d
logging             elasticsearch-elasticsearch-cdm-0     Bound    pvc-ghi   200Gi      2d`.trim(),

    'get pods --all-namespaces --no-headers': buildMockPods(),
    'get pods -n openshift-etcd --no-headers': `
etcd-master-0   4/4   Running   0   2d
etcd-master-1   4/4   Running   0   2d
etcd-master-2   4/4   Running   0   2d`.trim(),
    'get pods -n openshift-authentication --no-headers': `
oauth-openshift-6d4b9f7c8-4xkzp   1/1   Running   0   2d
oauth-openshift-6d4b9f7c8-9mnjr   1/1   Running   0   2d`.trim(),
    'get pods -n openshift-monitoring --no-headers': `
alertmanager-main-0                      2/2   Running   0   2d
alertmanager-main-1                      2/2   Running   0   2d
prometheus-k8s-0                         6/6   Running   0   2d
prometheus-k8s-1                         6/6   Running   0   2d
prometheus-operator-5d9b4b7d8d-xzpqr    2/2   Running   0   2d
thanos-querier-7f8c9d6b5-abc12          6/6   Running   0   2d`.trim(),
    'get pods -n openshift-kube-apiserver --no-headers': `
kube-apiserver-master-0   5/5   Running   0   2d
kube-apiserver-master-1   5/5   Running   0   2d
kube-apiserver-master-2   5/5   Running   0   2d`.trim(),
    'get pods -n openshift-kube-scheduler --no-headers': `
openshift-kube-scheduler-master-0   3/3   Running   0   2d
openshift-kube-scheduler-master-1   3/3   Running   0   2d
openshift-kube-scheduler-master-2   3/3   Running   0   2d`.trim(),
    'get pods -n openshift-kube-controller-manager --no-headers': `
kube-controller-manager-master-0   5/5   Running   0   2d
kube-controller-manager-master-1   5/5   Running   0   2d
kube-controller-manager-master-2   5/5   Running   0   2d`.trim(),
    'get nodes -o json': JSON.stringify({
      items: [
        { metadata: { name: 'master-0' } },
        { metadata: { name: 'master-1' } },
        { metadata: { name: 'master-2' } },
        { metadata: { name: 'worker-0' } },
        { metadata: { name: 'worker-1' } },
      ]
    }),
    'describe node master-0': buildMockDescribeNode('master-0', '1820m', '24%', '6600m', '88%', '3890Mi', '25%', '10760Mi', '71%'),
    'describe node master-1': buildMockDescribeNode('master-1', '1600m', '21%', '5800m', '77%', '3500Mi', '22%', '9800Mi', '64%'),
    'describe node master-2': buildMockDescribeNode('master-2', '1700m', '22%', '6000m', '80%', '3700Mi', '24%', '10200Mi', '67%'),
    'describe node worker-0': buildMockDescribeNode('worker-0', '4200m', '55%', '8000m', '105%', '8000Mi', '52%', '14000Mi', '92%'),
    'describe node worker-1': buildMockDescribeNode('worker-1', '3800m', '50%', '7200m', '95%', '7400Mi', '48%', '13000Mi', '85%'),
    'whoami': 'system:serviceaccount:ocp-health-dashboard:ocp-health-sa',
    'get secrets --all-namespaces -o go-template': buildMockSSLCerts(),
    'get pdb -A -o json': JSON.stringify({
      items: [
        { metadata: { namespace: 'production', name: 'api-pdb' },
          spec: { minAvailable: 2 },
          status: { expectedPods: 3, currentHealthy: 3 } },
        { metadata: { namespace: 'production', name: 'worker-pdb' },
          spec: { maxUnavailable: 1 },
          status: { expectedPods: 2, currentHealthy: 2 } },
        { metadata: { namespace: 'staging', name: 'frontend-pdb' },
          spec: { minAvailable: 1 },
          status: { expectedPods: 1, currentHealthy: 1 } },
        { metadata: { namespace: 'openshift-ingress', name: 'router-pdb' },
          spec: { minAvailable: 1 },
          status: { expectedPods: 2, currentHealthy: 2 } },
      ]
    }),

    'whoami --show-console': 'https://console-openshift-console.apps.mock-cluster.example.com',
    'version --client': 'Client Version: 4.13.0\nKustomize Version: v4.5.7',
  };

  // find best matching mock
  for (const [pattern, response] of Object.entries(MOCK_DATA)) {
    if (cmd.includes(pattern)) return Promise.resolve(response);
  }

  // default: empty (pass)
  return Promise.resolve('');
}

function buildMockSSLCerts() {
  // Simulate EXACT go-template output using ||| delimiter:
  //   "NS NAME BASE64_OF_PEM|||NS NAME BASE64_OF_PEM|||..."
  //
  // Kubernetes .data.tls.crt encoding chain:
  //   DER bytes → PEM (base64 + headers) → base64(PEM) = what's stored
  // go-template prints the stored value = base64(PEM_TEXT)
  function makeSecretValue(nbYY, nbMM, nbDD, naYY, naMM, naDD) {
    // Build minimal DER with correct UTCTime validity
    function utctime(yr, mo, da) {
      const yy = String(yr % 100).padStart(2, '0');
      const s  = yy + String(mo).padStart(2,'0') + String(da).padStart(2,'0') + '120000Z';
      return Buffer.from([0x17, 0x0d, ...Buffer.from(s, 'ascii')]);
    }
    const nb       = utctime(nbYY, nbMM, nbDD);
    const na       = utctime(naYY, naMM, naDD);
    const validity = Buffer.concat([Buffer.from([0x30, nb.length + na.length]), nb, na]);
    const der      = Buffer.concat([Buffer.alloc(60, 0xAA), validity, Buffer.alloc(20, 0xBB)]);
    // PEM-encode (64-char line wrap, as openssl does)
    const b64der = der.toString('base64').match(/.{1,64}/g).join('\n');
    const pem    = '-----BEGIN CERTIFICATE-----\n' + b64der + '\n-----END CERTIFICATE-----\n';
    // Outer base64 = what Kubernetes stores in .data.tls.crt
    return Buffer.from(pem).toString('base64');
  }

  const rows = [
    // [ns, name, nbYY,Mo,Da,  naYY,Mo,Da]
    ['open-cluster-management-hub', 'registration-webhook-serving-cert', 2026,3,6,  2026,4,5],
    ['open-cluster-management-hub', 'work-webhook-serving-cert',         2026,3,6,  2026,4,5],
    ['openshift-compliance',        'result-client-cert-ocp4-cis',       2026,3,10, 2026,3,11],
    ['openshift-compliance',        'result-server-cert-ocp4-cis',       2026,3,10, 2026,3,11],
    ['openshift-kube-apiserver',    'aggregator-client',                  2026,3,3,  2026,4,1],
    ['openshift-kube-apiserver',    'kubelet-client',                     2026,3,2,  2026,4,1],
    ['my-app',                      'ingress-tls-cert',                   2024,1,1,  2027,6,30],
    ['my-app',                      'api-serving-cert',                   2023,6,1,  2026,12,31],
    ['production',                  'db-cert',                            2024,6,1,  2025,12,31],
    ['monitoring',                  'grafana-tls',                        2024,1,1,  2028,1,1],
  ];

  return rows
    .map(([ns, name, nbYY, nbMM, nbDD, naYY, naMM, naDD]) =>
      `${ns} ${name} ${makeSecretValue(nbYY, nbMM, nbDD, naYY, naMM, naDD)}`)
    .join('|||') + '|||';
}

function buildMockDescribeNode(name, cpuReq, cpuReqPct, cpuLim, cpuLimPct, memReq, memReqPct, memLim, memLimPct) {
  return `Name: ${name}
Roles: worker
Allocated resources:
  (Total limits may be over 100 percent, i.e., overcommitted.)
  Resource           Requests      Limits
  --------           --------      ------
  cpu                ${cpuReq} (${cpuReqPct})  ${cpuLim} (${cpuLimPct})
  memory             ${memReq} (${memReqPct})   ${memLim} (${memLimPct})
  ephemeral-storage  0 (0%)         0 (0%)
Events: <none>`;
}

function buildMockPods() {
  const lines = [];
  ['openshift-dns','openshift-ingress','openshift-image-registry','kube-system'].forEach(ns => {
    lines.push(`${ns}   some-pod-abc   1/1   Running   0   2d`);
  });
  lines.push(`my-app   frontend-abc   1/1   Running     0   2d`);
  lines.push(`my-app   backend-def    0/1   CrashLoopBackOff   5   1h`);
  return lines.join('\n');
}

module.exports = { run };
