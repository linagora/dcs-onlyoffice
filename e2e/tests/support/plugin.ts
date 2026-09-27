import { expect, type Frame, type FrameLocator, type Page } from '@playwright/test';

export interface PluginInfoIdentity {
  userId: string | null;
  userName: string | null;
}

type CallCommand = (command: () => unknown, isClose: boolean, isCalc: boolean, callback: (result: unknown) => void) => void;

// What the editor's plugin runtime installs on the plugin frame's window.
interface AscPluginRuntime {
  plugin?: {
    info?: Record<string, unknown>;
    executeMethod?: (method: string, args: unknown[], callback: (result: unknown) => void) => void;
    callCommand?: CallCommand;
  };
}

declare global {
  interface Window {
    Asc?: AscPluginRuntime;
    // The editor's own callCommand, kept while a test simulates a failure.
    dcsWorkingCallCommand?: CallCommand;
  }
}

const PLUGIN_PAGE = '/plugin/index.html';

export function pluginPanel(page: Page): FrameLocator {
  return page.frameLocator('iframe[name="frameEditor"]').frameLocator(`iframe[src*="${PLUGIN_PAGE}"]`);
}

export async function pluginFrame(page: Page): Promise<Frame> {
  let found: Frame | null = null;
  await expect
    .poll(
      () => {
        found = page.frames().find((frame) => frame.url().includes(PLUGIN_PAGE)) ?? null;
        return found !== null;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  if (found === null) {
    throw new Error('The labelling plugin iframe never appeared');
  }
  return found;
}

export async function pluginInfoIdentity(frame: Frame): Promise<PluginInfoIdentity> {
  return frame.evaluate(() => {
    const info = window.Asc?.plugin?.info ?? {};
    return {
      userId: typeof info.userId === 'string' ? info.userId : null,
      userName: typeof info.userName === 'string' ? info.userName : null,
    };
  });
}

// Calls an editor method from the plugin's frame, as the plugin itself does.
export async function executeEditorMethod(frame: Frame, name: string, parameters: unknown[]): Promise<unknown> {
  return frame.evaluate(
    async ({ name, parameters }) =>
      new Promise((resolve) => {
        window.Asc?.plugin?.executeMethod?.(name, parameters, (result) => {
          resolve(result ?? null);
        });
      }),
    { name, parameters },
  );
}

// Simulates an editor that fails every command the plugin sends, as if the
// editor had broken, until restoreEditorCommands is called.
export async function breakEditorCommands(frame: Frame, message: string): Promise<void> {
  await frame.evaluate((failure) => {
    const plugin = window.Asc?.plugin;
    if (plugin?.callCommand === undefined) {
      throw new Error('The plugin runtime has no callCommand');
    }
    window.dcsWorkingCallCommand = plugin.callCommand;
    plugin.callCommand = () => {
      throw new Error(failure);
    };
  }, message);
}

export async function restoreEditorCommands(frame: Frame): Promise<void> {
  await frame.evaluate(() => {
    const plugin = window.Asc?.plugin;
    if (plugin !== undefined && window.dcsWorkingCallCommand !== undefined) {
      plugin.callCommand = window.dcsWorkingCallCommand;
    }
  });
}
