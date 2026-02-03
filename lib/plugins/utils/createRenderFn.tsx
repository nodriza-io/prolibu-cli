import React from "react";
import ReactDOM from "react-dom/client";
import { PluginContext } from "../types/ProlibuPlugins";

const cloneDeep = (obj: any) => {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch (error) {
    return obj;
  }
};

const drawComponent = (
  Component: any,
  node: HTMLElement,
  opts = {} as any,
  mode = "prod"
) => {
  const { shadowRoot, styleSheet } = opts || ({} as any);
  const { doc, configNodeId, pluginLibrary, preferences, comCompConfig } =
    cloneDeep(opts || {});

  const root = ReactDOM.createRoot(node);
  root.render(
    <Component
      ctx={{
        doc,
        shadowRoot,
        styleSheet,
        preferences,
        configNodeId,
        pluginLibrary,
        formSchemaModel: {
          ...comCompConfig?.model,
          language: comCompConfig?.language,
        },
      }}
    />
  );
};

export const createRenderFn = (Component: any) => {
  return (node: HTMLElement, opts = {} as any, mode = "prod") => {
    if (mode === "dev") return Component;
    const draw = (attempts: number) => {
      if (attempts > 10) {
        console.error("Failed to render component after multiple attempts.");
        return;
      }
      attempts++;
      if (typeof ReactDOM.createRoot === "function") {
        drawComponent(Component, node, opts, mode);
      } else {
        setTimeout(() => draw(attempts), 100);
      }
    };
    draw(0);
  };
};
