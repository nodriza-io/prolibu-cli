'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNTS_DIR = path.join(process.cwd(), 'accounts');

/**
 * Persistent map of { sourceId → prolibuId } for a single Prolibu model.
 * Stored at: accounts/<domain>/migrations/<crm>/idMaps/<Model>.json
 *
 * Lets the migration engine skip already-migrated records on re-run
 * and resolve cross-model references without extra API calls.
 */
class IdMapStore {
    /**
     * @param {object} opts
     * @param {string} opts.domain - Prolibu domain (e.g. stg.prolibu.com)
     * @param {string} opts.crm    - CRM adapter key (e.g. 'salesforce')
     * @param {string} opts.model  - Prolibu model name (e.g. 'Company', 'Contact')
     */
    constructor({ domain, crm, model }) {
        this.domain = domain;
        this.crm = crm;
        this.model = model;
        this._map = {};
        this._dirty = false;
        this._filePath = path.join(
            ACCOUNTS_DIR, domain, 'migrations', crm, 'idMaps', `${model}.json`
        );
    }

    /**
     * Load stored mappings from disk. Safe to call multiple times (idempotent).
     * @returns {this}
     */
    load() {
        if (!fs.existsSync(this._filePath)) return this;
        try {
            const raw = fs.readFileSync(this._filePath, 'utf8');
            const data = JSON.parse(raw);
            this._map = (typeof data === 'object' && data !== null && !Array.isArray(data)) ? data : {};
        } catch {
            this._map = {};
        }
        return this;
    }

    /**
     * Flush current map to disk immediately.
     */
    save() {
        fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
        fs.writeFileSync(this._filePath, JSON.stringify(this._map, null, 2));
        this._dirty = false;
    }

    /**
     * Register a sourceId → prolibuId pair.
     * @param {string} sourceId  - ID from the source system (e.g. Salesforce Id)
     * @param {string} prolibuId - Prolibu _id
     */
    set(sourceId, prolibuId) {
        if (!sourceId || !prolibuId) return;
        this._map[String(sourceId)] = String(prolibuId);
        this._dirty = true;
    }

    /**
     * Look up the Prolibu _id for a source system ID.
     * @param {string} sourceId
     * @returns {string|undefined}
     */
    get(sourceId) {
        return this._map[String(sourceId)];
    }

    /**
     * Return only the source IDs not yet present in the map.
     * @param {string[]} sourceIds
     * @returns {string[]}
     */
    missing(sourceIds) {
        return sourceIds.filter(id => !this._map[String(id)]);
    }

    /** Number of entries currently in the map. */
    get size() {
        return Object.keys(this._map).length;
    }

    /** True if the map has unsaved changes. */
    get isDirty() {
        return this._dirty;
    }
}

module.exports = IdMapStore;
