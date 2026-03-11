'use strict';
/**
 * resourcequota.js — Cluster Resource Allocation report
 *
 * STORAGE CLASS DISCOVERY — fully automatic, zero config required
 * ───────────────────────────────────────────────────────────────
 * 1. All ResourceQuota .spec.hard keys are scanned for:
 *      <scname>.storageclass.storage.k8s.io/requests.storage
 *      <scname>.storageclass.storage.k8s.io/persistentvolumeclaims
 * 2. The union of SC names found across all quotas becomes the column set.
 * 3. Adding a new SC to any quota auto-adds it to the report on next refresh.
 * 4. Each SC gets TWO columns: Storage (GiB) and PVC count.
 *
 * ConfigMap keys (ocp-health-rq-config):
 *   RQ_SKIP_NAMESPACES — comma-separated namespace prefixes to exclude
 *                        (default: openshift-,kube-,default)
 */

const { run } = require('../executor');
const logger  = require('../logger');

function env(k, d) { const v = process.env[k]; return (v !== undefined && v !== '') ? v : d; }

function getSkipPrefixes() {
  return env('RQ_SKIP_NAMESPACES', 'openshift-,kube-,default')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// ── Unit converters ───────────────────────────────────────────────────────
function cpuToMillicores(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (s.endsWith('m')) return parseInt(s, 10);
  return Math.round(parseFloat(s) * 1000);
}
function memToMiB(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (s.endsWith('Gi')) return parseInt(s, 10) * 1024;
  if (s.endsWith('Mi')) return parseInt(s, 10);
  if (s.endsWith('Ki')) return Math.round(parseInt(s, 10) / 1024);
  if (s.endsWith('G'))  return parseInt(s, 10) * 1024;
  if (s.endsWith('M'))  return parseInt(s, 10);
  if (s.endsWith('K'))  return Math.round(parseInt(s, 10) / 1024);
  return parseInt(s, 10) || 0;
}
function storageToGiB(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (s.endsWith('Ti')) return parseInt(s, 10) * 1024;
  if (s.endsWith('Gi')) return parseInt(s, 10);
  if (s.endsWith('Mi')) return parseFloat((parseInt(s, 10) / 1024).toFixed(3));
  if (s.endsWith('Ki')) return parseFloat((parseInt(s, 10) / (1024 * 1024)).toFixed(6));
  if (s.endsWith('T'))  return parseInt(s, 10) * 1024;
  if (s.endsWith('G'))  return parseInt(s, 10);
  if (s.endsWith('M'))  return parseFloat((parseInt(s, 10) / 1024).toFixed(3));
  return parseInt(s, 10) || 0;
}

// ── SC key helpers ────────────────────────────────────────────────────────
// These two functions produce the exact ResourceQuota .spec.hard field names.
function scStorageKey(scName) { return `${scName}.storageclass.storage.k8s.io/requests.storage`; }
function scPVCKey(scName)     { return `${scName}.storageclass.storage.k8s.io/persistentvolumeclaims`; }

// ── SC discovery: scan quota keys for SC references ───────────────────────
const SC_KEY_RE = /^([^.]+(?:\.[^/]+)*)\.storageclass\.storage\.k8s\.io\/(requests\.storage|persistentvolumeclaims)$/;

function extractSCNamesFromQuotas(allQuotas) {
  const found = new Set();
  for (const q of allQuotas) {
    const hard = (q.spec && q.spec.hard) || (q.status && q.status.hard) || {};
    for (const key of Object.keys(hard)) {
      const m = key.match(SC_KEY_RE);
      if (m) found.add(m[1]);
    }
  }
  return [...found].sort();
}

// ── Report 1: Node capacity ────────────────────────────────────────────────
async function getNodeRows() {
  const json  = await run(['get', 'nodes', '-o', 'json'], 30000);
  const nodes = JSON.parse(json).items || [];
  return nodes.map(n => {
    const labels   = n.metadata.labels || {};
    const addr     = (n.status.addresses || []).find(a => a.type === 'InternalIP');
    const isMaster = n.metadata.name.includes('master') ||
      labels['node-role.kubernetes.io/master'] !== undefined ||
      labels['node-role.kubernetes.io/control-plane'] !== undefined;
    const ready = (n.status.conditions || []).find(c => c.type === 'Ready');
    return {
      name:              n.metadata.name,
      ip:                addr ? addr.address : '—',
      role:              isMaster ? 'Master' : 'Worker',
      status:            ready && ready.status === 'True' ? 'Ready' : 'NotReady',
      capacityCpuCores:  String(n.status.capacity    ? n.status.capacity.cpu    : '0'),
      capacityMemMiB:    memToMiB(n.status.capacity  ? n.status.capacity.memory : '0'),
      allocatableCpuM:   cpuToMillicores(n.status.allocatable ? n.status.allocatable.cpu    : '0'),
      allocatableMemMiB: memToMiB(n.status.allocatable ? n.status.allocatable.memory : '0'),
    };
  });
}

// ── Report 2: ResourceQuota rows ──────────────────────────────────────────
async function getQuotaData() {
  const skipPrefixes = getSkipPrefixes();
  const [nsJson, rqJson] = await Promise.all([
    run(['get', 'namespaces', '-o', 'json'], 30000),
    run(['get', 'resourcequota', '--all-namespaces', '-o', 'json'], 60000).catch(e => {
      logger.warn(`ResourceQuota list error: ${e.message}`);
      return '{"items":[]}';
    }),
  ]);

  const allNs = (JSON.parse(nsJson).items || [])
    .map(n => n.metadata.name)
    .filter(n => !skipPrefixes.some(p => n.startsWith(p)));

  const allQuotas = JSON.parse(rqJson).items || [];

  // ── Dynamic SC discovery ──────────────────────────────────────────────
  const usedSCNames = extractSCNamesFromQuotas(allQuotas);
  logger.info(`ResourceQuota: discovered ${usedSCNames.length} SC(s) in quotas: [${usedSCNames.join(', ')}]`);

  const byNs = {};
  allQuotas.forEach(q => {
    const ns = q.metadata.namespace;
    if (!byNs[ns]) byNs[ns] = [];
    byNs[ns].push(q);
  });

  const rows = [];
  for (const ns of allNs) {
    const quotas = byNs[ns] || [];
    if (quotas.length === 0) {
      const scFields = {};
      usedSCNames.forEach(sc => { scFields[scStorageKey(sc)] = 0; scFields[scPVCKey(sc)] = 0; });
      rows.push({ namespace:ns, quotaName:'N/A', cpuReqM:0, cpuLimM:0, memReqMiB:0, memLimMiB:0, hasQuota:false, ...scFields });
      continue;
    }
    for (const q of quotas) {
      // Use .spec.hard — the quota definition — prefer over .status.hard
      const hard = (q.spec && q.spec.hard) || (q.status && q.status.hard) || {};
      const scFields = {};
      for (const sc of usedSCNames) {
        scFields[scStorageKey(sc)] = storageToGiB(hard[scStorageKey(sc)] || '');
        scFields[scPVCKey(sc)]     = hard[scPVCKey(sc)] ? parseInt(hard[scPVCKey(sc)], 10) : 0;
      }
      rows.push({
        namespace: ns,
        quotaName: q.metadata.name,
        cpuReqM:   cpuToMillicores(hard['requests.cpu']    || hard['cpu']    || ''),
        cpuLimM:   cpuToMillicores(hard['limits.cpu']      || ''),
        memReqMiB: memToMiB(hard['requests.memory'] || hard['memory'] || ''),
        memLimMiB: memToMiB(hard['limits.memory']   || ''),
        hasQuota:  true,
        ...scFields,
      });
    }
  }
  return { rows, usedSCNames };
}

// ── Report 3: Summary ─────────────────────────────────────────────────────
function buildSummary(nodeRows, quotaRows, usedSCNames) {
  const workers = nodeRows.filter(n => n.role === 'Worker' && n.status === 'Ready');
  const withRQ  = quotaRows.filter(r => r.hasQuota);

  const totalAllocCpuM   = workers.reduce((s, n) => s + n.allocatableCpuM,   0);
  const totalAllocMemMiB = workers.reduce((s, n) => s + n.allocatableMemMiB, 0);
  const totalRqCpuM      = withRQ.reduce((s, r) => s + r.cpuReqM,   0);
  const totalRqMemMiB    = withRQ.reduce((s, r) => s + r.memReqMiB, 0);

  const storageTotals = {};
  usedSCNames.forEach(sc => {
    const sk = scStorageKey(sc), pk = scPVCKey(sc);
    storageTotals[sk] = withRQ.reduce((s, r) => s + (r[sk] || 0), 0);
    storageTotals[pk] = withRQ.reduce((s, r) => s + (r[pk] || 0), 0);
  });

  return {
    workerCount:     workers.length,
    masterCount:     nodeRows.filter(n => n.role === 'Master').length,
    totalAllocCpuM,  totalAllocMemMiB,
    totalRqCpuM,     totalRqMemMiB,
    freeCpuM:        totalAllocCpuM  - totalRqCpuM,
    freeMemMiB:      totalAllocMemMiB - totalRqMemMiB,
    cpuUtilPct:      totalAllocCpuM  > 0 ? Math.round(totalRqCpuM   / totalAllocCpuM   * 100) : 0,
    memUtilPct:      totalAllocMemMiB > 0 ? Math.round(totalRqMemMiB / totalAllocMemMiB * 100) : 0,
    storageTotals,
    nsTotal:         quotaRows.length,
    nsWithQuota:     new Set(withRQ.map(r => r.namespace)).size,
    nsWithoutQuota:  quotaRows.filter(r => !r.hasQuota).length,
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────
let _cache = null, _cacheTime = 0;
const CACHE_SECS = 300;

async function getAllQuotaData(force = false) {
  if (!force && _cache && (Date.now() - _cacheTime) < CACHE_SECS * 1000) {
    logger.debug('ResourceQuota: returning cached result');
    return _cache;
  }
  const t0 = Date.now();
  logger.info('ResourceQuota: fetching (dynamic SC discovery)');
  const [nodeRows, { rows: quotaRows, usedSCNames }] = await Promise.all([
    getNodeRows(),
    getQuotaData(),
  ]);
  const summary = buildSummary(nodeRows, quotaRows, usedSCNames);
  const result  = { fetchedAt:new Date().toISOString(), durationMs:Date.now()-t0, usedSCNames, nodeRows, quotaRows, summary };
  _cache = result; _cacheTime = Date.now();
  logger.info(`ResourceQuota: ${nodeRows.length} nodes, ${quotaRows.length} ns rows, ${usedSCNames.length} SCs in ${result.durationMs}ms`);
  return result;
}

// ── Mock data  ────────────────────────────────────────────────────────────
// Mirrors the exact example from the user (gp2-csi, gp3-csi, manual)
function getMockQuotaData() {
  const usedSCNames = ['gp2-csi', 'gp3-csi', 'manual'];
  const nodeRows = [
    { name:'master-0', ip:'10.0.0.1', role:'Master', status:'Ready', capacityCpuCores:'8',  capacityMemMiB:32768, allocatableCpuM:7500,  allocatableMemMiB:30720 },
    { name:'master-1', ip:'10.0.0.2', role:'Master', status:'Ready', capacityCpuCores:'8',  capacityMemMiB:32768, allocatableCpuM:7500,  allocatableMemMiB:30720 },
    { name:'master-2', ip:'10.0.0.3', role:'Master', status:'Ready', capacityCpuCores:'8',  capacityMemMiB:32768, allocatableCpuM:7500,  allocatableMemMiB:30720 },
    { name:'worker-0', ip:'10.0.1.1', role:'Worker', status:'Ready', capacityCpuCores:'16', capacityMemMiB:65536, allocatableCpuM:15000, allocatableMemMiB:63488 },
    { name:'worker-1', ip:'10.0.1.2', role:'Worker', status:'Ready', capacityCpuCores:'16', capacityMemMiB:65536, allocatableCpuM:15000, allocatableMemMiB:63488 },
    { name:'worker-2', ip:'10.0.1.3', role:'Worker', status:'Ready', capacityCpuCores:'16', capacityMemMiB:65536, allocatableCpuM:15000, allocatableMemMiB:63488 },
    { name:'worker-3', ip:'10.0.1.4', role:'Worker', status:'NotReady', capacityCpuCores:'16', capacityMemMiB:65536, allocatableCpuM:0, allocatableMemMiB:0 },
  ];
  function mkRow(ns, qn, cpuReqM, cpuLimM, memReqMiB, memLimMiB, stor) {
    const r = { namespace:ns, quotaName:qn, cpuReqM, cpuLimM, memReqMiB, memLimMiB, hasQuota:true };
    usedSCNames.forEach(sc => { r[scStorageKey(sc)] = stor[sc]?stor[sc][0]:0; r[scPVCKey(sc)] = stor[sc]?stor[sc][1]:0; });
    return r;
  }
  const quotaRows = [
    mkRow('demo-app',     'storage-and-compute-quota', 8000,12000,16384,32768, {'gp2-csi':[50,5],  'gp3-csi':[300,10],'manual':[20,2]}),
    mkRow('production',   'prod-quota',                8000,12000,16384,32768, {'gp2-csi':[100,10],'gp3-csi':[500,20],'manual':[0,0]}),
    mkRow('staging',      'staging-quota',             4000,6000,  8192,16384, {'gp2-csi':[50,5],  'gp3-csi':[200,8], 'manual':[10,1]}),
    mkRow('dev-team-a',   'dev-a-quota',               2000,4000,  4096, 8192, {'gp2-csi':[20,3],  'gp3-csi':[100,5], 'manual':[0,0]}),
    mkRow('dev-team-b',   'dev-b-quota',               2000,4000,  4096, 8192, {'gp2-csi':[20,3],  'gp3-csi':[100,5], 'manual':[0,0]}),
    mkRow('data-pipeline','dp-quota',                  6000,8000, 12288,24576, {'gp2-csi':[0,0],   'gp3-csi':[1000,15],'manual':[0,0]}),
    { namespace:'sandbox', quotaName:'N/A', cpuReqM:0, cpuLimM:0, memReqMiB:0, memLimMiB:0, hasQuota:false,
      ...usedSCNames.reduce((a,sc)=>{ a[scStorageKey(sc)]=0; a[scPVCKey(sc)]=0; return a; }, {}) },
  ];
  const summary = buildSummary(nodeRows, quotaRows, usedSCNames);
  return { fetchedAt:new Date().toISOString(), durationMs:287, usedSCNames, nodeRows, quotaRows, summary };
}

module.exports = { getAllQuotaData, getMockQuotaData };
