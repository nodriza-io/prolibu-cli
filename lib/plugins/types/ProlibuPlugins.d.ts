import React from "react";

type ProlibuPluginContext = (
  node: HTMLElement,
  opts?: Record<string, any>
) => void;

export interface ProlibuComponent {
  label: string;
  icon?: string;
  active?: boolean;
  containerId: string;
  description?: string;
  render: ProlibuPluginContext;
  styles?: string[];
  formSchema?: Record<string, any>;
}

export interface ProlibuPluginsConfig {
  components: ProlibuComponent[];
}

export interface PluginContext<
  T = Record<string, any>,
  D = Record<string, any>,
  F = Record<string, any>
> {
  ctx: {
    doc: D;
    shadowRoot: ShadowRoot;
    styleSheet: CSSStyleSheet;
    preferences: T;
    formSchemaModel: { model?: F } & { language?: string };
    configNodeId: string;
    pluginLibrary: string;
  };
}

declare global {
  ProlibuPlugin;
  ProlibuPluginsConfig;
  IPluginContextProp;
}

export {};
