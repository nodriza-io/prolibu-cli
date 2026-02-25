import { ExamplePlugin } from "./plugins/Example/ExamplePlugin";

// Helper function to create a render function for plugins
const createRenderFn = (Component: React.ComponentType<any>) => {
  return (node: HTMLElement, opts: any = {}, mode = "prod") => {
    if (mode === "dev") return Component;

    const draw = (attempts: number) => {
      if (attempts > 10) {
        console.error("Failed to render component after multiple attempts.");
        return;
      }

      // @ts-ignore
      if (typeof window.ReactDOM?.createRoot === "function") {
        // @ts-ignore
        const root = window.ReactDOM.createRoot(node);
        root.render(
          // @ts-ignore
          window.React.createElement(Component, { ctx: opts }),
        );
      } else {
        setTimeout(() => draw(attempts + 1), 100);
      }
    };

    draw(0);
  };
};

// Plugin configuration export
export default {
  components: [
    {
      active: true,
      label: "Example Plugin",
      containerId: "example-plugin",
      description: "A sample plugin to get you started",
      render: createRenderFn(ExamplePlugin),
      icon: "",
      // JSON Schema format for Formily
      formSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            title: "Message",
            default: "Hello from Prolibu!",
            description: "Message to display in the plugin",
          },
          theme: {
            type: "string",
            title: "Theme",
            enum: ["light", "dark"],
            default: "light",
            description: "Visual theme",
          },
          showBorder: {
            type: "boolean",
            title: "Show Border",
            default: true,
            description: "Display a border around the plugin",
          },
          fontSize: {
            type: "number",
            title: "Font Size",
            default: 14,
            description: "Text size in pixels",
          },
          accentColor: {
            type: "string",
            title: "Accent Color",
            format: "color",
            default: "#0d99ff",
            description: "Primary accent color",
          },
        },
      },
    },
  ],
};
