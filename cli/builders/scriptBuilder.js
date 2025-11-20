const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function bundleScript(scriptPath, outPath) {
  await esbuild.build({
    entryPoints: [scriptPath],
    bundle: true,
    platform: 'node',
    outfile: outPath,
    format: 'cjs',
    sourcemap: false,
    minify: false,
  });
  console.log(`[BUILD] esbuild finished bundling to ${outPath}`);
  return fs.readFileSync(outPath, 'utf8');
}

module.exports = { bundleScript };
