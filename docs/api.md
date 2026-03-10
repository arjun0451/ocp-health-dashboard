# API Reference

All endpoints are served by the Express HTTP server on port 8080 inside the pod and exposed via the OpenShift Route at the cluster URL.

**Base URL:** `https://<route-host>`

All responses are JSON unless otherwise noted. All endpoints are unauthenticated within the cluster network — access is controlled by the Route and any OpenShift OAuth proxy you choose to place in front.

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/status` | Current run state |
| `GET` | `/api/results` | Latest check results |
| `POST` | `/api/run` | Trigger a manual run |
| `GET` | `/api/history` | List past run IDs |
| `GET` | `/api/history/:runId` | Results for a specific run |
| `GET` | `/api/config` | Active configuration |
| `POST` | `/api/config/reload` | Reload config from disk |
| `GET` | `/api/report/:runId/json` | JSON report for a run |
| `GET` | `/api/report/:runId/pdf` | PDF report for a run |
| `GET` | `/api/report/latest/json` | JSON report for latest run |
| `GET` | `/api/report/latest/pdf` | PDF report for latest run |
| `GET` | `/api/docs` | All check documentation |
| `GET` | `/api/docs/:checkId` | Documentation for one check |
| `GET` | `/api/ssl/certs` | All TLS cert data |
| `GET` | `/api/ssl/debug` | Raw oc output debug info |
| `GET` | `/api/nodes/limits` | Node resource limit data |
| `GET` | `/api/pdb` | PDB analysis data |
| `GET` | `/healthz` | Liveness probe |
| `GET` | `/readyz` | Readiness probe |
| `GET` | `/artifacts/*` | Static artifact files |

---

## GET /api/status

Returns the current scheduler state.

**Response:**
```json
{
  "status": "ok",
  "isRunning": false,
  "lastRunTime": "2024-03-10T16:21:14.000Z",
  "lastRunId": "run-1710080474000",
  "triggeredBy": "scheduler",
  "clusterID": "prod-cluster",
  "mockMode": false
}
```

| Field | Type | Description |
|---|---|---|
| `isRunning` | boolean | `true` while a check run is in progress |
| `lastRunTime` | ISO string | Timestamp of last completed run |
| `lastRunId` | string | ID used to fetch results and reports |
| `triggeredBy` | string | `"scheduler"`, `"startup"`, or `"api"` |
| `clusterID` | string | Configured `CLUSTER_ID` value |
| `mockMode` | boolean | `true` if server started with `MOCK_MODE=true` |

---

## GET /api/results

Returns the results of the most recent check run.

**Response:**
```json
{
  "clusterID": "prod-cluster",
  "lastRunTime": "2024-03-10T16:21:14.000Z",
  "lastRunId": "run-1710080474000",
  "isRunning": false,
  "results": [
    {
      "no": 1,
      "id": "cluster_operators",
      "name": "Cluster Operators",
      "category": "control_plane",
      "status": "Passed",
      "detail": "All 20 operators healthy",
      "rawOutput": "",
      "durationMs": 412,
      "artifactPath": null
    },
    {
      "no": 17,
      "id": "ssl_certificates",
      "name": "SSL Certificate Expiry",
      "category": "security",
      "status": "Failed",
      "detail": "3 cert(s) expiring within 30 days. Checked 182 certs (232 TLS found, 50 excluded)",
      "rawOutput": "openshift-compliance/result-client-cert-ocp4-cis  expires: 2026-03-11  (1d left)\n...",
      "durationMs": 3908,
      "artifactPath": null
    }
  ]
}
```

**`status` values:** `"Passed"`, `"Failed"`, `"Error"`, `"Skipped"`

---

## POST /api/run

Triggers an immediate check run. Returns immediately; the run continues asynchronously.

**Response (200):**
```json
{ "message": "Run triggered", "triggeredBy": "api" }
```

**Response (409 — already running):**
```json
{ "error": "A run is already in progress" }
```

---

## GET /api/history

Returns a list of past run IDs, newest first.

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `limit` | `20` | Maximum number of runs to return |

**Response:**
```json
{
  "runs": [
    {
      "runId": "run-1710080474000",
      "runTime": "2024-03-10T16:21:14.000Z",
      "passed": 18,
      "failed": 1,
      "total": 19
    }
  ]
}
```

---

## GET /api/history/:runId

Returns full check results for a specific past run.

**Path parameters:**

| Parameter | Description |
|---|---|
| `:runId` | Run ID from `/api/history` |

**Response:** Same shape as `/api/results` but for the specified run.

**Response (404):**
```json
{ "error": "Run not found" }
```

---

## GET /api/config

Returns the active configuration loaded from environment variables and the checks YAML.

**Response:**
```json
{
  "scheduleHours": 12,
  "runOnStartup": true,
  "retentionDays": 30,
  "categories": ["control_plane", "nodes", "pods", "networking", "storage", "security", "monitoring", "availability"],
  "checks": [
    {
      "id": "cluster_operators",
      "name": "Cluster Operators",
      "category": "control_plane",
      "enabled": true
    }
  ]
}
```

---

## POST /api/config/reload

Reloads the `checks-config.yaml` from disk (useful after editing the ConfigMap without restarting the pod). Environment variable overrides are re-read from the process environment.

**Response:**
```json
{ "message": "Config reloaded", "enabledChecks": 19 }
```

---

## GET /api/report/:runId/json

Returns a structured JSON report for the specified run.

**Path parameters:**

| Parameter | Description |
|---|---|
| `:runId` | Run ID or `"latest"` |

**Response:** Full report object with run metadata, summary counts, and per-check results.

---

## GET /api/report/:runId/pdf

Returns a PDF report for the specified run as a binary download.

**Path parameters:**

| Parameter | Description |
|---|---|
| `:runId` | Run ID or `"latest"` |

**Response headers:**
```
Content-Type: application/pdf
Content-Disposition: attachment; filename="ocp-health-report-<runId>.pdf"
```

---

## GET /api/docs

Returns inline documentation for all checks.

**Response:**
```json
{
  "docs": [
    {
      "id": "ssl_certificates",
      "title": "SSL Certificate Expiry",
      "what": "Scans all kubernetes.io/tls secrets...",
      "why": "Expired certificates cause service outages...",
      "fail": "Common causes of failure...",
      "fix": "Remediation steps..."
    }
  ]
}
```

---

## GET /api/docs/:checkId

Returns documentation for a single check.

**Path parameters:**

| Parameter | Description |
|---|---|
| `:checkId` | Check ID, e.g. `ssl_certificates` |

**Response (200):** Single doc object (same shape as items in `/api/docs`)

**Response (404):**
```json
{ "error": "No documentation found for check: unknown_check" }
```

---

## GET /api/ssl/certs

Returns all parsed TLS certificate data from the cluster. Called by the SSL Certificates tab.

**Response:**
```json
{
  "certs": [
    {
      "ns": "open-cluster-management-hub",
      "name": "registration-webhook-serving-cert",
      "excluded": false,
      "notBefore": "2026-03-06",
      "notAfter": "2026-04-05",
      "daysLeft": 26
    },
    {
      "ns": "openshift-kube-apiserver",
      "name": "aggregator-client",
      "excluded": true,
      "notBefore": "2026-03-03",
      "notAfter": "2026-04-01",
      "daysLeft": 22
    }
  ],
  "total": 198,
  "stats": {
    "totalTLSFound": 232,
    "parsed": 198,
    "skippedParseErr": 0,
    "excluded": 16,
    "checked": 182,
    "excludeMode": "blacklist",
    "activeFilter": "blacklist: openshift-compliance, openshift-kube-apiserver, ..."
  }
}
```

**`certs` array fields:**

| Field | Type | Description |
|---|---|---|
| `ns` | string | Secret namespace |
| `name` | string | Secret name |
| `excluded` | boolean | `true` if in an excluded namespace |
| `notBefore` | string | `YYYY-MM-DD` — certificate start date |
| `notAfter` | string | `YYYY-MM-DD` — certificate expiry date |
| `daysLeft` | number | Days until expiry (negative = expired) |

**`stats` object fields:**

| Field | Description |
|---|---|
| `totalTLSFound` | TLS secrets found with `tls.crt` key |
| `parsed` | Successfully date-parsed |
| `skippedParseErr` | Failed to parse (malformed DER) |
| `excluded` | In excluded namespace |
| `checked` | Non-excluded, actively monitored |
| `excludeMode` | `"blacklist"` or `"whitelist"` |
| `activeFilter` | Comma-separated list of active filter namespaces |

**Error response (500):**
```json
{
  "error": "oc command failed: ...",
  "certs": [],
  "total": 0,
  "stats": { "totalTLSFound": 0, "parsed": 0, ... }
}
```

---

## GET /api/ssl/debug

Returns raw `oc` output samples for troubleshooting the SSL cert query. Useful if `parsed: 0` or parse errors are observed.

**Response:**
```json
{
  "rawLength": 48320,
  "recordCount": 232,
  "delimiter": "|||",
  "template": "{{range .items}}{{if and (eq .type \"kubernetes.io/tls\")...}}",
  "sampleRecords": [
    "open-cluster-management-hub registration-webhook-serving-cert LS0tLS1CRUdJTi...",
    "openshift-compliance result-client-cert-ocp4-cis LS0tLS1CRUdJTi..."
  ]
}
```

---

## GET /api/nodes/limits

Returns node resource allocation data. Called by the Node Limits tab.

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `live` | `false` | If `true`, re-runs `oc describe node` for all nodes right now |

**Response:**
```json
{
  "rows": [
    {
      "node": "worker-0",
      "cpuReqCores": "4200m",
      "cpuReqPct": 55,
      "cpuLimCores": "8000m",
      "cpuLimPct": 105,
      "memReqGiB": "8.0",
      "memReqPct": 52,
      "memLimGiB": "14.0",
      "memLimPct": 92,
      "over100": true
    }
  ]
}
```

---

## GET /api/pdb

Returns PodDisruptionBudget analysis. Called by the PDB Analysis tab.

**Response:**
```json
{
  "rows": [
    {
      "ns": "production",
      "name": "api-pdb",
      "type": "minAvailable",
      "expected": 3,
      "healthy": 3,
      "disruptionsAllowed": 1,
      "disruptionsPercent": 33,
      "remark": "1 of 3 pods can be disrupted",
      "color": "green"
    },
    {
      "ns": "production",
      "name": "worker-pdb",
      "type": "minAvailable",
      "expected": 1,
      "healthy": 1,
      "disruptionsAllowed": 0,
      "disruptionsPercent": 0,
      "remark": "Fully blocked",
      "color": "red"
    }
  ],
  "summary": {
    "total": 12,
    "blocked": 1,
    "lowHA": 3,
    "safe": 7,
    "fullOutage": 1
  }
}
```

**`color` values:** `"red"`, `"orange"`, `"green"`, `"blue"`, `"grey"`

---

## GET /healthz

Kubernetes liveness probe endpoint. Returns 200 if the server process is alive.

**Response (200):**
```json
{ "status": "ok" }
```

---

## GET /readyz

Kubernetes readiness probe endpoint. Returns 200 once the server has initialised and is ready to serve traffic.

**Response (200):**
```json
{ "status": "ready" }
```

---

## Example: Shell Script Using the API

```bash
#!/usr/bin/env bash
# quick-check.sh — trigger a run and wait for completion

ROUTE=$(oc get route ocp-health-dashboard \
  -n ocp-health-dashboard \
  -o jsonpath='{.spec.host}')
BASE="https://${ROUTE}"

echo "Triggering check run..."
curl -sf -X POST "${BASE}/api/run" | jq .

echo "Waiting for run to complete..."
while true; do
  RUNNING=$(curl -sf "${BASE}/api/status" | jq -r '.isRunning')
  [ "${RUNNING}" = "false" ] && break
  sleep 3
done

echo "Results:"
curl -sf "${BASE}/api/results" | jq '
  .results[] | 
  select(.status == "Failed" or .status == "Error") | 
  { check: .name, status: .status, detail: .detail }'
```
