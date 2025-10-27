// GET /v2/script/run with body { scriptId: scriptCode }
async function runScript(domain, apiKey, scriptCode) {
  const url = `https://${domain}/v2/script/run?scriptId=${scriptCode}`;
  try {
    const response = await axios({
      method: 'get',
      url,
      // data: { scriptId: scriptCode },
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
    // console.log('[DEBUG] runScript response:', response.data);
    const result = response.data;
    
    // Wait a bit for socket logs to arrive before showing results
    await new Promise(resolve => setTimeout(resolve, 500));
    
    let chalk;
    try {
      chalk = await import('chalk');
    } catch {
      chalk = null;
    }

    const gray = (str) => chalk ? chalk.default.gray(str) : str;
    const green = (str) => chalk ? chalk.default.green(str) : str;
    const red = (str) => chalk ? chalk.default.red(str) : str;
    // Errors block - simplified
    if (result.error) {
      console.log(`\n${red('[DONE WITH ERRORS]')}\n`);
      console.error(red(result.error?.error || result.error));
    }
    // Output block - only show if not empty
    if (result.output !== undefined && !_.isEmpty(result.output)) {
      console.log(`\n${green('[OUTPUT] ' + '-'.repeat(60))}\n`);
      console.dir(result.output, { depth: null, colors: true });
    }
    // Execution time
    if (result.timeMs !== undefined) {
      console.log(`\n${gray('Execution time: ' + result.timeMs + ' ms')}`);
    }
    // Message to rerun script
    console.log(gray('Press [R] to run the script again (No build/upload)'));
    return result;
  } catch (err) {
    console.error(`Failed to run script ${scriptCode}:`, err.response?.data || err.message);
  }
}
// POST initial script document to /v2/script
async function createScriptDoc(domain, apiKey, scriptCode, scriptName, code, extra = {}) {
  const url = `https://${domain}/v2/script`;
  try {
    const body = {
      scriptCode,
      scriptName,
      code,
      active: true,
      ...extra
    };
    await axios.post(url, body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
    // Success
  } catch (err) {
    console.error(`Failed to create script ${scriptCode}:`, err.response?.data || err.message);
  }
}
const axios = require('axios');
const _ = require('lodash');

/**
 * Check if script exists, create if not
 * @param {string} domain - Domain (e.g., 'dev11.prolibu.com')
 * @param {string} apiKey - API key for authentication
 * @param {string} scriptCode - Script code (e.g., 'deal-report-dev')
 * @returns {Promise<boolean>} true if exists or created successfully
 */
async function ensureScriptExists(domain, apiKey, scriptCode) {
  const checkUrl = `https://${domain}/v2/script/${scriptCode}`;
  
  try {
    // Try to GET the script to see if it exists
    await axios.get(checkUrl, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    
    // Script exists
    return true;
  } catch (error) {
    // If 404, script doesn't exist - create it
    if (error.response?.status === 404) {
      console.log(`🔧 Script '${scriptCode}' not found. Creating...`);
      
      try {
        const createUrl = `https://${domain}/v2/script`;
        await axios.post(createUrl, {
          scriptCode,
          scriptName: scriptCode,
          code: '// Script will be synced from local files',
          active: true,
          readme: '# Script created automatically',
          variables: [],
          lifecycleHooks: []
        }, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
        });
        
        console.log(`✅ Script '${scriptCode}' created successfully!`);
        return true;
      } catch (createError) {
        console.error(`❌ Failed to create script '${scriptCode}':`, createError.response?.data || createError.message);
        return false;
      }
    }
    
    // Other error (not 404)
    console.error(`❌ Error checking script '${scriptCode}':`, error.response?.data || error.message);
    return false;
  }
}

// PATCH field to /v2/script/{scriptCode}
async function patchScript(domain, apiKey, scriptCode, value, field) {
  const url = `https://${domain}/v2/script/${scriptCode}`;
  try {
    await axios.patch(url, { [field]: value }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
    // Success
  } catch (err) {
    console.error(`Failed to PATCH ${field} for ${scriptCode}:`, err.response?.data || err.message);
  }
}

module.exports = {
  ensureScriptExists,
  patchScript,
  createScriptDoc,
  runScript,
};
