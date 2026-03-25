import { useState, useEffect, useCallback } from "react";
import {
  fetchYamlStatus,
  fetchYamlFile,
  saveYamlFile,
  scaffoldYaml,
} from "../api";

const FILE_LABELS = {
  "schema.yml": {
    label: "Schema",
    description: "Entidades, objetos CRM, modelos Prolibu",
  },
  "mappings.yml": {
    label: "Mappings",
    description: "Mapeo campo por campo CRM → Prolibu",
  },
  "pipelines.yml": {
    label: "Pipelines",
    description: "Orden de ejecución, batch size, fases",
  },
  "transforms.yml": {
    label: "Transforms",
    description: "Reglas de transformación de datos",
  },
};

export default function YamlConfig() {
  const [status, setStatus] = useState(null);
  const [activeFile, setActiveFile] = useState(null);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchYamlStatus();
      setStatus(data.files);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const openFile = async (filename) => {
    setError(null);
    setSuccess(null);
    try {
      const data = await fetchYamlFile(filename);
      setActiveFile(filename);
      setContent(data.content);
      setOriginalContent(data.content);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleSave = async () => {
    if (!activeFile) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await saveYamlFile(activeFile, content);
      setOriginalContent(content);
      setSuccess(`${activeFile} guardado correctamente`);
      loadStatus(); // refresh status badges
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleScaffold = async () => {
    setError(null);
    setSuccess(null);
    try {
      const result = await scaffoldYaml();
      if (result.created.length) {
        setSuccess(`${result.created.length} archivos creados`);
      } else {
        setSuccess("Todos los archivos ya existen");
      }
      loadStatus();
    } catch (e) {
      setError(e.message);
    }
  };

  const hasChanges = content !== originalContent;

  if (loading) {
    return (
      <div className="yaml-config-page">
        <p className="loading-text">Cargando configuración YAML...</p>
      </div>
    );
  }

  return (
    <div className="yaml-config-page">
      <div className="yaml-header">
        <div>
          <h1>Configuración YAML</h1>
          <p className="yaml-subtitle">
            Edita los archivos de configuración de la migración. Los cambios se
            leen en tiempo real por el motor.
          </p>
        </div>
        <button className="btn btn-secondary" onClick={handleScaffold}>
          Inicializar templates
        </button>
      </div>

      {error && <div className="yaml-alert yaml-alert-error">{error}</div>}
      {success && (
        <div className="yaml-alert yaml-alert-success">{success}</div>
      )}

      <div className="yaml-layout">
        {/* File list sidebar */}
        <div className="yaml-sidebar">
          {status?.map((file) => {
            const meta = FILE_LABELS[file.file] || {
              label: file.file,
              description: "",
            };
            return (
              <button
                key={file.file}
                className={`yaml-file-card ${
                  activeFile === file.file ? "active" : ""
                }`}
                onClick={() => openFile(file.file)}
              >
                <div className="yaml-file-card-header">
                  <span className="yaml-file-name">{meta.label}</span>
                  <span
                    className={`yaml-badge ${
                      file.exists
                        ? file.isTemplate
                          ? "badge-template"
                          : "badge-custom"
                        : "badge-missing"
                    }`}
                  >
                    {file.exists
                      ? file.isTemplate
                        ? "template"
                        : "custom"
                      : "no existe"}
                  </span>
                </div>
                <span className="yaml-file-desc">{meta.description}</span>
              </button>
            );
          })}
        </div>

        {/* Editor area */}
        <div className="yaml-editor-area">
          {activeFile ? (
            <>
              <div className="yaml-editor-toolbar">
                <span className="yaml-editor-filename">{activeFile}</span>
                <div className="yaml-editor-actions">
                  {hasChanges && (
                    <span className="yaml-unsaved">Sin guardar</span>
                  )}
                  <button
                    className="btn btn-primary"
                    onClick={handleSave}
                    disabled={saving || !hasChanges}
                  >
                    {saving ? "Guardando..." : "Guardar"}
                  </button>
                </div>
              </div>
              <textarea
                className="yaml-editor"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                spellCheck={false}
              />
            </>
          ) : (
            <div className="yaml-editor-empty">
              <p>Selecciona un archivo para editar</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
