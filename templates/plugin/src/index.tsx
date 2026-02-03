import { ExamplePlugin } from './plugins/Example/ExamplePlugin';

// Helper function to create a render function for plugins
const createRenderFn = (Component: React.ComponentType<any>) => {
  return (node: HTMLElement, opts: any = {}, mode = 'prod') => {
    if (mode === 'dev') return Component;

    const draw = (attempts: number) => {
      if (attempts > 10) {
        console.error('Failed to render component after multiple attempts.');
        return;
      }

      // @ts-ignore
      if (typeof window.ReactDOM?.createRoot === 'function') {
        // @ts-ignore
        const root = window.ReactDOM.createRoot(node);
        root.render(
          // @ts-ignore
          window.React.createElement(Component, { ctx: opts })
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
      label: 'Example Plugin',
      containerId: 'example-plugin',
      description: 'A sample plugin to get you started',
      render: createRenderFn(ExamplePlugin),
      icon: '',
      formSchema: {
        message: {
          type: 'string',
          default: 'Hello from Prolibu!',
          description: 'Message to display'
        }
      }
    }
  ]
};
