import { useState, useEffect, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchCredentials, saveCredentials } from "../api";
import { showToast } from "../components/Toast";

/**
 * Human-friendly labels for common credential field keys.
 */
const FIELD_LABELS = {
  instanceUrl: "Instance URL",
  clientKey: "Client Key",
  clientSecret: "Client Secret",
  accessToken: "Access Token",
  refreshToken: "Refresh Token",
  apiKey: "API Key",
  apiSecret: "API Secret",
  username: "Username",
  password: "Password",
  tenantId: "Tenant ID",
  hubId: "Hub ID",
};

/**
 * Fields that should be treated as secrets (rendered as password inputs).
 */
const SECRET_FIELDS = new Set([
  "clientKey",
  "clientSecret",
  "accessToken",
  "refreshToken",
  "apiKey",
  "apiSecret",
  "password",
  "token",
]);

export default function Credentials() {
  const navigate = useNavigate();
  const { crm } = useParams();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fields, setFields] = useState([]); // required field keys from metadata
  const [crmLabel, setCrmLabel] = useState("");
  const [form, setForm] = useState({});
  const [hasExisting, setHasExisting] = useState(false);
  const [showSecrets, setShowSecrets] = useState({});

  const load = useCallback(async () => {
    try {
      const data = await fetchCredentials();
      setFields(data.fields || []);
      setCrmLabel(data.crmLabel || "CRM");

      // Pre-fill form with existing raw values
      const initial = {};
      for (const key of data.fields || []) {
        initial[key] = data.raw?.[key] || "";
      }
      setForm(initial);
      setHasExisting(Object.values(data.raw || {}).some((v) => !!v));
    } catch (e) {
      showToast(`Error loading credentials: ${e.message}`, "error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleChange = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSecret = (key) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    // Client-side validation
    const missing = fields.filter((f) => !form[f]?.trim());
    if (missing.length) {
      showToast(
        `Campos requeridos: ${missing
          .map((f) => FIELD_LABELS[f] || f)
          .join(", ")}`,
        "error",
      );
      return;
    }

    setSaving(true);
    try {
      await saveCredentials(form);
      showToast("Credenciales guardadas correctamente", "success");
      setHasExisting(true);
      // Trigger connection recheck in header badge
      window.dispatchEvent(new Event("recheck-connection"));
    } catch (e) {
      showToast(`Error: ${e.message}`, "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="cred-loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="credentials-page">
      <div className="cred-header">
        <button className="btn btn-ghost" onClick={() => navigate(`/${crm}`)}>
          ← Dashboard
        </button>
        <h2>🔑 Credenciales {crmLabel}</h2>
        <p className="cred-subtitle">
          Configura las credenciales de conexión con {crmLabel} para poder
          ejecutar el discovery y la migración.
        </p>
      </div>

      {hasExisting && (
        <div className="cred-notice cred-notice-ok">
          ✓ Ya existen credenciales configuradas. Puedes actualizarlas desde
          aquí.
        </div>
      )}

      <form className="cred-form" onSubmit={handleSubmit}>
        {fields.map((key) => {
          const isSecret = SECRET_FIELDS.has(key);
          const label = FIELD_LABELS[key] || key;
          return (
            <div className="cred-field" key={key}>
              <label htmlFor={`cred-${key}`}>{label}</label>
              <div className="cred-input-wrap">
                <input
                  id={`cred-${key}`}
                  type={isSecret && !showSecrets[key] ? "password" : "text"}
                  value={form[key] || ""}
                  onChange={(e) => handleChange(key, e.target.value)}
                  placeholder={
                    key === "instanceUrl"
                      ? "https://yourorg.my.salesforce.com"
                      : `Ingresa ${label}`
                  }
                  autoComplete="off"
                  spellCheck="false"
                />
                {isSecret && (
                  <button
                    type="button"
                    className="cred-toggle-vis"
                    onClick={() => toggleSecret(key)}
                    title={showSecrets[key] ? "Ocultar" : "Mostrar"}
                  >
                    {showSecrets[key] ? "🙈" : "👁️"}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        <div className="cred-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving
              ? "Guardando…"
              : hasExisting
              ? "Actualizar credenciales"
              : "Guardar credenciales"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => navigate(`/${crm}`)}
          >
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
