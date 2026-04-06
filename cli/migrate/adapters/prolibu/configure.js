'use strict';

const path = require('path');
const fs = require('fs');
const credentialStore = require('../../shared/credentialStore');

/**
 * configure — save source Prolibu credentials for a domain.
 *
 * Stores under: accounts/<domain>/migrations/prolibu/credentials.json
 *   { sourceDomain, sourceApiKey }
 */
module.exports = async function configureProlibu(flags) {
    const inquirer = await import('inquirer');

    // 1. Resolve destination domain
    let domain = flags.domain;
    if (!domain) {
        const res = await inquirer.default.prompt({
            type: 'input',
            name: 'domain',
            message: 'Enter DESTINATION Prolibu domain (the one you are migrating INTO):',
            validate: (input) => (input ? true : 'Domain is required.'),
        });
        domain = res.domain;
    }
    if (!domain.includes('.')) domain = `${domain}.prolibu.com`;

    // 2. Resolve destination API key
    const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');
    let apiKey = flags.apikey;
    if (!apiKey && fs.existsSync(profilePath)) {
        try {
            const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            apiKey = profile.apiKey;
        } catch { }
    }
    if (!apiKey) {
        const res = await inquirer.default.prompt({
            type: 'input',
            name: 'apiKey',
            message: `Destination Prolibu API key for "${domain}":`,
            validate: (input) => (input ? true : 'API key is required.'),
        });
        apiKey = res.apiKey;
        fs.mkdirSync(path.dirname(profilePath), { recursive: true });
        fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));
    }

    // 3. Source Prolibu credentials
    const existing = credentialStore.getCredentials(domain, 'prolibu') || {};

    let sourceDomain = existing.sourceDomain || flags['source-domain'] || '';
    if (!sourceDomain) {
        const res = await inquirer.default.prompt({
            type: 'input',
            name: 'sourceDomain',
            message: 'Source Prolibu domain (the account you are migrating FROM):',
            validate: (input) => (input ? true : 'Source domain is required.'),
        });
        sourceDomain = res.sourceDomain;
    }

    let sourceApiKey = existing.sourceApiKey || flags['source-api-key'] || '';
    if (!sourceApiKey) {
        const res = await inquirer.default.prompt({
            type: 'password',
            name: 'sourceApiKey',
            message: `API key for source domain "${sourceDomain}":`,
            validate: (input) => (input ? true : 'Source API key is required.'),
        });
        sourceApiKey = res.sourceApiKey;
    }

    const src = sourceDomain.includes('.') ? sourceDomain : `${sourceDomain}.prolibu.com`;

    credentialStore.saveCredentials(domain, 'prolibu', { sourceDomain: src, sourceApiKey });
    console.log(`✅ Source Prolibu credentials saved for "${domain}" (source: ${src})`);
    console.log(`   Next step: prolibu migrate prolibu run --domain ${domain} --phase discover`);
    console.log('');
};
