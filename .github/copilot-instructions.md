# Script Builder CLI

Script Builder is a Node.js CLI tool for creating, developing, and managing Prolibu v2 scripts. It provides automated workflows for local development, API integration, file watching, and script deployment to development and production environments.

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively

### Initial Setup and Installation
- `npm install` -- installs all dependencies in ~6 seconds. Always run this first.
- Set executable permissions: `chmod +x index.js build`
- No additional SDK installation required - everything runs on Node.js

### Core Commands and Usage
- `./index.js <command> <domain> <scriptName> [exec]` -- main CLI interface
- `./build <command> <domain> <scriptName>` -- wrapper script (calls index.js)
- Available commands:
  - `create <domain> <scriptName>` -- creates new development and production scripts
  - `dev <domain> <scriptName> [exec]` -- starts development mode with file watching
  - `prod <domain> <scriptName>` -- deploys to production environment

### Build and Bundle Operations
- esbuild bundling: ~65ms for typical scripts. NEVER CANCEL - always completes quickly.
- Minification (production): ~65ms additional time for minified builds
- File watching with chokidar: ~55ms initialization time
- Total workflow timing: Development setup typically completes in under 5 seconds

### File Structure and Templates
The tool creates scripts in this structure:
```
accounts/<domain>/<scriptName>/
├── code.js              -- main script code (ES6/CommonJS)
├── variables.json       -- script variables
├── payload.json         -- test payload (dev only)
├── lifecycleHooks.json  -- event triggers
├── lib/                 -- modular code directory
│   └── Utils.js         -- utility functions
├── dist/               -- generated bundles
│   ├── bundle.js       -- development bundle
│   └── bundle.min.js   -- production minified bundle
└── README.md           -- auto-synced documentation
```

### Development Workflow
- ALWAYS run file watchers in development: `./index.js dev <domain> <scriptName>`
- File watching monitors: `code.js`, `lib/` directory, `variables.json`, `payload.json`, `lifecycleHooks.json`, `README.md`
- Changes trigger automatic bundling and API upload
- Use `exec` flag to automatically run scripts after changes: `./index.js dev <domain> <scriptName> exec`

## Validation and Testing

### Manual Validation Steps
- ALWAYS test script creation: `./index.js create test.example.com testScript`
- Verify file watching: modify `code.js` and confirm auto-bundling occurs
- Test both environments: development (`dev`) and production (`prod`)
- Check bundle generation in `dist/` directory after operations

### Required Environment Setup
- Requires valid Prolibu API key for each domain
- API keys stored in `accounts/<domain>/config.json`
- Git repository URL required during script creation
- No additional linting or testing infrastructure available

### Script Lifecycle Testing
- Create script → modify `code.js` → verify bundle generation → test API upload
- Test README.md auto-sync: modify README.md and confirm API upload
- Validate production minification: check `bundle.min.js` generation

## API Integration and Configuration

### Domain Configuration
- Config stored at: `accounts/<domain>/config.json`
- Contains: `apiKey`, `minifyProductionScripts`, `gitRepositoryUrl`
- Never commit config files - excluded via `.gitignore`

### API Endpoints (Prolibu v2)
- Script creation: `POST /v2/script`
- Script updates: `PATCH /v2/script/{scriptCode}`
- Script execution: `GET /v2/script/run` with body `{ id: scriptCode }`
- Full OpenAPI spec available in `openapi.json`

### Authentication
- Uses Bearer token authentication: `Authorization: Bearer <PROLIBU_TOKEN>`
- API keys managed per domain via interactive prompts
- Environment variable support: `export PROLIBU_TOKEN=xxxxx`

## Common Tasks and File Locations

### Key Project Files
```
/
├── index.js             -- main CLI entry point
├── build               -- CLI wrapper script
├── package.json        -- dependencies and metadata
├── cli/
│   ├── commands.js     -- core command implementations
│   ├── prompts.js      -- interactive user prompts
│   └── bundle.js       -- esbuild bundling logic
├── api/
│   └── client.js       -- Prolibu API client
├── config/
│   └── config.js       -- configuration management
├── templates/          -- default script templates
│   ├── code.js
│   ├── variables.json
│   ├── payload.json
│   ├── lifecycleHooks.json
│   └── lib/Utils.js
└── openapi.json       -- Complete API specification
```

### Repository Structure
```
ls -la
.
├── .git/
├── .gitignore
├── README.md
├── api/
├── build*
├── cli/
├── config/
├── index.js*
├── models/
├── node_modules/
├── openapi.json
├── package-lock.json
├── package.json
├── script
└── templates/
```

### Common Command Patterns
```bash
# Complete workflow example
npm install
./index.js create dev10.prolibu.com myScript
./index.js dev dev10.prolibu.com myScript exec    # development with auto-run
./index.js prod dev10.prolibu.com myScript        # production deployment

# Quick development cycle
./index.js dev test.domain.com testScript
# Edit code.js, variables.json, or lib/ files
# Watch console for auto-bundling and upload confirmation

# Production deployment
./index.js prod prod.domain.com myScript
# Prompts for confirmation before publishing
```

### Dependencies and Versions
- Node.js runtime (no specific version requirement)
- Key dependencies: axios (HTTP), inquirer (prompts), chokidar (file watching), esbuild (bundling)
- No testing framework, linting, or CI/CD infrastructure
- Total dependencies: 82 packages, ~6 second install time

## Important Notes and Limitations

### File Watching Behavior
- Watches `code.js` and entire `lib/` directory recursively
- Auto-bundles and uploads on file changes
- README.md changes auto-sync to script documentation field
- Payload.json only monitored in development mode

### Production vs Development
- Development: includes payload.json for testing
- Production: excludes payload.json, enables minification if configured
- Both environments get separate script codes: `scriptName-dev` and `scriptName-prod`

### Git Integration
- Clones external repositories during script creation
- Preserves git history and remote connections
- Templates overlay onto cloned repositories

### Security Considerations
- API keys stored locally, never committed
- `.gitignore` excludes: `accounts/`, `.env`, `node_modules/`
- No secrets should be embedded in script code

Always validate each step of the development workflow and confirm that file watching and bundling operations complete successfully before considering implementation complete.