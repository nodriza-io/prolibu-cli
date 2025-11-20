const fs = require('fs');
const path = require('path');

function loadGlobalVariables(_env = 'dev') {
  global.env = _env;
  global.scriptCode = `${process.env.SCRIPT_PREFIX}-${_env}`;
  global.localDomain = process.env.DOMAIN;
  const projectPath = path.join(process.cwd(), 'accounts', process.env.DOMAIN, process.env.SCRIPT_PREFIX);
  const configPath = path.join(projectPath, 'config.json');
  
  // Read variables and lifecycleHooks from config.json
  if (fs.existsSync(configPath)) {
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    global.variables = configData.variables || [];
    global.lifecycleHooks = configData.lifecycleHooks || [];
  } else {
    global.variables = [];
    global.lifecycleHooks = [];
  }
  
  global.axios = require('axios');
  global.getVariable = require('../../lib/utils/variables').getVariable;
}

module.exports = { loadGlobalVariables };
