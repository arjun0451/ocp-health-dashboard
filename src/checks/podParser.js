'use strict';

/**
 * podParser.js
 * ------------
 * Robust parser for `oc get pods --no-headers` output.
 *
 * The naive split(/\s+/) approach breaks when RESTARTS contains
 * a space, e.g.:  "6 (13d ago)"  which shifts STATUS to index 4.
 *
 * Real column layout (no-headers):
 *   NAME   READY   STATUS   RESTARTS   AGE
 *   0      1       2        3          4
 *
 * But with recent kubectl/oc the RESTARTS field can be:
 *   "6 (13d ago)"   ← contains a space → naive split gives wrong STATUS index
 *
 * Fix: parse NAME, READY from start; AGE from end; STATUS is the token
 * that matches a known pod phase; everything else is RESTARTS.
 */

const PHASES = new Set([
  'Running','Pending','Succeeded','Failed','Unknown','Completed',
  'CrashLoopBackOff','OOMKilled','Error','ImagePullBackOff',
  'ErrImagePull','CreateContainerError','Init:Error','Terminating',
  'ContainerCreating','PodInitializing',
]);

/**
 * Parse a single `oc get pods --no-headers` line.
 * Returns { name, ready, status, restarts, age } or null if unparseable.
 */
function parsePodLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 4) return null;

  const name  = parts[0];
  const ready = parts[1];   // e.g. "6/6"
  const age   = parts[parts.length - 1];  // last token is always AGE

  // STATUS is the first token (after READY) that matches a known phase
  // or looks like a pod phase (capitalised, may contain colons/slashes)
  let statusIdx = 2;
  for (let i = 2; i < parts.length - 1; i++) {
    const tok = parts[i];
    if (PHASES.has(tok) || /^[A-Z]/.test(tok)) {
      statusIdx = i;
      break;
    }
  }

  const status   = parts[statusIdx];
  // RESTARTS = everything between READY and STATUS, plus tokens between STATUS and AGE
  const restarts = parts.slice(statusIdx + 1, parts.length - 1).join(' ');

  return { name, ready, status, restarts, age };
}

/**
 * Parse full `oc get pods --no-headers` output.
 * Returns array of pod objects.
 */
function parsePods(output) {
  return output.trim().split('\n')
    .filter(Boolean)
    .map(parsePodLine)
    .filter(Boolean);
}

/**
 * Returns true if the pod phase means it is healthy.
 */
function isHealthy(status) {
  return status === 'Running' || status === 'Completed' || status === 'Succeeded';
}

module.exports = { parsePodLine, parsePods, isHealthy };
