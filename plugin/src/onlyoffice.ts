import { logProblem } from './log.ts';
import { withTimeout } from './time.ts';

// Typed access to the ONLYOFFICE plugin runtime that plugins.js installs on
// window.Asc. The editor fills `info` and calls `init` once the plugin is loaded.

export interface PluginInfo {
  userId?: unknown;
  userName?: unknown;
  isViewMode?: unknown;
  // word in the text editor, cell in the spreadsheet editor.
  editorType?: unknown;
  // The options the host gave this plugin in the editor configuration.
  options?: unknown;
  [field: string]: unknown;
}

type CommandCallback = (result: unknown) => void;

// Called with -1 and the window's id when a window of the plugin is closed
// with its close box or the Escape key; the plugin then closes the window
// itself. The editor's runtime sends both values.
type ButtonHandler = (id: unknown, windowId: unknown) => void;

interface AscPlugin {
  guid?: string;
  init?: () => void;
  button?: ButtonHandler;
  info?: PluginInfo;
  callCommand?: (command: () => unknown, isClose: boolean, isCalc: boolean, callback: CommandCallback) => void;
  executeMethod?: (name: string, parameters: unknown[], callback: CommandCallback) => boolean;
  attachEvent?: (name: string, handler: (payload: unknown) => void) => void;
  detachEvent?: (name: string) => void;
  attachContextMenuClickEvent?: (id: string, handler: () => void) => void;
  attachToolbarMenuClickEvent?: (id: string, handler: () => void) => void;
}

// A window the editor shows for the plugin: one of the editor's dialogs, holding
// an iframe of one of the plugin's pages, on the plugin's origin.
export interface PluginWindowVariation {
  // Relative to the panel's page.
  url: string;
  description: string;
  isVisual: true;
  isModal: boolean;
  // Shown in the read-only editor too.
  isViewer: boolean;
  EditorsSupport: string[];
  buttons: [];
  size: [number, number];
  // No title bar, close box or buttons.
  isCustomWindow?: boolean;
  // Placed next to the cursor, under it when there is room.
  isTargeted?: boolean;
}

export interface PluginWindow {
  id: string;
  show: (variation: PluginWindowVariation) => void;
  close: () => void;
}

interface AscRuntime {
  plugin?: AscPlugin;
  scope?: Record<string, unknown>;
  // Installed by the editor when the plugin starts.
  PluginWindow?: new () => PluginWindow;
}

declare global {
  interface Window {
    Asc?: AscRuntime;
  }
}

// The editor the plugin runs in: ONLYOFFICE's text editor, which edits text
// documents, or its spreadsheet editor, which edits workbooks.
export type EditorType = 'word' | 'cell';

export function editorTypeOf(info: PluginInfo): EditorType {
  return info.editorType === 'cell' ? 'cell' : 'word';
}

let ready: Promise<PluginInfo> | null = null;
let buttonHandler: ButtonHandler = () => {};

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
      // The panel has no buttons, but its windows do.
      plugin.button = (id, windowId) => {
        buttonHandler(id, windowId);
      };
    });
  }
  return ready;
}

export function onPluginButton(handler: ButtonHandler): void {
  buttonHandler = handler;
}

export function offEditorEvent(name: string): void {
  window.Asc?.plugin?.detachEvent?.(name);
}

