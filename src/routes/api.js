'use strict';
/**
 * routes/api.js
 *
 * GET  /api/status
 * GET  /api/results
 * POST /api/run
 * GET  /api/history[?limit=N]
 * GET  /api/history/:runId
 * GET  /api/config
 * POST /api/config/reload
 * GET  /api/report/:runId/json
 * GET  /api/report/:runId/pdf
 * GET  /api/report/latest/json
 * GET  /api/report/latest/pdf
 * GET  /api/docs
 * GET  /api/docs/:checkId
 * GET  /api/ssl/certs           ← all TLS cert data for SSL tab
 * GET  /api/nodes/limits        ← node resource limits table
 * GET  /api/pdb                 ← PDB analysis for PDB tab
 */

const express = require('express');
const router  = express.Router();

const { state, execute }   = require('../scheduler');
const { loadIndex, loadRun } = require('../artifactStore');
const { loadConfig, reloadConfig } = require('../configLoader');
const { buildJSONReport, buildHTMLReport, generatePDF } = require('../reportGenerator');
const { getDocs }          = require('../checks/checkDocs');
const { getAllCertData, getRawOCOutput } = require('../checks/security');
const { getAllMetrics, getMockMetrics }  = require('../checks/prometheus');
const { getNodeLimitRows } = require('../checks/nodes');
const { getPDBData }       = require('../checks/pdb');
const logger = require('../logger');

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  res.json({
    status:      'ok',
    isRunning:   state.isRunning,
    lastRunTime: state.lastRunTime,
    lastRunId:   state.lastRunId,
    triggeredBy: state.triggeredBy,
    clusterID:   state.clusterID,
    mockMode:    process.env.MOCK_MODE === 'true',
  });
});

// ── Results ───────────────────────────────────────────────────────────────────
router.get('/results', (req, res) => {
  res.json({
    clusterID:   state.clusterID,
    lastRunTime: state.lastRunTime,
    lastRunId:   state.lastRunId,
    isRunning:   state.isRunning,
    results:     state.lastResults || [],
  });
});

// ── Trigger ───────────────────────────────────────────────────────────────────
router.post('/run', (req, res) => {
  if (state.isRunning) return res.status(409).json({ error: 'Already running', isRunning: true });
  execute('manual');
  res.json({ message: 'Health check started', isRunning: true });
});

// ── History ───────────────────────────────────────────────────────────────────
router.get('/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '30', 10), 200);
  const index = loadIndex().slice(0, limit);
  res.json({ history: index, total: index.length });
});

router.get('/history/:runId', (req, res) => {
  const data = loadRun(req.params.runId);
  if (!data) return res.status(404).json({ error: 'Run not found' });
  res.json(data);
});

// ── Config ────────────────────────────────────────────────────────────────────
router.get('/config',         (req, res) => res.json(loadConfig()));
router.post('/config/reload', (req, res) => {
  const cfg = reloadConfig();
  logger.info('Config reloaded via API');
  res.json({ message: 'Config reloaded', config: cfg });
});

// ── Reports ───────────────────────────────────────────────────────────────────
function resolveRunId(runId) {
  return runId === 'latest' ? state.lastRunId : runId;
}

router.get('/report/:runId/json', (req, res) => {
  const rid  = resolveRunId(req.params.runId);
  if (!rid) return res.status(404).json({ error: 'No run available' });
  const data = loadRun(rid);
  if (!data) return res.status(404).json({ error: 'Run not found' });
  const report = buildJSONReport(data);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="ocp-health-${rid}.json"`);
  res.send(JSON.stringify(report, null, 2));
});

router.get('/report/:runId/pdf', async (req, res) => {
  const rid  = resolveRunId(req.params.runId);
  if (!rid) return res.status(404).json({ error: 'No run available' });
  const data = loadRun(rid);
  if (!data) return res.status(404).json({ error: 'Run not found' });
  try {
    const html   = buildHTMLReport(data);
    const result = await generatePDF(html);
    const ext    = result.type === 'pdf' ? 'pdf' : 'html';
    res.setHeader('Content-Type', result.type === 'pdf' ? 'application/pdf' : 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="ocp-health-${rid}.${ext}"`);
    res.send(result.data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Docs ──────────────────────────────────────────────────────────────────────
router.get('/docs',          (req, res) => res.json({ docs: getDocs() }));
router.get('/docs/:checkId', (req, res) => {
  const doc = getDocs(req.params.checkId);
  if (!doc) return res.status(404).json({ error: 'Check not found' });
  res.json(doc);
});

// ── SSL certs tab ─────────────────────────────────────────────────────────────
// Returns ALL certs with notBefore, notAfter, daysLeft + stats object.
// Stats: totalTLSFound, parsed, skippedParseErr, excluded, checked, activeFilter
router.get('/ssl/certs', async (req, res) => {
  try {
    const certs = await getAllCertData();
    const stats = certs._stats;
    res.json({ certs: [...certs], total: certs.length, stats });
  } catch (e) {
    logger.error(`SSL certs API error: ${e.message}\n${e.stack}`);
    res.status(500).json({
      error: e.message,
      certs: [], total: 0,
      stats: { totalTLSFound: 0, parsed: 0, skippedParseErr: 0, excluded: 0, checked: 0 },
    });
  }
});

// ── SSL debug — shows raw oc output sample for troubleshooting ────────────────
// GET /api/ssl/debug
router.get('/ssl/debug', async (req, res) => {
  try {
    const info = await getRawOCOutput();
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Node limits tab ───────────────────────────────────────────────────────────
// Returns cached rows from last scheduler run.
// Pass ?live=true to re-run describe node right now.
router.get('/nodes/limits', async (req, res) => {
  try {
    if (req.query.live === 'true') {
      // Re-run the check live
      const { CHECKS } = require('../checks/nodes');
      await CHECKS.node_limits({ name: 'Node Resource Limits' });
    }
    res.json({ rows: getNodeLimitRows() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PDB tab ───────────────────────────────────────────────────────────────────
router.get('/pdb', async (req, res) => {
  try {
    const rows    = await getPDBData();
    const summary = {
      total:      rows.length,
      blocked:    rows.filter(r => r.color === 'red').length,
      lowHA:      rows.filter(r => r.color === 'orange').length,
      safe:       rows.filter(r => r.color === 'green').length,
      fullOutage: rows.filter(r => r.color === 'blue').length,
    };
    res.json({ rows, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Prometheus metrics tab ────────────────────────────────────────────────────
// GET /api/metrics          — full metrics payload (cached PROM_CACHE_SECS)
// GET /api/metrics?force=1  — bypass cache, re-query Thanos now
router.get('/metrics', async (req, res) => {
  try {
    const isMock = process.env.MOCK_MODE === 'true';
    const force  = req.query.force === '1' || req.query.force === 'true';
    const data   = isMock ? getMockMetrics() : await getAllMetrics(force);
    res.json(data);
  } catch (e) {
    logger.error(`Metrics API error: ${e.message}\n${e.stack}`);
    res.status(500).json({
      error:     e.message,
      fetchedAt: new Date().toISOString(),
      groups:    [],
    });
  }
});

module.exports = router;

