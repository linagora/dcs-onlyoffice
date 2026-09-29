import { expect, type Frame, type FrameLocator, type Locator, type Page } from '@playwright/test';
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
  GetContent(): { GetElement(index: number): { AddText(text: string): unknown; RemoveAllElements(): unknown } };
  SetLock(lock: string): unknown;
}

// A workbook's user protected range in the spreadsheet editor's internal
// model, which a command reaches through the active sheet.
interface SandboxUserProtectedRange {
  isUserCanEdit(userId: string): boolean;
}

interface SandboxApi {
  GetActiveSheet(): {
    worksheet: {
      getUserProtectedRangeByName(name: string): { obj: SandboxUserProtectedRange } | null;
      editUserProtectedRanges(from: SandboxUserProtectedRange, to: null, addToHistory: true): unknown;
    };
  };
  GetDocument(): {
    InsertContent(content: SandboxBlock[]): unknown;
    GetAllContentControls(): (SandboxBlock & { GetTag(): string; Delete(keepContent: boolean): unknown })[];
    GetCustomXmlParts(): { Add(xml: string): unknown; GetByNamespace(namespace: string): { GetXml(): string; Delete(): unknown }[] };
    GetSections(): { GetHeader(type: 'default', create: false): { GetElement(index: number): SandboxBlock | null } | null }[];
  };
  CreateBlockLvlSdt(): SandboxBlock;
}

declare const Api: SandboxApi;
declare const Asc: { scope: unknown };

const PLUGIN_PAGE = '/plugin/index.html';
const BUBBLE_PAGE = '/plugin/bubble.html';

export function pluginPanel(page: Page): FrameLocator {
  return page.frameLocator('iframe[name="frameEditor"]').frameLocator(`iframe[src*="${PLUGIN_PAGE}"]`);
}

// The portion the panel highlights, whose placeholder holds the cursor or
// the selection.
export function highlightedPortion(page: Page): Locator {
  return pluginPanel(page).locator('[data-testid="portion-item"][aria-current="true"]');
}

// The bubble: the window the panel opens next to the cursor when it shows a
// portion.
export function bubble(page: Page): FrameLocator {
  return page.frameLocator('iframe[name="frameEditor"]').frameLocator(`iframe[src*="${BUBBLE_PAGE}"]`);
}

// The bubble pages the editor loads from now on, one for each window the
// panel opens.
export function watchBubbleOpenings(page: Page): string[] {
  const openings: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(BUBBLE_PAGE)) {
      openings.push(request.url());
    }
  });
  return openings;
}

// The frame where ONLYOFFICE's own scripts run.
export function editorFrame(page: Page): Frame {
  const frame = page.frame({ name: 'frameEditor' });
  if (frame === null) {
    throw new Error('The page holds no editor');
  }
  return frame;
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

// How a portion's part stores its content: its text in clear, base64-encoded,
// or an envelope.
type StoredEncoding = 'base64' | 'ztdf';

// A portion the test writes itself, bypassing the panel.
interface WrittenPortion {
  labelCode: string;
  labelXml: string;
  placeholder: string;
}

export interface UnencryptedPortion extends WrittenPortion {
  text: string;
}

// An envelope taken from another portion, under the label given here.
export interface MovedEnvelope extends WrittenPortion {
  envelope: string;
}

// Writes a portion as iteration 2 did, before encryption: its text in clear,
// base64-encoded, in its part.
export async function insertUnencryptedPortion(frame: Frame, portion: UnencryptedPortion): Promise<void> {
  await writePortion(frame, portion, 'base64', Buffer.from(portion.text).toString('base64'));
}

// Writes a portion as a co-author able to edit the file could: an existing
// envelope, under a label that is not the one bound to it.
export async function insertMovedEnvelope(frame: Frame, portion: MovedEnvelope): Promise<void> {
  await writePortion(frame, portion, 'ztdf', portion.envelope);
}

// Writes a portion bypassing the panel.
async function writePortion(frame: Frame, portion: WrittenPortion, encoding: StoredEncoding, content: string): Promise<void> {
  await whilePanelCommandsHeld(frame, async () =>
    frame.evaluate(
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
      portionScope(portion, encoding, content),
    ),
  );
}

// Puts `xml` in place of the document's Custom XML parts of a namespace,
// bypassing the panel, as any editor could.
export async function replaceCustomXmlParts(frame: Frame, namespace: string, xml: string): Promise<void> {
  await whilePanelCommandsHeld(frame, async () =>
    frame.evaluate(
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
              const replacement = Asc.scope as { namespace: string; xml: string }; // SAFETY: the scope set just above
              const parts = Api.GetDocument().GetCustomXmlParts();
              for (const part of parts.GetByNamespace(replacement.namespace)) {
                part.Delete();
              }
              parts.Add(replacement.xml);
              return true;
            },
            false,
            true,
            () => {
              resolve();
            },
          );
        }),
      { namespace, xml },
    ),
  );
}

