'use strict';
// storage.js – PVC/PV health check

const { run } = require('../executor');

function pass(id, name, detail='', raw='') { return {id,name,category:'storage',status:'Passed',detail,rawOutput:raw}; }
function fail(id, name, detail='', raw='') { return {id,name,category:'storage',status:'Failed',detail,rawOutput:raw}; }

async function pvcHealth(cfg) {
  const id='pvc_health', name=cfg.name;
  try {
    const out = await run(['get','pvc','--all-namespaces','--no-headers']);
    const lines = out.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return pass(id, name, 'No PVCs found');
    const bad = lines.filter(l => {
      const c = l.trim().split(/\s+/);
      // NAMESPACE NAME STATUS VOLUME CAPACITY ACCESS STORAGECLASS AGE
      return c[2] && c[2].toLowerCase() !== 'bound';
    });
    if (bad.length === 0) return pass(id, name, `All ${lines.length} PVC(s) Bound`);
    return fail(id, name, `${bad.length} PVC(s) not Bound`, bad.join('\n'));
  } catch(e) { return fail(id,name,e.message,e.message); }
}

const CHECKS = { pvc_health: pvcHealth };
module.exports = { CHECKS };
