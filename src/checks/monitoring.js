'use strict';
// monitoring.js – monitoring stack pod health

const { run } = require('../executor');
const { parsePods, isHealthy } = require('./podParser');

function pass(id, name, detail='', raw='') { return {id,name,category:'monitoring',status:'Passed',detail,rawOutput:raw}; }
function fail(id, name, detail='', raw='') { return {id,name,category:'monitoring',status:'Failed',detail,rawOutput:raw}; }

const MONITORED_PREFIXES = [
  'prometheus-k8s',
  'alertmanager-main',
  'thanos-querier',
  'prometheus-operator',
];

async function monitoringStack(cfg) {
  const id='monitoring_stack', name=cfg.name;
  try {
    const out = await run(['get','pods','-n','openshift-monitoring','--no-headers']);
    const pods = parsePods(out);

    const bad = pods.filter(p =>
      MONITORED_PREFIXES.some(prefix => p.name.startsWith(prefix)) &&
      !isHealthy(p.status)
    );

    if (bad.length === 0) return pass(id, name, `All monitoring pods healthy`, out);

    const detail = bad.map(p => `${p.name} → ${p.status}`).join(', ');
    return fail(id, name, `${bad.length} monitoring pod(s) not running: ${detail}`, bad.map(p=>`${p.name} ${p.status}`).join('\n'));
  } catch(e) { return fail(id,name,e.message,e.message); }
}

const CHECKS = { monitoring_stack: monitoringStack };
module.exports = { CHECKS };
