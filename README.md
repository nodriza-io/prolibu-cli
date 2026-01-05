# Prolibu CLI

**Official CLI for Prolibu v2** - Build, test and deploy Scripts, Sites and Plugins with automation, modularity, and seamless API integration.

## What you can do with Prolibu CLI

Prolibu CLI is a modern, developer-focused framework for building and deploying:

- **Scripts**: Lifecycle hooks, integrations, and automation workflows
- **Sites**: Static sites and Single Page Applications (SPAs)
- **Virtual Tours (VT)**: Bulk upload virtual tours from folder structure
- **Plugins**: UI extensions (coming soon)

Key features:

- 🎯 Interactive scaffolding for scripts and sites
- 🔄 Git repository integration and cloning (optional)
- 🔥 Real-time file watching with hot reload
- 📦 Automatic bundling and minification (scripts)
- 🗜️ Automatic zipping and deployment (sites)
- 🧪 Comprehensive testing framework
- 🌐 Local development server with live reload
- 📱 QR code generation for mobile access (dev & prod)
- 🔐 Built-in authentication system for sites
- 📝 Automatic README sync to API
- 🔧 Modular code via shared lib/ folder
- 🌍 Dev/prod environment support
- ⌨️ Interactive watch mode (press 'p' to publish, 'x' to exit)
- 🎨 Pre-configured site templates with Prolibu branding

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
- `vt` - Manage virtual tours (bulk upload)
- `plugin` - Manage UI plugins (coming soon)

**Commands:**

- `create` - Create a new object
- `dev` - Run in development mode
- `prod` - Run in production mode
- `import` - Import from git repository
- `test` - Run tests (scripts only)
- `bulk` - Upload virtual tours in bulk (vt only)

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

# One-liner mode (git repo optional)
./prolibu site create \
  --domain dev10.prolibu.com \
  --apikey <your-api-key> \
  --prefix my-landing-page \
  --siteType Static

# With git repository
./prolibu site create \
  --domain dev10.prolibu.com \
  --apikey <your-api-key> \
  --prefix my-landing-page \
  --siteType Static \
  --repo https://github.com/user/my-site.git
```

**Site Types:**

- `Static` - Static HTML/CSS/JS sites (case-insensitive)
- `SPA` - Single Page Applications (case-insensitive)

**Note:** Git repository is now optional. You can create sites from templates without a repo.

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

1. Create `_prolibu_config.js` with domain configuration
2. Start local server at `http://localhost:3000`
3. Display QR code for mobile access (uses local IP)
4. Watch for file changes and auto-reload browser
5. Press `p` to publish to dev/prod environment
6. Press `x` to exit and cleanup

**Interactive Commands:**

- `p` or `P` - Publish site to Prolibu (creates zip, uploads, shows QR)
- `x` or `X` - Exit watch mode and cleanup
- `Ctrl+C` - Also exits and cleanup

**Auto-generated Files:**

- `_prolibu_config.js` - Contains domain configuration for API calls (auto-removed on exit)
- `dist.zip` - Site package (created when publishing)

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

## Working with Virtual Tours

### Create a virtual tour workspace

```bash
# Interactive mode
./prolibu vt create

# One-liner mode
./prolibu vt create \
  --domain dev11.prolibu.com \
  --apikey <your-api-key> \
  --prefix my-vt-project
```

This will create a workspace with:

- Main script (`index.js`)
- Configuration files (`config.json`, `settings.json`)
- Utilities library (`lib/utils.js`)
- Virtual tours folder (`virtualTours/`)
- Example tour structure

### Folder Structure

Virtual tours must follow this structure:

```
virtualTours/
└── TOUR_NAME/
    ├── _config.json          # Optional: tour metadata
    ├── _colors/
    │   ├── external/         # External color textures
    │   └── internal/         # Internal color textures
    ├── external/             # or 'exterior'
    │   └── {color-slug}/
    │       └── seq_*.png     # Sequences (multiple files = 1 scene)
    └── internal/             # or 'interior'
        └── {color-slug}/
            ├── 2d_*.jpeg     # 2D (each file = 1 scene)
            ├── 360_*.webp    # 360 (each file = 1 scene)
            └── seq_*.png     # Sequences
```

