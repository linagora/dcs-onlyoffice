import { expect, type Frame, type FrameLocator, type Page } from '@playwright/test';

export interface PluginInfoIdentity {
  userId: string | null;
  userName: string | null;
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
    const scope = window as { Asc?: { plugin?: { info?: Record<string, unknown> } } };
    const info = scope.Asc?.plugin?.info ?? {};
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
        const scope = window as {
          Asc?: { plugin?: { executeMethod?: (method: string, args: unknown[], callback: (result: unknown) => void) => void } };
        };
        scope.Asc?.plugin?.executeMethod?.(name, parameters, (result) => {
          resolve(result ?? null);
        });
      }),
    { name, parameters },
  );
}
