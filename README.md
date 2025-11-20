# Prolibu CLI

**Official CLI for Prolibu v2** - Build, test and deploy Scripts, Sites and Plugins with automation, modularity, and seamless API integration.

## What you can do with Prolibu CLI

Prolibu CLI is a modern, developer-focused framework for building and deploying:

- **Scripts**: Lifecycle hooks, integrations, and automation workflows
- **Sites**: Static sites and Single Page Applications (SPAs)
- **Plugins**: UI extensions (coming soon)

Key features:
- 🎯 Interactive scaffolding for scripts and sites
- 🔄 Git repository integration and cloning
- 🔥 Real-time file watching with hot reload
- 📦 Automatic bundling and minification (scripts)
- 🗜️ Automatic zipping and deployment (sites)
- 🧪 Comprehensive testing framework
- 🌐 Local development server for sites
- 📝 Automatic README sync to API
- 🔧 Modular code via shared lib/ folder
- 🌍 Dev/prod environment support

---

## Requirements

- Node.js (v18 or higher recommended)
- npm (to install dependencies)
- A valid Prolibu API key for your domain
- Git (for cloning repositories)

---

## Installation

### Quick Start

```bash
git clone https://github.com/nodriza-io/prolibu-cli.git
cd prolibu-cli
npm install
chmod +x prolibu script site  # Make executables
```

---

## Usage

### Main Command Structure

```bash
./prolibu <object> <command> [options]
```

**Objects:**
- `script` - Manage Prolibu scripts
- `site` - Manage static sites and SPAs
- `plugin` - Manage UI plugins (coming soon)

**Commands:**
- `create` - Create a new object
- `dev` - Run in development mode
- `prod` - Run in production mode
- `import` - Import from git repository
- `test` - Run tests (scripts only)

---

## Working with Scripts

### Create a script

```bash
# Interactive mode (prompts for all values)
./prolibu script create

# One-liner mode
./prolibu script create \
  --domain dev10.prolibu.com \
  --apikey <your-api-key> \
  --prefix hook-sample \
  --repo https://github.com/nodriza-io/hook-sample.git \
  --lifecycleHooks "Invoice,Contact"
```

### Development mode

```bash
# Interactive
./prolibu script dev

# With flags
./prolibu script dev \
  --domain dev10.prolibu.com \
  --prefix hook-sample \
  --watch

# Use a different entry file
./prolibu script dev \
  --domain dev10.prolibu.com \
  --prefix hook-sample \
  --file other-index \
  --watch
```

### Production mode

```bash
./prolibu script prod \
  --domain dev10.prolibu.com \
  --prefix hook-sample \
  --watch
```

### Import existing script

```bash
./prolibu script import \
  --domain dev10.prolibu.com \
  --prefix hook-sample \
  --repo https://github.com/nodriza-io/hook-sample.git
```

### Run tests

```bash
# Run default test file
./prolibu script test \
  --domain dev10.prolibu.com \
  --prefix hook-sample

# Run specific test file with watch mode
./prolibu script test \
  --domain dev10.prolibu.com \
  --prefix hook-sample \
  --file integration-test \
  --watch
```

---

## Working with Sites

### Create a site

```bash
# Interactive mode
./prolibu site create

# One-liner mode
./prolibu site create \
  --domain dev10.prolibu.com \
  --apikey <your-api-key> \
  --prefix my-landing-page \
  --siteType Static \
  --repo https://github.com/user/my-site.git
```

**Site Types:**
- `Static` - Static HTML/CSS/JS sites
- `SPA` - Single Page Applications

### Development mode with hot reload

```bash
./prolibu site dev \
  --domain dev10.prolibu.com \
  --prefix my-landing-page \
  --watch \
  --port 3000 \
  --ext html,css,js
```

This will:
1. Zip the `public/` folder
2. Upload to Prolibu
3. Start local server at `http://localhost:3000`
4. Watch for file changes and auto-sync

### Production deployment

```bash
./prolibu site prod \
  --domain dev10.prolibu.com \
  --prefix my-landing-page
```

### Import existing site

