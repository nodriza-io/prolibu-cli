'use strict';

const path = require('path');
const fs = require('fs');
const { listCustomFields } = require('../../../../../api/customFieldClient');
const { listCobs } = require('../../../../../api/cobClient');

/**
 * Phase: scaffold
 *
 * Pulls custom fields and custom objects from the SOURCE Prolibu account
 * and saves them to accounts/<domain>/objects/ (like `objects pull`).
 *
 * Does NOT push to the destination — use `prolibu objects push` or
 * `prolibu customfield push` / `prolibu cob push` for that.
 */
async function scaffold({ domain, sourceDomain, sourceApiKey }) {
  console.log(`🔧 Scaffolding schema from ${sourceDomain} → ${domain}`);
  console.log('');

  const accountDir = path.resolve(__dirname, '..', '..', '..', '..', '..', 'accounts', domain);
  const cfDir = path.join(accountDir, 'objects', 'CustomField');
  const cobDir = path.join(accountDir, 'objects', 'Cob');
  fs.mkdirSync(cfDir, { recursive: true });
  fs.mkdirSync(cobDir, { recursive: true });

  // ─── 1. Custom Fields ────────────────────────────────────────

  console.log('🏷  Fetching custom fields...');

  let sourceCFs = [];
  try {
    const result = await listCustomFields(sourceDomain, sourceApiKey, { limit: 200 });
    sourceCFs = result?.data || result || [];
  } catch (err) {
    console.error(`   ❌ Could not fetch source custom fields: ${err.message}`);
    console.error(`   💡 Verify sourceApiKey is valid and ${sourceDomain} is reachable`);
  }

  if (sourceCFs.length > 0) {
    for (const cf of sourceCFs) {
      const name = cf.objectAssigned || cf._id;
      fs.writeFileSync(path.join(cfDir, `${name}.json`), JSON.stringify(cf, null, 2), 'utf8');
    }
    console.log(`   💾 Saved ${sourceCFs.length} custom field(s) → objects/CustomField/`);
  } else {
    console.log('   ⚠️  No custom fields found in source account');
  }

  // ─── 2. Custom Objects (COBs) ─────────────────────────────────

  console.log('');
  console.log('📦 Fetching custom objects (COBs)...');

  let sourceCobs = [];
  try {
    const result = await listCobs(sourceDomain, sourceApiKey, { limit: 200 });
    sourceCobs = result?.data || result || [];
  } catch (err) {
    console.error(`   ❌ Could not fetch source COBs: ${err.message}`);
    console.error(`   💡 Verify sourceApiKey is valid and ${sourceDomain} is reachable`);
  }

  if (sourceCobs.length > 0) {
    for (const cob of sourceCobs) {
      const name = cob.modelName || cob._id;
      fs.writeFileSync(path.join(cobDir, `${name}.json`), JSON.stringify(cob, null, 2), 'utf8');
    }
    console.log(`   💾 Saved ${sourceCobs.length} COB(s) → objects/Cob/`);
  } else {
    console.log('   ⚠️  No custom objects found in source account');
  }

  // ─── Summary ─────────────────────────────────────────────────

  const totalSaved = sourceCFs.length + sourceCobs.length;

  console.log('');
  console.log(`✅ Scaffold complete — ${totalSaved} saved to disk`);
  console.log(`📁 Files written to accounts/${domain}/objects/`);
  console.log('');
}

module.exports = scaffold;
