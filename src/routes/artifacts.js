'use strict';

/**
 * routes/artifacts.js
 * -------------------
 * Serves files from the PVC artifact store at /artifacts/*
 * so the dashboard can link directly to failure logs.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const BASE = process.env.ARTIFACT_BASE_DIR || '/artifacts';

router.get('/*', (req, res) => {
  // Sanitize path – prevent directory traversal
  const rel  = path.normalize(req.params[0] || '').replace(/^(\.\.[/\\])+/, '');
  const full = path.join(BASE, rel);

  if (!full.startsWith(BASE)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'Artifact not found' });
  }

  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    return res.status(400).json({ error: 'Path is a directory' });
  }

  res.download(full, path.basename(full));
});

module.exports = router;
