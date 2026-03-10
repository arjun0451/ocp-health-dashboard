# Troubleshooting Guide

This guide covers the most common problems encountered when deploying and running the OCP Health Dashboard.

---

## Table of Contents

- [Pod Won't Start](#pod-wont-start)
- [Dashboard Shows No Results](#dashboard-shows-no-results)
- [SSL Tab Shows 0 Certs / All Parse Errors](#ssl-tab-shows-0-certs--all-parse-errors)
- [SSL Tab: 0 certs returned, TLS found: 232, excluded: 0, parseErr: 232](#ssl-tab-parseErr-232)
- [Check Shows "Error" Status](#check-shows-error-status)
- [maxBuffer Length Exceeded](#maxbuffer-length-exceeded)
- [etcd Health Check Fails](#etcd-health-check-fails)
- [Node Limits Tab Shows No Data](#node-limits-tab-shows-no-data)
- [PDB Tab Shows No Data](#pdb-tab-shows-no-data)
- [Storage Detail Column Shows Garbled Text](#storage-detail-column-shows-garbled-text)
- [PDF Reports Fail to Generate](#pdf-reports-fail-to-generate)
- [Pod CrashLoopBackOff](#pod-crashloopbackoff)
- [Image Pull Errors](#image-pull-errors)
- [Collecting Diagnostic Information](#collecting-diagnostic-information)

---

## Pod Won't Start

**Symptom:** `oc get pods -n ocp-health-dashboard` shows `Pending` or `ImagePullBackOff`.

**Check 1 — Image pull:**
```bash
oc describe pod -n ocp-health-dashboard \
  -l app=ocp-health-dashboard \
  | grep -A20 'Events:'
```

If you see `ImagePullBackOff` or `ErrImagePull`:
- Verify the image tag in the Deployment matches what you pushed
- Verify the image registry is accessible from the cluster nodes
- Check pull secrets are configured (see [Installation Guide — Option B](installation.md#option-b-external-registry-quayio-nexus-harbor-etc))

**Check 2 — PVC not binding:**
```bash
oc get pvc -n ocp-health-dashboard
```

If `STATUS` is `Pending`:
- Verify a matching StorageClass exists: `oc get storageclass`
- Check if the StorageClass supports `ReadWriteOnce`
- Set the `storageClassName` in the PVC section of `manifests.yaml`

---

## Dashboard Shows No Results

**Symptom:** The dashboard loads but shows "No results yet. Click Run Now to start."

**Check 1 — Did the first run complete?**
```bash
oc logs -n ocp-health-dashboard \
  -l app=ocp-health-dashboard --tail=50
```

Look for:
```
[scheduler] Startup run triggered
[scheduler] Run complete: 19 checks in 45.2s
```

If you see `Startup run triggered` but no `Run complete`, the run is still in progress or failed mid-way. Check for errors in the logs.

**Check 2 — Was RUN_ON_STARTUP disabled?**
```bash
oc get configmap ocp-health-config \
  -n ocp-health-dashboard \
  -o jsonpath='{.data.RUN_ON_STARTUP}'
```

If it returns `false`, trigger a run manually:
```bash
curl -X POST https://$(oc get route ocp-health-dashboard \
  -n ocp-health-dashboard -o jsonpath='{.spec.host}')/api/run
```

**Check 3 — oc binary cannot authenticate:**
```bash
oc exec -n ocp-health-dashboard \
  deployment/ocp-health-dashboard -- \
  oc whoami
```

Expected output: `system:serviceaccount:ocp-health-dashboard:ocp-health-sa`

If this fails, the ServiceAccount token is not mounting or the ClusterRoleBinding is missing:
```bash
oc get clusterrolebinding ocp-health-dashboard-cluster-admin
```

---

## SSL Tab Shows 0 Certs / All Parse Errors

**Symptom:** Stats bar shows `TLS found: 232  parsed: 0  parseErr: 232` or similar.

This is a cert encoding issue. The most common cause is that the parse function is trying to scan PEM text as DER bytes. This issue was corrected in the current version.

**Verify you have the correct version of `security.js`** by checking the go-template approach is in use:
```bash
oc exec -n ocp-health-dashboard \
  deployment/ocp-health-dashboard -- \
  grep -n 'DELIM\|double-decode\|BEGIN CERTIFICATE' src/checks/security.js \
  | head -5
```

Expected output should include references to `DELIM`, `BEGIN CERTIFICATE`, and the two-step decode.

**Use the Debug button** in the SSL tab to see raw oc output:

1. Click the **SSL Certificates** tab
2. Click **🔍 Debug**
3. Check the `sampleRecords` — they should start with `LS0tLS1` (which is `-----` in base64, confirming the value is base64(PEM_TEXT))

If `sampleRecords` are empty or the `recordCount` is 0, the go-template query is failing — see [maxBuffer Length Exceeded](#maxbuffer-length-exceeded).

---

<a name="ssl-tab-parseErr-232"></a>
## SSL Tab: `TLS found:232, excluded:0, parseErr:232`

This specific combination means:
- `oc` returned 232 TLS secrets successfully ✓
- Zero were excluded (your SSL_EXCLUDE_NAMESPACES config is empty or not taking effect)
- All 232 failed to parse ✗

**Root cause:** The cert decode function is receiving the wrong input. The value from `.data.tls.crt` is `base64(PEM_TEXT)`, not raw DER bytes. Decoding once gives PEM text (starts with `-----BEGIN`). Scanning PEM text for `0x17`/`0x18` DER tags will always fail.

**Fix confirmation:** In the current version, `security.js` performs a two-step decode:
1. `Buffer.from(b64, 'base64')` → PEM text
2. Strip headers → inner base64 → `Buffer.from(innerB64, 'base64')` → raw DER bytes
3. Scan DER for date tags

If you are still seeing this error after the latest deployment:
```bash
# Confirm the fix is deployed
oc exec -n ocp-health-dashboard \
  deployment/ocp-health-dashboard -- \
  node -e "
const s = require('./src/checks/security');
console.log('exports:', Object.keys(s).join(', '));
"
```

Expected: `exports: CHECKS, getAllCertData, getRawOCOutput`

**Excluded namespaces showing as 0:** This means `SSL_EXCLUDE_NAMESPACES` is either not set or is empty. Check:
```bash
oc get configmap ocp-health-ssl-config \
  -n ocp-health-dashboard \
  -o yaml | grep -A5 'SSL_EXCLUDE'
```

---

## Check Shows "Error" Status

**Symptom:** A check shows `Error` status with a message like `Check failed: oc command failed`.

**Step 1 — Get the full error:**

Click the row in the dashboard to expand the raw output panel. The full error message from `oc` will be shown.

**Step 2 — Run the oc command manually:**
```bash
oc exec -n ocp-health-dashboard \
  deployment/ocp-health-dashboard -- \
  oc get nodes --no-headers
```

Replace `get nodes --no-headers` with the relevant command for the failing check.

**Step 3 — Check RBAC:**
```bash
oc auth can-i get nodes \
  --as=system:serviceaccount:ocp-health-dashboard:ocp-health-sa
```

Expected: `yes`

If `no`, verify the ClusterRoleBinding is present and bound to the correct ServiceAccount:
```bash
oc get clusterrolebinding ocp-health-dashboard-cluster-admin -o yaml
```

---

## maxBuffer Length Exceeded

**Symptom:** A check returns error `stdout maxBuffer length exceeded`.

**Cause:** The `oc` command returned more data than the configured buffer limit.

**Resolution:**

The SSL check uses a 50 MB buffer and the go-template approach to filter at the `oc` side (only emitting TLS secrets with `tls.crt`). If you are still seeing this error for the SSL check, verify the current `security.js` is deployed (see above).

For other checks hitting the buffer limit (unlikely but possible on very large clusters), enable debug logging to identify which command is overflowing:

```bash
oc set env deployment/ocp-health-dashboard \
  LOG_LEVEL=debug -n ocp-health-dashboard
oc logs -n ocp-health-dashboard \
  -l app=ocp-health-dashboard -f | grep 'oc get\|maxBuffer'
```

---

## etcd Health Check Fails

**Symptom:** `etcd_health` check shows `Error: no etcd pod found` or similar.

**Check 1 — etcd pods:**
```bash
oc get pods -n openshift-etcd \
  -l app=etcd --no-headers
```

Expected: Three etcd pods in `Running` state.

**Check 2 — exec access:**
```bash
oc auth can-i create pods/exec \
  -n openshift-etcd \
  --as=system:serviceaccount:ocp-health-dashboard:ocp-health-sa
```

Expected: `yes` (granted via cluster-admin binding)

**Check 3 — etcdctl available:**
```bash
oc exec -n openshift-etcd \
  $(oc get pods -n openshift-etcd -l app=etcd -o name | head -1) \
  -- etcdctl endpoint health --cluster
```

If this succeeds from your workstation but fails inside the dashboard pod, check that the ServiceAccount token is being properly mounted.

---

## Node Limits Tab Shows No Data

**Symptom:** Node Limits tab shows "No data — run checks first or click Live Refresh."

**Cause:** The `node_limits` check has not run since the pod started, or it errored.

**Resolution:**

1. Trigger a manual run from the dashboard or API
2. Check the results tab for `node_limits` status
3. Click **↻ Live Refresh** in the Node Limits tab to fetch data right now without waiting for a full run

---

## PDB Tab Shows No Data

**Symptom:** PDB tab shows empty or "Error fetching PDB data."

**Check — PDB API:**
```bash
curl -s https://$(oc get route ocp-health-dashboard \
  -n ocp-health-dashboard -o jsonpath='{.spec.host}')/api/pdb | jq .
```

If this returns an error, check pod logs for the `pdb.js` module:
```bash
oc logs -n ocp-health-dashboard \
  -l app=ocp-health-dashboard --tail=100 \
  | grep -i pdb
```

**Check — oc get pdb:**
```bash
oc exec -n ocp-health-dashboard \
  deployment/ocp-health-dashboard -- \
  oc get pdb -A -o json | jq '.items | length'
```

If this returns 0, there are no PDBs in your cluster (which is a valid state — the tab will show no data).

---

## Storage Detail Column Shows Garbled Text

**Symptom:** The storage (or other) check result rows show characters like `29d")">` in the Detail cell.

**Cause:** This was a bug where `rawOutput` text was embedded directly into HTML `onclick` attributes. Special characters (`"`, `>`, `)`) in the text would break out of the attribute.

**Fix:** The current version stores all `rawOutput` in a JavaScript Map (`_rawMap`) keyed by an integer. The onclick attribute only contains the integer key. No text is embedded in HTML attributes.

**Verify the fix is deployed:**
```bash
curl -s https://$(oc get route ocp-health-dashboard \
  -n ocp-health-dashboard -o jsonpath='{.spec.host}') \
  | grep -c '_rawMap'
```

Expected: at least `1` (the Map is referenced in the script).

---

## PDF Reports Fail to Generate

**Symptom:** `/api/report/:runId/pdf` returns 500 or an empty file.

**Cause:** The PDF generator uses `puppeteer-core`, which requires a Chromium binary. On the minimal UBI image, the system Chromium may not be available.

**Workaround:** Use the JSON report instead:
```bash
curl -s https://${ROUTE}/api/report/latest/json | jq .
```

**To enable PDF generation**, ensure your container image includes Chromium:
```dockerfile
# Add to Containerfile:
RUN microdnf install -y chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

---

## Pod CrashLoopBackOff

**Symptom:** Pod repeatedly crashes.

**Get the exit reason:**
```bash
oc describe pod -n ocp-health-dashboard \
  -l app=ocp-health-dashboard \
  | grep -A5 'Last State\|Exit Code'

oc logs -n ocp-health-dashboard \
  -l app=ocp-health-dashboard --previous
```

**Common causes:**

| Exit Code | Likely Cause |
|---|---|
| `1` | JavaScript syntax error or missing module — check `package.json` and `npm install` |
| `137` | OOMKilled — increase memory limit in the Deployment |
| `143` | SIGTERM — normal graceful shutdown, not a crash |

**OOMKilled — increase memory:**
```yaml
# In the Deployment resources section:
resources:
  requests:
    memory: "256Mi"
  limits:
    memory: "1Gi"    # increase from 512Mi
```

---

## Image Pull Errors

**Symptom:** `ImagePullBackOff` in pod events.

**Check the event details:**
```bash
oc get events -n ocp-health-dashboard \
  --sort-by='.lastTimestamp' | tail -10
```

**Resolution by error type:**

| Error | Resolution |
|---|---|
| `unauthorized` | Re-run `podman login` to refresh the registry token |
| `manifest unknown` | The image tag does not exist in the registry — re-push |
| `connection refused` | Registry route is not accessible from cluster nodes |
| `x509: certificate` | Registry uses a self-signed cert — add it to the cluster trust bundle |

**Add a self-signed registry cert to the cluster:**
```bash
oc create configmap registry-trust \
  --from-file=your-registry.example.com=ca.crt \
  -n openshift-config

oc patch image.config.openshift.io/cluster \
  --type merge \
  -p '{"spec":{"additionalTrustedCA":{"name":"registry-trust"}}}'
```

---

## Collecting Diagnostic Information

When opening a GitHub issue or escalating a problem, collect this information:

```bash
#!/usr/bin/env bash
# collect-diag.sh

echo "=== Pod status ==="
oc get pods -n ocp-health-dashboard -o wide

echo ""
echo "=== Recent events ==="
oc get events -n ocp-health-dashboard \
  --sort-by='.lastTimestamp' | tail -20

echo ""
echo "=== Pod logs (last 100 lines) ==="
oc logs -n ocp-health-dashboard \
  -l app=ocp-health-dashboard --tail=100

echo ""
echo "=== ConfigMaps ==="
oc get configmap -n ocp-health-dashboard -o yaml | \
  grep -v 'resourceVersion\|uid\|creationTimestamp'

echo ""
echo "=== API status ==="
ROUTE=$(oc get route ocp-health-dashboard \
  -n ocp-health-dashboard \
  -o jsonpath='{.spec.host}' 2>/dev/null)
[ -n "${ROUTE}" ] && curl -sk "https://${ROUTE}/api/status" | jq . || echo "Route not available"

echo ""
echo "=== SSL debug ==="
[ -n "${ROUTE}" ] && curl -sk "https://${ROUTE}/api/ssl/debug" | jq . || echo "Route not available"
```

```bash
chmod +x collect-diag.sh
./collect-diag.sh > diag-$(date +%Y%m%d-%H%M%S).txt
```

Attach the output file to your issue report.
