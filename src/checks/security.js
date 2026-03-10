'use strict';
/**
 * security.js  –  SSL certificate expiry
 *
 * Bug-4 root cause: jsonpath filter ?(@.type=="kubernetes.io/tls")
 * is broken across oc versions — it silently returns 0 items.
 * Fix: fetch ALL secrets as raw JSON, filter type === "kubernetes.io/tls"
 *      in Node.js, no shell quoting or jsonpath filter at all.
 *
 * getAllCertData()  – exported for the SSL details tab API
 */

'use strict';
const { run } = require('../executor');

const EXCLUDED_NS = new Set([
  'openshift-compliance',
  'openshift-kube-apiserver',
  'openshift-kube-apiserver-operator',
  'openshift-kube-controller-manager',
  'openshift-kube-controller-manager-operator',
  'openshift-kube-scheduler',
  'openshift-operator-lifecycle-manager',
  'openshift-config-managed',
]);

/* ── ASN.1 byte scanner ────────────────────────────────────────────────────────
 * Scans raw DER bytes for the FIRST two date fields (notBefore, notAfter)
 * inside a certificate's Validity SEQUENCE.
 * Handles UTCTime (0x17) and GeneralizedTime (0x18).
 * Returns { notBefore: ms|null, notAfter: ms|null } or null on failure.
 */
function parseCertDates(b64) {
  try {
    const der   = Buffer.from(b64.replace(/\s/g, ''), 'base64');
    const found = [];

    for (let i = 0; i < der.length - 17 && found.length < 2; i++) {
      // UTCTime  tag=0x17  len=0x0d  → 13 bytes  YYMMDDHHMMSSZ
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
      // GeneralizedTime  tag=0x18  len=0x0f  → 15 bytes  YYYYMMDDHHMMSSZ
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

/* ── Fetch + parse all TLS secrets ────────────────────────────────────────────
 * Returns array of cert objects (all certs, not just expiring ones).
 * Each: { ns, name, excluded, notBefore, notAfter, daysLeft }
 */
async function getAllCertData() {
  // Fetch ALL secrets as JSON — no jsonpath filter (avoids oc version bugs)
  const raw  = await run(['get', 'secrets', '--all-namespaces', '-o', 'json'], 120000);
  const list = JSON.parse(raw);
  const items = Array.isArray(list.items) ? list.items : [];

  const certs = [];
  for (const item of items) {
    if (item.type !== 'kubernetes.io/tls') continue;

    const ns      = (item.metadata?.namespace || '').trim();
    const name    = (item.metadata?.name      || '').trim();
    const certB64 = (item.data?.['tls.crt']   || '').trim();

    if (!certB64) continue;

    const dates = parseCertDates(certB64);
    if (!dates || !dates.notAfter) continue;

    const now      = Date.now();
    const daysLeft = Math.floor((dates.notAfter - now) / 86400000);
    const excluded = EXCLUDED_NS.has(ns);

    certs.push({
      ns,
      name,
      excluded,
      notBefore: dates.notBefore
        ? new Date(dates.notBefore).toISOString().slice(0, 10)
        : 'N/A',
      notAfter:  new Date(dates.notAfter).toISOString().slice(0, 10),
      daysLeft,
    });
  }
  return certs;
}

/* ── Health check (called by scheduler) ───────────────────────────────────────*/
async function sslCertificates(cfg) {
  const id        = 'ssl_certificates';
  const name      = cfg.name;
  const threshold = parseInt(process.env.CERT_THRESHOLD || cfg.threshold || 30, 10);

  try {
    const all      = await getAllCertData();
    const checked  = all.filter(c => !c.excluded);
    const expiring = checked.filter(c => c.daysLeft < threshold);
    const summary  =
      `Checked ${checked.length} certs ` +
      `(${all.length} total, ${all.length - checked.length} in excluded namespaces)`;

    if (expiring.length === 0) {
      return { id, name, category: 'security', status: 'Passed',
               detail: `No certs expiring within ${threshold} days. ${summary}`,
               rawOutput: '' };
    }
    const raw = expiring
      .map(c => `${c.ns}/${c.name}  expires:${c.notAfter}  (${c.daysLeft}d left)`)
      .join('\n');
    return { id, name, category: 'security', status: 'Failed',
             detail: `${expiring.length} cert(s) expiring within ${threshold} days. ${summary}`,
             rawOutput: raw };
  } catch (e) {
    return { id, name, category: 'security', status: 'Error',
             detail: `Check failed: ${e.message}`, rawOutput: e.message };
  }
}

const CHECKS = { ssl_certificates: sslCertificates };
module.exports = { CHECKS, getAllCertData };
