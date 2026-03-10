'use strict';
// pods.js – platform and non-platform pod status checks

const { run } = require('../executor');
const { parsePods, isHealthy } = require('./podParser');

function pass(id, name, detail='', raw='') { return {id,name,category:'pods',status:'Passed',detail,rawOutput:raw}; }
function fail(id, name, detail='', raw='') { return {id,name,category:'pods',status:'Failed',detail,rawOutput:raw}; }

const PLATFORM_RE = /^(openshift-|kube-)/;

async function getAllPods() {
  const out = await run(['get','pods','--all-namespaces','--no-headers']);
  // all-namespaces adds NAMESPACE as first column: NAMESPACE NAME READY STATUS RESTARTS AGE
  const lines = out.trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) return null;
    const namespace = parts[0];
    // Re-use podParser on the remainder (NAME READY STATUS RESTARTS AGE)
    const { parsePodLine } = require('./podParser');
    const pod = parsePodLine(parts.slice(1).join(' '));
    if (!pod) return null;
    return { namespace, ...pod };
  }).filter(Boolean);
}

// ── Check: Platform Namespace Pods ───────────────────────────────────────────
async function platformPods(cfg) {
  const id = 'platform_pods', name = cfg.name;
  try {
    const pods = await getAllPods();
    const bad  = pods.filter(p => PLATFORM_RE.test(p.namespace) && !isHealthy(p.status));
    if (bad.length === 0) return pass(id, name, 'All platform pods healthy');
    const detail = bad.map(p => `${p.namespace}/${p.name} → ${p.status}`).join(', ');
    return fail(id, name, `${bad.length} platform pod(s) not running`, bad.map(p=>`${p.namespace} ${p.name} ${p.status}`).join('\n'));
  } catch(e) { return fail(id,name,e.message,e.message); }
}

// ── Check: Non-Platform Pods ──────────────────────────────────────────────────
async function nonPlatformPods(cfg) {
  const id = 'non_platform_pods', name = cfg.name;
  try {
    const pods = await getAllPods();
    const bad  = pods.filter(p => !PLATFORM_RE.test(p.namespace) && !isHealthy(p.status));
    if (bad.length === 0) return pass(id, name, 'All application pods healthy');
    const detail = bad.map(p => `${p.namespace}/${p.name} → ${p.status}`).join(', ');
    return fail(id, name, `${bad.length} application pod(s) not running`, bad.map(p=>`${p.namespace} ${p.name} ${p.status}`).join('\n'));
  } catch(e) { return fail(id,name,e.message,e.message); }
}

const CHECKS = { platform_pods: platformPods, non_platform_pods: nonPlatformPods };
module.exports = { CHECKS };
