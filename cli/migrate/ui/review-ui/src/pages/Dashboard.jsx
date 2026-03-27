import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMigration } from "../store";
import { fetchStatus, runDiscover, subscribeMigrationLogs } from "../api";
import { showToast } from "../components/Toast";

const PHASE_ICONS = {
  configure: "🔑",
  discover: "🔍",
  config: "⚙️",
  migrate: "🚀",
};

function getPhaseLink(crm, key) {
  const map = {
    configure: `/${crm}/credentials`,
    discover: null,
    config: `/${crm}/config`,
    migrate: `/${crm}/execution`,
  };
  return map[key] || null;
}

export default function Dashboard() {
  const { state } = useMigration();
  const navigate = useNavigate();
  const { crm } = useParams();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(null); // which phase is running
  const [logs, setLogs] = useState([]);
  const [discoverProgress, setDiscoverProgress] = useState(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await fetchStatus();
      setStatus(data);
    } catch (e) {
      showToast(`Error loading status: ${e.message}`, "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleDiscover = async () => {
    setRunning("discover");
    setLogs([]);

    setDiscoverProgress(null);

    // Subscribe to SSE for logs
    const unsub = subscribeMigrationLogs(
      (msg) => {
        if (msg.type === "log") {
          setLogs((prev) => [...prev, msg.data]);
        } else if (msg.type === "discover-progress") {
          setDiscoverProgress(msg.data);
        } else if (msg.type === "phase-done") {
          setRunning(null);
          setDiscoverProgress(null);
          loadStatus(); // refresh status
          if (msg.data?.error) {
            showToast(`Discovery failed: ${msg.data.error}`, "error");
          } else {
            showToast("Discovery completado", "success");
          }
          unsub();
        } else if (msg.type === "error") {
          showToast(msg.data, "error");
        }
      },
      () => {
        setRunning(null);
      },
    );

    try {
      await runDiscover({ withCount: true });
    } catch (e) {
      showToast(`Error: ${e.message}`, "error");
      setRunning(null);
      unsub();
    }
  };

  if (loading) {
    return (
      <div className="dash-loading">
        <div className="spinner" />
      </div>
    );
  }

  const phases = status?.phases || {};

  return (
    <div className="dashboard">
      <div className="dash-hero">
        <h2>Migration Dashboard</h2>
        <p className="dash-domain">{state.domain}</p>
        {status?.crm && (
          <span className="dash-crm-badge">
            {status.crmLabel || status.crm}
          </span>
        )}
      </div>

      <div className="dash-phases">
        {Object.entries(phases).map(([key, phase]) => (
          <div
            key={key}
            className={`dash-phase-card ${phase.done ? "done" : "pending"}`}
          >
            <div className="dash-phase-icon">{PHASE_ICONS[key] || "📦"}</div>
            <div className="dash-phase-info">
              <div className="dash-phase-label">
                {phase.label}
                <span
                  className={`dash-phase-status ${phase.done ? "ok" : "wait"}`}
                >
                  {phase.done ? "✓ Listo" : "Pendiente"}
                </span>
              </div>
              {phase.detail && (
                <div className="dash-phase-detail">{phase.detail}</div>
              )}
            </div>
            <div className="dash-phase-actions">
              {key === "configure" && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => navigate(`/${crm}/credentials`)}
                >
                  {phase.done ? "Editar" : "Configurar"}
                </button>
              )}
              {key === "discover" && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleDiscover}
                  disabled={running === "discover" || !phases.configure?.done}
                  title={
                    !phases.configure?.done
                      ? "Configura credenciales del CRM primero"
                      : ""
                  }
                >
                  {running === "discover"
                    ? "Ejecutando…"
                    : phase.done
                    ? "Re-descubrir"
                    : "Ejecutar"}
                </button>
              )}
              {key === "config" && phase.done && (
                <button
                  className="btn btn-sm"
                  onClick={() => navigate(`/${crm}/config`)}
                >
                  Editar
                </button>
              )}
              {key === "config" && !phase.done && phases.discover?.done && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => navigate(`/${crm}/config`)}
                >
                  Configurar
                </button>
              )}
              {key === "migrate" && phases.config?.done && (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => navigate(`/${crm}/execution`)}
                >
                  {phase.done ? "Volver a migrar" : "Migrar"}
                </button>
              )}
              {getPhaseLink(crm, key) && phase.done && (
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => navigate(getPhaseLink(crm, key))}
                >
                  Ver →
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Discovery logs */}
      {running === "discover" && (
        <div className="dash-log-panel">
          <h4>Discovery en curso…</h4>
          {discoverProgress && (
            <div className="progress-bar-container">
              <div
                className="progress-bar"
                style={{
                  width: `${Math.round(
                    (discoverProgress.done / discoverProgress.total) * 100,
                  )}%`,
                }}
              />
              <span className="progress-stats">
                {discoverProgress.done} / {discoverProgress.total} objetos (
                {Math.round(
                  (discoverProgress.done / discoverProgress.total) * 100,
                )}
                %)
              </span>
            </div>
          )}
          <div className="dash-log-scroll">
            {logs.map((line, i) => (
              <div key={i} className="dash-log-line">
                {line}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Objects summary card */}
      {(state.localObjects?.cobs?.length > 0 ||
        state.localObjects?.customFields?.length > 0) && (
        <div className="card" style={{ marginTop: 20 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 10,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14 }}>
              📦 Objects locales
            </div>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => navigate(`/${crm}/objects`)}
            >
              Ver todos →
            </button>
          </div>
          <div style={{ display: "flex", gap: 20 }}>
            <div style={{ fontSize: 13, color: "#475569" }}>
              <strong>{state.localObjects?.cobs?.length || 0}</strong> Custom
              Object{state.localObjects?.cobs?.length !== 1 ? "s" : ""}
            </div>
            <div style={{ fontSize: 13, color: "#475569" }}>
              <strong>{state.localObjects?.customFields?.length || 0}</strong>{" "}
              Custom Field entit
              {state.localObjects?.customFields?.length !== 1 ? "ies" : "y"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
