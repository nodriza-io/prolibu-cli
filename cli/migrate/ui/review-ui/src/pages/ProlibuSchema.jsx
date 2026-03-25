import { useState } from "react";
import { useMigration } from "../store";

export default function ProlibuSchema() {
  const { state } = useMigration();
  const schemas = state.prolibuSpec?.components?.schemas || {};
  const keys = Object.keys(schemas).sort();
  const [open, setOpen] = useState({});

  const toggle = (name) => setOpen((o) => ({ ...o, [name]: !o[name] }));

  if (!keys.length) {
    return (
      <div className="prolibu-page">
        <div className="placeholder">
          <div className="icon">🟦</div>
          <h3>Schema de Prolibu no disponible</h3>
          <div>
            Verifica que el API key sea válido y que{" "}
            <code>/v2/openapi/specification</code> esté accesible.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="prolibu-page">
      <div className="intro">
        {keys.length} entidades en Prolibu — haz clic para expandir
      </div>

      {keys.map((name) => {
        const sc = schemas[name];
        const props = sc?.properties || {};
        const req = sc?.required || [];
        const pKeys = Object.keys(props);
        const isOpen = open[name];

        return (
          <div className="ent-card" key={name}>
            <div
              className={`ent-hdr${isOpen ? " open" : ""}`}
              onClick={() => toggle(name)}
            >
              <div>
                <strong>{name}</strong>
                <span className="cnt">{pKeys.length} campos</span>
              </div>
              <span className="arrow">{isOpen ? "▼" : "▶"}</span>
            </div>
            {isOpen && (
              <div className="ent-body open">
                {sc?.description && (
                  <div className="desc-text">{sc.description}</div>
                )}
                <table style={{ marginTop: 8 }}>
                  <thead>
                    <tr>
                      <th>Campo</th>
                      <th>Tipo</th>
                      <th>Req</th>
                      <th>Descripción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pKeys.map((pn) => {
                      const pf = props[pn];
                      const typ =
                        pf.type ||
                        (pf.$ref ? pf.$ref.split("/").pop() : "—") ||
                        "—";
                      const r = req.includes(pn);
                      const dsc = pf.description || pf.example || "";

                      return (
                        <tr key={pn}>
                          <td>
                            <code>{pn}</code>
                          </td>
                          <td>
                            <span className="type-tag">{typ}</span>
                          </td>
                          <td>
                            {r && <span style={{ color: "#dc2626" }}>●</span>}
                          </td>
                          <td
                            style={{
                              color: "#64748b",
                              maxWidth: 260,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {dsc}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
