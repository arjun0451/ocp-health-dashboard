'use strict';
/**
 * controlPlane.js
 * ---------------
 * Checks: cluster_operators, cluster_version, machine_config_pool,
 *         etcd_health, authentication, control_plane_pods
 *
 * Bug fixes:
 *  - control_plane_pods: installer-* and revision-pruner-* pods are
 *    short-lived jobs; Error/Completed on them is normal. Filtered out.
 *  - etcd_health: uses `oc exec` into etcd pod to run etcdctl, matching
 *    the original bash script behaviour instead of just checking pod phase.
 */

const { run } = require('../executor');
const { parsePods, isHealthy } = require('./podParser');

function pass(id, name, detail='', raw='') { return {id,name,category:'control_plane',status:'Passed',detail,rawOutput:raw}; }
function fail(id, name, detail='', raw='') { return {id,name,category:'control_plane',status:'Failed',detail,rawOutput:raw}; }

// Pods whose Error/Completed status is expected and should NOT trigger failure
const IGNORABLE_PREFIXES = [
  'installer-',          // OCP installer jobs (complete then stay as Error/Completed)
  'revision-pruner-',    // revision cleanup jobs
  'etcd-quorum-guard',   // static pod guard, not a health indicator
  'guard-',
];

function isIgnorablePod(name) {
  return IGNORABLE_PREFIXES.some(p => name.startsWith(p));
}

// ── Cluster Operators ─────────────────────────────────────────────────────────
async function clusterOperators(cfg) {
  const id='cluster_operators', name=cfg.name;
  try {
    const out = await run(['get','co','--no-headers']);
    const lines = out.trim().split('\n').filter(Boolean);
    const failing = lines.filter(line => {
      const c = line.trim().split(/\s+/);
      // NAME VERSION AVAILABLE PROGRESSING DEGRADED AGE
      return c[2] !== 'True' || c[3] !== 'False' || c[4] !== 'False';
    });
    if (failing.length === 0) return pass(id, name, `All ${lines.length} operators healthy`);
    return fail(id, name, `${failing.length} operator(s) not healthy`, failing.join('\n'));
  } catch(e) { return fail(id,name,e.message,e.message); }
}

// ── Cluster Version ───────────────────────────────────────────────────────────
async function clusterVersion(cfg) {
  const id='cluster_version', name=cfg.name;
  try {
    const out = await run(['get','clusterversion','--no-headers']);
    const lines = out.trim().split('\n').filter(Boolean);
    const bad = lines.filter(l => { const c=l.trim().split(/\s+/); return c[2]!=='True'||c[3]!=='False'; });
    if (bad.length === 0) {
      const ver = lines[0]?.trim().split(/\s+/)[1] || '';
      return pass(id, name, `Version: ${ver}`);
    }
    return fail(id, name, 'ClusterVersion not healthy', bad.join('\n'));
  } catch(e) { return fail(id,name,e.message,e.message); }
}

// ── MachineConfigPool ─────────────────────────────────────────────────────────
async function machineConfigPool(cfg) {
  const id='machine_config_pool', name=cfg.name;
  try {
    const out = await run(['get','mcp','--no-headers']);
    const bad = out.trim().split('\n').filter(Boolean).filter(l => {
      const c = l.trim().split(/\s+/);
      return c[2] !== 'True' || c[3] !== 'False';
    });
    if (bad.length === 0) return pass(id, name);
    return fail(id, name, `${bad.length} MCP(s) degraded or not updated`, bad.join('\n'));
  } catch(e) { return fail(id,name,e.message,e.message); }
}

// ── Etcd Health ───────────────────────────────────────────────────────────────
// Mirrors the original bash script: exec into a running etcd pod and run
// `etcdctl endpoint health --cluster`, then check for any unhealthy lines.
async function etcdHealth(cfg) {
  const id='etcd_health', name=cfg.name;
  try {
    // Step 1: find a running etcd pod
    const podOut = await run([
      'get','pods','-n','openshift-etcd',
      '-l','app=etcd',
      '--field-selector=status.phase=Running',
      '-o','jsonpath={.items[0].metadata.name}',
    ]);
    const podName = podOut.trim();
    if (!podName) {
      // Fallback: get any Running etcd pod without label selector
      const fallback = await run(['get','pods','-n','openshift-etcd','--no-headers']);
      const pods = parsePods(fallback).filter(p => p.name.startsWith('etcd-') && isHealthy(p.status));
      if (pods.length === 0) return fail(id, name, 'No running etcd pods found', fallback);
      // Use first running pod
      const firstPod = pods[0].name;
      return await runEtcdHealthCheck(id, name, firstPod);
    }
    return await runEtcdHealthCheck(id, name, podName);
  } catch(e) { return fail(id,name,e.message,e.message); }
}

