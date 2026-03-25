'use strict';

const fs = require('fs');
const path = require('path');

const PRESETS_DIR = __dirname;

/**
 * List all available presets by scanning JSON files in this directory.
 * @returns {{ name: string, label: string, description: string }[]}
 */
function list() {
  return fs.readdirSync(PRESETS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
      return { name: data.name, label: data.label, description: data.description };
    });
}

/**
 * Load a preset by name.
 * @param {string} name - Preset name (e.g. "standard", "minimal", "full")
 * @returns {object|null} The full preset object, or null if not found
 */
function load(name) {
  const filePath = path.join(PRESETS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Get just the preset names.
 * @returns {string[]}
 */
function names() {
  return list().map(p => p.name);
}

module.exports = { list, load, names };
