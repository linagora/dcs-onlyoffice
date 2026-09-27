import { expect, type Frame, type FrameLocator, type Page } from '@playwright/test';
import { PORTION_NAMESPACE } from './docx.ts';

export interface PluginInfoIdentity {
  userId: string | null;
  userName: string | null;
}

type CallCommand = (command: () => unknown, isClose: boolean, isCalc: boolean, callback: (result: unknown) => void) => void;

// What the editor's plugin runtime installs on the plugin frame's window.
interface AscPluginRuntime {
  // The data a command reads as Asc.scope in the editor's sandbox.
  scope?: unknown;
  plugin?: {
    info?: Record<string, unknown>;
    // Set while a command awaits the editor's answer: the SDK's single slot.
    onCallCommandCallback?: unknown;
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

// Globals of the editor's sandbox, where a command runs.
interface SandboxBlock {
  SetTag(tag: string): unknown;
  GetContent(): { GetElement(index: number): { AddText(text: string): unknown } };
  SetLock(lock: string): unknown;
}

interface SandboxApi {
  GetDocument(): { InsertContent(content: SandboxBlock[]): unknown; GetCustomXmlParts(): { Add(xml: string): unknown } };
  CreateBlockLvlSdt(): SandboxBlock;
}

declare const Api: SandboxApi;
declare const Asc: { scope: unknown };

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

export interface UnencryptedPortion {
  labelCode: string;
  labelXml: string;
  placeholder: string;
  text: string;
}

// Writes a portion as iteration 2 did, before encryption: its text in clear,
// base64-encoded, in its part. The plugin SDK keeps a single callback slot, so
// the panel's commands are held off, and the test waits for the one the
// editor may still be answering before it sends its own.
export async function insertUnencryptedPortion(frame: Frame, portion: UnencryptedPortion): Promise<void> {
  await breakEditorCommands(frame, 'Held off while the test writes a portion');
  try {
    await expect
      .poll(async () => frame.evaluate(() => (window.Asc?.plugin?.onCallCommandCallback ?? null) === null), { timeout: 30_000 })
      .toBe(true);
    await frame.evaluate(
      async (scope) =>
        new Promise<void>((resolve, reject) => {
          const runtime = window.Asc;
          const callCommand = window.dcsWorkingCallCommand;
          if (runtime === undefined || callCommand === undefined) {
            reject(new Error('The plugin runtime has no callCommand'));
            return;
          }
          runtime.scope = scope;
          callCommand.call(
            runtime.plugin,
            () => {
              // Runs in the editor's sandbox, with Api and Asc.scope only.
              const { tag, placeholder, xml } = Asc.scope as { tag: string; placeholder: string; xml: string }; // SAFETY: the scope set just above
              const document = Api.GetDocument();
              const block = Api.CreateBlockLvlSdt();
              block.SetTag(tag);
              block.GetContent().GetElement(0).AddText(placeholder);
              block.SetLock('sdtContentLocked');
              document.InsertContent([block]);
              document.GetCustomXmlParts().Add(xml);
              return true;
            },
            false,
            true,
            () => {
              resolve();
            },
          );
        }),
      unencryptedScope(portion),
    );
  } finally {
    await restoreEditorCommands(frame);
  }
}

function unencryptedScope(portion: UnencryptedPortion): { tag: string; placeholder: string; xml: string } {
  const id = crypto.randomUUID();
  return {
    tag: JSON.stringify({ v: 1, id, label: portion.labelCode }),
    placeholder: portion.placeholder,
    xml:
      `<dcs:portion xmlns:dcs="${PORTION_NAMESPACE}" id="${id}" version="1" label="${portion.labelCode}">` +
      `<dcs:label>${portion.labelXml}</dcs:label>` +
      `<dcs:content encoding="base64">${Buffer.from(portion.text).toString('base64')}</dcs:content>` +
      '</dcs:portion>',
  };
}

// The ADatP-4774 XML of a label, as the plugin gets it from the policy
// service, through the portal's relay.
export async function labelXmlOf(frame: Frame, policy: string, code: string): Promise<string> {
  const xml = await frame.evaluate(
    async ({ policy, code }) => {
      const response = await fetch(`/api/policy/policies/${encodeURIComponent(policy)}/labels/adatp4774`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const body: unknown = await response.json();
      return typeof body === 'object' && body !== null && 'xml' in body && typeof body.xml === 'string' ? body.xml : null;
    },
    { policy, code },
  );
  if (xml === null) {
    throw new Error(`The policy service gave no XML for label ${code}`);
  }
  return xml;
}