**File Naming Conventions:**

- `2d_*` → Creates 2D scene
- `360_*` → Creates 360° panoramic scene
- `seq_*` → Creates sequence scene (animation/slideshow)

**Supported Image Extensions:**
`.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.avif`

### Upload all tours in bulk

```bash
./prolibu vt bulk \
  --domain dev11.prolibu.com \
  --prefix my-vt-project
```

This will:

1. Read all tours from `virtualTours/` folder
2. Upload color textures from `_colors/`
3. Create VirtualTour entities
4. Create scenes with media files
5. Associate scenes with tours

### Upload specific tour

```bash
./prolibu vt bulk \
  --domain dev11.prolibu.com \
  --prefix my-vt-project \
  --tour BMW_81AP
```

### Watch mode (auto-upload on changes)

```bash
./prolibu vt bulk \
  --domain dev11.prolibu.com \
  --prefix my-vt-project \
  --watch
```

In watch mode:

- Monitors changes in `virtualTours/` folder
- Auto-uploads when files are added/changed/removed
- Re-runs bulk upload after 2 seconds of inactivity

### Custom virtualTours folder

```bash
./prolibu vt bulk \
  --domain dev11.prolibu.com \
  --prefix my-vt-project \
  --folder /path/to/tours
```

### Tour Configuration (\_config.json)

Each tour can have optional metadata in `_config.json`:

```json
{
  "virtualTourName": "BMW 3 Series 2024",
  "description": "Virtual tour of BMW 3 Series",
  "eventType": "Automotive",
  "config": {
    "theme": "flow",
    "ui": {
      "fullscreen": true,
      "enableRibbon": true
    },
    "sequence": {
      "drag": { "enabled": true, "swipeable": true, "speed": 100 }
    },
    "panorama": {
      "autoRotate": true,
      "autoRotateSpeed": 1
    }
  }
}
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
├── vt                       # Virtual tours wrapper
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
│   │   ├── site/
│   │   │   ├── index.js    # Site command router
│   │   │   ├── create.js   # Create site
│   │   │   ├── run.js      # Run dev/prod
│   │   │   └── import.js   # Import from git
│   │   └── vt/
│   │       ├── index.js    # VT command router
│   │       ├── create.js   # Create VT workspace
│   │       └── bulk.js     # Bulk upload
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
│   ├── site/               # Site templates
│   │   ├── config.json     # Model data (uploaded to API)
│   │   ├── settings.json   # Build settings (local only)
│   │   ├── README.md
│   │   ├── .gitignore
│   │   └── public/
│   │       └── index.html
│   └── vt/                 # Virtual tour templates
│       ├── index.js        # Bulk upload script
│       ├── config.json     # Configuration
│       ├── settings.json   # Settings
│       ├── README.md
│       ├── .gitignore
│       └── lib/
│           └── utils.js    # VT utilities
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
│       ├── <siteName>/     # Site project
│       │   ├── config.json     # Model data (siteType, git)
│       │   ├── settings.json   # Build settings (port)
│       │   ├── README.md       # Synced to config.json.readme
│       │   ├── dist.zip        # Generated package
│       │   └── public/         # Source files
│       │       ├── index.html
│       │       ├── styles.css
│       │       └── app.js
│       └── <vtName>/       # Virtual tour project
│           ├── index.js        # Bulk upload script
│           ├── config.json     # Configuration
│           ├── settings.json   # Settings
│           ├── README.md
│           ├── lib/
│           │   └── utils.js
│           └── virtualTours/   # Your tours
│               ├── README.md
│               └── TOUR_1/
│                   ├── _config.json
│                   ├── _colors/
│                   ├── external/
│                   └── internal/
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
  "minifyProductionCode": false, // Minify code in production mode
  "removeComments": true // Strip comments from bundle
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
├── settings.json
├── README.md
├── dist.zip          # Generated automatically
└── public/           # Your site files
    ├── index.html
    ├── styles.css
    ├── script.js
    ├── _prolibu_config.js  # Auto-generated in dev mode
    └── assets/
        └── logo.png
```

**Built-in Authentication System**

New sites come with a pre-configured authentication system:

