'use strict';
/**
 * security.js — SSL Certificate Expiry (bulletproof rewrite)
 * ===========================================================
 *
 * ROOT CAUSE OF parseErr:232
 * --------------------------
 * Kubernetes stores .data.tls.crt as:   base64( PEM_TEXT )
 *
 * PEM_TEXT looks like:
 *   -----BEGIN CERTIFICATE-----\n<base64_of_DER_chunked_64>\n-----END CERTIFICATE-----\n
 *
 * The go-template prints .data.tls.crt  →  that outer base64 string (clean, no newlines)
 *
 * What the OLD code did (WRONG):
 *   Buffer.from(secretB64, 'base64')  →  PEM_TEXT (ASCII)
 *   Then scanned PEM text for 0x17/0x18 ASN.1 DER tags  →  ALWAYS FAILS
 *   (PEM text starts with "-----BEGIN" = 0x2D, not DER)
 *
 * What the CORRECT code must do:
 *   Step 1: Buffer.from(secretB64, 'base64').toString('ascii')  →  PEM_TEXT
 *   Step 2: Strip "-----BEGIN/END CERTIFICATE-----" + whitespace  →  inner base64
 *   Step 3: Buffer.from(innerB64, 'base64')  →  raw DER bytes
 *   Step 4: Scan DER bytes for 0x17 (UTCTime) / 0x18 (GeneralizedTime) tags
 *
 * GO-TEMPLATE FORMAT
 * ------------------
 * We use a SINGLE-LINE template (no embedded whitespace):
 *   {{range .items}}{{if and (eq .type "kubernetes.io/tls") (index .data "tls.crt")}}
 *   {{.metadata.namespace}} {{.metadata.name}} {{index .data "tls.crt"}}{{"DELIM"}}
 *   {{end}}{{end}}
 *
 * We use "|||" as a record delimiter instead of newline because go-template
 * may emit extra whitespace/newlines from template text. The cert base64
 * itself contains only [A-Za-z0-9+/=] — never the pipe character. Safe.
 *
 * NAMESPACE FILTERING (via ocp-health-ssl-config ConfigMap):
 *   SSL_EXCLUDE_NAMESPACES  — comma-separated blacklist (default: 8 OCP internal NS)
 *   SSL_INCLUDE_NAMESPACES  — comma-separated whitelist (overrides blacklist when set)
 *   CERT_THRESHOLD          — days before expiry to flag (default: 30)
 */

const logger = require('../logger');
const { run }  = require('../executor');

// ── Configurable namespace filter ─────────────────────────────────────────────
const DEFAULT_EXCLUDES = [
  'openshift-compliance',
  'openshift-kube-apiserver',
  'openshift-kube-apiserver-operator',
  'openshift-kube-controller-manager',
  'openshift-kube-controller-manager-operator',
  'openshift-kube-scheduler',
  'openshift-operator-lifecycle-manager',
  'openshift-config-managed',
];

function getFilterSets() {
  const excRaw = (process.env.SSL_EXCLUDE_NAMESPACES || '').trim();
  const incRaw = (process.env.SSL_INCLUDE_NAMESPACES || '').trim();
  const excludeSet = excRaw
    ? new Set(excRaw.split(',').map(s => s.trim()).filter(Boolean))
    : new Set(DEFAULT_EXCLUDES);
  const includeSet = incRaw
    ? new Set(incRaw.split(',').map(s => s.trim()).filter(Boolean))
    : null;  // null = blacklist mode
  return { excludeSet, includeSet };
}

function isExcluded(ns, excludeSet, includeSet) {
  if (includeSet !== null) return !includeSet.has(ns);  // whitelist mode
  return excludeSet.has(ns);                             // blacklist mode
}

// ── Go-template ───────────────────────────────────────────────────────────────
// Record delimiter: ||| (never appears in base64 or namespace/secret names)
// Template is a SINGLE LINE — no embedded whitespace that could break parsing.
const DELIM = '|||';
const GO_TEMPLATE =
  '{{range .items}}' +
  '{{if and (eq .type "kubernetes.io/tls") (index .data "tls.crt")}}' +
  '{{.metadata.namespace}} {{.metadata.name}} {{index .data "tls.crt"}}' + DELIM +
  '{{end}}' +
  '{{end}}';

