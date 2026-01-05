module.exports = async function createVt(flags) {
    const inquirer = await import('inquirer');
    const path = require('path');
    const fs = require('fs');
    const { execSync } = require('child_process');

    let domain = flags.domain;
    let prefix = flags.prefix;
    let apiKey = flags.apikey;
    let tourType = flags.type || 'automotive'; // 'automotive' o 'spaces'

    // 1. domain
    if (!domain) {
        const response = await inquirer.default.prompt({
            type: 'input',
            name: 'domain',
            message: 'Enter domain:',
            validate: input => input ? true : 'Domain is required.'
        });
        domain = response.domain;
    }

    // 2. apiKey (ensure profile.json is created/updated)
    const profilePath = path.join(process.cwd(), 'accounts', domain, 'profile.json');

    if (fs.existsSync(profilePath)) {
        try {
            const profileData = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
            if (!apiKey) apiKey = profileData.apiKey;
        } catch { }
    }
    if (!apiKey) {
        const response = await inquirer.default.prompt({
            type: 'input',
            name: 'apiKey',
            message: `Enter API key for domain '${domain}':`,
            validate: input => input ? true : 'API key is required.'
        });
        apiKey = response.apiKey;
    }

    const domainDir = path.dirname(profilePath);
    if (!fs.existsSync(domainDir)) {
        fs.mkdirSync(domainDir, { recursive: true });
    }
    fs.writeFileSync(profilePath, JSON.stringify({ apiKey }, null, 2));

    // 3. prefix
    if (!prefix) {
        const response = await inquirer.default.prompt({
            type: 'input',
            name: 'prefix',
            message: 'Enter virtual tour project name:',
            validate: input => input ? true : 'Project name is required.'
        });
        prefix = response.prefix;
    }

    // 4. Tour type
    if (!flags.type) {
        const response = await inquirer.default.prompt({
            type: 'list',
            name: 'tourType',
            message: 'Select tour type:',
            choices: [
                { name: '🚗 Automotive (colors + external/internal)', value: 'automotive' },
                { name: '🏠 Spaces (panoramas + floor plans)', value: 'spaces' }
            ],
            default: 'automotive'
        });
        tourType = response.tourType;
    }

    // Create virtual tour directory
    const vtDir = path.join(process.cwd(), 'accounts', domain, prefix);
    if (fs.existsSync(vtDir) && fs.readdirSync(vtDir).length > 0) {
        const { confirmDelete } = await inquirer.default.prompt({
            type: 'confirm',
            name: 'confirmDelete',
            message: `The folder ${vtDir} already exists and is not empty. Delete it and continue?`,
            default: false
        });
        if (!confirmDelete) {
            console.log('Aborted by user.');
            process.exit(1);
        }
        fs.rmSync(vtDir, { recursive: true, force: true });
    }
    if (!fs.existsSync(vtDir)) {
        fs.mkdirSync(vtDir, { recursive: true });
    }

    // Copy template files
    const templatesDir = path.join(__dirname, '../../../templates/vt');

    // Copy main files
    const filesToCopy = ['index.js', 'config.json', 'settings.json', 'README.md', '.gitignore'];
    filesToCopy.forEach(file => {
        const src = path.join(templatesDir, file);
        const dest = path.join(vtDir, file);
        if (fs.existsSync(src)) {
            fs.copyFileSync(src, dest);
        }
    });

    // Copy lib folder
    const libSrc = path.join(templatesDir, 'lib');
    const libDest = path.join(vtDir, 'lib');
    if (fs.existsSync(libSrc)) {
        fs.cpSync(libSrc, libDest, { recursive: true });
    }

    // Create virtualTours folder structure
    const virtualToursDir = path.join(vtDir, 'virtualTours');
    fs.mkdirSync(virtualToursDir, { recursive: true });

    // Create example structure based on tour type
    const exampleTourDir = path.join(virtualToursDir, 'EXAMPLE_TOUR');
    fs.mkdirSync(exampleTourDir, { recursive: true });

    if (tourType === 'spaces') {
        // Spaces structure
        fs.mkdirSync(path.join(exampleTourDir, 'scenes'), { recursive: true });
        fs.mkdirSync(path.join(exampleTourDir, '_floorplans'), { recursive: true });

        // Create _config.json example for Spaces
        const exampleConfig = {
            virtualTourName: 'Example Space Tour',
            description: 'This is an example spaces virtual tour',
            eventType: 'Spaces',
            config: {
                theme: 'cascade',
                floorPlan: { showOpened: true },
                hotspots: { enableAudio: true }
            }
        };
        fs.writeFileSync(
            path.join(exampleTourDir, '_config.json'),
            JSON.stringify(exampleConfig, null, 2)
        );

        // Create README for Spaces example
        const exampleReadme = `# Virtual Tour Structure (Spaces)

This is an example virtual tour structure for Spaces/Real Estate. Replace with your own tours.

## Folder Structure:
\`\`\`
virtualTours/
└── NOMBRE_TOUR/
    ├── _config.json          # Opcional: metadatos del tour
    ├── _floorplans/          # Planos de piso (opcional)
    │   ├── planta-baja.jpg
    │   └── segundo-piso.png
    └── scenes/               # Panoramas 360°
        ├── 360_sala.webp
        ├── 360_cocina.webp
        └── 360_habitacion.jpg
\`\`\`

## File Naming:
- \`360_*\` → sceneType: '360' (panorama)
- \`2d_*\` → sceneType: '2d' (imagen plana)

## Run bulk upload:
\`\`\`bash
./prolibu vt bulk --domain ${domain} --prefix ${prefix} --type spaces
\`\`\`
`;
        fs.writeFileSync(path.join(virtualToursDir, 'README.md'), exampleReadme);

    } else {
        // Automotive structure (default)
        // Create _colors folder
        const colorsDir = path.join(exampleTourDir, '_colors');
        fs.mkdirSync(path.join(colorsDir, 'external'), { recursive: true });
        fs.mkdirSync(path.join(colorsDir, 'internal'), { recursive: true });

        // Create external/internal folders
        fs.mkdirSync(path.join(exampleTourDir, 'external', 'black'), { recursive: true });
        fs.mkdirSync(path.join(exampleTourDir, 'internal', 'black'), { recursive: true });

        // Create _config.json example for Automotive
        const exampleConfig = {
            virtualTourName: 'Example Tour',
            description: 'This is an example virtual tour',
            eventType: 'Automotive',
            config: {
                theme: 'flow'
            }
        };
        fs.writeFileSync(
            path.join(exampleTourDir, '_config.json'),
            JSON.stringify(exampleConfig, null, 2)
        );

        // Create README for Automotive example
        const exampleReadme = `# Virtual Tour Structure (Automotive)

This is an example virtual tour structure for Automotive. Replace with your own tours.

## Folder Structure:
\`\`\`
virtualTours/
└── NOMBRE_TOUR/
    ├── _config.json          # Opcional: metadatos del tour
    ├── _colors/
    │   ├── external/         # Texturas de colores externos
    │   └── internal/         # Texturas de colores internos
    ├── external/
    │   └── {color-slug}/
    │       └── seq_*.png     # Sequences (múltiples = 1 scene)
    └── internal/
        └── {color-slug}/
            ├── 2d_*.jpeg     # 2D (cada archivo = 1 scene)
            ├── 360_*.webp    # 360 (cada archivo = 1 scene)
            └── seq_*.png     # Sequences
\`\`\`

## File Naming:
- \`2d_*\` → sceneType: '2d'
- \`360_*\` → sceneType: '360'
- \`seq_*\` → sceneType: 'sequence'

## Run bulk upload:
\`\`\`bash
./prolibu vt bulk --domain ${domain} --prefix ${prefix}
\`\`\`
`;
        fs.writeFileSync(path.join(virtualToursDir, 'README.md'), exampleReadme);
    }

    const typeEmoji = tourType === 'spaces' ? '🏠' : '🚗';
    const typeName = tourType === 'spaces' ? 'Spaces' : 'Automotive';

    console.log('');
    console.log(`✅ Virtual tour workspace created successfully! (${typeEmoji} ${typeName})`);
    console.log('');
    console.log('📁 Project location:', vtDir);
    console.log('');
    console.log('Next steps:');
    console.log('1. Add your virtual tour folders to virtualTours/');
    if (tourType === 'spaces') {
        console.log('2. Run bulk upload: ./prolibu vt bulk --domain', domain, '--prefix', prefix, '--type spaces');
    } else {
        console.log('2. Run bulk upload: ./prolibu vt bulk --domain', domain, '--prefix', prefix);
    }
    console.log('');
    console.log('Structure created:');
    console.log('  ├── index.js              # Main script');
    console.log('  ├── config.json           # Configuration');
    console.log('  ├── settings.json         # Settings');
    console.log('  ├── lib/                  # Utilities');
    console.log('  │   └── utils.js');
    console.log('  └── virtualTours/         # Your tours folder');
    console.log('      ├── README.md');
    if (tourType === 'spaces') {
        console.log('      └── EXAMPLE_TOUR/     # Example (Spaces)');
        console.log('          ├── _config.json');
        console.log('          ├── _floorplans/');
        console.log('          └── scenes/');
    } else {
        console.log('      └── EXAMPLE_TOUR/     # Example (Automotive)');
        console.log('          ├── _config.json');
        console.log('          ├── _colors/');
        console.log('          ├── external/');
        console.log('          └── internal/');
    }
};
