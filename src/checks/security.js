'use strict';
/**
 * security.js  –  SSL certificate expiry
 *
 * Root causes fixed:
 *
 * 1. maxBuffer exceeded:
 *    `oc get secrets -A -o json` downloads ALL secret data (including cert
 *    blobs from hundreds of Opaque secrets) → easily exceeds 10 MB buffer.
 *    Fix: use a go-template that filters on the oc side:
 *      {{if and (eq .type "kubernetes.io/tls") (index .data "tls.crt")}}
 *    This emits only TLS secrets that actually have a tls.crt key,
 *    outputting tab-separated: NAMESPACE\tNAME\tCERT_B64\n
 *    No JSON, no Opaque secrets, no extra data fields — tiny output.
 *
 * 2. Excluded namespaces configurable:
 *    Read from env vars SSL_EXCLUDE_NAMESPACES and SSL_INCLUDE_NAMESPACES
 *    (comma-separated). Defaults match the original hardcoded list.
 *    Set via the ocp-health-ssl-config ConfigMap.
 *
 * 3. Stats: total TLS secrets found vs those with tls.crt vs excluded.
 *
 * getAllCertData() exported for /api/ssl/certs route.
 */

const { run } = require('../executor');

// ── Namespace filter config ───────────────────────────────────────────────────
// Read from env (set via ocp-health-ssl-config ConfigMap).
// SSL_EXCLUDE_NAMESPACES: comma-separated list of namespaces to exclude
// SSL_INCLUDE_NAMESPACES: if set, ONLY these namespaces are checked (whitelist)
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