// ── ASN.1 date parser — correct double-decode ─────────────────────────────────
// Input:  secretB64 — the raw .data.tls.crt value (base64 of PEM text)
// Output: { notBefore: ms, notAfter: ms } or null
function parseCertDates(secretB64) {
  try {
    // Step 1: decode outer base64 → PEM text
    const pem = Buffer.from(secretB64.replace(/\s/g, ''), 'base64').toString('ascii');

    // Must be a certificate PEM block
    if (!pem.includes('BEGIN CERTIFICATE')) return null;

    // Step 2: strip PEM armor → inner base64 → raw DER bytes
    const innerB64 = pem
      .replace(/-----BEGIN CERTIFICATE-----/g, '')
      .replace(/-----END CERTIFICATE-----/g, '')
      .replace(/\s/g, '');
    if (!innerB64) return null;

    const der = Buffer.from(innerB64, 'base64');
    if (der.length < 20) return null;

    // Step 3: scan DER bytes for Validity sequence dates
    // UTCTime  tag=0x17 len=0x0d → 13 bytes YYMMDDHHMMSSZ
    // GenTime  tag=0x18 len=0x0f → 15 bytes YYYYMMDDHHMMSSZ
    const found = [];
    for (let i = 0; i < der.length - 17 && found.length < 2; i++) {
      if (der[i] === 0x17 && der[i + 1] === 0x0d) {
        const s = der.slice(i + 2, i + 15).toString('latin1');
        if (/^\d{12}Z$/.test(s)) {
          const yy = parseInt(s.slice(0, 2), 10);
          found.push(Date.UTC(
            yy >= 50 ? 1900 + yy : 2000 + yy,
            parseInt(s.slice(2, 4), 10) - 1,
            parseInt(s.slice(4, 6), 10),
            parseInt(s.slice(6, 8), 10),
            parseInt(s.slice(8, 10), 10),
            parseInt(s.slice(10, 12), 10)
          ));
          i += 14;
          continue;
        }
      }
      if (der[i] === 0x18 && der[i + 1] === 0x0f) {
        const s = der.slice(i + 2, i + 17).toString('latin1');
        if (/^\d{14}Z$/.test(s)) {
          found.push(Date.UTC(
            parseInt(s.slice(0, 4), 10),
            parseInt(s.slice(4, 6), 10) - 1,
            parseInt(s.slice(6, 8), 10),
            parseInt(s.slice(8, 10), 10),
            parseInt(s.slice(10, 12), 10),
            parseInt(s.slice(12, 14), 10)
          ));
          i += 16;
          continue;
        }
      }
    }

    if (found.length < 2) return null;
    return { notBefore: found[0], notAfter: found[1] };
  } catch (_) { return null; }
}

// ── Parse one raw record (ns + space + name + space + base64cert) ─────────────
function parseRecord(record) {
  const trimmed = record.trim();
  if (!trimmed) return null;

  // Split on whitespace: [0]=ns, [1]=name, [2]=cert_b64
  // Base64 alphabet = [A-Za-z0-9+/=] — no spaces, so split is unambiguous
  const firstSpace  = trimmed.indexOf(' ');
  if (firstSpace < 0) return null;
  const secondSpace = trimmed.indexOf(' ', firstSpace + 1);
  if (secondSpace < 0) return null;

  const ns      = trimmed.slice(0, firstSpace).trim();
  const name    = trimmed.slice(firstSpace + 1, secondSpace).trim();
  const certB64 = trimmed.slice(secondSpace + 1).replace(/\s/g, ''); // strip any stray whitespace

  if (!ns || !name || !certB64) return null;
  return { ns, name, certB64 };
}

