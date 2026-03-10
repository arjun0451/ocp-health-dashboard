'use strict';

/**
 * scheduler.js
 * ------------
 * Manages scheduled and on-demand health check execution.
 * Exposes a shared state object used by the API routes.
 */

const cron    = require('node-cron');
const logger  = require('./logger');
const { runChecks }       = require('./checks/index');
const { saveRun, purgeOldRuns } = require('./artifactStore');
const { loadConfig }      = require('./configLoader');

// ── Shared state (in-memory, routes read this) ────────────────────────────────
const state = {
  isRunning:   false,
  lastRunId:   null,
  lastResults: null,      // most recent results array
  lastRunTime: null,      // ISO string
  triggeredBy: null,      // 'schedule' | 'manual'
  clusterID:   process.env.CLUSTER_ID || 'OpenShift Cluster',
};

// ── Build a runId from current timestamp ─────────────────────────────────────
function makeRunId() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth()+1).padStart(2,'0'),
    String(d.getDate()).padStart(2,'0'),
    '_',
    String(d.getHours()).padStart(2,'0'),
    String(d.getMinutes()).padStart(2,'0'),
    String(d.getSeconds()).padStart(2,'0'),
  ].join('');
}

// ── Core execution ────────────────────────────────────────────────────────────
async function execute(triggeredBy = 'schedule') {
  if (state.isRunning) {
    logger.warn('Health check already running – skipping duplicate trigger');
    return;
  }

  state.isRunning   = true;
  state.triggeredBy = triggeredBy;
  const runId       = makeRunId();
  const startedAt   = new Date().toISOString();
  const startMs     = Date.now();

  logger.info(`=== Health check run started [${runId}] triggered by: ${triggeredBy} ===`);

  try {
    const results     = await runChecks();
    const completedAt = new Date().toISOString();
    const durationMs  = Date.now() - startMs;

    // Persist to PVC
    saveRun(runId, results, {
      clusterID: state.clusterID,
      startedAt,
      completedAt,
      durationMs,
      triggeredBy,
    });

    // Update in-memory state
    state.lastRunId   = runId;
    state.lastResults = results;
    state.lastRunTime = completedAt;

    const passed  = results.filter(r => r.status === 'Passed').length;
    const failed  = results.filter(r => r.status === 'Failed').length;
    logger.info(`=== Run complete [${runId}] in ${(durationMs/1000).toFixed(1)}s — ${passed} passed / ${failed} failed ===`);

    // Purge old artifacts
    const cfg = loadConfig();
    purgeOldRuns(cfg.retentionDays);

  } catch (err) {
    logger.error(`Health check run failed: ${err.message}`);
  } finally {
    state.isRunning = false;
  }
}

// ── Schedule setup ────────────────────────────────────────────────────────────
let cronJob = null;

function startScheduler() {
  const cfg         = loadConfig();
  const hours       = cfg.scheduleHours || 12;
  // Build cron: run at minute 0 every N hours
  const cronExpr    = process.env.CRON_SCHEDULE || `0 */${hours} * * *`;

  logger.info(`Scheduler: cron="${cronExpr}" (every ${hours}h)`);

  if (cronJob) cronJob.stop();
  cronJob = cron.schedule(cronExpr, () => {
    logger.info('Cron trigger fired');
    execute('schedule');
  });

  // Run immediately on startup if configured
  if (cfg.runOnStartup) {
    logger.info('Running initial health check on startup...');
    setTimeout(() => execute('startup'), 2000);   // short delay so server is fully up
  }
}

module.exports = { state, execute, startScheduler };
