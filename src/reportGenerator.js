'use strict';

/**
 * reportGenerator.js
 * ------------------
 * Generates downloadable reports from a completed run.
 *
 * JSON  – structured audit report, returned as application/json
 * PDF   – generated from an HTML template rendered in a headless browser
 *         (requires Chromium available at CHROMIUM_PATH, or falls back to
 *          returning the HTML directly if Chromium is absent)
 */

const path = require('path');
const fs   = require('fs');
const logger = require('./logger');

// ── JSON Export ───────────────────────────────────────────────────────────────
function buildJSONReport(runData) {
  const { runId, meta, results } = runData;
  return {
    reportVersion: '2.0',
    generatedAt:   new Date().toISOString(),
    cluster:       meta.clusterID,
    runId,
    triggeredBy:   meta.triggeredBy,
    startedAt:     meta.startedAt,
    completedAt:   meta.completedAt,
    duration:      `${(meta.durationMs / 1000).toFixed(1)}s`,
    summary: {
      total:   results.length,
      passed:  results.filter(r => r.status === 'Passed').length,
      failed:  results.filter(r => r.status === 'Failed').length,
      skipped: results.filter(r => r.status === 'Skipped' || r.status === 'Error').length,
    },
    checks: results.map(r => ({
      no:          r.no,
      id:          r.id,
      name:        r.name,
      category:    r.category,
      status:      r.status,
      detail:      r.detail,
      durationMs:  r.durationMs,
      artifactUrl: r.artifactPath || null,
    })),
  };
}

// ── HTML Report Template ──────────────────────────────────────────────────────
function buildHTMLReport(runData) {
  const { runId, meta, results } = runData;
  const now    = new Date().toLocaleString();
  const passed = results.filter(r => r.status === 'Passed').length;
  const failed = results.filter(r => r.status === 'Failed').length;

  const categoryOrder = ['control_plane','nodes','pods','networking','storage','security','monitoring'];
  const grouped = {};
  results.forEach(r => {
    const cat = r.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(r);
  });

  const catLabel = {
    control_plane: 'Control Plane', nodes: 'Nodes', pods: 'Pods',
    networking: 'Networking', storage: 'Storage', security: 'Security',
    monitoring: 'Monitoring', other: 'Other'
  };

  const sections = [...categoryOrder, ...Object.keys(grouped).filter(c => !categoryOrder.includes(c))]
    .filter(c => grouped[c]?.length)
    .map(cat => {
      const rows = grouped[cat].map(r => `
        <tr>
          <td>${r.no}</td>
          <td>${esc(r.name)}</td>
          <td class="status-${r.status.toLowerCase()}">${r.status}</td>
          <td>${esc(r.detail || '')}</td>
        </tr>`).join('');
      return `
        <h3>${catLabel[cat] || cat}</h3>
        <table>
          <thead><tr><th>#</th><th>Check</th><th>Status</th><th>Detail</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>OCP Health Report – ${esc(runId)}</title>
<style>
  body{font-family:Arial,sans-serif;margin:32px;color:#1a1a1a;font-size:13px}
  h1{color:#c00;margin-bottom:4px}
  .meta{color:#555;margin-bottom:24px;font-size:12px}
  .summary{display:flex;gap:32px;margin-bottom:24px}
  .summary div{padding:12px 24px;border-left:4px solid #ddd}
  .summary .pass{border-color:#16a34a;color:#16a34a}
  .summary .fail{border-color:#dc2626;color:#dc2626}
  .summary div span{display:block;font-size:28px;font-weight:bold}
  h3{margin:20px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#555}
  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  th{background:#f3f4f6;text-align:left;padding:8px 12px;font-size:11px;text-transform:uppercase;color:#6b7280}
  td{padding:8px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top}
  .status-passed{color:#16a34a;font-weight:600}
  .status-failed{color:#dc2626;font-weight:600}
  .status-skipped,.status-error{color:#d97706;font-weight:600}
  footer{margin-top:32px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:12px}
</style>
</head><body>
<h1>OpenShift Cluster Health Report</h1>
<div class="meta">
  Cluster: <strong>${esc(meta.clusterID)}</strong> &nbsp;|&nbsp;
  Run ID: <strong>${esc(runId)}</strong> &nbsp;|&nbsp;
  Generated: <strong>${now}</strong> &nbsp;|&nbsp;
  Triggered by: <strong>${esc(meta.triggeredBy)}</strong>
</div>
<div class="summary">
  <div><strong>Total</strong><span>${results.length}</span></div>
  <div class="pass"><strong>Passed</strong><span>${passed}</span></div>
  <div class="fail"><strong>Failed</strong><span>${failed}</span></div>
</div>
${sections}
<footer>OCP Health Dashboard v2.0 &nbsp;–&nbsp; ${now}</footer>
</body></html>`;
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── PDF via Puppeteer (optional) ──────────────────────────────────────────────
async function generatePDF(html) {
  const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
  if (!fs.existsSync(chromiumPath)) {
    logger.warn('Chromium not found – returning HTML instead of PDF');
    return { type: 'html', data: Buffer.from(html, 'utf8') };
  }
  try {
    const puppeteer = require('puppeteer-core');
    const browser   = await puppeteer.launch({
      executablePath: chromiumPath,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf  = await page.pdf({ format: 'A4', printBackground: true, margin: { top:'20mm',bottom:'20mm',left:'15mm',right:'15mm' } });
    await browser.close();
    return { type: 'pdf', data: pdf };
  } catch (err) {
    logger.error(`PDF generation failed: ${err.message} – returning HTML`);
    return { type: 'html', data: Buffer.from(html, 'utf8') };
  }
}

module.exports = { buildJSONReport, buildHTMLReport, generatePDF };