// ── Main fetch ────────────────────────────────────────────────────────────────
async function getAllCertData() {
  const { excludeSet, includeSet } = getFilterSets();

  // 50 MB buffer — only TLS cert PEM data, no Opaque blobs, no JSON wrapper
  const raw = await run(
    ['get', 'secrets', '--all-namespaces', '-o', `go-template=${GO_TEMPLATE}`],
    120000,
    50 * 1024 * 1024
  );

  // Split on our delimiter — each record is "NS NAME BASE64CERT"
  const records = raw.split(DELIM).map(r => r.trim()).filter(Boolean);

  logger.debug(`SSL: raw output ${raw.length} bytes, ${records.length} records via delimiter`);

  let totalTLSFound   = 0;
  let skippedParseErr = 0;
  let skippedBadFmt   = 0;

  const certs = [];
  const now   = Date.now();

  for (const record of records) {
    const parsed = parseRecord(record);
    if (!parsed) { skippedBadFmt++; continue; }

    const { ns, name, certB64 } = parsed;
    totalTLSFound++;

    const dates = parseCertDates(certB64);
    if (!dates) {
      skippedParseErr++;
      logger.debug(`SSL: parse failed for ${ns}/${name} (b64 len=${certB64.length})`);
      continue;
    }

    const daysLeft = Math.floor((dates.notAfter - now) / 86400000);
    const excluded = isExcluded(ns, excludeSet, includeSet);

    certs.push({
      ns,
      name,
      excluded,
      notBefore: new Date(dates.notBefore).toISOString().slice(0, 10),
      notAfter:  new Date(dates.notAfter).toISOString().slice(0, 10),
      daysLeft,
    });
  }

  const stats = {
    totalTLSFound,
    parsed:          certs.length,
    skippedBadFmt,
    skippedParseErr,
    excluded:        certs.filter(c => c.excluded).length,
    checked:         certs.filter(c => !c.excluded).length,
    excludeMode:     includeSet ? 'whitelist' : 'blacklist',
    activeFilter:    includeSet
      ? `whitelist: ${[...includeSet].join(', ')}`
      : `blacklist: ${[...excludeSet].join(', ')}`,
  };

  logger.info(
    `SSL: found=${stats.totalTLSFound} parsed=${stats.parsed} ` +
    `excluded=${stats.excluded} parseErr=${stats.skippedParseErr} ` +
    `checked=${stats.checked}`
  );

  // Non-enumerable so the array serialises cleanly as a plain JSON array
  Object.defineProperty(certs, '_stats', {
    value: stats, enumerable: false, writable: true,
  });

  return certs;
}

// ── Debug helper — expose raw oc output via API for troubleshooting ───────────
async function getRawOCOutput() {
  const raw = await run(
    ['get', 'secrets', '--all-namespaces', '-o', `go-template=${GO_TEMPLATE}`],
    120000,
    50 * 1024 * 1024
  );
  const records = raw.split(DELIM).map(r => r.trim()).filter(Boolean);
  return {
    rawLength:   raw.length,
    recordCount: records.length,
    delimiter:   DELIM,
    template:    GO_TEMPLATE,
    // Show first 5 records (first 200 chars each) for debugging
    sampleRecords: records.slice(0, 5).map(r => r.slice(0, 200)),
  };
}

// ── Health check (called by scheduler) ───────────────────────────────────────
async function sslCertificates(cfg) {
  const id        = 'ssl_certificates';
  const name      = cfg.name;
  const threshold = parseInt(process.env.CERT_THRESHOLD || cfg.threshold || 30, 10);

  try {
    const all   = await getAllCertData();
    const stats = all._stats;

    const checked  = all.filter(c => !c.excluded);
    const expiring = checked.filter(c => c.daysLeft < threshold);

    const summary =
      `Checked ${stats.checked} certs ` +
      `(${stats.totalTLSFound} TLS secrets found` +
      (stats.excluded ? `, ${stats.excluded} excluded` : '') +
      (stats.skippedParseErr ? `, ${stats.skippedParseErr} parse errors` : '') +
      `)`;

    if (expiring.length === 0) {
      return {
        id, name, category: 'security', status: 'Passed',
        detail: `No certs expiring within ${threshold} days. ${summary}`,
        rawOutput: checked
          .sort((a, b) => a.daysLeft - b.daysLeft)
          .map(c => `${c.ns}/${c.name}  ${c.notAfter}  (${c.daysLeft}d)`)
          .join('\n'),
      };
    }

    return {
      id, name, category: 'security', status: 'Failed',
      detail: `${expiring.length} cert(s) expiring within ${threshold} days. ${summary}`,
      rawOutput: expiring
        .sort((a, b) => a.daysLeft - b.daysLeft)
        .map(c => `${c.ns}/${c.name}  expires: ${c.notAfter}  (${c.daysLeft}d left)`)
        .join('\n'),
    };
  } catch (e) {
    return {
      id, name, category: 'security', status: 'Error',
      detail: `Check failed: ${e.message}`,
      rawOutput: e.stack || e.message,
    };
  }
}

const CHECKS = { ssl_certificates: sslCertificates };
module.exports = { CHECKS, getAllCertData, getRawOCOutput };
