import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMigration } from "../store";
import {
  createProlibuField,
  saveSetup as apiSaveSetup,
  saveMappings as apiSaveMappings,
  startMigration,
  subscribeMigrationLogs,
} from "../api";
import { showToast } from "../components/Toast";

/* ── helpers (ported from legacy SPA) ────────────────────── */

function prolibuEntitySchema(entityName, prolibuSpec) {
  if (!entityName || !prolibuSpec) return null;
  const sc = prolibuSpec?.components?.schemas || {};
  const low = entityName.toLowerCase();
  return (
    sc[entityName] ||
    sc[entityName.charAt(0).toUpperCase() + entityName.slice(1)] ||
    Object.entries(sc).find(([k]) => k.toLowerCase() === low)?.[1] ||
    null
  );
}

function matchField(sfName, prolibuProps) {
  if (!prolibuProps) return null;
  const clean = sfName.toLowerCase().replace(/__c$/, "").replace(/_/g, "");
  return (
    Object.keys(prolibuProps).find((k) => {
      const kc = k.toLowerCase().replace(/_/g, "");
      return kc === clean || kc.includes(clean) || clean.includes(kc);
    }) || null
  );
}

function mapType(sfType) {
  const m = {
    string: "text",
    textarea: "textarea",
    double: "number",
    integer: "integer",
    currency: "currency",
    boolean: "boolean",
    date: "date",
    datetime: "datetime",
    id: "id",
    reference: "relation",
    picklist: "select",
    multipicklist: "multiselect",
    email: "email",
    phone: "phone",
    url: "url",
  };
  return m[sfType] || "text";
}

const CUSTOM_FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "integer",
  "currency",
  "boolean",
  "date",
  "datetime",
  "email",
  "phone",
  "url",
  "select",
  "multiselect",
  "relation",
];

/* ── Component ───────────────────────────────────────────── */

