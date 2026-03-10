'use strict';
/**
 * pdb.js  –  PodDisruptionBudget health checker
 * Enhancement-3: exact port of the bash/jq script.
 *
 * Calculation (mirrors bash):
 *   minAvailable:   disruptionsAllowed = currentHealthy - minAvailable
 *   maxUnavailable: disruptionsAllowed = maxUnavailable - (expectedPods - currentHealthy)
 *   capped at 0 if negative
 *
 *   disruptionsPercent = floor((disruptionsAllowed / expectedPods) × 100 + 0.5)
 *
 * Color / category (mirrors bash):
 *   RED    = disruptionsAllowed == 0                        → Blocked
 *   ORANGE = disruptionsPercent > 0 && < 30                → Low-HA
 *   GREEN  = disruptionsPercent >= 30 && < 100             → Safe
 *   BLUE   = disruptionsPercent == 100                     → Full outage allowed
 *
 * Excludes namespaces starting with "openshift" (same as bash).
 * Exposes getPDBData() for the /api/pdb route.
 */

const { run } = require('../executor');

async function getPDBData() {
  const raw  = await run(['get', 'pdb', '-A', '-o', 'json'], 60000);
  const list = JSON.parse(raw);
  const items = (list.items || []).filter(
    p => !p.metadata.namespace.startsWith('openshift')
  );

  return items.map(item => {
    const ns       = item.metadata.namespace;
    const name     = item.metadata.name;
    const expected = item.status?.expectedPods   ?? 0;
    const healthy  = item.status?.currentHealthy ?? 0;
    const minAvail = item.spec?.minAvailable     ?? null;   // may be int or string
    const maxUnav  = item.spec?.maxUnavailable   ?? null;

    // Convert to numbers (they can be strings like "1" or ints)
    const minA = minAvail !== null ? Number(minAvail) : null;
    const maxU = maxUnav  !== null ? Number(maxUnav)  : null;

    let type, calc, formula;
    if (minA !== null) {
      calc    = healthy - minA;
      type    = 'minAvailable';
      formula = `currentHealthy(${healthy}) - minAvailable(${minA}) = ${calc}`;
    } else if (maxU !== null) {
      calc    = maxU - (expected - healthy);
      type    = 'maxUnavailable';
      formula = `maxUnavailable(${maxU}) - (expected(${expected}) - healthy(${healthy})) = ${calc}`;
    } else {
      calc    = 0;
      type    = 'none';
      formula = 'N/A';
    }

    const disruptionsAllowed = Math.max(0, calc);
    const disruptionsPercent = expected === 0
      ? 0
      : Math.floor((disruptionsAllowed / expected) * 100 + 0.5);

    let remark, color;
    if (expected === 0) {
      remark = 'N/A (no pods configured)';
      color  = 'grey';
    } else if (disruptionsAllowed === 0) {
      remark = `Blocked (${formula})`;
      color  = 'red';
    } else {
      remark = `OK (${formula})`;
      color  = disruptionsPercent === 100 ? 'blue'
             : disruptionsPercent  <   30 ? 'orange'
             : 'green';
    }

    return {
      ns, name, type, expected, healthy,
      disruptionsAllowed, disruptionsPercent,
      remark, color,
    };
  });
}

async function pdbHealth(cfg) {
  const id = 'pdb_health', name = cfg.name;
  try {
    const rows     = await getPDBData();
    const blocked  = rows.filter(r => r.color === 'red').length;
    const lowHA    = rows.filter(r => r.color === 'orange').length;
    const safe     = rows.filter(r => r.color === 'green').length;
    const fullOut  = rows.filter(r => r.color === 'blue').length;

    const detail =
      `${rows.length} PDBs — ${blocked} Blocked, ${lowHA} Low-HA, ` +
      `${safe} Safe, ${fullOut} Full-outage-allowed`;

    const rawOut = rows.map(r =>
      `[${r.color.toUpperCase().padEnd(6)}] ${r.ns}/${r.name}  ` +
      `disruptions:${r.disruptionsAllowed}(${r.disruptionsPercent}%)  ${r.remark}`
    ).join('\n');

    const status = (blocked > 0 || lowHA > 0) ? 'Failed' : 'Passed';
    return { id, name, category: 'availability', status, detail, rawOutput: rawOut };
  } catch (e) {
    return { id, name, category: 'availability', status: 'Error',
             detail: e.message, rawOutput: e.message };
  }
}

const CHECKS = { pdb_health: pdbHealth };
module.exports = { CHECKS, getPDBData };
