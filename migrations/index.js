/**
 * migrations/index.js
 *
 * Top-level router for `prolibu migrate <crm> <command> [options]`
 *
 * To add a new CRM (e.g. HubSpot):
 *   1. Create migrations/hubspot/ with metadata.js and index.js
 *   2. It will be auto-detected — no changes needed here.
 */
const fs = require('fs');
const path = require('path');

/**
 * Auto-discover available CRMs by scanning for folders with a metadata.js file.
 */
function discoverCRMs() {
  const dir = __dirname;
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'metadata.js')))
    .map(d => d.name);
}

module.exports = async function migrateHandler(command, flags, args) {
  const crm = command;
  const subcommand = args[2];

  const availableCRMs = discoverCRMs();

  if (!crm) {
    console.log('Usage: prolibu migrate <crm> <command> [options]');
    console.log('       prolibu migrate ui [options]');
    console.log('');
    console.log('CRMs:');
    for (const c of availableCRMs) {
      let label = c;
      try { label = require(`./${c}/metadata`).label || c; } catch { }
      console.log(`  ${c.padEnd(14)} Migrate from ${label} to Prolibu`);
    }
    if (!availableCRMs.length) {
      console.log('  (none found — add a CRM folder with metadata.js)');
    }
    console.log('');
    console.log('Dashboard:');
    console.log('  ui           Start the migration dashboard (interactive web UI)');
    console.log('');
    console.log('Examples:');
    console.log('  prolibu migrate ui --domain dev10.prolibu.com');
    if (availableCRMs.length) {
      const ex = availableCRMs[0];
      console.log(`  prolibu migrate ui --domain dev10.prolibu.com --crm ${ex}`);
      console.log(`  prolibu migrate ${ex} configure --domain dev10.prolibu.com`);
      console.log(`  prolibu migrate ${ex} run --domain dev10.prolibu.com --entity all`);
      console.log(`  prolibu migrate ${ex} status --domain dev10.prolibu.com`);
    }
    return;
  }

  // ── Top-level "ui" command (CRM-agnostic dashboard) ──────
  if (crm === 'ui') {
    const startUI = require('./ui');
    await startUI(flags);
    return;
  }

  // ── CRM-specific commands ────────────────────────────────
  const crmDir = path.join(__dirname, crm);
  if (!availableCRMs.includes(crm) || !fs.existsSync(path.join(crmDir, 'index.js'))) {
    console.error(`❌ Unknown CRM: ${crm}`);
    console.log(`Available CRMs: ${availableCRMs.join(', ') || '(none)'}`);
    process.exit(1);
  }

  const crmHandler = require(`./${crm}/index`);
  await crmHandler(subcommand, flags, args);
};
