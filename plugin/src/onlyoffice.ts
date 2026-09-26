// Typed access to the ONLYOFFICE plugin runtime that plugins.js installs on
// window.Asc. The editor fills `info` and calls `init` once the plugin is loaded.

export interface PluginInfo {
  userId?: unknown;
  userName?: unknown;
  isViewMode?: unknown;
  [field: string]: unknown;
}

interface AscPlugin {
  init?: () => void;
  button?: (id: number) => void;
  info?: PluginInfo;
}

interface AscRuntime {
  plugin?: AscPlugin;
}

declare global {
  interface Window {
    Asc?: AscRuntime;
  }
}

let ready: Promise<PluginInfo> | null = null;

// Must run before the editor answers the plugin's handshake, hence at module
// load: a late `init` handler would never be called.
export function whenPluginReady(): Promise<PluginInfo> {
  if (ready === null) {
    const plugin = window.Asc?.plugin;
    if (plugin === undefined) {
      return Promise.reject(new Error('The ONLYOFFICE plugin runtime is not loaded'));
    }
    ready = new Promise((resolve) => {
      plugin.init = () => {
        resolve(plugin.info ?? {});
      };
      // Panel plugins have no buttons, but the runtime calls this handler.
      plugin.button = () => {};
    });
  }
  return ready;
}
