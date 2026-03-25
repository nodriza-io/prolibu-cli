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

// ── Credentials ─────────────────────────────────────────────

export function fetchCredentials() {
    return request('/api/credentials');
}

export function saveCredentials(credentials) {
    return request('/api/credentials', {
        method: 'POST',
        body: JSON.stringify(credentials),
    });
}

// ── Phases ──────────────────────────────────────────────────

export function runDiscover(opts = {}) {
    return request('/api/phases/discover', {
        method: 'POST',
        body: JSON.stringify(opts),
    });
}

// ── Config ───────────────────────────────────────────────────

export function saveConfig(cfg) {
    return request('/api/save-config', {
        method: 'POST',
        body: JSON.stringify(cfg),
    });
}

export function saveSetup(setup) {
    return request('/api/save-setup', {
        method: 'POST',
        body: JSON.stringify(setup),
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

export function createProlibuObject(body) {
    return request('/api/prolibu/create-object', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

// ── Pipelines ───────────────────────────────────────────────

export function fetchPipelines() {
    return request('/api/pipelines');
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

// ── YAML Config ─────────────────────────────────────────────

export function fetchYamlStatus() {
    return request('/api/yaml/status');
}

export function fetchYamlFile(filename) {
    return request(`/api/yaml/file/${filename}`);
}

export function saveYamlFile(filename, content) {
    return request(`/api/yaml/file/${filename}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
    });
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
