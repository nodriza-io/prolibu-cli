import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "react-router-dom";
import { useMigration } from "../store";
import {
  fetchObjectsState,
  pullObjects,
  pushObjects,
  scaffoldObjects,
  scaffoldFromDiscovery,
  subscribeMigrationLogs,
} from "../api";
import { showToast } from "../components/Toast";

/* ── helpers ─────────────────────────────────────────────── */

function AnsiLine({ text }) {
  // Strip ANSI color codes for plain display
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  return <div className="log-line">{clean}</div>;
}

/* ── Component ───────────────────────────────────────────── */

export default function Objects() {
  const { crm } = useParams();
  const { state } = useMigration();
  const discovery = state?.discovery;
  const [objs, setObjs] = useState(null); // { cobs, customFields }
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(null); // 'pull' | 'push' | 'scaffold' | 'scaffold-from-discovery' | null
  const [logs, setLogs] = useState([]);
  const [force, setForce] = useState(false);
  const [scaffoldWarnings, setScaffoldWarnings] = useState([]);
  const logEndRef = useRef(null);
  const closeRef = useRef(null);

  // Discovery panel state
  const [discSearch, setDiscSearch] = useState("");
  const [discFilter, setDiscFilter] = useState("custom"); // 'all' | 'custom'
  const [selected, setSelected] = useState({}); // { [sfObjectName]: { prolibuEntity } }
  const [expandedObj, setExpandedObj] = useState(null);
  const [expandedLocal, setExpandedLocal] = useState(null); // key for local inventory rows

  /* ── load state ────────────────────────────────────────── */
  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchObjectsState();
      setObjs(data);
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadState();
    return () => {
      if (closeRef.current) {
        closeRef.current();
        closeRef.current = null;
      }
    };
  }, [loadState]);

  // auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  /* ── subscribe to SSE while an operation is running ────── */
  const startSSE = useCallback(
    (action) => {
      if (closeRef.current) {
        closeRef.current();
      }
      setLogs([]);
      setRunning(action);

      const close = subscribeMigrationLogs(
        (msg) => {
          if (msg.type === "objects-log") {
            setLogs((prev) => [...prev, msg.data]);
          } else if (msg.type === "objects-done") {
            setRunning(null);
            closeRef.current = null;
            if (msg.data?.ok) {
              showToast(`✅ ${action} completado`);
              loadState();
            } else {
              showToast(`❌ ${action} falló: ${msg.data?.error || ""}`, true);
            }
          }
        },
        () => {
          setRunning(null);
          closeRef.current = null;
        },
      );
      closeRef.current = close;
    },
    [loadState],
  );

  /* ── action handlers ────────────────────────────────────── */
  const handlePull = async () => {
    startSSE("pull");
    try {
      await pullObjects();
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
      setRunning(null);
    }
  };

  const handlePush = async () => {
    startSSE("push");
    try {
      await pushObjects();
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
      setRunning(null);
    }
  };

  const handleScaffold = async () => {
    setLogs([]);
    setScaffoldWarnings([]);
    setRunning("scaffold");
    try {
      const res = await scaffoldObjects(force);
      if (res?.logs) setLogs(res.logs);
      if (res?.warnings?.length) setScaffoldWarnings(res.warnings);
      if (res?.ok) {
        showToast(
          res.warnings?.length
            ? `✅ Scaffold completado con ${res.warnings.length} advertencia(s)`
            : "✅ Scaffold completado",
        );
        loadState();
      } else {
        showToast(`❌ Scaffold falló: ${res?.error || ""}`, true);
      }
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    } finally {
      setRunning(null);
    }
  };

  const handleScaffoldFromDiscovery = async () => {
    const cobs = Object.entries(selected).map(([sfObject, v]) => ({
      sfObject,
      prolibuEntity: v.prolibuEntity,
    }));

    if (!cobs.length) {
      showToast("Selecciona al menos un objeto del discovery", true);
      return;
    }

    setLogs([]);
    setScaffoldWarnings([]);
    setRunning("scaffold-from-discovery");
    try {
      const res = await scaffoldFromDiscovery({ cobs, force });
      if (res?.logs) setLogs(res.logs);
      if (res?.warnings?.length) setScaffoldWarnings(res.warnings);
      if (res?.ok) {
        showToast(
          res.warnings?.length
            ? `✅ ${cobs.length} objeto(s) generado(s) — ${res.warnings.length} campo(s) necesitan atención`
            : `✅ ${cobs.length} objeto(s) generado(s)`,
        );
        loadState();
      } else {
        showToast(`❌ Scaffold falló: ${res?.error || ""}`, true);
      }
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    } finally {
      setRunning(null);
    }
  };

  const toggleSelect = (sfName, obj) => {
    setSelected((prev) => {
      if (prev[sfName]) {
        const next = { ...prev };
        delete next[sfName];
        return next;
      }
      const defaultName = sfName.toLowerCase().replace(/__c$/, "");
      return {
        ...prev,
        [sfName]: { enabled: true, prolibuEntity: defaultName },
      };
    });
  };

  const updateEntity = (sfName, value) => {
    setSelected((prev) => ({
      ...prev,
      [sfName]: { ...prev[sfName], prolibuEntity: value },
    }));
  };

  /* ── render ─────────────────────────────────────────────── */
  const cobs = objs?.cobs || [];
  const customFields = objs?.customFields || [];

  return (
    <div
      style={{
        padding: "24px",
        maxWidth: 960,
        margin: "0 auto",
        overflowY: "auto",
        height: "100%",
        boxSizing: "border-box",
      }}
    >
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>
          📦 Objects — {crm?.toUpperCase()}
        </h2>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "#64748b" }}>
          Gestiona los Custom Objects (Cob) y Custom Fields del dominio. Siempre
          pasan por archivos locales en{" "}
          <code>accounts/&lt;domain&gt;/objects/</code>.
        </p>
      </div>

      {/* ── Actions ──────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div
          style={{
            display: "flex",
            gap: 10,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <button
            className="btn btn-secondary"
            onClick={handlePull}
            disabled={!!running}
            title="Descarga Cobs y CustomFields desde Prolibu a disco local"
          >
            {running === "pull" ? "⏳ Pulling…" : "⬇️ Pull desde Prolibu"}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handlePush}
            disabled={!!running}
            title="Sube los archivos locales de objects/ a Prolibu"
          >
            {running === "push" ? "⏳ Pushing…" : "⬆️ Push a Prolibu"}
          </button>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginLeft: "auto",
            }}
          >
            <label
              style={{
                fontSize: 12,
                color: "#64748b",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                disabled={!!running}
              />
              --force
            </label>
            <button
              className="btn btn-primary"
              onClick={handleScaffold}
              disabled={!!running}
              title="Genera archivos objects/ desde prolibu_setup.json"
            >
              {running === "scaffold"
                ? "⏳ Scaffolding…"
                : "🏗️ Scaffold desde setup"}
            </button>
          </div>
        </div>

        <p style={{ margin: "10px 0 0", fontSize: 12, color: "#94a3b8" }}>
          <strong>Pull</strong> — trae lo existente en Prolibu al disco. &nbsp;
          <strong>Push</strong> — sube los archivos locales a Prolibu. &nbsp;
          <strong>Scaffold</strong> — genera archivos locales desde{" "}
          <code>prolibu_setup.json</code> (fase review).
        </p>
      </div>

      {/* ── Warnings ─────────────────────────────────────────── */}
      {scaffoldWarnings.length > 0 && (
        <div
          className="card"
          style={{
            marginBottom: 20,
            borderLeft: "4px solid #f59e0b",
            background: "#fffbeb",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, color: "#92400e" }}>
              ⚠️ {scaffoldWarnings.length} campo(s) requieren atención manual
            </div>
            <button
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 16,
                color: "#92400e",
                padding: "0 4px",
              }}
              onClick={() => setScaffoldWarnings([])}
              title="Cerrar"
            >
              ×
            </button>
          </div>
          <div style={{ fontSize: 12, color: "#78350f", marginBottom: 6 }}>
            Edita los archivos <code>objects/CustomField/*.json</code> generados
            y completa los valores marcados como <code>null</code>:
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12,
              color: "#92400e",
            }}
          >
            {scaffoldWarnings.map((w, i) => (
              <li key={i} style={{ marginBottom: 3 }}>
                <strong>{w.field}</strong>: {w.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Logs ─────────────────────────────────────────── */}
      {(logs.length > 0 || running) && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              marginBottom: 8,
              color: "#475569",
            }}
          >
            Logs {running ? `— ${running} en progreso…` : ""}
          </div>
          <div
            style={{
              background: "#0f172a",
              borderRadius: 6,
              padding: "12px 14px",
              fontFamily: "monospace",
              fontSize: 12,
              color: "#e2e8f0",
              maxHeight: 280,
              overflowY: "auto",
            }}
          >
            {logs.map((line, i) => (
              <AnsiLine key={i} text={line} />
            ))}
            {running && <div style={{ color: "#94a3b8", marginTop: 4 }}>▌</div>}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      {/* ── Discovery panel ──────────────────────────── */}
      {discovery && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              🔍 Desde Discovery
              <span
                style={{
                  fontWeight: 400,
                  fontSize: 12,
                  color: "#64748b",
                  marginLeft: 8,
                }}
              >
                {Object.keys(discovery.objects || {}).length} objetos ·
                selecciona para hacer scaffold como Cob
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className={`btn btn-sm ${
                  discFilter === "custom" ? "btn-primary" : ""
                }`}
                onClick={() =>
                  setDiscFilter(discFilter === "custom" ? "all" : "custom")
                }
              >
                {discFilter === "custom" ? "Solo __c" : "Todos"}
              </button>
            </div>
          </div>

          {/* Search */}
          <input
            type="text"
            placeholder="Buscar objeto SF…"
            value={discSearch}
            onChange={(e) => setDiscSearch(e.target.value)}
            style={{
              width: "100%",
              padding: "6px 10px",
              fontSize: 13,
              border: "1px solid #e2e8f0",
              borderRadius: 6,
              marginBottom: 10,
              boxSizing: "border-box",
            }}
          />

          {/* Object list */}
          <div
            style={{
              maxHeight: expandedObj ? 600 : 320,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {Object.entries(discovery.objects || {})
              .filter(([n, o]) => !o.error)
              .filter(([n]) =>
                discFilter === "custom" ? n.endsWith("__c") : true,
              )
              .filter(([n, o]) => {
                const q = discSearch.toLowerCase();
                return (
                  !q ||
                  n.toLowerCase().includes(q) ||
                  (o.label || "").toLowerCase().includes(q)
                );
              })
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([sfName, obj]) => {
                const isSelected = !!selected[sfName];
                const isCustom = sfName.endsWith("__c");
                const isExpanded = expandedObj === sfName;
                const fields = obj.fieldDetails || [];
                return (
                  <div
                    key={sfName}
                    style={{
                      flexShrink: 0,
                      borderRadius: 6,
                      background: isSelected ? "#eff6ff" : "#f8fafc",
                      border: `1px solid ${isSelected ? "#93c5fd" : "#e2e8f0"}`,
                      overflow: "hidden",
                    }}
                  >
                    {/* Row header */}
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "6px 10px",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(sfName, obj)}
                        disabled={!!running}
                      />
                      <div
                        style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
                        onClick={() =>
                          setExpandedObj(isExpanded ? null : sfName)
                        }
                      >
                        <div style={{ fontWeight: 600, fontSize: 13 }}>
                          {sfName}{" "}
                          <span style={{ color: "#94a3b8", fontWeight: 400 }}>
                            {isExpanded ? "▲" : "▼"}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: "#94a3b8" }}>
                          {obj.label} · {obj.fields} campos
                        </div>
                      </div>
                      {isSelected && (
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                          }}
                        >
                          <span style={{ fontSize: 11, color: "#64748b" }}>
                            Prolibu entity:
                          </span>
                          <input
                            type="text"
                            value={selected[sfName]?.prolibuEntity || ""}
                            onChange={(e) =>
                              updateEntity(sfName, e.target.value)
                            }
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              padding: "3px 7px",
                              fontSize: 12,
                              width: 130,
                              border: "1px solid #cbd5e1",
                              borderRadius: 4,
                            }}
                          />
                        </div>
                      )}
                      <span
                        className={`badge ${
                          isCustom ? "b-custom" : "b-unmapped"
                        }`}
                        style={{ fontSize: 10, flexShrink: 0 }}
                      >
                        {isCustom ? "custom" : "standard"}
                      </span>
                    </div>

                    {/* Expanded field list */}
                    {isExpanded && fields.length > 0 && (
                      <div
                        style={{
                          borderTop: "1px solid #e2e8f0",
                          maxHeight: 260,
                          overflowY: "auto",
                          background: "#fff",
                        }}
                      >
                        <table
                          style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: 11,
                          }}
                        >
                          <thead>
                            <tr
                              style={{
                                background: "#f1f5f9",
                                position: "sticky",
                                top: 0,
                              }}
                            >
                              <th
                                style={{
                                  padding: "4px 8px",
                                  textAlign: "left",
                                  fontWeight: 600,
                                  color: "#475569",
                                  width: "35%",
                                }}
                              >
                                Campo SF
                              </th>
                              <th
                                style={{
                                  padding: "4px 8px",
                                  textAlign: "left",
                                  fontWeight: 600,
                                  color: "#475569",
                                  width: "20%",
                                }}
                              >
                                Tipo SF
                              </th>
                              <th
                                style={{
                                  padding: "4px 8px",
                                  textAlign: "left",
                                  fontWeight: 600,
                                  color: "#475569",
                                  width: "35%",
                                }}
                              >
                                Label
                              </th>
                              <th
                                style={{
                                  padding: "4px 8px",
                                  textAlign: "center",
                                  fontWeight: 600,
                                  color: "#475569",
                                }}
                              >
                                Req
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {fields.map((f) => {
                              const isRef = f.type === "reference";
                              const isRequired =
                                f.nillable === false && f.createable === true;
                              return (
                                <tr
                                  key={f.name}
                                  style={{
                                    borderTop: "1px solid #f1f5f9",
                                    background: f.custom
                                      ? "#fefce8"
                                      : "transparent",
                                  }}
                                >
                                  <td
                                    style={{
                                      padding: "3px 8px",
                                      fontFamily: "monospace",
                                      color: f.custom ? "#92400e" : "#334155",
                                    }}
                                  >
                                    {f.name}
                                  </td>
                                  <td
                                    style={{
                                      padding: "3px 8px",
                                      color: isRef ? "#7c3aed" : "#64748b",
                                    }}
                                  >
                                    {f.type}
                                    {isRef && f.referenceTo
                                      ? ` → ${f.referenceTo}`
                                      : ""}
                                  </td>
                                  <td
                                    style={{
                                      padding: "3px 8px",
                                      color: "#64748b",
                                    }}
                                  >
                                    {f.label}
                                  </td>
                                  <td
                                    style={{
                                      padding: "3px 8px",
                                      textAlign: "center",
                                      color: isRequired ? "#dc2626" : "#94a3b8",
                                    }}
                                  >
                                    {isRequired ? "✱" : ""}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>

          {/* Action bar */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 12,
            }}
          >
            <div style={{ fontSize: 12, color: "#64748b" }}>
              {Object.keys(selected).length > 0
                ? `${Object.keys(selected).length} objeto(s) seleccionado(s)`
                : "Ninguno seleccionado"}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {Object.keys(selected).length > 0 && (
                <button className="btn btn-sm" onClick={() => setSelected({})}>
                  Limpiar
                </button>
              )}
              <button
                className="btn btn-sm btn-primary"
                onClick={handleScaffoldFromDiscovery}
                disabled={!!running || !Object.keys(selected).length}
              >
                {running === "scaffold-from-discovery"
                  ? "⏳ Scaffolding…"
                  : "🏗️ Scaffold seleccionados"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Local inventory ──────────────────────────────── */}
      {loading ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>
          Cargando inventario local…
        </div>
      ) : (
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
        >
          {/* Custom Objects */}
          <div className="card">
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
              📦 Custom Objects (Cob) — {cobs.length}
            </div>
            {cobs.length === 0 ? (
              <div style={{ color: "#94a3b8", fontSize: 12 }}>
                Ninguno en disco. Usa "Pull desde Prolibu" o "Scaffold desde
                setup".
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {cobs.map((cob, i) => {
                  const key = `cob-${cob.modelName}`;
                  const isExp = expandedLocal === key;
                  // Try to find SF fieldDetails from discovery
                  const sfObj = cob._source?.sObject
                    ? discovery?.objects?.[cob._source.sObject]
                    : null;
                  const sfFields = sfObj?.fieldDetails || [];
                  return (
                    <div
                      key={i}
                      style={{
                        flexShrink: 0,
                        borderRadius: 6,
                        background: "#f8fafc",
                        border: "1px solid #e2e8f0",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "6px 10px",
                          cursor: sfFields.length ? "pointer" : "default",
                        }}
                        onClick={() =>
                          sfFields.length &&
                          setExpandedLocal(isExp ? null : key)
                        }
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>
                            {cob.modelName}{" "}
                            {sfFields.length > 0 && (
                              <span
                                style={{
                                  color: "#94a3b8",
                                  fontWeight: 400,
                                  fontSize: 11,
                                }}
                              >
                                {isExp ? "▲" : "▼"}
                              </span>
                            )}
                          </div>
                          {cob._source?.sObject && (
                            <div style={{ fontSize: 11, color: "#94a3b8" }}>
                              ← {cob._source.sObject}
                              {sfFields.length > 0 &&
                                ` · ${sfFields.length} campos SF`}
                            </div>
                          )}
                        </div>
                        <span
                          className={`badge ${
                            cob._id ? "b-mapped" : "b-custom"
                          }`}
                          style={{ fontSize: 10 }}
                        >
                          {cob._id ? "en Prolibu" : "solo local"}
                        </span>
                      </div>
                      {isExp && sfFields.length > 0 && (
                        <div
                          style={{
                            borderTop: "1px solid #e2e8f0",
                            maxHeight: 220,
                            overflowY: "auto",
                            background: "#fff",
                          }}
                        >
                          <table
                            style={{
                              width: "100%",
                              borderCollapse: "collapse",
                              fontSize: 11,
                            }}
                          >
                            <thead>
                              <tr
                                style={{
                                  background: "#f1f5f9",
                                  position: "sticky",
                                  top: 0,
                                }}
                              >
                                <th
                                  style={{
                                    padding: "3px 8px",
                                    textAlign: "left",
                                    color: "#475569",
                                    fontWeight: 600,
                                  }}
                                >
                                  Campo SF
                                </th>
                                <th
                                  style={{
                                    padding: "3px 8px",
                                    textAlign: "left",
                                    color: "#475569",
                                    fontWeight: 600,
                                  }}
                                >
                                  Tipo
                                </th>
                                <th
                                  style={{
                                    padding: "3px 8px",
                                    textAlign: "left",
                                    color: "#475569",
                                    fontWeight: 600,
                                  }}
                                >
                                  Label
                                </th>
                                <th
                                  style={{
                                    padding: "3px 8px",
                                    textAlign: "center",
                                    color: "#475569",
                                    fontWeight: 600,
                                  }}
                                >
                                  Req
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {sfFields.map((f) => {
                                const isRequired =
                                  f.nillable === false && f.createable === true;
                                const isRef = f.type === "reference";
                                return (
                                  <tr
                                    key={f.name}
                                    style={{
                                      borderTop: "1px solid #f1f5f9",
                                      background: f.custom
                                        ? "#fefce8"
                                        : "transparent",
                                    }}
                                  >
                                    <td
                                      style={{
                                        padding: "3px 8px",
                                        fontFamily: "monospace",
                                        color: f.custom ? "#92400e" : "#334155",
                                      }}
                                    >
                                      {f.name}
                                    </td>
                                    <td
                                      style={{
                                        padding: "3px 8px",
                                        color: isRef ? "#7c3aed" : "#64748b",
                                      }}
                                    >
                                      {f.type}
                                      {isRef && f.referenceTo
                                        ? ` → ${f.referenceTo}`
                                        : ""}
                                    </td>
                                    <td
                                      style={{
                                        padding: "3px 8px",
                                        color: "#64748b",
                                      }}
                                    >
                                      {f.label}
                                    </td>
                                    <td
                                      style={{
                                        padding: "3px 8px",
                                        textAlign: "center",
                                        color: isRequired
                                          ? "#dc2626"
                                          : "#94a3b8",
                                      }}
                                    >
                                      {isRequired ? "✱" : ""}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Custom Fields */}
          <div className="card">
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
              🏷️ Custom Fields — {customFields.length} entidad
              {customFields.length !== 1 ? "es" : ""}
            </div>
            {customFields.length === 0 ? (
              <div style={{ color: "#94a3b8", fontSize: 12 }}>
                Ninguno en disco. Usa "Pull desde Prolibu" o "Scaffold desde
                setup".
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {customFields.map((cf, i) => {
                  const fieldCount = Object.keys(cf.customFields || {}).length;
                  const overrideCount = Object.keys(cf.overrides || {}).length;
                  const key = `cf-${cf.objectAssigned}`;
                  const isExp = expandedLocal === key;
                  const allFields = [
                    ...Object.entries(cf.customFields || {}).map(([k, v]) => ({
                      key: k,
                      ...v,
                      _section: "customFields",
                    })),
                    ...Object.entries(cf.overrides || {}).map(([k, v]) => ({
                      key: k,
                      ...v,
                      _section: "overrides",
                    })),
                  ];
                  return (
                    <div
                      key={i}
                      style={{
                        flexShrink: 0,
                        borderRadius: 6,
                        background: "#f8fafc",
                        border: "1px solid #e2e8f0",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "6px 10px",
                          cursor: allFields.length ? "pointer" : "default",
                        }}
                        onClick={() =>
                          allFields.length &&
                          setExpandedLocal(isExp ? null : key)
                        }
                      >
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 13 }}>
                            {cf.objectAssigned}{" "}
                            {allFields.length > 0 && (
                              <span
                                style={{
                                  color: "#94a3b8",
                                  fontWeight: 400,
                                  fontSize: 11,
                                }}
                              >
                                {isExp ? "▲" : "▼"}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: "#94a3b8" }}>
                            {fieldCount} campo{fieldCount !== 1 ? "s" : ""}
                            {overrideCount > 0
                              ? ` · ${overrideCount} override${
                                  overrideCount !== 1 ? "s" : ""
                                }`
                              : ""}
                          </div>
                        </div>
                        <span
                          className={`badge ${
                            cf._id ? "b-mapped" : "b-custom"
                          }`}
                          style={{ fontSize: 10 }}
                        >
                          {cf._id ? "en Prolibu" : "solo local"}
                        </span>
                      </div>
                      {isExp && allFields.length > 0 && (
                        <div
                          style={{
                            borderTop: "1px solid #e2e8f0",
                            maxHeight: 220,
                            overflowY: "auto",
                            background: "#fff",
                          }}
                        >
                          <table
                            style={{
                              width: "100%",
                              borderCollapse: "collapse",
                              fontSize: 11,
                            }}
                          >
                            <thead>
                              <tr
                                style={{
                                  background: "#f1f5f9",
                                  position: "sticky",
                                  top: 0,
                                }}
                              >
                                <th
                                  style={{
                                    padding: "3px 8px",
                                    textAlign: "left",
                                    color: "#475569",
                                    fontWeight: 600,
                                  }}
                                >
                                  Campo
                                </th>
                                <th
                                  style={{
                                    padding: "3px 8px",
                                    textAlign: "left",
                                    color: "#475569",
                                    fontWeight: 600,
                                  }}
                                >
                                  Tipo
                                </th>
                                <th
                                  style={{
                                    padding: "3px 8px",
                                    textAlign: "left",
                                    color: "#475569",
                                    fontWeight: 600,
                                  }}
                                >
                                  Ref / Enum
                                </th>
                                <th
                                  style={{
                                    padding: "3px 8px",
                                    textAlign: "center",
                                    color: "#475569",
                                    fontWeight: 600,
                                  }}
                                >
                                  Req
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {allFields.map((f) => (
                                <tr
                                  key={f.key}
                                  style={{
                                    borderTop: "1px solid #f1f5f9",
                                    background:
                                      f._section === "overrides"
                                        ? "#f0fdf4"
                                        : "transparent",
                                  }}
                                >
                                  <td
                                    style={{
                                      padding: "3px 8px",
                                      fontFamily: "monospace",
                                      color: "#334155",
                                    }}
                                  >
                                    {f.key}
                                    {f._section === "overrides" && (
                                      <span
                                        style={{
                                          marginLeft: 4,
                                          fontSize: 10,
                                          color: "#16a34a",
                                          background: "#dcfce7",
                                          borderRadius: 3,
                                          padding: "1px 4px",
                                        }}
                                      >
                                        override
                                      </span>
                                    )}
                                  </td>
                                  <td
                                    style={{
                                      padding: "3px 8px",
                                      color:
                                        f.type === "objectid"
                                          ? "#7c3aed"
                                          : "#64748b",
                                    }}
                                  >
                                    {Array.isArray(f.type)
                                      ? f.type.join(" | ")
                                      : f.type || "string"}
                                  </td>
                                  <td
                                    style={{
                                      padding: "3px 8px",
                                      color: "#64748b",
                                      maxWidth: 160,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {f.ref != null ? (
                                      <span style={{ color: "#7c3aed" }}>
                                        →{" "}
                                        {f.ref || (
                                          <em style={{ color: "#ef4444" }}>
                                            ⚠ sin ref
                                          </em>
                                        )}
                                      </span>
                                    ) : f.enum?.length ? (
                                      f.enum.slice(0, 3).join(", ") +
                                      (f.enum.length > 3
                                        ? `… +${f.enum.length - 3}`
                                        : "")
                                    ) : (
                                      ""
                                    )}
                                  </td>
                                  <td
                                    style={{
                                      padding: "3px 8px",
                                      textAlign: "center",
                                      color: f.required ? "#dc2626" : "#94a3b8",
                                    }}
                                  >
                                    {f.required ? "✱" : ""}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
