import { useState, useEffect, useCallback } from "react";
import { NavLink, Outlet, useParams, useNavigate } from "react-router-dom";
import { useMigration } from "../store";
import Toast from "./Toast";
import {
  closeServer,
  checkCRMConnection,
  checkProlibuConnection,
} from "../api";

const CONNECTION_POLL_MS = 5 * 60 * 1000; // 5 minutes

function getNavItems(crm) {
  return [
    { to: `/${crm}`, label: "🏠 Dashboard", end: true },
    { to: `/${crm}/schema`, label: "📊 Schema Map" },
    { to: `/${crm}/config`, label: "📄 YAML Config" },
    { to: `/${crm}/prolibu`, label: "🟦 Prolibu Schema" },
    { to: `/${crm}/pipelines`, label: "🔗 Pipelines" },
    { to: `/${crm}/execution`, label: "▶️ Ejecución" },
  ];
}

export default function Layout() {
  const { crm } = useParams();
  const navigate = useNavigate();
  const { state } = useMigration();
  const [conn, setConn] = useState({
    connected: null,
    error: null,
    loading: true,
  });
  const [prolibuConn, setProlibuConn] = useState({
    connected: null,
    error: null,
    loading: true,
  });

  const pollConnection = useCallback(async () => {
    try {
      const result = await checkCRMConnection();
      setConn({
        connected: result.connected,
        error: result.error || null,
        loading: false,
      });
    } catch {
      setConn({ connected: false, error: "Network error", loading: false });
    }
  }, []);

  const pollProlibuConnection = useCallback(async () => {
    try {
      const result = await checkProlibuConnection();
      setProlibuConn({
        connected: result.connected,
        error: result.error || null,
        loading: false,
      });
    } catch (err) {
      console.error("Prolibu connection check error:", err);
      setProlibuConn({
        connected: false,
        error: err.message || "Network error",
        loading: false,
      });
    }
  }, []);

  // Poll CRM connection on mount + every 5 minutes
  useEffect(() => {
    pollConnection();
    const timer = setInterval(pollConnection, CONNECTION_POLL_MS);
    // Allow child pages (e.g. Credentials) to trigger a recheck
    const handler = () => pollConnection();
    window.addEventListener("recheck-connection", handler);
    return () => {
      clearInterval(timer);
      window.removeEventListener("recheck-connection", handler);
    };
  }, [pollConnection]);

  // Poll Prolibu connection on mount + every 5 minutes
  useEffect(() => {
    pollProlibuConnection();
    const timer = setInterval(pollProlibuConnection, CONNECTION_POLL_MS);
    const handler = () => pollProlibuConnection();
    window.addEventListener("recheck-connection", handler);
    return () => {
      clearInterval(timer);
      window.removeEventListener("recheck-connection", handler);
    };
  }, [pollProlibuConnection]);

  if (state.loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div style={{ fontSize: 13, color: "#64748b" }}>
          Cargando datos de migración…
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="loading-screen">
        <div style={{ color: "#dc2626", fontSize: 14 }}>
          ❌ No se pudo cargar el estado: {state.error}
        </div>
      </div>
    );
  }

  const disc = state.discovery;
  const total = disc ? Object.keys(disc.objects || {}).length : 0;
  const custom = disc
    ? Object.values(disc.objects || {}).filter((o) => o.type === "custom")
        .length
    : 0;

  const handleDone = async () => {
    if (!window.confirm("¿Cerrar el servidor de review y volver al terminal?"))
      return;
    try {
      await closeServer();
    } catch {}
    document.body.innerHTML = `<div style="
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:100vh;gap:16px;font-family:system-ui;color:#64748b;background:#f8fafc;">
      <div style="font-size:36px;">✅</div>
      <div style="font-size:15px;font-weight:600;color:#1e293b;">Servidor cerrado</div>
      <div style="font-size:13px;">Puedes cerrar esta pestaña.</div>
    </div>`;
  };

  const crmLabel = state.crmLabel || crm;
  const navItems = getNavItems(crm);

  return (
    <div className="app-shell">
      <header className="header">
        <div className="hdr-left">
          <button
            className="btn-back"
            onClick={() => navigate("/")}
            title="Volver al selector"
          >
            ←
          </button>
          <div>
            <h1 className="header-title">
              🔄 Migration Dashboard — {state.domain}
            </h1>
            <div className="header-meta">
              {disc &&
                `Descubierto el ${new Date(
                  disc.discoveredAt,
                ).toLocaleString()} · ${total} SObjects (${custom} custom)`}
            </div>
          </div>
        </div>
        <div className="hdr-right">
          <div
            className={`conn-badge ${
              conn.loading
                ? "conn-checking"
                : conn.connected
                ? "conn-ok"
                : "conn-fail"
            }`}
            title={
              conn.error ||
              (conn.connected
                ? `Conectado a ${crmLabel}`
                : `Desconectado de ${crmLabel}`)
            }
            onClick={pollConnection}
          >
            <span className="conn-dot" />
            <span className="conn-label">
              {conn.loading
                ? "Verificando…"
                : conn.connected
                ? `${crmLabel} conectado`
                : conn.error || `${crmLabel} desconectado`}
            </span>
          </div>
          <div
            className={`conn-badge ${
              prolibuConn.loading
                ? "conn-checking"
                : prolibuConn.connected
                ? "conn-ok"
                : "conn-fail"
            }`}
            title={
              prolibuConn.error ||
              (prolibuConn.connected
                ? `Conectado a ${state.domain}`
                : `Desconectado de ${state.domain}`)
            }
            onClick={pollProlibuConnection}
          >
            <span className="conn-dot" />
            <span className="conn-label">
              {prolibuConn.loading
                ? "Verificando…"
                : prolibuConn.connected
                ? `${state.domain} conectado`
                : prolibuConn.error || `${state.domain} desconectado`}
            </span>
          </div>
          <button className="btn-done" onClick={handleDone}>
            ✕ Cerrar servidor
          </button>
        </div>
      </header>

      <nav className="nav-tabs">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `tab-btn${isActive ? " active" : ""}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="main-content">
        <Outlet />
      </main>

      <Toast />
    </div>
  );
}
