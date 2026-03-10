'use strict';
/**
 * networking.js
 * -------------
 * Checks: api_server, ingress_controller, machine_config_server
 *
 * Bug fix (Bug-3):
 *   MCS port 22623 is only accessible from cluster nodes (bootstrap/master),
 *   NOT from inside a regular pod. Direct TCP connection from the dashboard
 *   pod to 22623 will always get ECONNREFUSED.
 *
 *   Fix: Check MCS health by verifying the machine-config-server pods
 *   in openshift-machine-config-operator namespace are Running, AND
 *   check the MachineConfigOperator ClusterOperator status — same signal,
 *   no firewall issues.
 */

const { run }  = require('../executor');
const https    = require('https');
const { parsePods, isHealthy } = require('./podParser');

function pass(id, name, detail='', raw='') { return {id,name,category:'networking',status:'Passed',detail,rawOutput:raw}; }
function fail(id, name, detail='', raw='') { return {id,name,category:'networking',status:'Failed',detail,rawOutput:raw}; }
function skip(id, name, detail='')         { return {id,name,category:'networking',status:'Skipped',detail,rawOutput:''}; }

function httpsGet(url, timeoutMs=10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── Check: API Server ─────────────────────────────────────────────────────────
async function apiServer(cfg) {
  const id='api_server', name=cfg.name;
  const apiUrl = process.env.API_URL || 'https://kubernetes.default.svc:443';
  try {
    const { body } = await httpsGet(`${apiUrl}/readyz`);
    if (body.trim() === 'ok') return pass(id, name, `${apiUrl}/readyz → ok`);
    return fail(id, name, `Unexpected /readyz response: ${body.trim().substring(0,80)}`, body);
  } catch(e) { return fail(id,name,e.message,e.message); }
}

// ── Check: Ingress Controller ─────────────────────────────────────────────────
async function ingressController(cfg) {
  const id='ingress_controller', name=cfg.name;
  const consoleUrl = process.env.CONSOLE_URL;
  if (!consoleUrl) return skip(id, name, 'CONSOLE_URL not configured in ConfigMap');
  try {
    const { status } = await httpsGet(consoleUrl, 15000);
    if ([200,301,302,303,307,308].includes(status)) {
      return pass(id, name, `Console URL returned HTTP ${status}`);
    }
    return fail(id, name, `Console URL returned HTTP ${status}`, `HTTP ${status}`);
  } catch(e) { return fail(id,name,e.message,e.message); }
}

// ── Check: Machine Config Server ─────────────────────────────────────────────
// Port 22623 is node-only (not accessible from pods). Instead we verify:
//  1. machine-config-server pods are Running in openshift-machine-config-operator
//  2. The machine-config ClusterOperator is Available=True, Degraded=False
async function machineConfigServer(cfg) {
  const id='machine_config_server', name=cfg.name;
  const issues = [];
  const rawLines = [];

  try {
    // Check 1: MCS pods running
    const podOut = await run([
      'get','pods','-n','openshift-machine-config-operator','--no-headers',
    ]);
    const pods = parsePods(podOut);
    const mcsPods = pods.filter(p => p.name.startsWith('machine-config-server'));
    const badPods = mcsPods.filter(p => !isHealthy(p.status));

    if (mcsPods.length === 0) {
      issues.push('No machine-config-server pods found');
    } else if (badPods.length > 0) {
      badPods.forEach(p => {
        issues.push(`Pod ${p.name} is ${p.status}`);
        rawLines.push(`${p.name} ${p.status}`);
      });
    }

    // Check 2: machine-config ClusterOperator status
    const coOut = await run([
      'get','co','machine-config','--no-headers',
    ]);
    const coLine = coOut.trim().split('\n').filter(Boolean)[0] || '';
    const coCols = coLine.trim().split(/\s+/);
    // NAME VERSION AVAILABLE PROGRESSING DEGRADED AGE
    const available   = coCols[2];
    const progressing = coCols[3];
    const degraded    = coCols[4];

    if (available !== 'True' || degraded !== 'False') {
      issues.push(`ClusterOperator machine-config: Available=${available} Degraded=${degraded}`);
      rawLines.push(coLine);
    }

    if (issues.length === 0) {
      const runningCount = mcsPods.filter(p => isHealthy(p.status)).length;
      return pass(id, name,
        `${runningCount} MCS pod(s) running; ClusterOperator healthy`,
        podOut + '\n' + coOut);
    }
    return fail(id, name, issues.join('; '), rawLines.join('\n'));

  } catch(e) {
    return fail(id, name, `Check failed: ${e.message}`, e.message);
  }
}

const CHECKS = {
  api_server:            apiServer,
  ingress_controller:    ingressController,
  machine_config_server: machineConfigServer,
};
module.exports = { CHECKS };
