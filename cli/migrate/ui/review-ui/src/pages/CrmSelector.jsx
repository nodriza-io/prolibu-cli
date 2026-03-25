import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchCRMs, selectCRM } from "../api";

const CRM_ICONS = {
  salesforce: "☁️",
  hubspot: "🟠",
  dynamics: "🔷",
  zoho: "🟢",
  pipedrive: "🔵",
  freshsales: "🟩",
};

export default function CrmSelector() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selecting, setSelecting] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchCRMs()
      .then((d) => {
        setData(d);
        // Auto-redirect when a CRM is already active (pre-selected via CLI)
        if (d?.activeCrm) {
          navigate(`/${d.activeCrm}`, { replace: true });
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const handleSelect = async (crm) => {
    setSelecting(crm.key);
    setError(null);
    try {
      await selectCRM(crm.key);
      navigate(`/${crm.key}`);
    } catch (e) {
      setError(e.message);
      setSelecting(null);
    }
  };

  if (loading) {
    return (
      <div className="crm-selector-page">
        <div className="crm-selector-loading">
          <div className="spinner" />
          <p>Detectando integraciones disponibles…</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="crm-selector-page">
        <div className="crm-selector-error">
          <span className="crm-error-icon">⚠️</span>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  const crms = data?.crms || [];
  const domain = data?.domain || "";
  const domainShort = domain.replace(".prolibu.com", "");

  return (
    <div className="crm-selector-page">
      <div className="crm-selector-hero">
        <h1 className="crm-selector-title">🔄 Migration Dashboard</h1>
        <p className="crm-selector-domain">{domain}</p>
        <p className="crm-selector-subtitle">
          Selecciona el CRM o ERP de origen para iniciar la migración
        </p>
      </div>

      {error && <div className="crm-selector-alert">{error}</div>}

      {crms.length === 0 ? (
        <div className="crm-selector-empty">
          <span className="crm-empty-icon">📂</span>
          <h3>No se encontraron integraciones</h3>
          <p>
            No hay carpetas con <code>metadata.js</code> en el directorio de
            migraciones. Crea un adaptador para comenzar.
          </p>
        </div>
      ) : (
        <div className="crm-selector-grid">
          {crms.map((crm) => {
            const icon = CRM_ICONS[crm.key] || "📦";
            const isSelecting = selecting === crm.key;
            return (
              <button
                key={crm.key}
                className={`crm-card ${
                  isSelecting ? "crm-card-selecting" : ""
                }`}
                onClick={() => handleSelect(crm)}
                disabled={!!selecting}
              >
                <div className="crm-card-icon">{icon}</div>
                <div className="crm-card-info">
                  <h3 className="crm-card-label">{crm.label}</h3>
                  <span className="crm-card-key">
                    /{domainShort}/{crm.key}
                  </span>
                </div>
                <div className="crm-card-footer">
                  <span
                    className={`crm-card-badge ${
                      crm.hasCredentials ? "badge-ok" : "badge-pending"
                    }`}
                  >
                    {crm.hasCredentials ? "✓ Credenciales" : "Sin credenciales"}
                  </span>
                  {isSelecting && <div className="spinner spinner-sm" />}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <footer className="crm-selector-footer">
        <p>
          Cada carpeta en <code>migrations/</code> con un archivo{" "}
          <code>metadata.js</code> aparece como integración disponible.
        </p>
      </footer>
    </div>
  );
}
