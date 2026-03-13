import { useEffect, useState } from "react";
import { useMigration } from "../store";
import { fetchPipelines } from "../api";

export default function Pipelines() {
  const { state, dispatch } = useMigration();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const pipelines = state.pipelines || {};

  useEffect(() => {
    if (Object.keys(pipelines).length) return;
    setLoading(true);
    fetchPipelines()
      .then((data) => {
        dispatch({ type: "SET_PIPELINES", payload: data });
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="pipelines-page">
        <div className="placeholder">
          <div className="spinner" />
          <h3>Cargando pipelines…</h3>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pipelines-page">
        <div className="placeholder">
          <div className="icon">⚠️</div>
          <h3>Error cargando pipelines</h3>
          <div>{error}</div>
        </div>
      </div>
    );
  }

  const entities = Object.entries(pipelines);

  if (!entities.length) {
    return (
      <div className="pipelines-page">
        <div className="placeholder">
          <div className="icon">🔗</div>
          <h3>Sin pipelines configurados</h3>
          <div>
            Los pipelines se crean como archivos en{" "}
            <code>
              accounts/&lt;domain&gt;/migrations/salesforce/pipelines/
            </code>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pipelines-page">
      <div className="page-intro">
        <h2>Pipelines de Migración</h2>
        <p>
          Cada entidad tiene un pipeline con pasos{" "}
          <strong>before → transform → after</strong>. Si no existe un archivo
          de pipeline personalizado, se usa el transformer base.
        </p>
      </div>

      <div className="pipeline-grid">
        {entities.map(([entityKey, pipeline]) => (
          <div className="pipeline-card" key={entityKey}>
            <div className="pipeline-header">
              <h3>{entityKey}</h3>
              <span
                className={`pipeline-badge ${
                  pipeline.custom ? "custom" : "base"
                }`}
              >
                {pipeline.custom
                  ? "📦 Pipeline personalizado"
                  : "🔧 Transformer base"}
              </span>
            </div>

            <div className="pipeline-flow">
              {(pipeline.steps || []).map((step, i) => (
                <div key={i} className="pipeline-step-wrap">
                  {i > 0 && <div className="pipeline-arrow">→</div>}
                  <div className={`pipeline-step ${step.type || ""}`}>
                    <div className="step-label">{step.name || step.type}</div>
                    <div className="step-desc">{step.description || ""}</div>
                  </div>
                </div>
              ))}

              {(!pipeline.steps || !pipeline.steps.length) && (
                <div className="pipeline-step transform">
                  <div className="step-label">transform</div>
                  <div className="step-desc">
                    Transformer base (mapea campos SF → Prolibu)
                  </div>
                </div>
              )}
            </div>

            {pipeline.source && (
              <div className="pipeline-source">
                <code>{pipeline.source}</code>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