// Adds Custom XML parts to the document, bypassing the panel.
export async function addCustomXmlParts(frame: Frame, xmls: string[]): Promise<void> {
  await whilePanelCommandsHeld(frame, async () =>
    frame.evaluate(
      async (parts) =>
        new Promise<void>((resolve, reject) => {
          const runtime = window.Asc;
          const callCommand = window.dcsWorkingCallCommand;
          if (runtime === undefined || callCommand === undefined) {
            reject(new Error('The plugin runtime has no callCommand'));
            return;
          }
          runtime.scope = parts;
          callCommand.call(
            runtime.plugin,
            () => {
              // Runs in the editor's sandbox, with Api and Asc.scope only.
              const added = Asc.scope as string[]; // SAFETY: the scope set just above
              const customXmlParts = Api.GetDocument().GetCustomXmlParts();
              for (const xml of added) {
                customXmlParts.Add(xml);
              }
              return true;
            },
            false,
            true,
            () => {
              resolve();
            },
          );
        }),
      xmls,
    ),
  );
}

// Gives a portion's part another label in clear, bypassing the panel, as any
// editor could; the envelope stays as it was.
export async function relabelPortionPart(frame: Frame, portionId: string, labelCode: string): Promise<void> {
  await whilePanelCommandsHeld(frame, async () =>
    frame.evaluate(
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
              const { id, label, namespace } = Asc.scope as { id: string; label: string; namespace: string }; // SAFETY: the scope set just above
              const parts = Api.GetDocument().GetCustomXmlParts();
              for (const part of parts.GetByNamespace(namespace)) {
                const xml = part.GetXml();
                if (/ id=["']([^"']*)["']/.exec(xml)?.[1] === id) {
                  part.Delete();
                  parts.Add(xml.replace(/ label=["'][^"']*["']/, ` label="${label}"`));
                }
              }
              return true;
            },
            false,
            true,
            () => {
              resolve();
            },
          );
        }),
      { id: portionId, label: labelCode, namespace: PORTION_NAMESPACE },
    ),
  );
}

// Removes a portion's placeholder and part, bypassing the panel, as a tool
// able to edit the file could.
export async function removePortion(frame: Frame, portionId: string): Promise<void> {
  await whilePanelCommandsHeld(frame, async () =>
    frame.evaluate(
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
              const { id, namespace } = Asc.scope as { id: string; namespace: string }; // SAFETY: the scope set just above
              const document = Api.GetDocument();
              const parts = document.GetCustomXmlParts();
              for (const part of parts.GetByNamespace(namespace)) {
                if (/ id=["']([^"']*)["']/.exec(part.GetXml())?.[1] === id) {
                  part.Delete();
                }
              }
              for (const control of document.GetAllContentControls()) {
                if (control.GetTag().includes(id)) {
                  control.SetLock('unlocked');
                  control.Delete(false);
                }
              }
              return true;
            },
            false,
            true,
            () => {
              resolve();
            },
          );
        }),
      { id: portionId, namespace: PORTION_NAMESPACE },
    ),
  );
}

