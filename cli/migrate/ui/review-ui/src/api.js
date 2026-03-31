const BASE = '';

async function request(url, options = {}) {
    const res = await fetch(`${BASE}${url}`, {
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
}

// ── CRM Discovery & Connection ──────────────────────────────

export function fetchCRMs() {
    return request('/api/crms');
}

export function selectCRM(crm) {
    return request('/api/select-crm', {
        method: 'POST',
        body: JSON.stringify({ crm }),
    });
}

export function checkCRMConnection() {
    return request('/api/crm/connection');
}

export function checkProlibuConnection() {
    return request('/api/prolibu/connection');
}

// ── State ────────────────────────────────────────────────────

export function fetchState() {
    return request('/api/state');
}

export function fetchStatus() {
    return request('/api/status');
}


// ── Phases ──────────────────────────────────────────────────

export function runDiscover(opts = {}) {
    return request('/api/phases/discover', {
        method: 'POST',
        body: JSON.stringify(opts),
    });
}

// ── Config ───────────────────────────────────────────────────

export function toggleSchemaEntity(entityKey, enabled) {
    return request('/api/schema/toggle-entity', {
        method: 'POST',
        body: JSON.stringify({ entityKey, enabled }),
    });
}

export function addSchemaEntity({ source, target, entityKey }) {
    return request('/api/schema/add-entity', {
        method: 'POST',
        body: JSON.stringify({ source, target, entityKey }),
    });
}

export function saveConfig(cfg) {
    return request('/api/save-config', {
        method: 'POST',
        body: JSON.stringify(cfg),
    });
}

export function saveMappings(mappings) {
    return request('/api/save-mappings', {
        method: 'POST',
        body: JSON.stringify(mappings),
    });
}

// ── Prolibu proxy ───────────────────────────────────────────

export function createProlibuField(body) {
    return request('/api/prolibu/create-field', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

// ── Flow Editor ─────────────────────────────────────────────

export function fetchFlow() {
    return request('/api/flow');
}

export function saveFlow(flow) {
    return request('/api/flow', {
        method: 'POST',
        body: JSON.stringify({ flow }),
    });
}

// ── Execution ───────────────────────────────────────────────

export function startMigration({ entities, dryRun }) {
    return request('/api/migrate', {
        method: 'POST',
        body: JSON.stringify({ entities, dryRun }),
    });
}

export function cancelMigration() {
    return request('/api/migrate/cancel', { method: 'POST' });
}

/**
 * Subscribe to migration SSE log stream.
 * Returns a function to close the connection.
 */
export function subscribeMigrationLogs(onMessage, onError) {
    const es = new EventSource(`${BASE}/api/migrate/stream`);

    es.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            onMessage(data);
        } catch {
            onMessage({ type: 'raw', message: e.data });
        }
    };

    es.addEventListener('done', (e) => {
        try {
            const data = JSON.parse(e.data);
            onMessage({ type: 'done', ...data });
        } catch { }
        es.close();
    });

    es.addEventListener('error', (e) => {
        if (es.readyState === EventSource.CLOSED) return;
        onError?.(e);
    });

    return () => es.close();
}

// ── Done ────────────────────────────────────────────────────

export function closeServer() {
    return request('/api/done', { method: 'POST' });
}

export function fetchYamlConfig() {
    return request('/api/yaml/config');
}

export function scaffoldYaml() {
    return request('/api/yaml/scaffold', { method: 'POST' });
}

// ── Prolibu Schema Service ──────────────────────────────────

/** List all Prolibu entity names. */
export function fetchProlibuEntities() {
    return request('/api/prolibu/entities');
}

/** Get the full schema for a Prolibu entity. */
export function fetchProlibuSchema(entity) {
    return request(`/api/prolibu/schema/${entity}`);
}

/** Get flat field map { fieldPath: { type, description } } for a Prolibu entity. */
export function fetchProlibuFields(entity) {
    return request(`/api/prolibu/fields/${entity}`);
}

/** Re-fetch the OpenAPI spec from Prolibu. */
export function refreshProlibuSchema() {
    return request('/api/prolibu/refresh-schema', { method: 'POST' });
}

/** Get the known CRM → Prolibu field mapping for the active CRM. */
export function fetchFieldMapping() {
    return request('/api/field-mapping');
}

// ── Objects CLI bridge ──────────────────────────────────────

/** Read local objects/ folder inventory from disk. */
export function fetchObjectsState() {
    return request('/api/objects/state');
}

/** Save Cob + CustomField JSONs to disk (local only, no push). */
export function saveObjectFiles({ cob, customField }) {
    return request('/api/objects/save', {
        method: 'POST',
        body: JSON.stringify({ cob, customField }),
    });
}

/** Pull Cobs and CustomFields from Prolibu → local disk. Starts async, use SSE for progress. */
export function pullObjects() {
    return request('/api/objects/pull', { method: 'POST' });
}

/** Push local Cobs and CustomFields → Prolibu. Starts async, use SSE for progress. */
export function pushObjects() {
    return request('/api/objects/push', { method: 'POST' });
}

/** Push a single model (Cob + CustomField) → Prolibu. Starts async, use SSE for progress. */
export function pushObjectModel(modelName) {
    return request('/api/objects/push-model', {
        method: 'POST',
        body: JSON.stringify({ modelName }),
    });
}

/** Generate local objects/ files from prolibu_setup.json. Starts async, use SSE for progress. */
export function scaffoldObjects(force = false) {
    return request('/api/objects/scaffold', {
        method: 'POST',
        body: JSON.stringify({ force }),
    });
}

/**
 * Scaffold Cobs and CustomFields directly from a discovery.json selection.
 * @param {{ cobs: {sfObject, prolibuEntity}[], customFields: [], force: boolean }} payload
 */
export function scaffoldFromDiscovery(payload) {
    return request('/api/objects/scaffold-from-discovery', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

/**
 * Subscribe to objects operation logs via SSE (same stream as migration).
 * Returns an unsubscribe function.
 * @param {(msg: {type: string, data: any}) => void} onMessage
 * @param {() => void} onClose
 */
export function subscribeObjectsLogs(onMessage, onClose) {
    const es = new EventSource('/api/migrate/stream');
    es.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'objects-log' || msg.type === 'objects-done') {
                onMessage(msg);
            }
        } catch { /* ignore */ }
    };
    es.onerror = () => {
        es.close();
        if (onClose) onClose();
    };
    return () => es.close();
}
