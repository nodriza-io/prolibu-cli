const VALID_TYPES = ['string', 'number', 'boolean', 'date', 'objectid', 'mixed', 'array'];

module.exports = async function createObject(flags) {
  const chalk = (await import('chalk')).default;
  const inquirer = await import('inquirer');
  const fs = require('fs');
  const path = require('path');
  const { resolveDomainAndKey } = require('../../core/domainResolver');

  const { domain } = await resolveDomainAndKey(flags);

  // 1. modelName
  let modelName = flags.modelName;
  if (!modelName) {
    const r = await inquirer.default.prompt({
      type: 'input',
      name: 'modelName',
      message: 'Model name (PascalCase, e.g. Pet, Vehicle):',
      validate: (v) => {
        if (!v) return 'Model name is required.';
        if (!/^[A-Z][a-zA-Z0-9]*$/.test(v)) return 'Must be PascalCase (start with uppercase, no spaces/hyphens).';
        return true;
      },
    });
    modelName = r.modelName;
  }

  // 2. Interactive field builder
  console.log(chalk.cyan(`\nDefine fields for ${modelName} (press Enter with empty name to finish):\n`));

  const fields = {};
  let addMore = true;

  while (addMore) {
    const { fieldName } = await inquirer.default.prompt({
      type: 'input',
      name: 'fieldName',
      message: 'Field name (camelCase, empty to finish):',
    });

    if (!fieldName || !fieldName.trim()) {
      addMore = false;
      break;
    }

    const { fieldType } = await inquirer.default.prompt({
      type: 'list',
      name: 'fieldType',
      message: `Type for '${fieldName}':`,
      choices: VALID_TYPES,
      default: 'string',
    });

    const { required } = await inquirer.default.prompt({
      type: 'confirm',
      name: 'required',
      message: 'Required?',
      default: false,
    });

    const { displayName } = await inquirer.default.prompt({
      type: 'confirm',
      name: 'displayName',
      message: 'Display name (used as label in UI)?',
      default: false,
    });

    const field = { type: fieldType };
    if (required) field.required = true;
    if (displayName) field.displayName = true;

    // Extra options per type
    if (fieldType === 'string') {
      const { hasEnum } = await inquirer.default.prompt({
        type: 'confirm',
        name: 'hasEnum',
        message: 'Restrict to specific values (enum)?',
        default: false,
      });
      if (hasEnum) {
        const { enumValues } = await inquirer.default.prompt({
          type: 'input',
          name: 'enumValues',
          message: 'Enum values (comma separated):',
        });
        if (enumValues.trim()) {
          field.enum = enumValues.split(',').map((v) => v.trim()).filter(Boolean);
        }
      }
    } else if (fieldType === 'number') {
      const { hasMin } = await inquirer.default.prompt({
        type: 'confirm', name: 'hasMin', message: 'Set minimum value?', default: false,
      });
      if (hasMin) {
        const { min } = await inquirer.default.prompt({
          type: 'number', name: 'min', message: 'Min value:',
        });
        field.min = min;
      }
      const { hasMax } = await inquirer.default.prompt({
        type: 'confirm', name: 'hasMax', message: 'Set maximum value?', default: false,
      });
      if (hasMax) {
        const { max } = await inquirer.default.prompt({
          type: 'number', name: 'max', message: 'Max value:',
        });
        field.max = max;
      }
    } else if (fieldType === 'objectid') {
      const { ref } = await inquirer.default.prompt({
        type: 'input',
        name: 'ref',
        message: 'Reference model (e.g. User, Contact, Deal):',
      });
      if (ref.trim()) field.ref = ref.trim();
    }

    const { description } = await inquirer.default.prompt({
      type: 'input',
      name: 'description',
      message: 'Description (optional):',
      default: '',
    });
    if (description.trim()) field.description = description.trim();

    fields[fieldName.trim()] = field;
    console.log(chalk.green(`  ✅ ${fieldName}: ${fieldType}`));
    console.log('');
  }

  // 3. Build COB definition
  const cobDef = {
    modelName,
    active: true,
    ...fields,
  };

  // 4. Write to local file
  const cobDir = path.join(process.cwd(), 'accounts', domain, 'objects', 'Cob');
  fs.mkdirSync(cobDir, { recursive: true });

  const filePath = path.join(cobDir, `${modelName}.json`);
  if (fs.existsSync(filePath)) {
    const { overwrite } = await inquirer.default.prompt({
      type: 'confirm',
      name: 'overwrite',
      message: `${modelName}.json already exists. Overwrite?`,
      default: false,
    });
    if (!overwrite) {
      console.log('Aborted.');
      return;
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(cobDef, null, 2));
  console.log(chalk.green(`\n✅ ${modelName}.json created at accounts/${domain}/objects/Cob/`));
  console.log(chalk.gray(JSON.stringify(cobDef, null, 2)));

  // 5. Ask if they want to push to platform
  const { pushNow } = await inquirer.default.prompt({
    type: 'confirm',
    name: 'pushNow',
    message: 'Push to the platform now?',
    default: false,
  });

  if (pushNow) {
    const api = require('../../../api/cobClient');
    const { apiKey } = await resolveDomainAndKey(flags);
    try {
      const result = await api.createCob(domain, apiKey, cobDef);
      console.log(chalk.green(`✅ Custom Object '${result.modelName}' created on the platform`));
      console.log(chalk.gray(`   ID: ${result._id}`));
      console.log(chalk.gray(`   API: /v2/${result.modelName.toLowerCase()}`));
    } catch (err) {
      const errData = err.response?.data;
      console.error(chalk.red(`❌ Error: ${errData?.error || err.message}`));
    }
  }
};