export default function SchemaMap() {
  const { state, dispatch } = useMigration();
  const navigate = useNavigate();
  const { crm } = useParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedObj, setSelectedObj] = useState(null);

  /* ── field mapping state ───────────────────────────── */
  const [fieldMaps, setFieldMaps] = useState({});
  const [createdFields, setCreatedFields] = useState({});
  const [creatingFor, setCreatingFor] = useState(null);
  const [newField, setNewField] = useState({
    apiName: "",
    label: "",
    type: "text",
    description: "",
    required: false,
    defaultValue: "",
    picklistOptions: [],
    referenceTo: "",
  });
  const [optionInput, setOptionInput] = useState("");
  const [creating, setCreating] = useState(false);

  /* ── migration state ───────────────────────────── */
  const [migrateModal, setMigrateModal] = useState(false);
  const [migrateDryRun, setMigrateDryRun] = useState(true);
  const [migrating, setMigrating] = useState(false);
  const [migrateLogs, setMigrateLogs] = useState([]);
  const [migrateResult, setMigrateResult] = useState(null);
  const sseRef = useRef(null);
  const logEndRef = useRef(null);

  const {
    discovery,
    sfToProlibu,
    prolibuSpec,
    fieldMapping: knownFieldMapping,
  } = state;
  const sfMap = sfToProlibu || {};
  const knownFields = knownFieldMapping || {};

  /* ── auto-init mappings on object select ────────────── */
  useEffect(() => {
    if (!selectedObj || fieldMaps[selectedObj]) return;
    const m = sfMap[selectedObj];
    if (!m) return;
    const sc = prolibuEntitySchema(m.prolibu, prolibuSpec);
    const props = sc?.properties;
    const obj = discovery?.objects?.[selectedObj];
    const fields = obj?.fieldDetails || [];
    const known = knownFields[selectedObj] || {};
    const initial = {};
    for (const f of fields) {
      // 1. Use known field mapping if available
      if (known[f.name] !== undefined) {
        // null means explicitly skip, empty string means unmapped
        initial[f.name] = known[f.name] || "";
      }
      // 2. Fall back to heuristic match against Prolibu props
      else if (props) {
        initial[f.name] = matchField(f.name, props) || "";
      } else {
        initial[f.name] = "";
      }
    }
    setFieldMaps((prev) => ({ ...prev, [selectedObj]: initial }));
  }, [selectedObj, sfMap, prolibuSpec, discovery, knownFields]);

  /* ── mapping helpers ────────────────────────────────── */
  const setMapping = useCallback(
    (sfField, prolibuField) => {
      if (!selectedObj) return;
      if (prolibuField === "__create__") {
        const obj = discovery?.objects?.[selectedObj];
        const fd = (obj?.fieldDetails || []).find((f) => f.name === sfField);
        const sfType = fd?.type || "string";
        setCreatingFor(sfField);
        setNewField({
          apiName: sfField.toLowerCase().replace(/__c$/, "").replace(/_/g, ""),
          label: fd?.label || sfField,
          type: mapType(sfType),
          description: `Mapped from SF: ${sfField} (${sfType})`,
          required: false,
          defaultValue: "",
          picklistOptions: fd?.picklistValues ? [...fd.picklistValues] : [],
          referenceTo: fd?.referenceTo || "",
        });
        setOptionInput("");
        return;
      }
      setFieldMaps((prev) => ({
        ...prev,
        [selectedObj]: {
          ...(prev[selectedObj] || {}),
          [sfField]: prolibuField,
        },
      }));
    },
    [selectedObj, discovery],
  );

  const handleCreateField = useCallback(async () => {
    if (!selectedObj || !creatingFor) return;
    const m = sfMap[selectedObj];
    if (!m) return;
    setCreating(true);
    try {
      const body = {
        objectAssigned: m.prolibu,
        customFields: {
          [newField.apiName]: {
            type: newField.type,
            label: newField.label,
            isCustomField: true,
          },
        },
      };
      await createProlibuField(body);
      setCreatedFields((prev) => ({
        ...prev,
        [selectedObj]: {
          ...(prev[selectedObj] || {}),
          [newField.apiName]: { type: newField.type, label: newField.label },
        },
      }));
      setFieldMaps((prev) => ({
        ...prev,
        [selectedObj]: {
          ...(prev[selectedObj] || {}),
          [creatingFor]: newField.apiName,
        },
      }));
      showToast(`✅ Campo "${newField.apiName}" creado en ${m.prolibu}`);
      setCreatingFor(null);
    } catch (e) {
      showToast(`❌ Error: ${e.message}`, true);
    } finally {
      setCreating(false);
    }
  }, [selectedObj, creatingFor, newField, sfMap]);

  /* ── build & save setup from mappings ───────────────── */
  const handleSaveSetup = useCallback(async () => {
    const setup = { customObjects: [], customFields: [] };
    for (const [sfObjName, maps] of Object.entries(fieldMaps)) {
      const m = sfMap[sfObjName];
      if (!m) continue;
      const sc = prolibuEntitySchema(m.prolibu, prolibuSpec);
      const props = sc?.properties || {};
      const obj = discovery?.objects?.[sfObjName];
      for (const [sfField, pField] of Object.entries(maps)) {
        if (!pField) continue;
        if (props[pField]) continue; // standard field, no setup needed
        const fd = (obj?.fieldDetails || []).find((f) => f.name === sfField);
        const created = createdFields[sfObjName]?.[pField];
        setup.customFields.push({
          prolibuEntity: m.prolibu,
          apiName: pField,
          label: created?.label || fd?.label || pField,
          type: created?.type || mapType(fd?.type || "string"),
          sourceSField: sfField,
        });
      }
    }
    try {
      const d = await apiSaveSetup(setup);
      if (d.ok) showToast(`✅ prolibu_setup.json guardado → ${d.path}`);
      else showToast(`❌ ${d.error}`, true);
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    }
  }, [fieldMaps, sfMap, prolibuSpec, discovery, createdFields]);

  /* ── save field mappings to mappings.json ────────────── */
  const handleSaveMappings = useCallback(async () => {
    try {
      const d = await apiSaveMappings({ fieldMaps });
      if (d.ok) showToast(`✅ mappings.json guardado → ${d.path}`);
      else showToast(`❌ ${d.error}`, true);
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    }
  }, [fieldMaps]);

  /* ── migrate single entity ───────────────────────────── */
  const openMigrateModal = useCallback(() => {
    setMigrateLogs([]);
    setMigrateResult(null);
    setMigrateDryRun(true);
    setMigrating(false);
    setMigrateModal(true);
  }, []);

  const closeMigrateModal = useCallback(() => {
    if (sseRef.current) {
      sseRef.current();
      sseRef.current = null;
    }
    setMigrateModal(false);
    setMigrating(false);
  }, []);

  const handleMigrate = useCallback(async () => {
    if (!selectedObj) return;
    const m = sfMap[selectedObj];
    if (!m) return;

    const entityKey = m.prolibu;
    setMigrating(true);
    setMigrateLogs([]);
    setMigrateResult(null);

    try {
      const res = await startMigration({
        entities: [entityKey],
        dryRun: migrateDryRun,
      });
      if (!res.ok) {
        showToast(`❌ ${res.error || "Error al iniciar migración"}`, true);
        setMigrating(false);
        return;
      }

      const close = subscribeMigrationLogs(
        (msg) => {
          if (msg.type === "log") {
            setMigrateLogs((prev) => [...prev, msg.data]);
          } else if (msg.type === "result") {
            setMigrateResult(msg.data);
          } else if (msg.type === "done") {
            setMigrating(false);
            showToast(
              migrateDryRun
                ? "✅ Dry-run completado"
                : "✅ Migración completada",
            );
            sseRef.current = null;
          } else if (msg.type === "error") {
            setMigrateLogs((prev) => [...prev, `❌ ERROR: ${msg.data}`]);
          }
        },
        () => {
          setMigrating(false);
        },
      );
      sseRef.current = close;
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
      setMigrating(false);
    }
  }, [selectedObj, sfMap, migrateDryRun]);

  // auto-scroll migration logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [migrateLogs]);

  // cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (sseRef.current) {
        sseRef.current();
        sseRef.current = null;
      }
    };
  }, []);

  /* ── filtered & grouped object list ─────────────────── */
  const { mapped, custom, unmapped } = useMemo(() => {
    const objs = discovery?.objects || {};
    let entries = Object.entries(objs).filter(([, o]) => !o.error);
    const q = search.toLowerCase();

    if (q) {
      entries = entries.filter(
        ([n, o]) =>
          n.toLowerCase().includes(q) ||
          (o.label || "").toLowerCase().includes(q),
      );
    }
    if (filter === "mapped") entries = entries.filter(([n]) => sfMap[n]);
    if (filter === "custom")
      entries = entries.filter(([n]) => n.endsWith("__c"));
    if (filter === "data")
      entries = entries.filter(([, o]) => (o.records ?? 1) > 0);

    const isC = (n) => n.endsWith("__c");
    const byRec = ([, a], [, b]) => (b.records || 0) - (a.records || 0);
    const byName = ([a], [b]) => a.localeCompare(b);

    return {
      mapped: entries.filter(([n]) => !isC(n) && sfMap[n]).sort(byRec),
      custom: entries.filter(([n]) => isC(n)).sort(byRec),
      unmapped: entries.filter(([n]) => !isC(n) && !sfMap[n]).sort(byName),
    };
  }, [discovery, sfMap, search, filter]);

  /* ── add to config and navigate ─────────────────────── */
  const addToConfig = useCallback(
    (sfObjectName) => {
      const obj = discovery.objects[sfObjectName];
      const flds = (obj?.fieldDetails || []).map((f) => f.name);
      const m = sfMap[sfObjectName];
      const isC = sfObjectName.endsWith("__c");
      const cfg = { ...state.cfg };

      if (m) {
        const key = m.prolibu;
        if (!cfg.entities[key]) {
          const top = flds.filter((f) => !f.endsWith("__c")).slice(0, 14);
          cfg.entities = {
            ...cfg.entities,
            [key]: {
              enabled: true,
              sobject: sfObjectName,
              select: top.join(", "),
            },
          };
        } else {
          cfg.entities = {
            ...cfg.entities,
            [key]: { ...cfg.entities[key], enabled: true },
          };
        }
      } else if (isC) {
        if (!cfg.customObjects[sfObjectName]) {
          const top = flds
            .filter(
              (f) =>
                ![
                  "IsDeleted",
                  "SystemModstamp",
                  "LastModifiedById",
                  "CreatedById",
                ].includes(f),
            )
            .slice(0, 12);
          const key = sfObjectName.toLowerCase().replace("__c", "");
          cfg.customObjects = {
            ...cfg.customObjects,
            [sfObjectName]: {
              enabled: true,
              prolibuEntity: key,
              select: top.join(", "),
            },
          };
        } else {
          cfg.customObjects = {
            ...cfg.customObjects,
            [sfObjectName]: {
              ...cfg.customObjects[sfObjectName],
              enabled: true,
            },
          };
        }
      }

      dispatch({ type: "SET_CFG", payload: cfg });
      navigate(`/${crm}/config`);
    },
    [state.cfg, sfMap, discovery, dispatch, navigate, crm],
  );

  /* ── render group ───────────────────────────────────── */
  const renderGroup = (label, items) => {
    if (!items.length) return null;
    const withCount = discovery?.withCount;
    return (
      <>
        <div className="grp-label">
          {label} ({items.length})
        </div>
        {items.map(([name, obj]) => {
          const m = sfMap[name];
          const isC = name.endsWith("__c");
          const cls = m ? "b-mapped" : isC ? "b-custom" : "b-unmapped";
          const lbl = m ? `→ ${m.prolibu}` : isC ? "custom" : "sin mapeo";
          const sub = withCount
            ? `${(obj.records || 0).toLocaleString()} registros`
            : `${obj.fields || 0} campos`;

          return (
            <div
              key={name}
              className={`obj-row${selectedObj === name ? " sel" : ""}`}
              onClick={() => setSelectedObj(name)}
            >
              <div>
                <div className="obj-name">{name}</div>
                <div className="obj-sub">{sub}</div>
              </div>
              <span className={`badge ${cls}`}>{lbl}</span>
            </div>
          );
        })}
      </>
    );
  };

  /* ── detail pane ────────────────────────────────────── */
  const renderDetail = () => {
    if (!selectedObj) {
      return (
        <div className="placeholder">
          <div className="icon">🗂️</div>
          <h3>Selecciona un objeto Salesforce</h3>
          <div>La comparación de campos SF ↔ Prolibu aparecerá aquí.</div>
        </div>
      );
    }

    const obj = discovery.objects[selectedObj];
    const m = sfMap[selectedObj];
    const withCount = discovery.withCount;
    const fields = obj?.fieldDetails || [];
    const isC = selectedObj.endsWith("__c");

    let prolibuProps = null;
    if (m) {
      const sc = prolibuEntitySchema(m.prolibu, prolibuSpec);
      prolibuProps = sc?.properties || null;
    }

    // Known YAML mappings for this object (e.g. { Name: 'companyName', ... })
    const known = knownFields[selectedObj] || {};
    const hasKnownMapping = Object.keys(known).length > 0;

    const customFieldCount = fields.filter((f) => f.custom).length;
    // Show mapping columns when we have prolibu schema OR known YAML mappings
    const showMapping = !!prolibuProps || hasKnownMapping || !!m;
    const currentMaps = fieldMaps[selectedObj] || {};
    const extra = createdFields[selectedObj] || {};

    // All available Prolibu fields = schema props + known YAML targets + dynamically created
    const allProlibuFields = (() => {
      const base = prolibuProps ? { ...prolibuProps } : {};
      // Add known mapping target fields that aren't already in the schema
      for (const toField of Object.values(known)) {
        if (toField && !base[toField]) {
          base[toField] = { type: "string", description: toField };
        }
      }
      for (const [k, v] of Object.entries(extra)) {
        if (!base[k]) base[k] = { type: v.type, description: v.label };
      }
      return base;
    })();

    // Already-used Prolibu fields (to warn duplicates)
    const usedFields = (() => {
      const used = new Set();
      for (const v of Object.values(currentMaps)) {
        if (v) used.add(v);
      }
      return used;
    })();

    // Mapping stats
    const stats = (() => {
      let autoMatch = 0,
        manual = 0,
        unmapped = 0,
        toCreate = 0;
      for (const f of fields) {
        const mapped = currentMaps[f.name];
        if (!mapped) {
          unmapped++;
          continue;
        }
        // Check if this came from a known YAML mapping or heuristic match
        const knownMatch = known[f.name];
        const autoM = matchField(f.name, prolibuProps);
        if (knownMatch === mapped || autoM === mapped) autoMatch++;
        else if (extra[mapped]) toCreate++;
        else manual++;
      }
      return { autoMatch, manual, unmapped, toCreate };
    })();

    const sorted = [...fields].sort((a, b) => {
      if (a.custom !== b.custom) return a.custom ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    // Sorted Prolibu field names for dropdown
    const prolibuFieldNames = Object.keys(allProlibuFields).sort((a, b) =>
      a.localeCompare(b),
    );

    return (
      <>
        <div className="det-header">
          <div>
            <div className="det-title">{selectedObj}</div>
            <div className="det-sub">
              {obj?.label || ""} · {isC ? "Custom Object" : "Standard Object"} ·{" "}
              {fields.length} campos
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {m && (
              <button className="migrate-btn" onClick={openMigrateModal}>
                🚀 Migrar
              </button>
            )}
            {showMapping && (
              <button className="save-mapping-btn" onClick={handleSaveMappings}>
                💾 Guardar Mappings
              </button>
            )}
            {showMapping && (
              <button
                className="save-mapping-btn"
                onClick={handleSaveSetup}
                style={{ opacity: 0.7 }}
              >
                📦 Guardar Setup
              </button>
            )}
            <button
              className="add-cfg-btn"
              onClick={() => addToConfig(selectedObj)}
            >
              + Agregar al Config
            </button>
          </div>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="n">{fields.length}</div>
            <div className="l">Campos totales</div>
          </div>
          <div className="stat">
            <div className="n">{customFieldCount}</div>
            <div className="l">Custom fields</div>
          </div>
          {withCount && (
            <div className="stat">
              <div className="n">{(obj?.records || 0).toLocaleString()}</div>
              <div className="l">Registros</div>
            </div>
          )}
          {showMapping && (
            <>
              <div className="stat">
                <div className="n">{Object.keys(allProlibuFields).length}</div>
                <div className="l">Campos Prolibu</div>
              </div>
              <div className="stat stat-ok">
                <div className="n">{stats.autoMatch}</div>
                <div className="l">Auto-match</div>
              </div>
              <div className="stat stat-manual">
                <div className="n">{stats.manual}</div>
                <div className="l">Manual</div>
              </div>
              <div className="stat stat-warn">
                <div className="n">{stats.toCreate}</div>
                <div className="l">Creados</div>
              </div>
              <div className="stat stat-empty">
                <div className="n">{stats.unmapped}</div>
                <div className="l">Sin mapeo</div>
              </div>
            </>
          )}
        </div>

        {m && (
          <div className="mapping-banner">
            <span style={{ fontSize: 20 }}>🔄</span>
            <div>
              <div
                style={{
                  fontSize: 10,
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: ".05em",
                }}
              >
                Mapeado a entidad Prolibu
              </div>
              <div className="ent">{m.prolibu}</div>
            </div>
            {!prolibuProps && !hasKnownMapping && (
              <span style={{ fontSize: 11, color: "#d97706" }}>
                ⚠️ Schema Prolibu no disponible
              </span>
            )}
            {hasKnownMapping && (
              <span style={{ fontSize: 11, color: "#059669" }}>
                ✅ {Object.keys(known).length} campos pre-mapeados (YAML)
              </span>
            )}
            <div className="note">{m.notes || ""}</div>
          </div>
        )}

        {!m && isC && (
          <div className="warn-banner">
            🔶 <strong>Custom Object</strong> — Sin mapeo predefinido. Usa el{" "}
            <strong>Config Builder</strong> para asignarlo a una entidad
            Prolibu.
          </div>
        )}

        {!m && !isC && (
          <div className="info-banner">
            ⚪ <strong>Sin mapeo por defecto</strong> — Este objeto estándar no
            tiene equivalente predefinido en Prolibu.
          </div>
        )}

        <div className="sec-title">
          {showMapping ? "Mapeo de campos CRM → Prolibu" : "Campos Salesforce"}
        </div>
        <table className={showMapping ? "mapping-table" : ""}>
          <thead>
            <tr>
              <th>Campo CRM</th>
              <th>Tipo</th>
              <th>Custom</th>
              {showMapping && <th>→ Campo Prolibu</th>}
              {showMapping && <th>Tipo Prolibu</th>}
              {showMapping && <th>Estado</th>}
            </tr>
          </thead>
          <tbody>
            {sorted.map((f) => {
              const mapped = currentMaps[f.name] || "";
              const autoM = matchField(f.name, prolibuProps);
              const knownMatch = known[f.name];
              const isDuplicate =
                mapped &&
                usedFields.has(mapped) &&
                Object.entries(currentMaps).some(
                  ([k, v]) => v === mapped && k !== f.name,
                );

              let statusEl = null;
              if (showMapping) {
                if (!mapped) {
                  statusEl = <span className="s-none">· Sin mapeo</span>;
                } else if (knownMatch === mapped) {
                  statusEl = <span className="s-ok">✅ YAML</span>;
                } else if (autoM === mapped) {
                  statusEl = <span className="s-ok">✅ Match</span>;
                } else if (extra[mapped]) {
                  statusEl = <span className="s-created">✨ Creado</span>;
                } else {
                  statusEl = <span className="s-manual">🔗 Manual</span>;
                }
              }

              return (
                <tr
                  key={f.name}
                  className={
                    creatingFor === f.name
                      ? "row-creating"
                      : !mapped && showMapping
                      ? "row-unmapped"
                      : ""
                  }
                >
                  <td>
                    <code>{f.name}</code>
                    {f.label && f.label !== f.name && (
                      <>
                        <br />
                        <span style={{ color: "#94a3b8", fontSize: 10 }}>
                          {f.label}
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    <span className="type-tag">{f.type}</span>
                  </td>
                  <td>
                    {f.custom ? <span className="custom-dot">●</span> : ""}
                  </td>
                  {showMapping && (
                    <td>
                      <select
                        className={`mapping-select${
                          mapped
                            ? autoM === mapped
                              ? " matched"
                              : " manual"
                            : " empty"
                        }`}
                        value={mapped}
                        onChange={(e) => setMapping(f.name, e.target.value)}
                      >
                        <option value="">— sin asignar —</option>
                        <optgroup label="Campos del modelo">
                          {prolibuFieldNames.map((pf) => (
                            <option key={pf} value={pf}>
                              {pf}
                              {allProlibuFields[pf]?.type
                                ? ` (${allProlibuFields[pf].type})`
                                : ""}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Acciones">
                          <option value="__create__">
                            ➕ Crear custom field…
                          </option>
                        </optgroup>
                      </select>
                      {isDuplicate && (
                        <span
                          className="dup-warn"
                          title="Campo usado en otro mapeo"
                        >
                          ⚠️
                        </span>
                      )}
                    </td>
                  )}
                  {showMapping && (
                    <td>
                      {mapped && allProlibuFields[mapped]?.type ? (
                        <span className="type-tag type-prolibu">
                          {allProlibuFields[mapped].type}
                        </span>
                      ) : mapped ? (
                        <span className="type-tag" style={{ opacity: 0.4 }}>
                          —
                        </span>
                      ) : null}
                    </td>
                  )}
                  {showMapping && <td>{statusEl}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* ── create custom field drawer ────────── */}
        {creatingFor && showMapping && (
          <>
            <div
              className="drawer-overlay"
              onClick={() => setCreatingFor(null)}
            />
            <div className="drawer-panel">
              <div className="drawer-header">
                <div>
                  <div className="drawer-title">Crear Custom Field</div>
                  <div className="drawer-sub">
                    Campo <strong>{creatingFor}</strong> → Entidad{" "}
                    <strong>{m?.prolibu}</strong>
                  </div>
                </div>
                <button
                  className="drawer-close"
                  onClick={() => setCreatingFor(null)}
                >
                  ✕
                </button>
              </div>

              {/* source info */}
              {(() => {
                const fd = (obj?.fieldDetails || []).find(
                  (f) => f.name === creatingFor,
                );
                return fd ? (
                  <div className="drawer-source-info">
                    <div className="drawer-section-label">
                      Campo Origen (Salesforce)
                    </div>
                    <div className="drawer-source-grid">
                      <div>
                        <span className="dsg-label">Nombre</span>
                        <span className="dsg-val">{fd.name}</span>
                      </div>
                      <div>
                        <span className="dsg-label">Label</span>
                        <span className="dsg-val">{fd.label}</span>
                      </div>
                      <div>
                        <span className="dsg-label">Tipo</span>
                        <span className="dsg-val">
                          <span className="type-tag">{fd.type}</span>
                        </span>
                      </div>
                      <div>
                        <span className="dsg-label">Custom</span>
                        <span className="dsg-val">
                          {fd.custom ? "Sí" : "No"}
                        </span>
                      </div>
                      {fd.picklistValues && (
                        <div style={{ gridColumn: "1 / -1" }}>
                          <span className="dsg-label">Picklist values</span>
                          <span className="dsg-val" style={{ fontSize: 10 }}>
                            {fd.picklistValues.slice(0, 15).join(", ")}
                            {fd.picklistValues.length > 15 &&
                              ` … +${fd.picklistValues.length - 15}`}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : null;
              })()}

              <div className="drawer-section-label">
                Campo Destino (Prolibu)
              </div>
              <div className="drawer-form">
                <div className="drawer-field">
                  <label>API Name</label>
                  <input
                    type="text"
                    value={newField.apiName}
                    onChange={(e) =>
                      setNewField((p) => ({ ...p, apiName: e.target.value }))
                    }
                    placeholder="nombre_campo"
                  />
                  <span className="drawer-hint">
                    Nombre técnico del campo (sin espacios)
                  </span>
                </div>
                <div className="drawer-field">
                  <label>Label</label>
                  <input
                    type="text"
                    value={newField.label}
                    onChange={(e) =>
                      setNewField((p) => ({ ...p, label: e.target.value }))
                    }
                    placeholder="Etiqueta visible"
                  />
                  <span className="drawer-hint">
                    Nombre visible en la UI de Prolibu
                  </span>
                </div>
                <div className="drawer-row-2">
                  <div className="drawer-field">
                    <label>Tipo</label>
                    <select
                      value={newField.type}
                      onChange={(e) =>
                        setNewField((p) => ({ ...p, type: e.target.value }))
                      }
                    >
                      {CUSTOM_FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="drawer-field">
                    <label>Requerido</label>
                    <label className="drawer-toggle">
                      <input
                        type="checkbox"
                        checked={newField.required}
                        onChange={(e) =>
                          setNewField((p) => ({
                            ...p,
                            required: e.target.checked,
                          }))
                        }
                      />
                      <span>{newField.required ? "Sí" : "No"}</span>
                    </label>
                  </div>
                </div>
                <div className="drawer-field">
                  <label>Valor por defecto</label>
                  <input
                    type="text"
                    value={newField.defaultValue}
                    onChange={(e) =>
                      setNewField((p) => ({
                        ...p,
                        defaultValue: e.target.value,
                      }))
                    }
                    placeholder="(vacío)"
                  />
                </div>
                <div className="drawer-field">
                  <label>Descripción</label>
                  <textarea
                    rows={2}
                    value={newField.description}
                    onChange={(e) =>
                      setNewField((p) => ({
                        ...p,
                        description: e.target.value,
                      }))
                    }
                    placeholder="Descripción del campo…"
                  />
                </div>
                {(newField.type === "select" ||
                  newField.type === "multiselect") && (
                  <div className="drawer-field">
                    <label>Opciones</label>
                    <div className="picklist-add-row">
                      <input
                        type="text"
                        value={optionInput}
                        onChange={(e) => setOptionInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && optionInput.trim()) {
                            e.preventDefault();
                            setNewField((p) => ({
                              ...p,
                              picklistOptions: [
                                ...p.picklistOptions,
                                optionInput.trim(),
                              ],
                            }));
                            setOptionInput("");
                          }
                        }}
                        placeholder="Escribir opción y presionar Enter…"
                      />
                      <button
                        type="button"
                        className="picklist-add-btn"
                        disabled={!optionInput.trim()}
                        onClick={() => {
                          setNewField((p) => ({
                            ...p,
                            picklistOptions: [
                              ...p.picklistOptions,
                              optionInput.trim(),
                            ],
                          }));
                          setOptionInput("");
                        }}
                      >
                        +
                      </button>
                    </div>
                    {newField.picklistOptions.length > 0 && (
                      <ul className="picklist-items">
                        {newField.picklistOptions.map((opt, i) => (
                          <li key={i} className="picklist-item">
                            <span>{opt}</span>
                            <button
                              type="button"
                              className="picklist-remove"
                              onClick={() =>
                                setNewField((p) => ({
                                  ...p,
                                  picklistOptions: p.picklistOptions.filter(
                                    (_, idx) => idx !== i,
                                  ),
                                }))
                              }
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <span className="drawer-hint">
                      Se crearán como valores del picklist en Prolibu
                    </span>
                  </div>
                )}
                {newField.type === "relation" && (
                  <div className="drawer-field">
                    <label>Entidad referenciada</label>
                    <input
                      type="text"
                      value={newField.referenceTo}
                      onChange={(e) =>
                        setNewField((p) => ({
                          ...p,
                          referenceTo: e.target.value,
                        }))
                      }
                      placeholder="Ej: Contact, Account…"
                    />
                    <span className="drawer-hint">
                      Entidad a la que apunta este campo de referencia
                    </span>
                  </div>
                )}
              </div>

              <div className="drawer-footer">
                <button
                  className="drawer-cancel"
                  onClick={() => setCreatingFor(null)}
                >
                  Cancelar
                </button>
                <button
                  className="drawer-submit"
                  onClick={handleCreateField}
                  disabled={creating || !newField.apiName}
                >
                  {creating ? "Creando…" : "➕ Crear campo"}
                </button>
              </div>
            </div>
          </>
        )}

        {(obj?.relationships || []).length > 0 && (
          <>
            <div className="sec-title" style={{ marginTop: 16 }}>
              Relaciones ({obj.relationships.length})
            </div>
            <table>
              <thead>
                <tr>
                  <th>Campo</th>
                  <th>Referencia a</th>
                  <th>Tipo</th>
                </tr>
              </thead>
              <tbody>
                {obj.relationships.map((rel) => (
                  <tr key={rel.name}>
                    <td>
                      <code>{rel.name}</code>
                    </td>
                    <td>{rel.referenceTo}</td>
                    <td>
                      <span className="type-tag">{rel.type}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </>
    );
  };

  return (
    <div className="schema-page">
      <div className="schema-list">
        <div className="list-search">
          <input
            placeholder="🔍 Buscar objeto…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="list-filters">
          {[
            ["all", "Todos"],
            ["mapped", "✅ Mapeados"],
            ["custom", "🔶 Custom"],
            ["data", "Con datos"],
          ].map(([f, label]) => (
            <button
              key={f}
              className={`fbtn${filter === f ? " active" : ""}`}
              onClick={() => setFilter(f)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="obj-list">
          {renderGroup("✅ Mapeados a Prolibu", mapped)}
          {renderGroup("🔶 Custom Objects", custom)}
          {renderGroup("⚪ Sin mapeo por defecto", unmapped)}
          {!mapped.length && !custom.length && !unmapped.length && (
            <div style={{ padding: 20, color: "#94a3b8", textAlign: "center" }}>
              Sin resultados
            </div>
          )}
        </div>
      </div>
      <div className="schema-detail">{renderDetail()}</div>

      {/* ── Migration modal ────────────────────── */}
      {migrateModal && (
        <>
          <div
            className="drawer-overlay"
            onClick={migrating ? undefined : closeMigrateModal}
          />
          <div className="migrate-modal">
            <div className="migrate-modal-header">
              <div>
                <div className="migrate-modal-title">🚀 Migrar entidad</div>
                <div className="migrate-modal-sub">
                  {selectedObj} → <strong>{sfMap[selectedObj]?.prolibu}</strong>
                </div>
              </div>
              <button
                className="drawer-close"
                onClick={closeMigrateModal}
                disabled={migrating}
              >
                ✕
              </button>
            </div>

            {!migrating && migrateLogs.length === 0 && (
              <div className="migrate-modal-body">
                <div className="migrate-option">
                  <label className="drawer-toggle">
                    <input
                      type="checkbox"
                      checked={migrateDryRun}
                      onChange={(e) => setMigrateDryRun(e.target.checked)}
                    />
                    <span>Dry Run</span>
                  </label>
                  <span className="migrate-hint">
                    {migrateDryRun
                      ? "Simula la migración sin escribir datos en Prolibu"
                      : "⚠️ Se escribirán datos reales en Prolibu"}
                  </span>
                </div>
              </div>
            )}

            {migrateLogs.length > 0 && (
              <div className="migrate-logs">
                {migrateLogs.map((line, i) => (
                  <div
                    key={i}
                    className={`migrate-log-line${
                      line.startsWith("❌")
                        ? " error"
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
            )}

            {migrateResult && (
              <div className="migrate-result">
                <div className="migrate-result-entity">
                  {migrateResult.entity}
                </div>
                {migrateResult.created != null && (
                  <span className="migrate-stat ok">
                    ✅ {migrateResult.created} creados
                  </span>
                )}
                {migrateResult.updated != null && (
                  <span className="migrate-stat ok">
                    🔄 {migrateResult.updated} actualizados
                  </span>
                )}
                {migrateResult.errors != null && migrateResult.errors > 0 && (
                  <span className="migrate-stat err">
                    ❌ {migrateResult.errors} errores
                  </span>
                )}
                {migrateResult.skipped != null && migrateResult.skipped > 0 && (
                  <span className="migrate-stat warn">
                    ⏭️ {migrateResult.skipped} omitidos
                  </span>
                )}
              </div>
            )}

            <div className="migrate-modal-footer">
              <button
                className="drawer-cancel"
                onClick={closeMigrateModal}
                disabled={migrating}
              >
                {migrateLogs.length > 0 && !migrating ? "Cerrar" : "Cancelar"}
              </button>
              {(!migrateLogs.length || migrating) && (
                <button
                  className="migrate-run-btn"
                  onClick={handleMigrate}
                  disabled={migrating}
                >
                  {migrating
                    ? "⏳ Migrando…"
                    : migrateDryRun
                    ? "🧪 Ejecutar Dry Run"
                    : "🚀 Ejecutar Migración"}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
