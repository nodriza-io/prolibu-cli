import { useState, useEffect, useRef, useCallback } from "react";
import { useMigration } from "../store";
import {
  fetchFlow,
  saveFlow,
  startMigration,
  subscribeMigrationLogs,
  cancelMigration,
  addSchemaEntity,
} from "../api";
import { showToast } from "../components/Toast";

export default function FlowEditor() {
  const { state } = useMigration();
  const [flow, setFlow] = useState([]);
  const [allEntities, setAllEntities] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [dependencies, setDependencies] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragItem, setDragItem] = useState(null); // { entity, fromStep }
  const [dropTarget, setDropTarget] = useState(null); // step index or 'pool'
  const [editingStep, setEditingStep] = useState(null);
  const [addableEntities, setAddableEntities] = useState([]);
  const [addingEntity, setAddingEntity] = useState(false);
  const editRef = useRef(null);

  // Execution states
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const logsEndRef = useRef(null);

  // Entities already placed in the flow
  const assignedEntities = new Set(flow.flatMap((s) => s.entities));

  // Available pool = known but not assigned
  const poolEntities = allEntities.filter((e) => !assignedEntities.has(e));

  // Load flow and available entities on mount
  useEffect(() => {
    fetchFlow()
      .then((data) => {
        // Set available entities from server (schema + config + transformers)
        if (data.availableEntities?.length) {
          setAllEntities(data.availableEntities);
        }
        if (data.addableEntities?.length) {
          setAddableEntities(data.addableEntities);
        }
        if (data.warnings?.length) {
          setWarnings(data.warnings);
        }
        if (data.dependencies) {
          setDependencies(data.dependencies);
        }

        const known = new Set(data.availableEntities || []);

        if (data.flow?.length) {
          // Filter flow entities to only known ones
          setFlow(
            data.flow.map((step) => ({
              ...step,
              entities: step.entities.filter(
                (e) => known.size === 0 || known.has(e),
              ),
            })),
          );
        }
        // No saved flow — start empty so user builds from scratch
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Focus step name input when editing
  useEffect(() => {
    if (editingStep !== null && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingStep]);

  const updateFlow = useCallback((newFlow) => {
    setFlow(newFlow);
    setDirty(true);
  }, []);

  // ── Drag handlers ──
  const handleDragStart = (entity, fromStep) => {
    setDragItem({ entity, fromStep });
  };

  const handleDragOver = (e, targetStep) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(targetStep);
  };

  const handleDragLeave = (e) => {
    // Only clear if actually leaving the container
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDropTarget(null);
    }
  };

  const handleDrop = (e, targetStep) => {
    e.preventDefault();
    setDropTarget(null);
    if (!dragItem) return;

    const { entity, fromStep } = dragItem;
    const newFlow = flow.map((s) => ({ ...s, entities: [...s.entities] }));

    // Remove from source
    if (fromStep !== null && fromStep !== undefined && fromStep !== "pool") {
      newFlow[fromStep].entities = newFlow[fromStep].entities.filter(
        (e2) => e2 !== entity,
      );
    }

    // Add to target
    if (targetStep === "pool") {
      // Just removed — entity goes back to pool
      updateFlow(newFlow);
    } else if (targetStep !== undefined && targetStep !== null) {
      if (!newFlow[targetStep].entities.includes(entity)) {
        newFlow[targetStep].entities.push(entity);
      }
      // Auto-place dependencies only when dragging from the pool (not step→step)
      if (fromStep === null || fromStep === undefined || fromStep === "pool") {
        const {
          newFlow: resolvedFlow,
          adjustedIdx,
          autoAdded,
        } = resolveAndPlaceDeps(entity, targetStep, newFlow);
        // Move entity from targetStep to adjustedIdx if they differ (step was inserted)
        if (adjustedIdx !== targetStep) {
          resolvedFlow[targetStep].entities = resolvedFlow[
            targetStep
          ].entities.filter((e2) => e2 !== entity);
          if (!resolvedFlow[adjustedIdx].entities.includes(entity)) {
            resolvedFlow[adjustedIdx].entities.push(entity);
          }
        }
        updateFlow(resolvedFlow);
        if (autoAdded.length > 0) {
          showToast(
            `🔗 Dependencias agregadas al paso previo: ${autoAdded.join(", ")}`,
          );
        }
      } else {
        updateFlow(newFlow);
      }
    }

    setDragItem(null);
  };

  const handleDragEnd = () => {
    setDragItem(null);
    setDropTarget(null);
  };

  // ── Step management ──
  const addStep = () => {
    updateFlow([...flow, { name: `Paso ${flow.length + 1}`, entities: [] }]);
  };

  const removeStep = (idx) => {
    updateFlow(flow.filter((_, i) => i !== idx));
  };

  const renameStep = (idx, name) => {
    const newFlow = flow.map((s, i) => (i === idx ? { ...s, name } : s));
    updateFlow(newFlow);
  };

  const moveStep = (idx, direction) => {
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= flow.length) return;
    const newFlow = [...flow];
    [newFlow[idx], newFlow[newIdx]] = [newFlow[newIdx], newFlow[idx]];
    updateFlow(newFlow);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveFlow(flow);
      setDirty(false);
      showToast("Flujo guardado correctamente");
    } catch (e) {
      showToast(`Error al guardar: ${e.message}`, true);
    } finally {
      setSaving(false);
    }
  };

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  // Cancel running migration
  const handleCancel = async () => {
    try {
      await cancelMigration();
      setLogs((prev) => [
        ...prev,
        { time: new Date(), text: "⛔ Migración cancelada por el usuario." },
      ]);
    } catch (err) {
      showToast(`Error al cancelar: ${err.message}`, true);
    } finally {
      setRunning(false);
    }
  };

  // Execute migration flow
  const handleExecute = async () => {
    if (dirty) {
      showToast("Guarda el flujo antes de ejecutar", true);
      return;
    }
    const allFlowEntities = flow.flatMap((step) => step.entities);
    if (allFlowEntities.length === 0) {
      showToast("No hay entidades en el flujo", true);
      return;
    }

    setRunning(true);
    setLogs([{ time: new Date(), text: "🚀 Iniciando migración..." }]);

    // Connect to SSE stream
    const closeSse = subscribeMigrationLogs(
      (msg) => {
        if (msg.type === "log") {
          setLogs((prev) => [...prev, { time: new Date(), text: msg.data }]);
        } else if (msg.type === "done") {
          setLogs((prev) => [
            ...prev,
            {
              time: new Date(),
              text: `✅ ${msg.data || "Migración completada"}`,
            },
          ]);
        } else if (msg.type === "error") {
          setLogs((prev) => [
            ...prev,
            { time: new Date(), text: `❌ ${msg.data}` },
          ]);
        }
      },
      () => {
        setRunning(false);
      },
    );

    // Execute each step sequentially
    try {
      for (let i = 0; i < flow.length; i++) {
        const step = flow[i];
        if (step.entities.length === 0) continue;

        setLogs((prev) => [
          ...prev,
          { time: new Date(), text: `\n── Paso ${i + 1}: ${step.name} ──` },
        ]);

        const res = await startMigration({
          entities: step.entities,
          dryRun: false,
        });
        if (!res.ok) {
          throw new Error(res.error || `Error en paso ${i + 1}`);
        }

        // Wait a bit for SSE logs to arrive before next step
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } catch (err) {
      setLogs((prev) => [
        ...prev,
        { time: new Date(), text: `❌ Error: ${err.message}` },
      ]);
      setRunning(false);
      closeSse();
    }
  };

  // Resolve deps and place them forming a chain of steps when deps are themselves
  // dependent on each other. Deps at the same topological level share a step.
  // Returns { newFlow, adjustedIdx, autoAdded }.
  const resolveAndPlaceDeps = (entity, stepIdx, baseFlow) => {
    const deps = dependencies[entity] || [];
    if (deps.length === 0)
      return { newFlow: baseFlow, adjustedIdx: stepIdx, autoAdded: [] };

    const beforeSet = new Set(
      baseFlow.slice(0, stepIdx).flatMap((s) => s.entities),
    );
    const fromSet = new Set(baseFlow.slice(stepIdx).flatMap((s) => s.entities));

    const needToPlace = deps.filter((d) => !beforeSet.has(d));
    if (needToPlace.length === 0)
      return { newFlow: baseFlow, adjustedIdx: stepIdx, autoAdded: [] };

    // Compute topological level for each dep that needs placing.
    // Level 0 = no deps in needSet (must go first).
    // Level N = max(level of its deps within needSet) + 1.
    const needSet = new Set(needToPlace);
    const levels = {};
    const computing = new Set(); // cycle guard
    const getLevel = (dep) => {
      if (dep in levels) return levels[dep];
      if (computing.has(dep)) return 0; // cycle detected — treat as root
      computing.add(dep);
      const innerDeps = (dependencies[dep] || []).filter((d) => needSet.has(d));
      const level =
        innerDeps.length === 0 ? 0 : Math.max(...innerDeps.map(getLevel)) + 1;
      computing.delete(dep);
      return (levels[dep] = level);
    };
    for (const dep of needToPlace) getLevel(dep);

    const maxLevel = Math.max(...Object.values(levels));

    // How many new steps must be inserted before stepIdx to fit the chain?
    // We need (maxLevel + 1) slots before stepIdx.
    const insertions = Math.max(0, maxLevel + 1 - stepIdx);
    const adjustedIdx = stepIdx + insertions;

    // Deep-copy and remove misplaced deps (in steps >= stepIdx)
    let newFlow = baseFlow.map((s) => ({ ...s, entities: [...s.entities] }));
    for (const d of needToPlace) {
      if (fromSet.has(d)) {
        for (let i = stepIdx; i < newFlow.length; i++) {
          newFlow[i].entities = newFlow[i].entities.filter((e2) => e2 !== d);
        }
      }
    }

    // Insert blank steps at the front for the chain links that don't exist yet
    if (insertions > 0) {
      const newSteps = Array.from({ length: insertions }, (_, i) => ({
        name: insertions === 1 ? "Prerequisitos" : `Prerequisitos ${i + 1}`,
        entities: [],
      }));
      newFlow = [...newSteps, ...newFlow];
    }

    // Place each dep at its level-determined step:
    // level 0 → adjustedIdx - maxLevel - 1 (earliest)
    // level maxLevel → adjustedIdx - 1 (immediately before entity)
    for (const dep of needToPlace) {
      const targetStepIdx = adjustedIdx - (maxLevel - levels[dep]) - 1;
      if (!newFlow[targetStepIdx].entities.includes(dep)) {
        newFlow[targetStepIdx].entities.push(dep);
      }
    }

    return { newFlow, adjustedIdx, autoAdded: needToPlace };
  };

  // Quick add: add entity directly to a step
  const addEntityToStep = (stepIdx, entity) => {
    const { newFlow, adjustedIdx, autoAdded } = resolveAndPlaceDeps(
      entity,
      stepIdx,
      flow,
    );
    const finalFlow = newFlow.map((s, i) =>
      i === adjustedIdx ? { ...s, entities: [...s.entities, entity] } : s,
    );
    updateFlow(finalFlow);
    if (autoAdded.length > 0) {
      showToast(
        `🔗 Dependencias agregadas al paso previo: ${autoAdded.join(", ")}`,
      );
    }
  };

  const removeEntityFromStep = (stepIdx, entity) => {
    const newFlow = flow.map((s, i) =>
      i === stepIdx
        ? { ...s, entities: s.entities.filter((e2) => e2 !== entity) }
        : s,
    );
    updateFlow(newFlow);
  };

  if (loading) {
    return (
      <div className="flow-editor-page">
        <div className="placeholder">
          <div className="spinner" />
          <h3>Cargando configuración de flujo…</h3>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-editor-page">
      {/* Header */}
      <div className="flow-header">
        <div className="flow-header-left">
          <h2>Editor de Flujo de Migración</h2>
          <p className="flow-subtitle">
            Arrastra entidades entre pasos para definir el orden de ejecución.
            Los pasos se ejecutan secuencialmente; las entidades dentro de un
            mismo paso se procesan juntas.
          </p>
        </div>
        <div className="flow-header-actions">
          {dirty && <span className="flow-unsaved">● Cambios sin guardar</span>}
          <button
            className="btn btn-primary flow-save-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? (
              <>
                <span className="spinner small" /> Guardando…
              </>
            ) : (
              "💾 Guardar flujo"
            )}
          </button>
          <button
            className="btn btn-danger flow-cancel-btn"
            onClick={handleCancel}
            disabled={!running}
          >
            ⛔ Cancelar
          </button>
          <button
            className="btn btn-success flow-execute-btn"
            onClick={handleExecute}
            disabled={
              running || dirty || flow.flatMap((s) => s.entities).length === 0
            }
          >
            {running ? (
              <>
                <span className="spinner small" /> Ejecutando…
              </>
            ) : (
              "▶️ Ejecutar Flujo"
            )}
          </button>
        </div>
      </div>

      {/* Conflict warnings — only show when conflicting entities are both in the flow */}
      {warnings
        .filter(
          (w) =>
            w.type === "conflict" &&
            w.entities.every((e) => assignedEntities.has(e)),
        )
        .map((w, i) => (
          <div key={i} className="flow-warning">
            <span className="flow-warning-icon">⚠️</span>
            <span>{w.message}</span>
          </div>
        ))}

      {/* Entity Pool */}
      <div
        className={`flow-pool${dropTarget === "pool" ? " drop-active" : ""}`}
        onDragOver={(e) => handleDragOver(e, "pool")}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, "pool")}
      >
        <div className="flow-pool-label">
          Entidades disponibles
          <span className="flow-pool-count">{poolEntities.length}</span>
          {addableEntities.length > 0 && (
            <div className="flow-pool-add">
              {addingEntity ? (
                <select
                  autoFocus
                  className="flow-pool-add-select"
                  defaultValue=""
                  onBlur={() => setAddingEntity(false)}
                  onChange={async (e) => {
                    const chosen = addableEntities.find((a) => a.entityKey === e.target.value);
                    if (!chosen) return;
                    setAddingEntity(false);
                    try {
                      await addSchemaEntity({ source: chosen.source, target: chosen.target, entityKey: chosen.entityKey });
                      setAllEntities((prev) => [...prev, chosen.entityKey]);
                      setAddableEntities((prev) => prev.filter((a) => a.entityKey !== chosen.entityKey));
                    } catch (err) {
                      showToast(`Error al agregar entidad: ${err.message}`, true);
                    }
                  }}
                >
                  <option value="" disabled>Selecciona entidad…</option>
                  {addableEntities.map((a) => (
                    <option key={a.entityKey} value={a.entityKey}>
                      {a.source} → {a.target}
                    </option>
                  ))}
                </select>
              ) : (
                <button
                  className="btn btn-sm flow-pool-add-btn"
                  onClick={() => setAddingEntity(true)}
                >
                  + Agregar entidad
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flow-pool-chips">
          {poolEntities.length === 0 && (
            <span className="flow-pool-empty">
              {allEntities.length === 0
                ? "No hay entidades habilitadas en la configuración"
                : "Todas las entidades están asignadas a un paso"}
            </span>
          )}
          {poolEntities.map((entity) => (
            <div
              key={entity}
              className={`flow-chip${
                dragItem?.entity === entity ? " dragging" : ""
              }`}
              draggable
              onDragStart={() => handleDragStart(entity, "pool")}
              onDragEnd={handleDragEnd}
            >
              {entity}
            </div>
          ))}
        </div>
      </div>

      {/* Flow Canvas */}
      <div className="flow-canvas">
        {flow.length === 0 && (
          <div className="flow-empty-state">
            <div className="flow-empty-icon">🔀</div>
            <h3>Sin pasos configurados</h3>
            <p>Agrega pasos para definir el flujo de migración</p>
            <button className="btn btn-primary" onClick={addStep}>
              + Agregar primer paso
            </button>
          </div>
        )}

        {flow.map((step, idx) => (
          <div key={idx} className="flow-step-wrapper">
            {idx > 0 && (
              <div className="flow-arrow">
                <svg width="48" height="24" viewBox="0 0 48 24">
                  <line
                    x1="0"
                    y1="12"
                    x2="38"
                    y2="12"
                    stroke="#94a3b8"
                    strokeWidth="2"
                  />
                  <polygon points="36,6 48,12 36,18" fill="#94a3b8" />
                </svg>
              </div>
            )}

            <div
              className={`flow-step${dropTarget === idx ? " drop-active" : ""}`}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, idx)}
            >
              {/* Step header */}
              <div className="flow-step-header">
                <div className="flow-step-number">{idx + 1}</div>
                {editingStep === idx ? (
                  <input
                    ref={editRef}
                    className="flow-step-name-input"
                    value={step.name}
                    onChange={(e) => renameStep(idx, e.target.value)}
                    onBlur={() => setEditingStep(null)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setEditingStep(null);
                    }}
                  />
                ) : (
                  <span
                    className="flow-step-name"
                    onClick={() => setEditingStep(idx)}
                    title="Click para renombrar"
                  >
                    {step.name}
                  </span>
                )}
                <div className="flow-step-actions">
                  <button
                    className="flow-step-btn"
                    onClick={() => moveStep(idx, -1)}
                    disabled={idx === 0}
                    title="Mover a la izquierda"
                  >
                    ←
                  </button>
                  <button
                    className="flow-step-btn"
                    onClick={() => moveStep(idx, 1)}
                    disabled={idx === flow.length - 1}
                    title="Mover a la derecha"
                  >
                    →
                  </button>
                  <button
                    className="flow-step-btn danger"
                    onClick={() => removeStep(idx)}
                    title="Eliminar paso"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Entities in step */}
              <div className="flow-step-entities">
                {step.entities.length === 0 && (
                  <div className="flow-step-drop-hint">
                    Arrastra entidades aquí
                  </div>
                )}
                {step.entities.map((entity) => (
                  <div
                    key={entity}
                    className={`flow-chip in-step${
                      dragItem?.entity === entity ? " dragging" : ""
                    }`}
                    draggable
                    onDragStart={() => handleDragStart(entity, idx)}
                    onDragEnd={handleDragEnd}
                  >
                    <span className="flow-chip-label">{entity}</span>
                    <button
                      className="flow-chip-remove"
                      onClick={() => removeEntityFromStep(idx, entity)}
                      title="Quitar del paso"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              {/* Quick-add dropdown */}
              {poolEntities.length > 0 && (
                <div className="flow-step-add">
                  <select
                    className="flow-add-select"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) addEntityToStep(idx, e.target.value);
                    }}
                  >
                    <option value="">+ Agregar entidad…</option>
                    {poolEntities.map((entity) => (
                      <option key={entity} value={entity}>
                        {entity}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        ))}

        {flow.length > 0 && (
          <div className="flow-step-wrapper">
            <div className="flow-arrow add-arrow">
              <svg width="48" height="24" viewBox="0 0 48 24">
                <line
                  x1="0"
                  y1="12"
                  x2="38"
                  y2="12"
                  stroke="#cbd5e1"
                  strokeWidth="2"
                  strokeDasharray="4 4"
                />
                <polygon points="36,6 48,12 36,18" fill="#cbd5e1" />
              </svg>
            </div>
            <button className="flow-add-step" onClick={addStep}>
              <span className="flow-add-icon">+</span>
              <span>Agregar paso</span>
            </button>
          </div>
        )}
      </div>

      {/* Execution Logs */}
      {logs.length > 0 && (
        <div className="flow-logs">
          <div className="flow-logs-header">
            <h3>📋 Logs de Ejecución</h3>
            {!running && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setLogs([])}
              >
                Limpiar
              </button>
            )}
          </div>
          <div className="flow-logs-content">
            {logs.map((log, i) => (
              <div key={i} className="flow-log-line">
                <span className="flow-log-time">
                  {log.time.toLocaleTimeString()}
                </span>
                <span className="flow-log-text">{log.text}</span>
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}