// Changes the words of the page marking that opens the first section's
// default header, as an author could once they unlock it. The panel's
// commands must be held.
export async function rewordPageMarking(frame: Frame, words: string): Promise<void> {
  await frame.evaluate(
    async (scope) =>
      new Promise<void>((resolve, reject) => {
        const runtime = window.Asc;
        const callCommand = window.dcsWorkingCallCommand;
        if (runtime === undefined || callCommand === undefined) {
          reject(new Error('The panel\'s commands are not held'));
          return;
        }
        runtime.scope = scope;
        callCommand.call(
          runtime.plugin,
          () => {
            // Runs in the editor's sandbox, with Api and Asc.scope only.
            const text = Asc.scope as string; // SAFETY: the scope set just above
            const marking = Api.GetDocument().GetSections()[0]?.GetHeader('default', false)?.GetElement(0) ?? null;
            if (marking === null) {
              return false;
            }
            marking.SetLock('unlocked');
            const paragraph = marking.GetContent().GetElement(0);
            paragraph.RemoveAllElements();
            paragraph.AddText(text);
            return true;
          },
          false,
          true,
          () => {
            resolve();
          },
        );
      }),
    words,
  );
}

// The plugin SDK keeps a single callback slot, so the panel's commands are
// held off, and the test waits for the one the editor may still be answering
// before it sends its own.
export async function holdPanelCommands(frame: Frame): Promise<void> {
  await breakEditorCommands(frame, 'Held off while the test writes to the document');
  await expect
    .poll(async () => frame.evaluate(() => (window.Asc?.plugin?.onCallCommandCallback ?? null) === null), { timeout: 30_000 })
    .toBe(true);
}

async function whilePanelCommandsHeld(frame: Frame, write: () => Promise<void>): Promise<void> {
  await holdPanelCommands(frame);
  try {
    await write();
  } finally {
    await restoreEditorCommands(frame);
  }
}

function portionScope(portion: WrittenPortion, encoding: StoredEncoding, content: string): { tag: string; placeholder: string; xml: string } {
  const id = crypto.randomUUID();
  return {
    tag: JSON.stringify({ v: 1, id, label: portion.labelCode }),
    placeholder: portion.placeholder,
    xml:
      `<dcs:portion xmlns:dcs="${PORTION_NAMESPACE}" id="${id}" version="1" label="${portion.labelCode}">` +
      `<dcs:label>${portion.labelXml}</dcs:label>` +
      `<dcs:content encoding="${encoding}">${content}</dcs:content>` +
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

// Removes a workbook portion's user protected range, bypassing the panel, as
// a co-author could through the editor's internal model: its lock lifted in
// this browser, for the command only.
export async function removeUserProtectedRange(frame: Frame, title: string): Promise<void> {
  await whilePanelCommandsHeld(frame, async () =>
    frame.evaluate(
      async (rangeTitle) =>
        new Promise<void>((resolve, reject) => {
          const runtime = window.Asc;
          const callCommand = window.dcsWorkingCallCommand;
          if (runtime === undefined || callCommand === undefined) {
            reject(new Error('The plugin runtime has no callCommand'));
            return;
          }
          runtime.scope = rangeTitle;
          callCommand.call(
            runtime.plugin,
            () => {
              // Runs in the editor's sandbox, with Api and Asc.scope only.
              const name = Asc.scope as string; // SAFETY: the scope set just above
              const worksheet = Api.GetActiveSheet().worksheet;
              const found = worksheet.getUserProtectedRangeByName(name);
              if (found === null) {
                return false;
              }
              Reflect.set(found.obj, 'isUserCanEdit', () => true);
              try {
                worksheet.editUserProtectedRanges(found.obj, null, true);
              } finally {
                Reflect.deleteProperty(found.obj, 'isUserCanEdit');
              }
              return true;
            },
            false,
            true,
            () => {
              resolve();
            },
          );
        }),
      title,
    ),
  );
}
