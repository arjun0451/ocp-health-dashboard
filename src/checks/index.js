'use strict';
/**
 * checks/index.js – central registry
 * To add a new check: create src/checks/myModule.js, add to REGISTRY, add to checks-config.yaml.
 */

const { getEnabledChecks, loadConfig } = require('../configLoader');
const logger = require('../logger');

const { CHECKS: cpChecks }   = require('./controlPlane');
const { CHECKS: nodeChecks } = require('./nodes');
const { CHECKS: podChecks }  = require('./pods');
const { CHECKS: netChecks }  = require('./networking');
const { CHECKS: stgChecks }  = require('./storage');
const { CHECKS: secChecks }  = require('./security');
const { CHECKS: monChecks }  = require('./monitoring');
const { CHECKS: pdbChecks }  = require('./pdb');

const REGISTRY = {
  ...cpChecks,
  ...nodeChecks,
  ...podChecks,
  ...netChecks,
  ...stgChecks,
  ...secChecks,
  ...monChecks,
  ...pdbChecks,
};

async function runChecks() {
  const enabled = getEnabledChecks();
  const results = [];

  logger.info(`Running ${enabled.length} enabled checks...`);

  for (let i = 0; i < enabled.length; i++) {
    const checkCfg = enabled[i];
    const fn = REGISTRY[checkCfg.id];

    if (!fn) {
      logger.warn(`No implementation for check: ${checkCfg.id}`);
      results.push({ no: i+1, id: checkCfg.id, name: checkCfg.name,
                     category: checkCfg.category, status: 'Skipped',
                     detail: 'No implementation registered', rawOutput: '', artifactPath: null });
      continue;
    }

    try {
      const start  = Date.now();
      const result = await fn(checkCfg);
      const dur    = Date.now() - start;
      results.push({ no: i+1, durationMs: dur, artifactPath: null, ...result });
      logger.info(`[${String(i+1).padStart(2,'0')}] ${result.name}: ${result.status} (${dur}ms)`);
    } catch(err) {
      logger.error(`Check ${checkCfg.id} threw: ${err.message}`);
      results.push({ no: i+1, id: checkCfg.id, name: checkCfg.name,
                     category: checkCfg.category, status: 'Error',
                     detail: err.message, rawOutput: err.stack || err.message,
                     artifactPath: null, durationMs: 0 });
    }
  }
  return results;
}

module.exports = { runChecks, REGISTRY };
