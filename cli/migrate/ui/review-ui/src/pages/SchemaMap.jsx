import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useMigration } from "../store";
import {
  createProlibuField,
  saveObjectFiles,
  pushObjectModel,
  subscribeObjectsLogs,
  refreshProlibuSchema,
  saveConfig as apiSaveConfig,
  saveMappings as apiSaveMappings,
  startMigration,
  cancelMigration,
  subscribeMigrationLogs,
  toggleSchemaEntity,
  addSchemaEntity,
} from "../api";
import { showToast } from "../components/Toast";
import {
  prolibuEntitySchema,
  matchField,
  mapType,
  buildCobFromSFFields,
} from "../utils/schema";

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
  const { crm } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const selectedObj = searchParams.get("obj") || null;
  const setSelectedObj = (name) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (name) next.set("obj", name);
        else next.delete("obj");
        return next;
      },
      { replace: true },
    );

  /* ── field mapping state ───────────────────────────── */
  const [fieldMaps, setFieldMaps] = useState({});
  const [fieldRefs, setFieldRefs] = useState({}); // { sfObject: { sfField: 'ProlibuModel' } }
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
  const [migrating, setMigrating] = useState(false);
  const [migrateLogs, setMigrateLogs] = useState([]);
  const [migrateResult, setMigrateResult] = useState(null);
  const [migrateProgress, setMigrateProgress] = useState(null);
  const sseRef = useRef(null);
  const logEndRef = useRef(null);

  const {
    discovery,
    sfToProlibu,
    prolibuSpec,
    cfg,
    schemaEntities,
    fieldMapping: knownFieldMapping,
  } = state;
  const sfMap = sfToProlibu || {};
  const knownFields = knownFieldMapping || {};

  // Available Prolibu models for reference fields
  // Extract from: 1) OpenAPI paths, 2) components.schemas, 3) known sfToProlibu mappings
  const prolibuModels = useMemo(() => {
    const models = new Set();

    // 1. Extract from OpenAPI paths: /v2/{model}/ patterns
    const paths = prolibuSpec?.paths || {};
    for (const p of Object.keys(paths)) {
      const m = p.match(/^\/v2\/([a-z][a-z0-9-]*)\/$/i);
      if (m) {
        // Capitalize first letter for display
        const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
        models.add(name);
      }
    }

    // 2. Add from components.schemas if available
    const schemas = prolibuSpec?.components?.schemas || {};
    for (const name of Object.keys(schemas)) {
      models.add(name);
    }

    // 3. Add known Prolibu models from sfToProlibu mapping as fallback
    for (const mapping of Object.values(sfMap)) {
      if (mapping?.prolibu) {
        models.add(mapping.prolibu);
      }
    }

    return [...models].sort((a, b) => a.localeCompare(b));
  }, [prolibuSpec, sfMap]);

  /* ── schema entity toggle (absorbed from ConfigBuilder) ── */
  const targetToSchemaKey = useMemo(() => {
    const m = {};
    for (const [k, v] of Object.entries(schemaEntities || {})) {
      if (v.target) m[v.target] = k;
    }
    return m;
  }, [schemaEntities]);

  const isEntityEnabled = useCallback(
    (prolibuTarget) => {
      const sk = targetToSchemaKey[prolibuTarget];
      if (!sk) return false;
      return schemaEntities[sk]?.enabled !== false;
    },
    [schemaEntities, targetToSchemaKey],
  );

  const handleToggleEntity = useCallback(
    (sfName, enabled) => {
      const m = sfMap[sfName];
      if (!m) return;
      const sk = targetToSchemaKey[m.prolibu];
      if (!sk) return;
      toggleSchemaEntity(sk, enabled).catch(() => {});
      dispatch({
        type: "SET_SCHEMA_ENTITY_ENABLED",
        payload: { entityKey: sk, enabled },
      });
    },
    [sfMap, targetToSchemaKey, dispatch],
  );

  /* ── config mutations (absorbed from ConfigBuilder) ───── */
  const updateEntityCfg = useCallback(
    (sfName, field, value) => {
      const m = sfMap[sfName];
      if (!m) return;
      const key = m.prolibu;
      const prev = cfg.entities[key] || { sobject: sfName };
      dispatch({
        type: "SET_ENTITY_CFG",
        payload: { key, value: { ...prev, [field]: value } },
      });
    },
    [sfMap, cfg, dispatch],
  );

  const handleSaveConfig = useCallback(async () => {
    try {
      const d = await apiSaveConfig(cfg);
      if (d.ok) showToast(`✅ config.json guardado`);
      else showToast(`❌ ${d.error}`, true);
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    }
  }, [cfg]);

  /* ── assign unmapped object to Prolibu entity ───────── */
  const [assignTarget, setAssignTarget] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [entityMissing, setEntityMissing] = useState({}); // { sfName: targetName }
  const [creatingCob, setCreatingCob] = useState(false);

  // Pre-fill assign input with SF object name when selecting an unmapped object
  useEffect(() => {
    if (!selectedObj) return;
    const m = sfMap[selectedObj];
    if (!m) {
      setAssignTarget(selectedObj.replace(/__c$/, ""));
    } else {
      setAssignTarget("");
    }
  }, [selectedObj, sfMap]);

  const entityExistsInProlibu = useCallback(
    (t) => {
      const schemas = prolibuSpec?.components?.schemas || {};
      const paths = prolibuSpec?.paths || {};
      return (
        !!schemas[t] ||
        !!schemas[t.charAt(0).toUpperCase() + t.slice(1)] ||
        !!paths[`/v2/${t}/`]
      );
    },
    [prolibuSpec],
  );

  const handleAssignEntity = useCallback(
    async (sfName, target) => {
      if (!target) return;
      const t = target.trim().toLowerCase();
      const entityKey = t.endsWith("s") ? t : `${t}s`;
      setAssigning(true);
      try {
        const res = await addSchemaEntity({
          source: sfName,
          target: t,
          entityKey,
        });
        if (res.ok) {
          dispatch({
            type: "ADD_SCHEMA_ENTITY",
            payload: {
              source: sfName,
              entityKey: res.entityKey,
              entity: res.entity,
              sfToProlibuEntry: res.sfToProlibuEntry,
            },
          });
          setAssignTarget("");

          const obj = discovery?.objects?.[sfName];
          const fields = obj?.fieldDetails || [];

          // Pre-fill 1:1 field mappings BEFORE any await (prevents auto-init effect overwrite)
          // and persist them immediately to mappings.json
          if (fields.length) {
            const SKIP = new Set([
              "Id",
              "IsDeleted",
              "CreatedDate",
              "CreatedById",
              "LastModifiedDate",
              "LastModifiedById",
              "SystemModstamp",
              "LastActivityDate",
              "LastViewedDate",
              "LastReferencedDate",
              "OwnerId",
            ]);
            const initial = {};
            for (const f of fields) {
              initial[f.name] = SKIP.has(f.name) ? "" : f.name;
            }
            setFieldMaps((prev) => ({ ...prev, [sfName]: initial }));
            apiSaveMappings({ fieldMaps: { [sfName]: initial } }).catch(
              () => {},
            );
          }

          if (entityExistsInProlibu(t)) {
            showToast(`✅ ${sfName} → ${t} asignado`);
          } else {
            // Save Cob + CustomField JSONs to disk immediately
            // Use sfName directly — already PascalCase (e.g. BackgroundOperation)
            const modelName = sfName.replace(/__c$/, "");
            if (fields.length) {
              const { cob, customField } = buildCobFromSFFields(
                modelName,
                fields,
              );
              try {
                await saveObjectFiles({ cob, customField });
                showToast(
                  `✅ ${sfName} → ${t} asignado — JSONs guardados en disco`,
                );
              } catch {
                showToast(`⚠️ Asignado pero error guardando JSONs`, true);
              }
            }
            setEntityMissing((prev) => ({ ...prev, [sfName]: t }));
          }
        }
      } catch (e) {
        showToast(`❌ ${e.message}`, true);
      } finally {
        setAssigning(false);
      }
    },
    [dispatch, entityExistsInProlibu, discovery],
  );

  const cobSseRef = useRef(null);
  const [cobPushLogs, setCobPushLogs] = useState([]);

  const handlePublishCob = useCallback(
    async (sfName) => {
      const m = sfMap[sfName];
      if (!m) return;
      const modelName = m.prolibu.charAt(0).toUpperCase() + m.prolibu.slice(1);
      setCreatingCob(true);
      setCobPushLogs([]);
      try {
        // Push single model via bash: cob sync --model X + customfield push --model X
        const pushRes = await pushObjectModel(modelName);
        if (!pushRes.ok) {
          showToast(`❌ ${pushRes.error || "Error al iniciar push"}`, true);
          setCreatingCob(false);
          return;
        }

        const close = subscribeObjectsLogs(
          (msg) => {
            if (msg.type === "objects-log") {
              setCobPushLogs((p) => [...p, msg.data]);
            } else if (msg.type === "objects-done") {
              if (msg.data?.ok) {
                showToast(`✅ "${modelName}" publicado en Prolibu`);
                setEntityMissing((prev) => {
                  const next = { ...prev };
                  delete next[sfName];
                  return next;
                });
                // Refresh prolibuSpec so the new entity's schema is available
                refreshProlibuSchema()
                  .then((r) => {
                    if (r.spec) {
                      dispatch({ type: "SET_PROLIBU_SPEC", payload: r.spec });
                    }
                  })
                  .catch(() => {});
              } else {
                showToast(`❌ ${msg.data?.error || "Error en push"}`, true);
              }
              setCreatingCob(false);
              cobSseRef.current = null;
            }
          },
          () => {
            setCreatingCob(false);
          },
        );
        cobSseRef.current = close;
      } catch (e) {
        showToast(`❌ ${e.message}`, true);
        setCreatingCob(false);
      }
    },
    [sfMap],
  );

  // Cleanup COB SSE on unmount
  useEffect(() => {
    return () => {
      if (cobSseRef.current) {
        cobSseRef.current();
        cobSseRef.current = null;
      }
    };
  }, []);

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

  /* ── set reference model for a field ─────────────────── */
  const setFieldRef = useCallback(
    (sfField, refModel) => {
      if (!selectedObj) return;
      setFieldRefs((prev) => ({
        ...prev,
        [selectedObj]: {
          ...(prev[selectedObj] || {}),
          [sfField]: refModel || undefined,
        },
      }));
    },
    [selectedObj],
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

  /* ── save field mappings to mappings.json ────────────── */
  const handleSaveMappings = useCallback(async () => {
    try {
      // Include ref info in fieldMaps for fields that are references
      const enrichedFieldMaps = {};
      for (const [sfObj, maps] of Object.entries(fieldMaps)) {
        enrichedFieldMaps[sfObj] = {};
        const refs = fieldRefs[sfObj] || {};
        for (const [sfField, toField] of Object.entries(maps)) {
          if (refs[sfField]) {
            // Field has a reference - store as object
            enrichedFieldMaps[sfObj][sfField] = {
              to: toField,
              ref: refs[sfField],
            };
          } else {
            // Simple mapping
            enrichedFieldMaps[sfObj][sfField] = toField;
          }
        }
      }
      const d = await apiSaveMappings({ fieldMaps: enrichedFieldMaps });
      if (d.ok) showToast(`✅ mappings.json guardado → ${d.path}`);
      else showToast(`❌ ${d.error}`, true);
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    }
  }, [fieldMaps, fieldRefs]);

  /* ── migrate single entity ───────────────────────────── */
  const openMigrateModal = useCallback(() => {
    setMigrateLogs([]);
    setMigrateResult(null);
    setMigrateProgress(null);
    setMigrating(false);
    setMigrateModal(true);
  }, []);

  const closeMigrateModal = useCallback(() => {
    if (sseRef.current) {
      sseRef.current();
      sseRef.current = null;
    }
    if (migrating) {
      cancelMigration().catch(() => {});
    }
    setMigrateModal(false);
    setMigrating(false);
  }, [migrating]);

  const handleMigrate = useCallback(async () => {
    if (!selectedObj) return;
    const m = sfMap[selectedObj];
    if (!m) return;

    const entityKey = m.prolibu;
    setMigrating(true);
    setMigrateLogs([]);
    setMigrateResult(null);
    setMigrateProgress(null);

    try {
      const res = await startMigration({
        entities: [entityKey],
        dryRun: false,
      });
      if (!res.ok) {
        showToast(`❌ ${res.error || "Error al iniciar migración"}`, true);
        setMigrating(false);
        return;
      }

      const close = subscribeMigrationLogs(
        (msg) => {
          if (msg.type === "log") {
            // Parse the CLI summary line:
            // "   ✅ 147 migrated, 🔄 147 updated, ➕ 0 created, ⏭️ 13 skipped, ❌ 13 errors"
            const summaryMatch = msg.data?.match(/✅\s*(\d+)\s*migrated/);
            if (summaryMatch) {
              const migratedN = parseInt(summaryMatch[1]);
              const createdM = msg.data.match(/➕\s*(\d+)/);
              const updatedM = msg.data.match(/🔄\s*(\d+)/);
              const skippedM = msg.data.match(/⏭️\s*(\d+)/);
              const errorsM = msg.data.match(/❌\s*(\d+)/);
              setMigrateResult({
                entity: sfMap[selectedObj]?.prolibu,
                migrated: migratedN,
                created: createdM ? parseInt(createdM[1]) : 0,
                updated: updatedM ? parseInt(updatedM[1]) : 0,
                skipped: skippedM ? parseInt(skippedM[1]) : 0,
                errors: errorsM ? parseInt(errorsM[1]) : 0,
              });
              // Still show the line in logs
            }
            setMigrateLogs((prev) => [...prev, msg.data]);
          } else if (msg.type === "result") {
            setMigrateResult(msg.data);
          } else if (msg.type === "done") {
            setMigrating(false);
            showToast("✅ Migración completada");
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
  }, [selectedObj, sfMap]);

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
      mapped: entries.filter(([n]) => sfMap[n]).sort(byRec),
      custom: entries.filter(([n]) => isC(n) && !sfMap[n]).sort(byRec),
      unmapped: entries.filter(([n]) => !isC(n) && !sfMap[n]).sort(byName),
    };
  }, [discovery, sfMap, search, filter]);

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
          const enabled = m ? isEntityEnabled(m.prolibu) : false;

          return (
            <div
              key={name}
              className={`obj-row${selectedObj === name ? " sel" : ""}`}
              onClick={() => setSelectedObj(name)}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {m && (
                  <label
                    className="toggle mini"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) =>
                        handleToggleEntity(name, e.target.checked)
                      }
                    />
                    <span className="slider" />
                  </label>
                )}
                <div style={{ minWidth: 0 }}>
                  <div className="obj-name">{name}</div>
                  <div className="obj-sub">{sub}</div>
                </div>
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

    // All available Prolibu fields = schema props + known YAML targets + current maps + dynamically created
    const allProlibuFields = (() => {
      const base = prolibuProps ? { ...prolibuProps } : {};
      // Add known mapping target fields that aren't already in the schema
      for (const toField of Object.values(known)) {
        if (toField && !base[toField]) {
          base[toField] = { type: "string", description: toField };
        }
      }
      // Add currently-selected values so dropdowns render correctly even without Prolibu spec
      for (const toField of Object.values(currentMaps)) {
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

    // Current field refs for this object
    const currentRefs = fieldRefs[selectedObj] || {};

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
            <button className="save-mapping-btn" onClick={handleSaveConfig}>
              💾 Consulta SOQL
            </button>
            {showMapping && (
              <button className="save-mapping-btn" onClick={handleSaveMappings}>
                💾 Mappings
              </button>
            )}
            {m && (
              <button className="migrate-btn" onClick={openMigrateModal}>
                🚀 Migrar
              </button>
            )}
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

        {m && entityMissing[selectedObj] && (
          <div className="entity-missing-banner">
            <div className="entity-missing-text">
              ⚠️ La entidad <strong>"{entityMissing[selectedObj]}"</strong> no
              existe en Prolibu. Los JSONs (Cob + CustomField) ya fueron
              guardados en disco.
            </div>
            <button
              className="create-cob-btn"
              disabled={creatingCob}
              onClick={() => handlePublishCob(selectedObj)}
            >
              {creatingCob ? "⏳ Publicando…" : "🚀 Publicar en Prolibu"}
            </button>
            {cobPushLogs.length > 0 && (
              <div className="cob-push-logs">
                {cobPushLogs.map((line, i) => (
                  <div key={i} className="cob-push-log-line">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!m && isC && (
          <div className="warn-banner">
            <div>
              🔶 <strong>Custom Object</strong> — Sin mapeo predefinido.
            </div>
            <div className="assign-row">
              <input
                type="text"
                className="assign-input"
                placeholder="Entidad Prolibu (ej: task)"
                value={assignTarget}
                onChange={(e) => setAssignTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && assignTarget.trim()) {
                    handleAssignEntity(selectedObj, assignTarget);
                  }
                }}
              />
              <button
                className="assign-btn"
                disabled={assigning || !assignTarget.trim()}
                onClick={() => handleAssignEntity(selectedObj, assignTarget)}
              >
                {assigning ? "…" : "Asignar →"}
              </button>
            </div>
          </div>
        )}

        {!m && !isC && (
          <div className="info-banner">
            <div>
              ⚪ <strong>Sin mapeo por defecto</strong> — Este objeto estándar
              no tiene equivalente predefinido en Prolibu.
            </div>
            <div className="assign-row">
              <input
                type="text"
                className="assign-input"
                placeholder="Entidad Prolibu (ej: task)"
                value={assignTarget}
                onChange={(e) => setAssignTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && assignTarget.trim()) {
                    handleAssignEntity(selectedObj, assignTarget);
                  }
                }}
              />
              <button
                className="assign-btn"
                disabled={assigning || !assignTarget.trim()}
                onClick={() => handleAssignEntity(selectedObj, assignTarget)}
              >
                {assigning ? "…" : "Asignar →"}
              </button>
            </div>
          </div>
        )}

        {m && (
          <div className="entity-config-section">
            <div className="fld">
              <label>Campos para SELECT (separados por coma)</label>
              <textarea
                rows={2}
                defaultValue={cfg.entities[m.prolibu]?.select || ""}
                key={`sel-${selectedObj}`}
                onBlur={(e) =>
                  updateEntityCfg(selectedObj, "select", e.target.value)
                }
                placeholder="Id, Name, Email, …"
              />
            </div>
            <div className="fld">
              <label>Filtro SOQL adicional (sin &apos;WHERE&apos;)</label>
              <input
                type="text"
                defaultValue={cfg.entities[m.prolibu]?.filter || ""}
                key={`flt-${selectedObj}`}
                onBlur={(e) =>
                  updateEntityCfg(selectedObj, "filter", e.target.value)
                }
                placeholder="IsActive = true"
              />
            </div>
            <div className="soql-preview">
              SELECT {cfg.entities[m.prolibu]?.select || "*"} FROM {selectedObj}
              {cfg.entities[m.prolibu]?.filter
                ? ` WHERE ${cfg.entities[m.prolibu].filter}`
                : ""}
            </div>
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
              {showMapping && <th>Ref Model</th>}
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
              const currentRef = currentRefs[f.name] || "";
              const isDuplicate =
                mapped &&
                usedFields.has(mapped) &&
                Object.entries(currentMaps).some(
                  ([k, v]) => v === mapped && k !== f.name,
                );

              let statusEl = null;
              if (showMapping) {
                if (currentRef) {
                  statusEl = <span className="s-ref">🔗 Ref</span>;
                } else if (!mapped) {
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
                      {f.type === "reference" || f.referenceTo ? (
                        <select
                          className="ref-select"
                          value={currentRef}
                          onChange={(e) => setFieldRef(f.name, e.target.value)}
                          title={
                            f.referenceTo
                              ? `SF → ${f.referenceTo}`
                              : "Seleccionar modelo destino"
                          }
                        >
                          <option value="">— sin ref —</option>
                          {prolibuModels.map((model) => (
                            <option key={model} value={model}>
                              {model}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span style={{ color: "#64748b", fontSize: 10 }}>
                          —
                        </span>
                      )}
                    </td>
                  )}
                  {showMapping && (
                    <td>
                      {currentRef ? (
                        <span
                          className="ref-indicator"
                          title={`Referencia a ${currentRef}._id`}
                        >
                          → <code>{currentRef}._id</code>
                        </span>
                      ) : (
                        <>
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
                        </>
                      )}
                    </td>
                  )}
                  {showMapping && (
                    <td>
                      {currentRef ? (
                        <span className="type-tag type-prolibu">objectid</span>
                      ) : mapped && allProlibuFields[mapped]?.type ? (
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
          <div className="drawer-overlay" onClick={closeMigrateModal} />
          <div className="migrate-modal">
            <div className="migrate-modal-header">
              <div>
                <div className="migrate-modal-title">🚀 Migrar entidad</div>
                <div className="migrate-modal-sub">
                  {selectedObj} → <strong>{sfMap[selectedObj]?.prolibu}</strong>
                </div>
              </div>
              <button className="drawer-close" onClick={closeMigrateModal}>
                ✕
              </button>
            </div>

            {!migrating && migrateLogs.length === 0 && (
              <div className="migrate-modal-body">
                <div className="migrate-option">
                  <span className="migrate-hint">
                    ⚠️ Se escribirán datos reales en Prolibu
                  </span>
                </div>
              </div>
            )}

            {/* Progress bar */}
            {migrating && migrateProgress && (
              <div className="migrate-progress">
                <div className="migrate-progress-header">
                  <span>
                    {migrateProgress.current} / {migrateProgress.total}{" "}
                    registros
                  </span>
                  <span>{migrateProgress.percent}%</span>
                </div>
                <div className="migrate-progress-bar">
                  <div
                    className="migrate-progress-fill"
                    style={{ width: `${migrateProgress.percent}%` }}
                  />
                </div>
                <div className="migrate-progress-stats">
                  <span className="mp-stat created">
                    ➕ {migrateProgress.created}
                  </span>
                  <span className="mp-stat updated">
                    🔄 {migrateProgress.updated}
                  </span>
                  <span className="mp-stat errors">
                    ❌ {migrateProgress.errors}
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
              <button className="drawer-cancel" onClick={closeMigrateModal}>
                {migrating
                  ? "⛔ Cancelar"
                  : migrateLogs.length > 0
                  ? "Cerrar"
                  : "Cancelar"}
              </button>
              {(!migrateLogs.length || migrating) && (
                <button
                  className="migrate-run-btn"
                  onClick={handleMigrate}
                  disabled={migrating}
                >
                  {migrating ? "⏳ Migrando…" : "🚀 Ejecutar Migración"}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
