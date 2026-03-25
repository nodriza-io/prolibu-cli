import { useState, useEffect, useRef, useCallback } from "react";
import { useMigration } from "../store";
import { fetchFlow, saveFlow } from "../api";
import { showToast } from "../components/Toast";

export default function FlowEditor() {
  const { state } = useMigration();
  const [flow, setFlow] = useState([]);
  const [allEntities, setAllEntities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragItem, setDragItem] = useState(null); // { entity, fromStep }
  const [dropTarget, setDropTarget] = useState(null); // step index or 'pool'
  const [editingStep, setEditingStep] = useState(null);
  const editRef = useRef(null);

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

        const known = new Set(data.availableEntities || []);

        if (data.flow?.length) {
          // Filter flow entities to only known ones
          setFlow(
            data.flow.map((step) => ({
              ...step,
              entities: step.entities.filter((e) => known.size === 0 || known.has(e)),
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

  const updateFlow = useCallback(
    (newFlow) => {
      setFlow(newFlow);
      setDirty(true);
    },
    [],
  );

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
    } else if (targetStep !== undefined && targetStep !== null) {
      if (!newFlow[targetStep].entities.includes(entity)) {
        newFlow[targetStep].entities.push(entity);
      }
    }

    // Remove empty steps (optional — keep them)
    updateFlow(newFlow);
    setDragItem(null);
  };

  const handleDragEnd = () => {
    setDragItem(null);
    setDropTarget(null);
  };

  // ── Step management ──
  const addStep = () => {
    updateFlow([
      ...flow,
      { name: `Paso ${flow.length + 1}`, entities: [] },
    ]);
  };

  const removeStep = (idx) => {
    updateFlow(flow.filter((_, i) => i !== idx));
  };

  const renameStep = (idx, name) => {
    const newFlow = flow.map((s, i) =>
      i === idx ? { ...s, name } : s,
    );
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

  // Quick add: add entity directly to a step
  const addEntityToStep = (stepIdx, entity) => {
    const newFlow = flow.map((s, i) =>
      i === stepIdx
        ? { ...s, entities: [...s.entities, entity] }
        : s,
    );
    updateFlow(newFlow);
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
          {dirty && (
            <span className="flow-unsaved">● Cambios sin guardar</span>
          )}
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
        </div>
      </div>

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
                  <polygon
                    points="36,6 48,12 36,18"
                    fill="#94a3b8"
                  />
                </svg>
              </div>
            )}

            <div
              className={`flow-step${
                dropTarget === idx ? " drop-active" : ""
              }`}
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
                      if (e.target.value)
                        addEntityToStep(idx, e.target.value);
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

      {/* Summary */}
      {flow.length > 0 && (
        <div className="flow-summary">
          <h3>Resumen de ejecución</h3>
          <div className="flow-summary-steps">
            {flow.map((step, idx) => (
              <div key={idx} className="flow-summary-item">
                <span className="flow-summary-num">{idx + 1}</span>
                <div className="flow-summary-detail">
                  <strong>{step.name}</strong>
                  <span className="flow-summary-entities">
                    {step.entities.length === 0
                      ? "Sin entidades"
                      : step.entities.join(", ")}
                  </span>
                </div>
                {idx < flow.length - 1 && (
                  <span className="flow-summary-arrow">→</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