async function runEtcdHealthCheck(id, name, podName) {
  try {
    const result = await run([
      'exec','-n','openshift-etcd',
      '-c','etcdctl',
      podName,
      '--',
      'sh','-c','etcdctl endpoint health --cluster 2>/dev/null',
    ], 30000);

    const unhealthy = result.trim().split('\n').filter(Boolean)
      .filter(l => !l.includes('is healthy'));

    if (unhealthy.length === 0) {
      return { id, name, category:'control_plane', status:'Passed',
               detail:`All etcd endpoints healthy (via ${podName})`, rawOutput: result };
    }
    return { id, name, category:'control_plane', status:'Failed',
             detail:`${unhealthy.length} unhealthy endpoint(s)`, rawOutput: unhealthy.join('\n') };
  } catch(e) {
    // etcdctl exec failed — fall back to checking pod readiness
    const fallback = await run(['get','pods','-n','openshift-etcd','--no-headers']).catch(()=>'');
    const pods = parsePods(fallback);
    const bad  = pods.filter(p => p.name.startsWith('etcd-') && !isHealthy(p.status));
    if (bad.length === 0 && pods.filter(p=>p.name.startsWith('etcd-')).length > 0) {
      return { id, name, category:'control_plane', status:'Passed',
               detail:`etcdctl exec unavailable; all etcd pods Running (fallback check)`, rawOutput: fallback };
    }
    return { id, name, category:'control_plane', status:'Failed',
             detail:`etcdctl exec failed: ${e.message}`, rawOutput: e.message };
  }
}

// ── Authentication ────────────────────────────────────────────────────────────
async function authentication(cfg) {
  const id='authentication', name=cfg.name;
  try {
    const out  = await run(['get','pods','-n','openshift-authentication','--no-headers']);
    const pods = parsePods(out);
    const bad  = pods.filter(p => !isHealthy(p.status));
    if (bad.length === 0) return pass(id, name, `All ${pods.length} auth pod(s) running`);
    return fail(id, name, `${bad.length} auth pod(s) not running`,
      bad.map(p=>`${p.name} ${p.status}`).join('\n'));
  } catch(e) { return fail(id,name,e.message,e.message); }
}

// ── Control Plane Pods ────────────────────────────────────────────────────────
// Fix: installer-*, revision-pruner-* are short-lived OCP jobs whose
// Error/Completed state is normal and must NOT be flagged as failures.
async function controlPlanePods(cfg) {
  const id='control_plane_pods', name=cfg.name;
  const namespaces = [
    'openshift-kube-apiserver',
    'openshift-kube-scheduler',
    'openshift-kube-controller-manager',
    'openshift-etcd',
  ];
  const bad = [];
  const rawLines = [];

  for (const ns of namespaces) {
    try {
      const out  = await run(['get','pods','-n',ns,'--no-headers']);
      const pods = parsePods(out);
      pods
        .filter(p => !isIgnorablePod(p.name))   // ← skip installer/pruner jobs
        .filter(p => !isHealthy(p.status))
        .forEach(p => {
          bad.push(`${ns}/${p.name} (${p.status})`);
          rawLines.push(`${ns} ${p.name} ${p.status}`);
        });
    } catch(e) {
      bad.push(`${ns}: ${e.message}`);
      rawLines.push(e.message);
    }
  }
  if (bad.length === 0) return pass(id, name, 'All control plane pods healthy');
  return fail(id, name, `${bad.length} pod(s) unhealthy`, rawLines.join('\n'));
}

const CHECKS = {
  cluster_operators:   clusterOperators,
  cluster_version:     clusterVersion,
  machine_config_pool: machineConfigPool,
  etcd_health:         etcdHealth,
  authentication,
  control_plane_pods:  controlPlanePods,
};
module.exports = { CHECKS };