```bash
./prolibu site import \
  --domain dev10.prolibu.com \
  --prefix my-landing-page \
  --repo https://github.com/user/my-site.git
```

---

## Backward Compatibility

For users migrating from Script Builder CLI, the old commands still work:

```bash
# Old command
./script dev --domain dev10.prolibu.com --scriptPrefix my-hook --watch

# New command (recommended)
./prolibu script dev --domain dev10.prolibu.com --prefix my-hook --watch

# Also works with new prefix flag
./script dev --domain dev10.prolibu.com --prefix my-hook --watch
```

Both `./script` and `./site` are wrappers that redirect to `./prolibu script` and `./prolibu site`.

**Flag Compatibility:**
- `--prefix` - New unified flag (recommended)
- `--scriptPrefix` - Still works for backward compatibility
- `--sitePrefix` - Still works for backward compatibility

---

## Project Structure

```
prolibu-cli/
├── prolibu                  # Main executable
├── script                   # Backward compatibility wrapper
├── site                     # Backward compatibility wrapper
├── cli/
│   ├── core/               # Core CLI utilities
│   │   ├── flags.js        # Flag parsing
│   │   ├── prompts.js      # Interactive prompts
│   │   └── cookieUtil.js   # Cookie utilities
│   ├── commands/           # Command handlers by object type
│   │   ├── script/
│   │   │   ├── index.js    # Script command router
│   │   │   ├── create.js   # Create script
│   │   │   ├── run.js      # Run dev/prod
│   │   │   ├── import.js   # Import from git
│   │   │   └── test.js     # Run tests
│   │   └── site/
│   │       ├── index.js    # Site command router
│   │       ├── create.js   # Create site
│   │       ├── run.js      # Run dev/prod
│   │       └── import.js   # Import from git
│   ├── builders/           # Build logic per object type
│   │   ├── scriptBuilder.js # esbuild bundling for scripts
│   │   └── siteBuilder.js   # Zip creation for sites
│   └── socketLog.js        # Real-time log streaming
├── api/
│   ├── client.js           # Base API client (legacy)
│   ├── scriptClient.js     # Script-specific API calls
│   └── siteClient.js       # Site-specific API calls
├── config/
│   └── config.js           # Configuration management
├── templates/
│   ├── script/             # Script templates
│   │   ├── index.js
│   │   ├── config.json     # Model data (uploaded to API)
│   │   ├── settings.json   # Build settings (local only)
│   │   ├── .gitignore
│   │   └── lib/
│   └── site/               # Site templates
│       ├── config.json     # Model data (uploaded to API)
│       ├── settings.json   # Build settings (local only)
│       ├── README.md
│       ├── .gitignore
│       └── public/
│           └── index.html
├── lib/                    # Shared libraries
│   ├── utils/
│   └── vendors/
│       ├── sendgrid/
│       ├── salesforce/
│       ├── hubspot/
│       ├── ultramsg/
│       ├── prolibu/
│       └── ai/
├── accounts/               # Your workspaces
│   └── <domain>/
│       ├── profile.json    # Domain config (API key)
│       ├── <scriptName>/   # Script project
│       │   ├── index.js
│       │   ├── config.json     # Model data (variables, hooks, git)
│       │   ├── settings.json   # Build settings (minify, comments)
│       │   ├── lib/
│       │   ├── test/
│       │   └── README.md       # Synced to config.json.readme
│       └── <siteName>/     # Site project
│           ├── config.json     # Model data (siteType, git)
│           ├── settings.json   # Build settings (port)
│           ├── README.md       # Synced to config.json.readme
│           ├── dist.zip        # Generated package
│           └── public/         # Source files
│               ├── index.html
│               ├── styles.css
│               └── app.js
├── test/                   # CLI framework tests
│   ├── script.test.js      # Script tests (19 tests)
│   ├── site.test.js        # Site tests (7 tests)
│   └── config.json         # Test configuration (gitignored)
├── package.json
└── README.md
```

## Features Deep Dive

### Scripts

**Entry File Configuration**

By default, scripts use `index.js` as the main entry point. You can specify an alternative entry file:

