import { useState, useMemo, useCallback, useEffect } from "react";
import { useMigration } from "../store";
import { saveConfig as apiSaveConfig, saveSetup as apiSaveSetup } from "../api";
import { showToast } from "../components/Toast";

/* ── helpers ─────────────────────────────────────────────── */

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

function buildSetup(cfg, sfToProlibu, discovery, prolibuSpec) {
  const setup = { customObjects: [], customFields: [] };
  const map = sfToProlibu || {};
  const objs = discovery?.objects || {};

  // Custom objects that need to be created in Prolibu
  for (const [sfName, cc] of Object.entries(cfg.customObjects || {})) {
    if (!cc.enabled) continue;
    setup.customObjects.push({
      prolibuEntity: cc.prolibuEntity,
      label: cc.prolibuEntity,
      sourceSObject: sfName,
      action: "create",
    });
  }

  // Custom fields inside standard mapped entities that don't exist in Prolibu yet
  for (const [key, ec] of Object.entries(cfg.entities || {})) {
    if (!ec.enabled || !ec.sobject) continue;
    const sfName = ec.sobject;
    const obj = objs[sfName];
    if (!obj) continue;
    const m = map[sfName];
    if (!m) continue;
    const schema = prolibuEntitySchema(m.prolibu, prolibuSpec);
    const props = schema?.properties || null;

    const selected = (ec.select || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const fn of selected) {
      const fd = (obj.fieldDetails || []).find((f) => f.name === fn);
      if (!fd || !fd.custom) continue;
      if (props && matchField(fn, props)) continue;
      setup.customFields.push({
        prolibuEntity: m.prolibu,
        apiName: fn.toLowerCase(),
        label: fd.label || fn,
        type: mapType(fd.type),
        sourceSField: fn,
      });
    }
  }

  return setup;
}

/* ── Component ───────────────────────────────────────────── */