// A window not shown yet, so that its page can be prepared for its id.
export function newPluginWindow(): PluginWindow | null {
  const PluginWindowClass = window.Asc?.PluginWindow;
  return PluginWindowClass === undefined ? null : new PluginWindowClass();
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
// Commands therefore run one at a time, and the next one waits for the
// editor's answer to the previous one even after its caller gave up waiting:
// a late answer would otherwise land in the next command's slot. An editor
// that never answers blocks later commands, which then time out; reloading
// the editor recovers.
let commandQueue: Promise<unknown> = Promise.resolve();

const COMMAND_TIMEOUT_MS = 30_000;

// When the editor last answered a command, null before the first answer.
let lastAnswerAt: number | null = null;

export function lastCommandAnswerAt(): number | null {
  return lastAnswerAt;
}

// The command is serialised with toString() and runs in the editor's sandbox:
// it may only use `Api` and the JSON data passed as `Asc.scope`. No network
// call may happen inside it.
export function runCommand<T>(
  command: () => unknown,
  scope: Record<string, unknown>,
  recalculate: boolean,
  parse: (result: unknown) => T | null,
): Promise<T | null> {
  const previous = commandQueue;
  const answered = sendAfter(previous, command, scope, recalculate);
  // The caller receives the command's failure; the queue only waits for the
  // editor to be done with it.
  commandQueue = answered.catch(() => null);
  return parseAnswer(previous, answered, parse);
}

async function sendAfter(
  previous: Promise<unknown>,
  command: () => unknown,
  scope: Record<string, unknown>,
  recalculate: boolean,
): Promise<unknown> {
  await previous;
  return sendCommand(command, scope, recalculate);
}

// The time limit starts when the command's turn comes, not while it waits.
async function parseAnswer<T>(
  previous: Promise<unknown>,
  answered: Promise<unknown>,
  parse: (result: unknown) => T | null,
): Promise<T | null> {
  await previous;
  return parse(await withTimeout(answered, COMMAND_TIMEOUT_MS, 'The editor did not answer the command'));
}

function sendCommand(command: () => unknown, scope: Record<string, unknown>, recalculate: boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const runtime = window.Asc;
    const callCommand = runtime?.plugin?.callCommand;
    if (runtime === undefined || callCommand === undefined) {
      reject(new Error('The editor cannot run commands yet'));
      return;
    }
    runtime.scope = scope;
    callCommand.call(runtime.plugin, command, false, recalculate, (result) => {
      lastAnswerAt = Date.now();
      resolve(result);
    });
  });
}

export function callEditorMethod(name: string, parameters: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const plugin = window.Asc?.plugin;
    if (plugin?.executeMethod === undefined) {
      reject(new Error('The editor cannot run methods yet'));
      return;
    }
    plugin.executeMethod(name, parameters, (result) => {
      resolve(result ?? null);
    });
  });
}

export interface MenuEntry {
  id: string;
  text: string;
}

// The editor waits for every plugin listening to onContextMenuShow, so the
// plugin answers each time, possibly with no entry.
export function offerContextMenu(entries: () => MenuEntry[], onClick: (id: string) => void): boolean {
  const plugin = window.Asc?.plugin;
  if (plugin?.attachEvent === undefined || plugin.attachContextMenuClickEvent === undefined) {
    return false;
  }
  plugin.attachEvent('onContextMenuShow', () => {
    callEditorMethod('AddContextMenuItem', [{ guid: plugin.guid, items: entries() }]).catch((error: unknown) => {
      logProblem('Answering the context menu', error);
    });
  });
  for (const entry of entries()) {
    plugin.attachContextMenuClickEvent(entry.id, () => {
      onClick(entry.id);
    });
  }
  return true;
}

export interface ToolbarButton {
  id: string;
  text: string;
  hint: string;
  icon: string;
}

// Buttons added to the standard "Insert" tab of the text editor. The editor
// keeps its own caption for a tab it already has, so the tab's text needs no
// translation.
export async function addInsertTabButton(button: ToolbarButton, onClick: () => void): Promise<boolean> {
  const plugin = window.Asc?.plugin;
  if (plugin?.attachToolbarMenuClickEvent === undefined) {
    return false;
  }
  plugin.attachToolbarMenuClickEvent(button.id, onClick);
  await callEditorMethod('AddToolbarMenuItem', [
    {
      guid: plugin.guid,
      tabs: [
        {
          id: 'ins',
          text: 'Insert',
          items: [{ id: button.id, type: 'big-button', text: button.text, hint: button.hint, icons: button.icon, lockInViewMode: true }],
        },
      ],
    },
  ]);
  return true;
}
