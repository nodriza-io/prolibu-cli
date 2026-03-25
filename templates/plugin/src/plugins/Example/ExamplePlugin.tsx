import React, { useState } from "react";

interface PluginContext {
  ctx: {
    doc?: Record<string, any>;
    preferences?: Record<string, any>;
    // Template-editor uses comCompConfig
    comCompConfig?: {
      model?: {
        message?: string;
        theme?: "light" | "dark";
        showBorder?: boolean;
        fontSize?: number;
        accentColor?: string;
      };
      language?: string;
    };
    // Alias for dev mode compatibility
    formSchemaModel?: {
      model?: {
        message?: string;
        theme?: "light" | "dark";
        showBorder?: boolean;
        fontSize?: number;
        accentColor?: string;
      };
      language?: string;
    };
    configNodeId?: string;
    pluginLibrary?: string;
  };
}

export const ExamplePlugin: React.FC<PluginContext> = ({ ctx }) => {
  const [count, setCount] = useState(0);

  // Get values from form schema (works in both dev and production)
  const model = ctx?.comCompConfig?.model || ctx?.formSchemaModel?.model || {};
  const message = model.message || "Hello from Prolibu!";
  const theme = model.theme || "light";
  const showBorder = model.showBorder !== false;
  const fontSize = model.fontSize || 14;
  const accentColor = model.accentColor || "#0d99ff";

  // Dynamic styles based on form values
  const isDark = theme === "dark";

  const styles = {
    container: {
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      padding: "1.5rem",
      background: isDark
        ? "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)"
        : "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
      borderRadius: "12px",
      color: isDark ? "#e0e0e0" : "white",
      minHeight: "200px",
      border: showBorder ? `2px solid ${accentColor}` : "none",
      fontSize: `${fontSize}px`,
    } as React.CSSProperties,
    header: {
      marginBottom: "1rem",
    } as React.CSSProperties,
    title: {
      margin: 0,
      fontSize: "1.5em",
      fontWeight: 600,
      color: accentColor,
    } as React.CSSProperties,
    text: {
      margin: "0 0 1rem 0",
      opacity: 0.9,
    } as React.CSSProperties,
    counter: {
      display: "flex",
      alignItems: "center",
      gap: "1rem",
      marginTop: "1rem",
    } as React.CSSProperties,
    button: {
      width: "40px",
      height: "40px",
      border: "none",
      borderRadius: "50%",
      background: accentColor,
      color: "white",
      fontSize: "1.25rem",
      cursor: "pointer",
    } as React.CSSProperties,
    count: {
      fontSize: "1.5em",
      fontWeight: "bold",
      minWidth: "3rem",
      textAlign: "center" as const,
    } as React.CSSProperties,
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>{message}</h2>
      </div>
      <div>
        <p style={styles.text}>
          This is an example plugin. Edit this file to create your own!
        </p>
        <p style={styles.text}>
          Theme: <strong>{theme}</strong> | Font Size:{" "}
          <strong>{fontSize}px</strong>
        </p>
        <div style={styles.counter}>
          <button style={styles.button} onClick={() => setCount(count - 1)}>
            -
          </button>
          <span style={styles.count}>{count}</span>
          <button style={styles.button} onClick={() => setCount(count + 1)}>
            +
          </button>
        </div>
      </div>
    </div>
  );
};