export default function ConfigBuilder() {
  const { state, dispatch } = useMigration();
  const { discovery, sfToProlibu, prolibuSpec, cfg } = state;
  const map = sfToProlibu || {};
  const objs = discovery?.objects || {};
  const withCount = discovery?.withCount;

  const [jsonTab, setJsonTab] = useState("config");

  /* ── derived setup ──────────────────────────────────── */
  const setup = useMemo(
    () => buildSetup(cfg, sfToProlibu, discovery, prolibuSpec),
    [cfg, sfToProlibu, discovery, prolibuSpec],
  );

  /* ── mutations ──────────────────────────────────────── */
  const toggleEnt = useCallback(
    (key, sfName, enabled) => {
      if (!cfg.entities[key]) {
        const obj = objs[sfName] || {};
        const flds = (obj.fieldDetails || [])
          .filter((f) => !f.custom)
          .map((f) => f.name)
          .slice(0, 14);
        dispatch({
          type: "SET_ENTITY_CFG",
          payload: {
            key,
            value: { enabled, sobject: sfName, select: flds.join(", ") },
          },
        });
      } else {
        dispatch({
          type: "SET_ENTITY_CFG",
          payload: { key, value: { ...cfg.entities[key], enabled } },
        });
      }
    },
    [cfg, objs, dispatch],
  );

  const updEnt = useCallback(
    (key, sfName, field, value) => {
      const prev = cfg.entities[key] || { sobject: sfName };
      dispatch({
        type: "SET_ENTITY_CFG",
        payload: { key, value: { ...prev, [field]: value } },
      });
    },
    [cfg, dispatch],
  );

  const toggleCustom = useCallback(
    (sfName, enabled) => {
      if (!cfg.customObjects[sfName]) {
        dispatch({
          type: "SET_CUSTOM_OBJ_CFG",
          payload: {
            key: sfName,
            value: {
              enabled,
              prolibuEntity: sfName.toLowerCase().replace("__c", ""),
              select: "",
            },
          },
        });
      } else {
        dispatch({
          type: "SET_CUSTOM_OBJ_CFG",
          payload: {
            key: sfName,
            value: { ...cfg.customObjects[sfName], enabled },
          },
        });
      }
    },
    [cfg, dispatch],
  );

  const updCustom = useCallback(
    (sfName, field, value) => {
      const prev = cfg.customObjects[sfName] || {};
      dispatch({
        type: "SET_CUSTOM_OBJ_CFG",
        payload: { key: sfName, value: { ...prev, [field]: value } },
      });
    },
    [cfg, dispatch],
  );

  const updateBatchSize = useCallback(
    (v) => {
      dispatch({ type: "UPDATE_CFG", payload: { batchSize: Number(v) } });
    },
    [dispatch],
  );

  /* ── save actions ───────────────────────────────────── */
  const handleSaveConfig = async () => {
    try {
      const d = await apiSaveConfig(cfg);
      if (d.ok) showToast(`✅ config.json guardado → ${d.path}`);
      else showToast(`❌ ${d.error}`, true);
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    }
  };

  const handleSaveSetup = async () => {
    try {
      const d = await apiSaveSetup(setup);
      if (d.ok) showToast(`✅ prolibu_setup.json guardado → ${d.path}`);
      else showToast(`❌ ${d.error}`, true);
    } catch (e) {
      showToast(`❌ ${e.message}`, true);
    }
  };

  /* ── render standard entities ───────────────────────── */
  const mappedEntries = Object.keys(map).filter(
    (n) => objs[n] && !objs[n].error,
  );

  /* ── render custom objects ──────────────────────────── */
  const allCustom = Object.entries(objs).filter(
    ([n, o]) => n.endsWith("__c") && !o.error,
  );

  return (
    <div className="config-page">
      <div className="cfg-left">
        <div className="bat-section">
          {/* Standard entities */}
          {mappedEntries.map((sfName) => {
            const m = map[sfName];
            const key = m.prolibu;
            const ec = cfg.entities[key] || {};
            const enabled = ec.enabled === true;
            const select = ec.select || "";
            const filterVal = ec.filter || "";
            const rec = withCount
              ? ` · ${(objs[sfName]?.records || 0).toLocaleString()} reg`
              : "";

            return (
              <div className="cfg-card" key={key}>
                <div className="cfg-card-hdr">
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => toggleEnt(key, sfName, e.target.checked)}
                    />
                    <span className="slider" />
                  </label>
                  <h3>
                    {key}{" "}
                    <span
                      style={{
                        fontWeight: 400,
                        color: "#94a3b8",
                        fontSize: 11,
                      }}
                    >
                      ← {sfName}
                      {rec}
                    </span>
                  </h3>
                </div>
                <div className="fld">
                  <label>Campos para SELECT (separados por coma)</label>
                  <textarea
                    rows={3}
                    defaultValue={select}
                    onBlur={(e) =>
                      updEnt(key, sfName, "select", e.target.value)
                    }
                    placeholder="Id, Name, Email, …"
                  />
                </div>
                <div className="fld">
                  <label>
                    Filtro SOQL adicional (clausula WHERE, sin
                    &apos;WHERE&apos;)
                  </label>
                  <input
                    type="text"
                    defaultValue={filterVal}
                    onBlur={(e) =>
                      updEnt(key, sfName, "filter", e.target.value)
                    }
                    placeholder="IsActive = true"
                  />
                </div>
                <div className="fld">
                  <label>Vista previa SOQL</label>
                  <div className="soql-preview">
                    SELECT {cfg.entities[key]?.select || select || "*"} FROM{" "}
                    {sfName}
                    {cfg.entities[key]?.filter || filterVal
                      ? ` WHERE ${cfg.entities[key]?.filter || filterVal}`
                      : ""}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Custom objects */}
          {allCustom.length > 0 && (
            <>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                  marginBottom: 8,
                  marginTop: 4,
                }}
              >
                🔶 Objetos Custom de Salesforce
              </div>
              {allCustom.map(([sfName, obj]) => {
                const cc = cfg.customObjects[sfName] || {};
                const enabled = cc.enabled === true;
                const select = cc.select || "";
                const pEnt =
                  cc.prolibuEntity || sfName.toLowerCase().replace("__c", "");
                const rec = withCount
                  ? ` · ${(obj.records || 0).toLocaleString()} reg`
                  : "";

                return (
                  <div className="cfg-card" key={sfName}>
                    <div className="cfg-card-hdr">
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={(e) =>
                            toggleCustom(sfName, e.target.checked)
                          }
                        />
                        <span className="slider" />
                      </label>
                      <h3>
                        🔶 {sfName}
                        <span
                          style={{
                            fontWeight: 400,
                            color: "#94a3b8",
                            fontSize: 11,
                          }}
                        >
                          {rec}
                        </span>
                      </h3>
                    </div>
                    <div className="fld">
                      <label>Entidad en Prolibu (existente o nueva)</label>
                      <input
                        type="text"
                        defaultValue={pEnt}
                        onBlur={(e) =>
                          updCustom(sfName, "prolibuEntity", e.target.value)
                        }
                        placeholder="nombre_en_prolibu"
                      />
                    </div>
                    <div className="fld">
                      <label>Campos para SELECT</label>
                      <textarea
                        rows={2}
                        defaultValue={select}
                        onBlur={(e) =>
                          updCustom(sfName, "select", e.target.value)
                        }
                        placeholder="Id, Name, …"
                      />
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Batch size */}
        <div className="batch-row">
          <label>Tamaño de lote (batchSize)</label>
          <input
            type="number"
            min={1}
            max={2000}
            defaultValue={cfg.batchSize || 200}
            onBlur={(e) => updateBatchSize(e.target.value)}
          />
        </div>
      </div>

      <div className="cfg-right">
        <div className="json-tabs">
          <button
            className={jsonTab === "config" ? "active" : ""}
            onClick={() => setJsonTab("config")}
          >
            config.json
          </button>
          <button
            className={jsonTab === "setup" ? "active" : ""}
            onClick={() => setJsonTab("setup")}
          >
            prolibu_setup.json
          </button>
        </div>

        <pre className="json-preview">
          {JSON.stringify(jsonTab === "config" ? cfg : setup, null, 2)}
        </pre>

        <div className="save-row">
          <button className="save-btn" onClick={handleSaveConfig}>
            💾 Guardar config.json
          </button>
          <button className="save-btn" onClick={handleSaveSetup}>
            💾 Guardar prolibu_setup.json
          </button>
        </div>
      </div>
    </div>
  );
}
