// Typed access to the ONLYOFFICE plugin runtime that plugins.js installs on
// window.Asc. The editor fills `info` and calls `init` once the plugin is loaded.

export interface PluginInfo {
  userId?: unknown;
  userName?: unknown;
  isViewMode?: unknown;
  [field: string]: unknown;
}

type CommandCallback = (result: unknown) => void;

interface AscPlugin {
  init?: () => void;
  button?: (id: number) => void;
  info?: PluginInfo;
  callCommand?: (command: () => unknown, isClose: boolean, isCalc: boolean, callback: CommandCallback) => void;
  attachEvent?: (name: string, handler: (payload: unknown) => void) => void;
}

interface AscRuntime {
  plugin?: AscPlugin;
  scope?: Record<string, unknown>;
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

// Events must also be listed in config.json for the editor to send them.
export function onEditorEvent(name: string, handler: (payload: unknown) => void): boolean {
  const plugin = window.Asc?.plugin;
  if (plugin?.attachEvent === undefined) {
    return false;
  }
  plugin.attachEvent(name, handler);
  return true;
}

// The plugin SDK keeps a single callback slot for commands: a second command
// sent before the first answers takes over its slot and receives its result.
// Commands therefore run one at a time.
let commandQueue: Promise<unknown> = Promise.resolve();

const COMMAND_TIMEOUT_MS = 30_000;

// The command is serialised with toString() and runs in the editor's sandbox:
// it may only use `Api` and the JSON data passed as `Asc.scope`. No network
// call may happen inside it.
export function runCommand<T>(
  command: () => unknown,
  scope: Record<string, unknown>,
  recalculate: boolean,
  parse: (result: unknown) => T | null,
): Promise<T | null> {
  const run = commandQueue.then(() => sendCommand(command, scope, recalculate)).then(parse);
  commandQueue = run.catch(() => null);
  return run;
}

function sendCommand(command: () => unknown, scope: Record<string, unknown>, recalculate: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const runtime = window.Asc;
    const callCommand = runtime?.plugin?.callCommand;
    if (runtime === undefined || callCommand === undefined) {
      reject(new Error('The editor cannot run commands yet'));
      return;
    }
    // An editor busy with a long action may never answer; the queue moves on.
    const timer = setTimeout(() => {
      reject(new Error('The editor did not answer the command'));
    }, COMMAND_TIMEOUT_MS);
    runtime.scope = scope;
    callCommand.call(runtime.plugin, command, false, recalculate, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}