- Login form with email/password
- Validates credentials against `/v2/auth/signin`
- Stores `apiKey` in localStorage (without Bearer prefix)
- Fetches user info from `/v2/user/me` and caches in localStorage
- Redirects to Prolibu signin if on `.prolibu.com` domain
- Shows user name and logout in header
- Auto-validates on page load

**API Configuration**

In development mode, `_prolibu_config.js` is automatically created with:

```javascript
window.__PROLIBU_CONFIG__ = {
  domain: "dev10.prolibu.com",
  apiBaseUrl: "https://dev10.prolibu.com/v2",
  isDev: true,
};
```

Your `script.js` uses this to make API calls to the correct domain:

- Dev mode (localhost:3000) → API calls go to `dev10.prolibu.com`
- Production mode → API calls go to current domain

**Development Workflow**

1. Run `./prolibu site dev --watch`
2. Local server starts with QR code for mobile testing
3. Edit files in `public/`
4. Browser auto-reloads on file changes
5. Press `p` to publish to Prolibu
6. QR code shows for easy mobile access to published site
7. Press `x` to exit (auto-cleanup of `_prolibu_config.js`)

**Site Configuration Files**

**`config.json` - Model Data (uploaded to API)**

```json
{
  "variables": [], // Environment variables
  "lifecycleHooks": [], // Lifecycle hooks (if any)
  "siteType": "Static", // Static or SPA
  "readme": "# My Site\n\n...", // Site documentation
  "git": {
    "repositoryUrl": "https://github.com/user/site.git"
  }
}
```

**`settings.json` - Build Settings (local only)**

```json
{
  "port": 3000 // Local dev server port
}
```

**Default Site Template**

New sites come with:

- Responsive HTML structure
- Prolibu branding header with logo
- Separated CSS and JavaScript files
- Authentication system (signin/logout)
- API utility functions (`fetchAPI`, `getApiConfig`)
- User profile display with name truncation
- Mobile-friendly responsive design

---

## QR Code Features

### Development Mode

When you run `./prolibu site dev --watch`, you'll see:

```
◯ || ▶ Prolibu CLI v2.0
✓ Server running on port 3030

Available on:
  http://localhost:3030
  http://127.0.0.1:3030
  http://192.168.0.23:3030

📱 Scan QR code for mobile access:
█████████████████████████████
█████████████████████████████
██ ▄▄▄▄▄ █▀█ █▄█▀█ ▄▄▄▄▄ ██
██ █   █ █▀▀▀▄ ▄▀█ █   █ ██
...
```

The QR code points to your local IP address for easy mobile testing.

### Production Mode

When you publish with `p`, you'll see:

```
✓ Site 'my-site-dev' published successfully

🌐 Site URLs:
  https://dev10.prolibu.com/sites/.../my-site-dev/
  https://dev10.prolibu.com/r/my-site-dev (short)

📱 Scan QR code for mobile access:
█████████████████████████████
...
```

The QR code points to the short URL for quick mobile access.

---

## Watch Mode Process Management

The CLI now includes robust process management for watch mode:

**Cleanup Features:**

- Kills all child processes (live-server, etc.)
- Removes auto-generated files (`_prolibu_config.js`)
- Frees up ports properly
- Unwatches all file watchers
- Resets terminal state

**Exit Methods:**

1. Press `x` or `X` - Clean exit
2. Press `Ctrl+C` - Signal interrupt exit
3. Terminal close - Automatic cleanup

**Process Handling:**

- Uses `SIGKILL` for force termination
- Kills entire process tree with `pkill -P`
- Cleans up ports with `lsof` (macOS/Linux)
- Removes stdin listeners
- Resets terminal raw mode

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
const utils = require("./lib/utils/helper");
const myVendor = require("./lib/vendors/custom");
```

**Global project lib folder:**

```js
const sleep = require("lib/utils/sleep");
const SendGrid = require("lib/vendors/sendgrid/SendGrid");
const Salesforce = require("lib/vendors/salesforce/Salesforce");
const HubSpot = require("lib/vendors/hubspot/HubSpot");
const UltraMsg = require("lib/vendors/ultramsg/UltraMsg");
const DeviceApi = require("lib/vendors/prolibu/DeviceApi");
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
