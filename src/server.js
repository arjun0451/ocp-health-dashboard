'use strict';

/**
 * server.js
 * ---------
 * Express application entry point.
 * Wires together: static files, API routes, artifact serving, scheduler.
 */

const express = require('express');
const path    = require('path');
const logger  = require('./logger');
const { startScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Static dashboard ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public')));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api', require('./routes/api'));

// ── Artifact file serving ─────────────────────────────────────────────────────
app.use('/artifacts', require('./routes/artifacts'));

// ── OCP liveness / readiness probes ──────────────────────────────────────────
app.get('/healthz', (_, res) => res.status(200).send('ok'));
app.get('/readyz',  (_, res) => res.status(200).send('ok'));

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`OCP Health Dashboard v2.0 listening on :${PORT}`);
  logger.info(`Mock mode: ${process.env.MOCK_MODE === 'true' ? 'ON' : 'OFF'}`);
  startScheduler();
});

module.exports = app;
