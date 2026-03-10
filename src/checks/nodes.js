'use strict';
/**
 * nodes.js
 * --------
 * Checks: node_readiness, node_cpu, node_memory, node_limits
 *
 * Enhancement-1: node_limits
 * Ports the bash `oc describe node` + awk script exactly:
 *   - Parses "Allocated resources:" block per node
 *   - Extracts CPU requests/limits in cores and %
 *   - Extracts memory requests/limits in GiB and %
 *   - Flags node as over-committed if any value > 100%
 * Exposes getNodeLimitRows() for the dashboard API.
 */

const { run } = require('../executor');

function pass(id, name, detail = '', raw = '') {
  return { id, name, category: 'nodes', status: 'Passed', detail, rawOutput: raw };
}
function fail(id, name, detail = '', raw = '') {
  return { id, name, category: 'nodes', status: 'Failed', detail, rawOutput: raw };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pct(s) { return parseInt((s || '0').replace(/[()%]/g, ''), 10); }

/** Convert millicores string → cores float string, or plain cores passthrough */
function toCores(s) {
  if (!s) return '0.00';
  if (s.endsWith('m')) return (parseInt(s, 10) / 1000).toFixed(2);
  return parseFloat(s).toFixed(2);
}

/** Convert memory quantity → GiB float string */
function toGiB(s) {
  if (!s) return '0.00';
  if (s.endsWith('Ki')) return (parseInt(s, 10) / 1048576).toFixed(2);
  if (s.endsWith('Mi')) return (parseInt(s, 10) / 1024).toFixed(2);
  if (s.endsWith('Gi')) return parseFloat(s).toFixed(2);
  if (s.endsWith('Ti')) return (parseFloat(s) * 1024).toFixed(2);
  return parseFloat(s).toFixed(2);
}

// ── Parse one node's describe output ─────────────────────────────────────────
// Mirrors the awk script: look for "Allocated resources:" then parse
// the cpu and memory lines that follow.
function parseNodeDescribe(text) {
  const lines   = text.split('\n');
  let capture   = false;
  const result  = {
    cpuReqCores: '0.00', cpuReqPct: 0,
    cpuLimCores: '0.00', cpuLimPct: 0,
    memReqGiB:  '0.00',  memReqPct: 0,
    memLimGiB:  '0.00',  memLimPct: 0,
  };

  for (const line of lines) {
    if (/Allocated resources:/.test(line)) { capture = true; continue; }
    if (!capture) continue;
    if (/^Events:/.test(line) || /^Conditions:/.test(line)) break;

    // cpu   1820m (24%)   6600m (88%)
    // cpu   1     (12%)   2     (25%)
    const cpu = line.match(/^\s{2}cpu\s+(\S+)\s+\((\d+)%\)\s+(\S+)\s+\((\d+)%\)/);
    if (cpu) {
      result.cpuReqCores = toCores(cpu[1]);
      result.cpuReqPct   = parseInt(cpu[2], 10);
      result.cpuLimCores = toCores(cpu[3]);
      result.cpuLimPct   = parseInt(cpu[4], 10);
      continue;
    }

    // memory   3890Mi (25%)   10760Mi (71%)
    const mem = line.match(/^\s{2}memory\s+(\S+)\s+\((\d+)%\)\s+(\S+)\s+\((\d+)%\)/);
    if (mem) {
      result.memReqGiB  = toGiB(mem[1]);
      result.memReqPct  = parseInt(mem[2], 10);
      result.memLimGiB  = toGiB(mem[3]);
      result.memLimPct  = parseInt(mem[4], 10);
      capture = false;    // done with this node
    }
  }
  return result;
}

// ── Shared state for API ──────────────────────────────────────────────────────
let _nodeLimitRows = [];
function getNodeLimitRows() { return _nodeLimitRows; }

// ── Check: Node Readiness ─────────────────────────────────────────────────────
async function nodeReadiness(cfg) {
  const id = 'node_readiness', name = cfg.name;
  try {
    const out   = await run(['get', 'nodes', '--no-headers']);
    const lines = out.trim().split('\n').filter(Boolean);
    const bad   = lines.filter(l => {
      const c = l.trim().split(/\s+/);
      return !c[1]?.includes('Ready') || c[1] === 'NotReady';
    });
    if (bad.length === 0) return pass(id, name, `All ${lines.length} node(s) Ready`, out);
    return fail(id, name, `${bad.length}/${lines.length} node(s) not Ready`, bad.join('\n'));
  } catch (e) { return fail(id, name, e.message, e.message); }
}

// ── Check: Node CPU (real-time) ───────────────────────────────────────────────
async function nodeCPU(cfg) {
  const id = 'node_cpu', name = cfg.name;
  const threshold = cfg.threshold || 80;
  try {
    const out   = await run(['adm', 'top', 'nodes', '--no-headers']);
    const lines = out.trim().split('\n').filter(Boolean);
    const bad   = lines.filter(l => {
      const c = l.trim().split(/\s+/);
      return parseInt((c[2] || '0').replace('%', ''), 10) > threshold;
    });
    if (bad.length === 0) return pass(id, name, `All nodes CPU below ${threshold}%`, out);
    return fail(id, name, `${bad.length} node(s) exceed ${threshold}% CPU`, out);
  } catch (e) {
    return fail(id, name, `metrics-server may not be available: ${e.message}`, e.message);
  }
}

// ── Check: Node Memory (real-time) ────────────────────────────────────────────
async function nodeMemory(cfg) {
  const id = 'node_memory', name = cfg.name;
  const threshold = cfg.threshold || 80;
  try {
    const out   = await run(['adm', 'top', 'nodes', '--no-headers']);
    const lines = out.trim().split('\n').filter(Boolean);
    const bad   = lines.filter(l => {
      const c = l.trim().split(/\s+/);
      return parseInt((c[4] || '0').replace('%', ''), 10) > threshold;
    });
    if (bad.length === 0) return pass(id, name, `All nodes memory below ${threshold}%`, out);
    return fail(id, name, `${bad.length} node(s) exceed ${threshold}% memory`, out);
  } catch (e) {
    return fail(id, name, `metrics-server may not be available: ${e.message}`, e.message);
  }
}

// ── Check: Node Resource Limits (allocated requests/limits vs capacity) ────────
// Enhancement-1: exact port of the bash awk script.
// For each node: parse `oc describe node` "Allocated resources" section.
// Fail if ANY metric (CPU req, CPU lim, mem req, mem lim) > 100%.
async function nodeResourceLimits(cfg) {
  const id   = 'node_limits';
  const name = cfg.name;
  try {
    // Get node names from JSON (robust — no awk needed)
    const nodesJson = await run(['get', 'nodes', '-o', 'json']);
    const nodeNames = JSON.parse(nodesJson).items.map(n => n.metadata.name);

    if (nodeNames.length === 0) return fail(id, name, 'No nodes found');

    const rows     = [];
    const overRows = [];

    for (const nodeName of nodeNames) {
      const desc   = await run(['describe', 'node', nodeName], 30000);
      const parsed = parseNodeDescribe(desc);

      const over = parsed.cpuReqPct > 100 || parsed.cpuLimPct > 100
                || parsed.memReqPct > 100 || parsed.memLimPct > 100;

      const row = { node: nodeName, ...parsed, over100: over };
      rows.push(row);
      if (over) overRows.push(nodeName);
    }

    // Cache for /api/nodes/limits
    _nodeLimitRows = rows;

    const rawLines = rows.map(r =>
      `${r.node.padEnd(50)} CPU-Req:${r.cpuReqCores}c(${r.cpuReqPct}%) ` +
      `CPU-Lim:${r.cpuLimCores}c(${r.cpuLimPct}%) ` +
      `Mem-Req:${r.memReqGiB}GiB(${r.memReqPct}%) ` +
      `Mem-Lim:${r.memLimGiB}GiB(${r.memLimPct}%)` +
      (r.over100 ? '  ⚠ OVER 100%' : '')
    );

    if (overRows.length === 0)
      return pass(id, name, `All ${rows.length} node(s) within resource limits`, rawLines.join('\n'));

    return fail(id, name,
      `${overRows.length} node(s) over-committed (>100%): ${overRows.join(', ')}`,
      rawLines.join('\n'));

  } catch (e) { return fail(id, name, e.message, e.message); }
}

const CHECKS = {
  node_readiness: nodeReadiness,
  node_cpu:       nodeCPU,
  node_memory:    nodeMemory,
  node_limits:    nodeResourceLimits,
};
module.exports = { CHECKS, getNodeLimitRows };
