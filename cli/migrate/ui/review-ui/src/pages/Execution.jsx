import { useState, useRef, useCallback, useEffect } from "react";
import { useMigration } from "../store";
import { startMigration, subscribeMigrationLogs } from "../api";
import { showToast } from "../components/Toast";

export default function Execution() {
  const { state, dispatch } = useMigration();
  const { cfg, execution, schemaEntities } = state;
  const [dryRun, setDryRun] = useState(true);
  const [selected, setSelected] = useState({});
  const [running, setRunning] = useState(false);
  const logEndRef = useRef(null);
  const sseRef = useRef(null);

  /* ── gather available entities from config ──────────── */
  // Build reverse lookup: prolibu target → schema key
  const targetToKey = {};
  for (const [k, v] of Object.entries(schemaEntities || {})) {
    if (v.target) targetToKey[v.target] = k;
  }

  const enabledEntities = [];
  for (const [key, ec] of Object.entries(cfg.entities || {})) {
    const schemaKey = targetToKey[key];
    const entityEnabled = schemaKey
      ? schemaEntities[schemaKey]?.enabled !== false
      : false;
    if (entityEnabled)
      enabledEntities.push({ key, label: key, type: "standard" });
  }
  for (const [sfName, cc] of Object.entries(cfg.customObjects || {})) {
    if (cc.enabled)
      enabledEntities.push({
        key: sfName,
        label: cc.prolibuEntity || sfName,
        type: "custom",
      });
  }

  /* ── toggle entity selection ────────────────────────── */
  const toggle = (key) => setSelected((s) => ({ ...s, [key]: !s[key] }));

  const selectAll = () => {
    const next = {};
    enabledEntities.forEach((e) => (next[e.key] = true));
    setSelected(next);
  };
  const selectNone = () => setSelected({});

  /* ── auto‑scroll logs ──────────────────────────────── */
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [execution.logs]);

  /* ── clean up SSE on unmount ────────────────────────── */
  useEffect(() => {
    return () => {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, []);

  /* ── run migration ──────────────────────────────────── */
  const handleRun = useCallback(async () => {
    const ents = Object.keys(selected).filter((k) => selected[k]);
    if (!ents.length) {
      showToast("Selecciona al menos una entidad", true);
      return;
    }

    setRunning(true);
    dispatch({
      type: "SET_EXECUTION",
      payload: { running: true, logs: [], results: {}, dryRun },
    });

    try {
      // Start migration via POST
      const res = await startMigration({ entities: ents, dryRun });
      if (!res.ok) {
        showToast(`❌ ${res.error || "Error al iniciar migración"}`, true);
        setRunning(false);
        dispatch({ type: "SET_EXECUTION", payload: { running: false } });
        return;
      }

      // Subscribe to SSE stream for real-time logs
      const es = subscribeMigrationLogs(
        (msg) => {
          // Each message: { type: 'log'|'result'|'done', data: ... }
          if (msg.type === "log") {
            dispatch({ type: "APPEND_LOG", payload: msg.data });
          } else if (msg.type === "progress") {
            dispatch({ type: "SET_ENTITY_PROGRESS", payload: msg.data });
          } else if (msg.type === "result") {
            dispatch({ type: "SET_ENTITY_RESULT", payload: msg.data });
          } else if (msg.type === "done") {
            setRunning(false);
            dispatch({ type: "SET_EXECUTION", payload: { running: false } });
            showToast(
              dryRun ? "✅ Dry-run completado" : "✅ Migración completada",
            );
            es.close();
            sseRef.current = null;
          } else if (msg.type === "error") {
            dispatch({ type: "APPEND_LOG", payload: `❌ ERROR: ${msg.data}` });
          }
        },
        (err) => {
          console.error("SSE error", err);
          setRunning(false);
          dispatch({ type: "SET_EXECUTION", payload: { running: false } });
        },
      );
      sseRef.current = es;
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
      setRunning(false);
      dispatch({ type: "SET_EXECUTION", payload: { running: false } });
    }
  }, [selected, dryRun, dispatch]);

  const selCount = Object.values(selected).filter(Boolean).length;
  const logs = execution.logs || [];
  const results = execution.results || {};
  const progress = execution.progress || {};

  return (
    <div className="execution-page">
      {/* ── Left: controls + log viewer ───────────────── */}
      <div className="exec-main">
        <div className="exec-controls">
          <h2>Ejecutar Migración</h2>

          <div className="entity-chips">
            <div className="chip-actions">
              <button className="chip-btn" onClick={selectAll}>
                Seleccionar todo
              </button>
              <button className="chip-btn" onClick={selectNone}>
                Ninguno
              </button>
            </div>
            {enabledEntities.map((e) => (
              <button
                key={e.key}
                className={`entity-chip${selected[e.key] ? " active" : ""} ${
                  e.type
                }`}
                onClick={() => toggle(e.key)}
              >
                {e.type === "custom" && "🔶 "}
                {e.label}
              </button>
            ))}
            {!enabledEntities.length && (
              <div style={{ color: "#94a3b8", fontSize: 12 }}>
                No hay entidades habilitadas. Activa entidades en el Config
                Builder.
              </div>
            )}
          </div>

          <div className="run-options">
            <label className="toggle dry-toggle">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
              />
              <span className="slider" />
              <span className="toggle-label">
                {dryRun
                  ? "🔍 Dry-run (sin cambios reales)"
                  : "🚀 Ejecución en producción"}
              </span>
            </label>

            <button
              className={`run-btn${running ? " running" : ""}`}
              disabled={running || !selCount}
              onClick={handleRun}
            >
              {running ? (
                <>
                  <span className="spinner small" /> Ejecutando…
                </>
              ) : dryRun ? (
                `🔍 Dry-run (${selCount} entidades)`
              ) : (
                `🚀 Migrar (${selCount} entidades)`
              )}
            </button>
          </div>
        </div>

        {/* Log viewer */}
        <div className="log-viewer">
          <div className="log-header">
            <span>📋 Logs</span>
            <span className="log-count">{logs.length} líneas</span>
          </div>
          <div className="log-body">
            {logs.length === 0 && (
              <div className="log-empty">
                Los logs de ejecución aparecerán aquí…
              </div>
            )}
            {logs.map((line, i) => (
              <div
                key={i}
                className={`log-line${
                  line.startsWith("❌")
                    ? " err"
                    : line.startsWith("✅")
                    ? " ok"
                    : ""
                }`}
              >
                {line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* ── Right: results sidebar ────────────────────── */}
      <div className="exec-sidebar">
        <h3>Resultados</h3>
        {!Object.keys(results).length && (
          <div style={{ color: "#94a3b8", fontSize: 12, padding: 12 }}>
            {running
              ? "Esperando resultados…"
              : "Ejecuta una migración para ver los resultados."}
          </div>
        )}
        {/* Progress bars for entities currently migrating */}
        {Object.entries(progress).map(
          ([entity, p]) =>
            !results[entity] && (
              <div className="result-card" key={`prog-${entity}`}>
                <div className="result-header">
                  <strong>{entity}</strong>
                  <span className="result-status running">migrando…</span>
                </div>
                <div className="progress-bar-container">
                  <div
                    className="progress-bar"
                    style={{
                      width: `${Math.round((p.processed / p.total) * 100)}%`,
                    }}
                  />
                </div>
                <div className="progress-stats">
                  <span>
                    {p.processed}/{p.total} (
                    {Math.round((p.processed / p.total) * 100)}%)
                  </span>
                  <span>
                    ➕ {p.created || 0} | 🔄 {p.updated || 0} | ❌{" "}
                    {(p.errors && p.errors.length) || 0}
                  </span>
                </div>
              </div>
            ),
        )}

        {Object.entries(results).map(([entity, r]) => (
          <div className="result-card" key={entity}>
            <div className="result-header">
              <strong>{entity}</strong>
              <span className={`result-status ${r.status || ""}`}>
                {r.status || "…"}
              </span>
            </div>
            <div className="result-stats">
              {r.migrated != null && (
                <div className="rs">
                  <span className="rs-n">{r.migrated}</span> migrados
                </div>
              )}
              {r.skipped != null && (
                <div className="rs">
                  <span className="rs-n">{r.skipped}</span> omitidos
                </div>
              )}
              {r.errors != null && r.errors > 0 && (
                <div className="rs err">
                  <span className="rs-n">{r.errors}</span> errores
                </div>
              )}
              {r.total != null && (
                <div className="rs">
                  <span className="rs-n">{r.total}</span> total SF
                </div>
              )}
            </div>
          </div>
        ))}

        {execution.dryRun && Object.keys(results).length > 0 && (
          <div className="dry-notice">
            🔍 Modo dry-run — no se realizaron cambios reales en Prolibu.
          </div>
        )}
      </div>
    </div>
  );
}
