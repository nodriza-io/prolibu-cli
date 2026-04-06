const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
/* global describe, beforeAll, afterAll, it, expect */

const config = require('./config.json');

const TEST_DOMAIN = config.domain; // dev12.prolibu.com
const MIGRATIONS_DIR = path.join(__dirname, '..', 'accounts', TEST_DOMAIN, 'migrations');

const SF_CREDS = {
    instanceUrl: 'https://test.salesforce.com/',
    clientKey: 'testClientKey',
    clientSecret: 'testClientSecret',
};

const PROLIBU_CREDS = {
    sourceDomain: 'source.prolibu.com',
    sourceApiKey: 'testSourceApiKey',
};

describe('Prolibu CLI - migrate configure', () => {
    beforeAll(() => {
        // Clean up any existing credentials from previous test runs
        const sfCreds = path.join(MIGRATIONS_DIR, 'salesforce', 'credentials.json');
        const plCreds = path.join(MIGRATIONS_DIR, 'prolibu', 'credentials.json');
        if (fs.existsSync(sfCreds)) fs.unlinkSync(sfCreds);
        if (fs.existsSync(plCreds)) fs.unlinkSync(plCreds);
    });

    afterAll(() => {
        // Leave files in place — they're under accounts/<domain> which is already gitignored per CRM norms
    });

    it('salesforce configure saves credentials with all flags', () => {
        execSync(
            `./prolibu migrate salesforce configure` +
            ` --domain ${TEST_DOMAIN}` +
            ` --apikey ${config.apiKey}` +
            ` --instance-url "${SF_CREDS.instanceUrl}"` +
            ` --client-key "${SF_CREDS.clientKey}"` +
            ` --client-secret "${SF_CREDS.clientSecret}"`,
            { stdio: 'inherit' }
        );

        const creds = JSON.parse(
            fs.readFileSync(path.join(MIGRATIONS_DIR, 'salesforce', 'credentials.json'), 'utf8')
        );
        expect(creds.instanceUrl).toBe(SF_CREDS.instanceUrl);
        expect(creds.clientKey).toBe(SF_CREDS.clientKey);
        expect(creds.clientSecret).toBe(SF_CREDS.clientSecret);
    });

    it('prolibu configure saves credentials with all flags', () => {
        execSync(
            `./prolibu migrate prolibu configure` +
            ` --domain ${TEST_DOMAIN}` +
            ` --apikey ${config.apiKey}` +
            ` --source-domain "${PROLIBU_CREDS.sourceDomain}"` +
            ` --source-api-key "${PROLIBU_CREDS.sourceApiKey}"`,
            { stdio: 'inherit' }
        );

        const creds = JSON.parse(
            fs.readFileSync(path.join(MIGRATIONS_DIR, 'prolibu', 'credentials.json'), 'utf8')
        );
        expect(creds.sourceDomain).toBe(PROLIBU_CREDS.sourceDomain);
        expect(creds.sourceApiKey).toBe(PROLIBU_CREDS.sourceApiKey);
    });

    it('configure --crm salesforce saves credentials (generic configure + --crm flag)', () => {
        // Remove so we confirm it's re-created
        const sfCreds = path.join(MIGRATIONS_DIR, 'salesforce', 'credentials.json');
        if (fs.existsSync(sfCreds)) fs.unlinkSync(sfCreds);

        execSync(
            `./prolibu migrate configure` +
            ` --crm salesforce` +
            ` --domain ${TEST_DOMAIN}` +
            ` --apikey ${config.apiKey}` +
            ` --instance-url "${SF_CREDS.instanceUrl}"` +
            ` --client-key "${SF_CREDS.clientKey}"` +
            ` --client-secret "${SF_CREDS.clientSecret}"`,
            { stdio: 'inherit' }
        );

        const creds = JSON.parse(fs.readFileSync(sfCreds, 'utf8'));
        expect(creds.instanceUrl).toBe(SF_CREDS.instanceUrl);
    });

    it('configure --crm prolibu saves credentials (generic configure + --crm flag)', () => {
        const plCreds = path.join(MIGRATIONS_DIR, 'prolibu', 'credentials.json');
        if (fs.existsSync(plCreds)) fs.unlinkSync(plCreds);

        execSync(
            `./prolibu migrate configure` +
            ` --crm prolibu` +
            ` --domain ${TEST_DOMAIN}` +
            ` --apikey ${config.apiKey}` +
            ` --source-domain "${PROLIBU_CREDS.sourceDomain}"` +
            ` --source-api-key "${PROLIBU_CREDS.sourceApiKey}"`,
            { stdio: 'inherit' }
        );

        const creds = JSON.parse(fs.readFileSync(plCreds, 'utf8'));
        expect(creds.sourceDomain).toBe(PROLIBU_CREDS.sourceDomain);
        expect(creds.sourceApiKey).toBe(PROLIBU_CREDS.sourceApiKey);
    });
});