```bash
# Default: uses index.js
./prolibu script dev --domain dev10.prolibu.com --prefix my-script --watch

# Custom: uses custom-entry.js
./prolibu script dev --domain dev10.prolibu.com --prefix my-script --file custom-entry --watch
```

**Watch Mode**

- With `--watch`, the CLI watches for file changes and automatically syncs
- Real-time console logs via socket.io
- Press `R` to manually trigger script execution
- Watches: entry file, lib/ folder, config.json, settings.json, README.md

**Real-time Log Streaming**

When in watch mode, Prolibu CLI establishes a socket.io connection to stream console logs:
- Live output directly in your terminal
- Automatic reconnection if connection drops
- Filtered logs (only your script + environment)
- Color-coded disconnect/reconnect messages
- Error reporting and stack traces

**Dual Configuration System**

Prolibu CLI uses two configuration files to separate concerns:

**1. `config.json` - Model Data (uploaded to API)**

This file contains data that defines your script/site and is synced to Prolibu:

```json
{
  "variables": [
    { "key": "API_KEY", "value": "secret123" },
    { "key": "ENDPOINT", "value": "https://api.example.com" }
  ],
  "lifecycleHooks": ["Contact", "Account"],
  "readme": "# My Script\n\nDetailed documentation...",
  "git": {
    "repositoryUrl": "https://github.com/user/repo.git"
  }
}
```

**2. `settings.json` - Build Settings (local only, NOT uploaded)**

This file contains local build configuration that affects how your code is bundled:

```json
{
  "minifyProductionCode": false,  // Minify code in production mode
  "removeComments": true          // Strip comments from bundle
}
```

**Why two files?**
- ✅ Clear separation: Model data vs build configuration
- ✅ Security: Build settings stay local, not exposed in API
- ✅ Flexibility: Change build settings without touching model data
- ✅ Version control: Easier to track changes to business logic vs build config

**README.md ↔ config.json.readme Sync**

- `README.md` is automatically synced to `config.json.readme`
- Edit `README.md` in VS Code (easier for markdown)
- Changes are detected and synced to config.json
- Both files are watched and uploaded in real-time
- `config.json.readme` is sent to the API on every change

### Sites

**Site Structure**

All site files must be in the `public/` folder:

```
my-site/
├── config.json
├── README.md
├── dist.zip          # Generated automatically
└── public/           # Your site files
    ├── index.html
    ├── styles.css
    ├── app.js
    └── assets/
        └── logo.png
```

**Development Workflow**

1. Edit files in `public/`
2. Changes are detected automatically
3. Public folder is zipped
4. Zip is uploaded to Prolibu
5. Site is updated with new package
6. Local server shows changes instantly

**Site Configuration Files**

**`config.json` - Model Data (uploaded to API)**
```json
{
  "siteType": "Static",           // Static or SPA
  "readme": "# My Site\n\n...",   // Site documentation
  "git": {
    "repositoryUrl": "https://github.com/user/site.git"
  }
}
```

**`settings.json` - Build Settings (local only)**
```json
{
  "port": 3000                    // Local dev server port
}
```

---

## Running Tests

Prolibu CLI includes comprehensive test coverage with Jest:

```bash
# Run all tests (scripts + sites)
npm test

# Run only script tests
npm run test:script

# Run only site tests
npm run test:site

# Run all tests explicitly
npm run test:all
```

---

# Test System

This project includes **two types of testing**:

## 1. CLI Framework Tests
Uses **Jest** for automated testing of CLI commands and generated script structure.

### What do the CLI tests cover?
- Script creation and template file generation
- Validation of `profile.json` and `config.json` configuration
- Execution of CLI commands (`create`, `dev`, etc.) and error handling

### Where are the CLI tests?
Tests are located in the `/test` folder, mainly in `commands.test.js`.

### How to run CLI tests?
```bash
npm test
```

## 2. Individual Script Testing

Each script can have its own test suite for integration testing with external APIs and business logic validation.

