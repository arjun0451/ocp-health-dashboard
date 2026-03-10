'use strict';

const fs   = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const logger = require('./logger');

const CONFIG_PATH = process.env.CONFIG_PATH ||
  path.join(__dirname, '../config/checks-config.yaml');

let _cache = null;

/**
 * Load and parse the checks-config.yaml.
 * Results are cached for the lifetime of the process (ConfigMap changes need a pod restart,
 * which is normal OCP behaviour).
 */
function loadConfig() {
  if (_cache) return _cache;

  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    logger.warn(`Config file not found at ${CONFIG_PATH}, using defaults`);
    raw = '';
  }

  const parsed = yaml.load(raw) || {};

  // Env var overrides (from ConfigMap data keys)
  const scheduleHours = parseInt(
    process.env.SCHEDULE_HOURS || parsed.schedule_hours || 12, 10
  );
  const runOnStartup = (process.env.RUN_ON_STARTUP || String(parsed.run_on_startup ?? 'true')) === 'true';
  const retentionDays = parseInt(
    process.env.ARTIFACT_RETENTION_DAYS || parsed.artifact_retention_days || 30, 10
  );

  // Build a map of check overrides from env, e.g. CHECK_SSL_CERTIFICATES=false
  const checks = (parsed.checks || []).map(c => {
    const envKey = `CHECK_${c.id.toUpperCase()}`;
    const envOverride = process.env[envKey];
    return {
      ...c,
      enabled: envOverride !== undefined ? envOverride === 'true' : c.enabled !== false
    };
  });

  _cache = {
    scheduleHours,
    runOnStartup,
    retentionDays,
    categories: parsed.categories || [],
    checks
  };

  logger.info(`Config loaded: ${checks.filter(c => c.enabled).length}/${checks.length} checks enabled, schedule every ${scheduleHours}h`);
  return _cache;
}

/** Return only enabled checks, optionally filtered by category */
function getEnabledChecks(category) {
  const cfg = loadConfig();
  return cfg.checks.filter(c => c.enabled && (!category || c.category === category));
}

/** Invalidate cache (e.g. for hot-reload in dev) */
function reloadConfig() {
  _cache = null;
  return loadConfig();
}

module.exports = { loadConfig, getEnabledChecks, reloadConfig };
