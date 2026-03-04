const fs = require('fs');
const path = require('path');

const ACCOUNTS_DIR = path.join(process.cwd(), 'accounts');

/**
 * Get path to last-run log file
 * accounts/<domain>/migrations/<crm>/last-run.json
 */
function getLogPath(domain, crm) {
  return path.join(ACCOUNTS_DIR, domain, 'migrations', crm, 'last-run.json');
}

/**
 * Create a fresh log object to track a migration run
 */
function createLog() {
  return {
    started: new Date().toISOString(),
    completed: null,
    dryRun: false,
    entities: {},
    errors: [],
  };
}

/**
 * Read the last run log for a domain/crm
 * @returns {object|null}
 */
function readLog(domain, crm) {
  const filePath = getLogPath(domain, crm);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save the log to disk
 */
function saveLog(domain, crm, log) {
  const filePath = getLogPath(domain, crm);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
}

/**
 * Mark a migration run as complete and persist it
 */
function finalizeLog(domain, crm, log) {
  log.completed = new Date().toISOString();
  saveLog(domain, crm, log);
}

/**
 * Record entity-level stats into the log
 */
function recordEntityResult(log, entity, { migrated = 0, skipped = 0, errors = [] }) {
  log.entities[entity] = { migrated, skipped, errors };
  log.errors.push(...errors.map(e => ({ entity, error: e })));
}

/**
 * Print a summary of the log to stdout
 */
function printSummary(log) {
  console.log('');
  console.log('📊 Migration Summary');
  console.log(`   Started:   ${log.started}`);
  console.log(`   Completed: ${log.completed || '(not finished)'}`);
  if (log.dryRun) console.log('   ⚠️  DRY RUN — no data was written to Prolibu');
  console.log('');
  const entities = Object.entries(log.entities);
  if (entities.length === 0) {
    console.log('   No entities processed.');
  } else {
    for (const [entity, stats] of entities) {
      console.log(`   ${entity}: ✅ ${stats.migrated} migrated, ⏭️ ${stats.skipped} skipped, ❌ ${stats.errors.length} errors`);
    }
  }
  if (log.errors.length > 0) {
    console.log('');
    console.log('❌ Errors:');
    log.errors.forEach(({ entity, error }) => {
      console.log(`   [${entity}] ${error}`);
    });
  }
  console.log('');
}

module.exports = {
  getLogPath,
  createLog,
  readLog,
  saveLog,
  finalizeLog,
  recordEntityResult,
  printSummary,
};