### Script Test Structure
Tests are located in each script's folder:
```
accounts/<domain>/<scriptPrefix>/test/
├── index.test.js           # Default test file
├── <custom-name>.test.js   # Custom test files
└── ...
```

### Running Script Tests

**Basic usage:**
```bash
./prolibu script test \
  --domain <domain> \
  --scriptPrefix <scriptPrefix>
```

**With custom test file:**
```bash
./prolibu script test \
  --domain <domain> \
  --scriptPrefix <scriptPrefix> \
  --file <testFileName>
```

**With watch mode (auto-rerun on changes):**
```bash
./prolibu script test \
  --domain <domain> \
  --scriptPrefix <scriptPrefix> \
  --file <testFileName> \
  --watch
```

### Interactive Testing Features
- **Watch Mode**: Automatically re-runs tests when files change
- **Manual Re-run**: Press `R` to re-run tests manually
- **Environment Variables**: Automatically injects `DOMAIN` and `SCRIPT_PREFIX`
- **Live Feedback**: Real-time test results and error reporting

## Test Environment Setup
- **Jest** (included in devDependencies)
- **Environment Variables**: `DOMAIN` and `SCRIPT_PREFIX` automatically available
- **Global Utilities**: Access to shared test utilities and API clients
- **Faker Support**: Generate realistic test data with `@faker-js/faker`

## Cleanup Notes
- CLI tests: Generated files are automatically cleaned before each test
- Script tests: Manual cleanup may be required for external API resources
- Important: Scripts created during tests are not deleted from the Prolibu platform automatically

---

## Importing Libraries

### For Scripts

You can import libraries from:

**Local script lib folder:**
```js
const utils = require('./lib/utils/helper');
const myVendor = require('./lib/vendors/custom');
```

**Global project lib folder:**
```js
const sleep = require('lib/utils/sleep');
const SendGrid = require('lib/vendors/sendgrid/SendGrid');
const Salesforce = require('lib/vendors/salesforce/Salesforce');
const HubSpot = require('lib/vendors/hubspot/HubSpot');
const UltraMsg = require('lib/vendors/ultramsg/UltraMsg');
const DeviceApi = require('lib/vendors/prolibu/DeviceApi');
```

### Available Vendor Integrations

- **SendGrid** - Email sending
- **Salesforce** - CRM integration
- **HubSpot** - Marketing & CRM
- **UltraMsg** - WhatsApp messaging
- **Prolibu DeviceApi** - IoT device control (ESP32)
- **AI Providers** - DeepSeek, OpenAI, Anthropic

---

## API Endpoints

### Scripts
- `POST /v2/script` - Create script
- `GET /v2/script/{scriptCode}` - Get script
- `PATCH /v2/script/{scriptCode}` - Update (code, variables, hooks, readme, git)
- `GET /v2/script/run?scriptId={scriptCode}` - Run script

### Sites
- `POST /v2/site` - Create site
- `GET /v2/site/{siteCode}` - Get site
- `PATCH /v2/site/{siteCode}` - Update site fields
  - `package` field: Upload ZIP directly with multipart/form-data
  - Other fields: `readme`, `git.repositoryUrl`, `siteType`, etc.

**Authentication:** `Authorization: Bearer <API_KEY>`

---

## Migration from Script Builder CLI

If you're upgrading from the old Script Builder CLI:

1. **Update your local repo:**
   ```bash
   git pull origin main
   npm install
   chmod +x prolibu script site
   ```

2. **Commands still work:**
   - Old: `./script dev --domain ... --scriptPrefix ...`
   - New: `./prolibu script dev --domain ... --prefix ...`
   - Both work! `./script` redirects to `./prolibu script`

3. **Use the new `--prefix` flag:**
   - Replaces `--scriptPrefix` and `--sitePrefix`
   - More consistent across all commands
   - Old flags still work for compatibility

4. **No code changes needed:**
   - Your existing scripts work as-is
   - Same folder structure
   - Same config files

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Support

For issues, questions, or feature requests, please visit:
- GitHub: https://github.com/nodriza-io/prolibu-cli
- Documentation: https://docs.prolibu.com

---

**Built with ❤️ by the Prolibu team**