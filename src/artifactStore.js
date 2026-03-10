'use strict';

/**
 * artifactStore.js
 * ----------------
 * Manages the lifecycle of health-check artifacts on the PVC mount.
 *
 * PVC layout:
 *   /artifacts/
 *     index.json                         ← master run index (last 90 entries)
 *     runs/
 *       <runId>/
 *         summary.json                   ← check results array
 *         report.json                    ← full exportable report
 *         <checkId>.log                  ← per-check detail log (only on fail)
 *
 * All paths are relative to ARTIFACT_BASE_DIR env var.
 */

const fs   = require('fs');
const path = require('path');
const logger = require('./logger');

const BASE = process.env.ARTIFACT_BASE_DIR || '/artifacts';
const RUNS = path.join(BASE, 'runs');
const INDEX_FILE = path.join(BASE, 'index.json');

// Ensure directories exist at startup
function ensureDirs() {
  [BASE, RUNS].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

/** Load the run index (array of run metadata, newest first) */
function loadIndex() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

/** Save the run index */
function saveIndex(index) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

/**
 * Persist a completed run to the PVC.
 * @param {string} runId        – e.g. "20240315_143000"
 * @param {object[]} results    – array of check result objects
 * @param {object} meta         – { clusterID, startedAt, completedAt, durationMs, triggeredBy }
 * @returns {string}            – runId
 */
function saveRun(runId, results, meta) {
  ensureDirs();
  const runDir = path.join(RUNS, runId);
  if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });

  // Per-check detail logs for failed checks
  const artifacts = [];
  for (const r of results) {
    if ((r.status === 'Failed' || r.status === 'Error') && r.rawOutput) {
      const logFile = `${r.id}.log`;
      fs.writeFileSync(path.join(runDir, logFile), r.rawOutput);
      artifacts.push({ checkId: r.id, checkName: r.name, file: logFile });
      r.artifactPath = `/artifacts/runs/${runId}/${logFile}`;
    }
  }

  // Summary JSON
  const summary = { runId, meta, results };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // Full report JSON (audit-friendly)
  const report = {
    reportVersion: '2.0',
    generatedAt: new Date().toISOString(),
    cluster: meta.clusterID,
    runId,
    triggeredBy: meta.triggeredBy || 'schedule',
    duration: `${(meta.durationMs / 1000).toFixed(1)}s`,
    summary: {
      total:   results.length,
      passed:  results.filter(r => r.status === 'Passed').length,
      failed:  results.filter(r => r.status === 'Failed').length,
      skipped: results.filter(r => r.status === 'Skipped').length,
    },
    results,
    artifacts,
  };
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify(report, null, 2));

  // Update index
  const index = loadIndex();
  index.unshift({
    runId,
    startedAt:   meta.startedAt,
    completedAt: meta.completedAt,
    durationMs:  meta.durationMs,
    triggeredBy: meta.triggeredBy || 'schedule',
    clusterID:   meta.clusterID,
    total:        results.length,
    passed:       results.filter(r => r.status === 'Passed').length,
    failed:       results.filter(r => r.status === 'Failed').length,
    skipped:      results.filter(r => r.status === 'Skipped').length,
    hasArtifacts: artifacts.length > 0,
    artifacts,
  });
  // Keep last 90 runs in index
  saveIndex(index.slice(0, 90));

  logger.info(`Artifacts saved: ${runDir} (${artifacts.length} failure logs)`);
  return runId;
}

/** Load a specific run's summary */
function loadRun(runId) {
  const file = path.join(RUNS, runId, 'summary.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Load the full report JSON for a run */
function loadReport(runId) {
  const file = path.join(RUNS, runId, 'report.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Delete runs older than retentionDays.
 * Called by the scheduler after each run.
 */
function purgeOldRuns(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400 * 1000;
  const index  = loadIndex();
  const keep   = [];
  const remove = [];

  for (const entry of index) {
    const ts = new Date(entry.startedAt).getTime();
    if (ts < cutoff) remove.push(entry.runId);
    else keep.push(entry);
  }

  for (const runId of remove) {
    const dir = path.join(RUNS, runId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      logger.info(`Purged old artifact run: ${runId}`);
    }
  }

  if (remove.length > 0) saveIndex(keep);
}

module.exports = { loadIndex, saveRun, loadRun, loadReport, purgeOldRuns };