function getExcludedNS() {
  const raw = process.env.SSL_EXCLUDE_NAMESPACES || '';
  if (!raw.trim()) return new Set(DEFAULT_EXCLUDES);
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

function getIncludedNS() {
  const raw = process.env.SSL_INCLUDE_NAMESPACES || '';
  if (!raw.trim()) return null; // null = all namespaces (minus excludes)
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

function isExcluded(ns) {
  const inc = getIncludedNS();
  if (inc !== null) return !inc.has(ns);   // whitelist mode
  return getExcludedNS().has(ns);           // blacklist mode
}

// ── Go-template: filters at oc level ─────────────────────────────────────────
// Only emits secrets where:
//   .type == "kubernetes.io/tls"  AND  .data["tls.crt"] exists (non-empty)
// Output: NAMESPACE<TAB>NAME<TAB>BASE64_CERT<NEWLINE>
// Using {{printf}} avoids inline double-quote shell issues.
const GO_TEMPLATE = [
  '{{range .items}}',
  '{{if and (eq .type "kubernetes.io/tls") (index .data "tls.crt")}}',
  '{{printf "%s\\t%s\\t%s\\n" .metadata.namespace .metadata.name (index .data "tls.crt")}}',
  '{{end}}',
  '{{end}}',
].join('');

// ── ASN.1 byte scanner ────────────────────────────────────────────────────────
// Finds notBefore + notAfter inside a DER-encoded X.509 certificate.
// Handles UTCTime (0x17) and GeneralizedTime (0x18).
// Returns { notBefore: ms|null, notAfter: ms|null } or null on parse failure.
function parseCertDates(b64) {
  try {
    const der   = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    const found = [];

    for (let i = 0; i < der.length - 17 && found.length < 2; i++) {
      // UTCTime tag=0x17 len=0x0d → 13 bytes: YYMMDDHHMMSSZ
      if (der[i] === 0x17 && der[i + 1] === 0x0d) {
        const s = der.slice(i + 2, i + 15).toString('latin1');
        if (/^\d{12}Z$/.test(s)) {
          const yy = parseInt(s.slice(0, 2), 10);
          const yr = yy >= 50 ? 1900 + yy : 2000 + yy;
          found.push(Date.UTC(yr,
            parseInt(s.slice(2, 4), 10) - 1,
            parseInt(s.slice(4, 6), 10),
            parseInt(s.slice(6, 8), 10),
            parseInt(s.slice(8, 10), 10),
            parseInt(s.slice(10, 12), 10)));
          i += 14;
          continue;
        }
      }
      // GeneralizedTime tag=0x18 len=0x0f → 15 bytes: YYYYMMDDHHMMSSZ
      if (der[i] === 0x18 && der[i + 1] === 0x0f) {
        const s = der.slice(i + 2, i + 17).toString('latin1');
        if (/^\d{14}Z$/.test(s)) {
          found.push(Date.UTC(
            parseInt(s.slice(0, 4), 10),
            parseInt(s.slice(4, 6), 10) - 1,
            parseInt(s.slice(6, 8), 10),
            parseInt(s.slice(8, 10), 10),
            parseInt(s.slice(10, 12), 10),
            parseInt(s.slice(12, 14), 10)));
          i += 16;
          continue;
        }
      }
    }

    if (found.length === 0) return null;
    return {
      notBefore: found.length >= 2 ? found[0] : null,
      notAfter:  found.length >= 2 ? found[1] : found[0],
    };
  } catch (_) { return null; }
}

// ── Main fetch function ───────────────────────────────────────────────────────
// Uses go-template to filter on the oc side → only TLS secrets with tls.crt.
// Returns array of cert objects for all certs (excluded flag set per namespace).
async function getAllCertData() {
  // go-template emits NAMESPACE\tNAME\tCERT_B64\n for each qualifying secret.
  // maxBuffer: 50 MB — cert data can be large but this only fetches tls.crt fields
  const raw = await run(
    ['get', 'secrets', '--all-namespaces',
     '-o', `go-template=${GO_TEMPLATE}`],
    120000,
    50 * 1024 * 1024   // 50 MB buffer — only cert data, no Opaque blobs
  );

  const lines = raw.split('\n').filter(l => l.trim());
  let totalTLSFound = 0;
  let skippedNoCert = 0;
  let skippedParseErr = 0;

  const certs = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [ns, name, certB64Raw] = parts;
    const certB64 = certB64Raw.trim();

    // go-template already filtered for non-empty tls.crt — count it
    totalTLSFound++;

    if (!certB64) { skippedNoCert++; continue; }

    const dates = parseCertDates(certB64);
    if (!dates || !dates.notAfter) { skippedParseErr++; continue; }

    const now      = Date.now();
    const daysLeft = Math.floor((dates.notAfter - now) / 86400000);
    const excluded = isExcluded(ns.trim());

    certs.push({
      ns:         ns.trim(),
      name:       name.trim(),
      excluded,
      notBefore:  dates.notBefore
        ? new Date(dates.notBefore).toISOString().slice(0, 10)
        : 'N/A',
      notAfter:   new Date(dates.notAfter).toISOString().slice(0, 10),
      daysLeft,
    });
  }

  // Attach stats for the API response
  certs._stats = {
    totalTLSFound,
    parsed:         certs.length,
    skippedNoCert,
    skippedParseErr,
    excluded:       certs.filter(c => c.excluded).length,
    checked:        certs.filter(c => !c.excluded).length,
  };

  return certs;
}

// ── Health check (called by scheduler) ───────────────────────────────────────
async function sslCertificates(cfg) {
  const id        = 'ssl_certificates';
  const name      = cfg.name;
  const threshold = parseInt(process.env.CERT_THRESHOLD || cfg.threshold || 30, 10);

  try {
    const all   = await getAllCertData();
    const stats = all._stats || {};

    const checked  = all.filter(c => !c.excluded);
    const expiring = checked.filter(c => c.daysLeft < threshold);
    const summary  = `Checked ${stats.checked || checked.length} certs ` +
      `(${stats.totalTLSFound || all.length} TLS found, ` +
      `${stats.excluded || 0} excluded namespaces, ` +
      `${stats.skippedParseErr || 0} parse errors)`;

    if (expiring.length === 0) {
      return { id, name, category: 'security', status: 'Passed',
               detail: `No certs expiring within ${threshold} days. ${summary}`,
               rawOutput: '' };
    }
    const rawOut = expiring
      .map(c => `${c.ns}/${c.name}  expires: ${c.notAfter}  (${c.daysLeft}d left)`)
      .join('\n');
    return { id, name, category: 'security', status: 'Failed',
             detail: `${expiring.length} cert(s) expiring within ${threshold} days. ${summary}`,
             rawOutput: rawOut };
  } catch (e) {
    return { id, name, category: 'security', status: 'Error',
             detail: `Check failed: ${e.message}`, rawOutput: e.message };
  }
}

const CHECKS = { ssl_certificates: sslCertificates };
module.exports = { CHECKS, getAllCertData };
