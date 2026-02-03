import React, { useState } from 'react';

interface PluginContext {
  ctx: {
    doc?: Record<string, any>;
    preferences?: Record<string, any>;
    // Template-editor uses comCompConfig
    comCompConfig?: {
      model?: {
        message?: string;
      };
      language?: string;
    };
    // Alias for dev mode compatibility
    formSchemaModel?: {
      model?: {
        message?: string;
      };
      language?: string;
    };
    configNodeId?: string;
    pluginLibrary?: string;
  };
}

// Inline styles for better compatibility with different rendering contexts
const styles = {
  container: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    padding: '1.5rem',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    borderRadius: '12px',
    color: 'white',
    minHeight: '200px',
  } as React.CSSProperties,
  header: {
    marginBottom: '1rem',
  } as React.CSSProperties,
  title: {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: 600,
  } as React.CSSProperties,
  text: {
    margin: '0 0 1rem 0',
    opacity: 0.9,
  } as React.CSSProperties,
  counter: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginTop: '1rem',
  } as React.CSSProperties,
  button: {
    width: '40px',
    height: '40px',
    border: 'none',
    borderRadius: '50%',
    background: 'rgba(255, 255, 255, 0.2)',
    color: 'white',
    fontSize: '1.25rem',
    cursor: 'pointer',
  } as React.CSSProperties,
  count: {
    fontSize: '1.5rem',
    fontWeight: 'bold',
    minWidth: '3rem',
    textAlign: 'center' as const,
  } as React.CSSProperties,
};

export const ExamplePlugin: React.FC<PluginContext> = ({ ctx }) => {
  const [count, setCount] = useState(0);
  // Check both comCompConfig (template-editor) and formSchemaModel (dev mode)
  const message = ctx?.comCompConfig?.model?.message || ctx?.formSchemaModel?.model?.message || 'Hello from Prolibu!';

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>{message}</h2>
      </div>
      <div>
        <p style={styles.text}>This is an example plugin. Edit this file to create your own!</p>
        <div style={styles.counter}>
          <button style={styles.button} onClick={() => setCount(count - 1)}>-</button>
          <span style={styles.count}>{count}</span>
          <button style={styles.button} onClick={() => setCount(count + 1)}>+</button>
        </div>
      </div>
    </div>
  );
};
