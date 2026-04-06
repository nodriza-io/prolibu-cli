/**
 * cli/migrate/index.js
 *
 * Top-level router for `prolibu migrate <crm> <command> [options]`
 *
 * To add a new CRM (e.g. HubSpot):
 *   1. Create cli/migrate/adapters/hubspot/ with metadata.js and index.js
 *   2. It will be auto-detected — no changes needed here.
 */
const fs = require('fs');
const path = require('path');

/**
 * Auto-discover available CRMs by scanning for folders with a metadata.js file.
 */
function discoverCRMs() {
  const dir = path.join(__dirname, 'adapters');
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'metadata.js')))
    .map(d => d.name);
}

module.exports = async function migrateHandler(command, flags, args) {
  const crm = command;
  const subcommand = args[2];

  const availableCRMs = discoverCRMs();

  if (!crm && !flags.ui) {
    console.log('Usage: prolibu migrate <crm> <command> [options]');
    console.log('       prolibu migrate configure [options]');
    console.log('       prolibu migrate --ui [options]');
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
    console.log('Commands:');
    console.log('  configure    Set up source CRM credentials (guided wizard)');
    console.log('');
    console.log('Flags:');
    console.log('  --ui         Start the migration dashboard (interactive web UI)');
    console.log('');
    console.log('Examples:');
    console.log('  prolibu migrate --ui --domain dev10.prolibu.com');
    if (availableCRMs.length) {
      const ex = availableCRMs[0];
      console.log(`  prolibu migrate configure --domain dev10.prolibu.com`);
      console.log(`  prolibu migrate configure --crm ${ex} --domain dev10.prolibu.com`);
      console.log(`  prolibu migrate ${ex} run --domain dev10.prolibu.com --entity all`);
      console.log(`  prolibu migrate ${ex} status --domain dev10.prolibu.com`);
    }
    return;
  }

  // ── Top-level "ui" flag (CRM-agnostic dashboard) ──────────
  if (flags.ui) {
    const startUI = require('../commands/migrate/ui');
    await startUI(flags);
    return;
  }

  // ── configure — guided wizard with CRM selector ─────────
  if (crm === 'configure') {
    let selectedCRM = flags.crm;
    if (!selectedCRM) {
      const inquirer = await import('inquirer');
      const choices = availableCRMs.map(c => {
        let label = c;
        try { label = require(`./adapters/${c}/metadata`).label || c; } catch { }
        return { name: label, value: c };
      });
      const { picked } = await inquirer.default.prompt({
        type: 'list',
        name: 'picked',
        message: 'Which CRM are you migrating FROM?',
        choices,
      });
      selectedCRM = picked;
    }
    const configureCRM = require(`./adapters/${selectedCRM}/configure`);
    await configureCRM(flags);
    return;
  }

  // ── Intercept '<crm> configure' → unified configure flow ─
  if (subcommand === 'configure') {
    flags.crm = flags.crm || crm;
    const configureCRM = require(`./adapters/${flags.crm}/configure`);
    await configureCRM(flags);
    return;
  }

  // ── CRM-specific commands ────────────────────────────────
  const crmDir = path.join(__dirname, 'adapters', crm);
  if (!availableCRMs.includes(crm) || !fs.existsSync(path.join(crmDir, 'index.js'))) {
    console.error(`❌ Unknown CRM: ${crm}`);
    console.log(`Available CRMs: ${availableCRMs.join(', ') || '(none)'}`);
    process.exit(1);
  }

  const crmHandler = require(`./adapters/${crm}/index`);
  await crmHandler(subcommand, flags, args);
};
