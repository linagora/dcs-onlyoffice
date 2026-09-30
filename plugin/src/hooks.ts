import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { BubbleContent } from './bubble-channel.ts';
import { PortionBubble } from './bubble.ts';
import { describeError, logProblem } from './log.ts';
import { messages } from './messages.ts';
import {
  addInsertTabButton,
  type EditorType,
  editorTypeOf,
  offerContextMenu,
  onEditorEvent,
  onSelectionChange,
  type PluginInfo,
  showPanel,
} from './onlyoffice.ts';
import type { EnvelopeClient } from './envelopes.ts';
import {
  type DocumentLabelRequest,
  fetchPortionLabelChoices,
  fetchPortionLocks,
  type LabelView,
  type LockHolder,
  releasePortionLock,
  releasePortionLockOnLeave,
  takePortionLock,
} from './policy.ts';
import { reportPortionChange, reportPortionDeletion, sendScreenMarking } from './portal.ts';
import { writeFailureOf } from './PortionForm.tsx';
import {
  changePortion,
  deletePortion,
  type DocumentState,
  documentLabelIn,
  EDITORS,
  nextVersion,
  type OtherLabels,
  parsePortionTag,
  readDocumentState,
  showsPageMarkingOf,
  type StoredPortion,
  writeDocumentLabel,
  type WriteResult,
} from './portions.ts';
import type { PortionReader, PortionReading } from './readings.ts';

export type Loadable<T> = { status: 'loading' } | { status: 'failed'; reason: string } | { status: 'loaded'; value: T };

export function useLoadable<T>(load: () => Promise<T>, dependencies: readonly unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      const value = await load();
      if (!cancelled) {
        setState({ status: 'loaded', value });
      }
    };
    run().catch((error: unknown) => {
      if (!cancelled) {
        setState({ status: 'failed', reason: describeError(error) });
      }
    });
    return () => {
      cancelled = true;
    };
    // The caller lists what `load` depends on.
  }, dependencies);
  return state;
}

const REFRESH_INTERVAL_MS = 3_000;
// When the panel shows itself again after a workbook loaded.
const PANEL_SHOW_DELAYS_MS = [0, 1_000, 3_000];

export interface DocumentStateView {
  state: DocumentState | null;
  activePortionId: string | null;
  // How many times the selection changed, where the panel follows it
  // through the editor's calls rather than its events.
  selectionChanges: number;
  // Why the last background reread failed, until a reread succeeds.
  rereadProblem: string | null;
  // Rereads the document at once and returns what it holds.
  refresh: () => Promise<DocumentState>;
}

// The document's portions and labels, kept current: the editor's events cover
// the local author, regular rereading covers co-authors.
export function useDocumentState(pluginReady: Promise<PluginInfo>): DocumentStateView {
  const [state, setState] = useState<DocumentState | null>(null);
  const [activePortionId, setActivePortionId] = useState<string | null>(null);
  const [selectionChanges, setSelectionChanges] = useState(0);
  const [rereadProblem, setRereadProblem] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<DocumentState> => {
    const current = await readDocumentState(editorTypeOf(await pluginReady));
    // Only a real change re-renders, so that polling stays cheap.
    setState((previous) => (previous !== null && sameState(previous, current) ? previous : current));
    setRereadProblem(null);
    return current;
  }, [pluginReady]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const showTimers: ReturnType<typeof setTimeout>[] = [];
    const refreshInBackground = (): void => {
      refresh().catch((error: unknown) => {
        logProblem('Rereading the document', error);
        if (!cancelled) {
          setRereadProblem(describeError(error));
        }
      });
    };
    const start = async (): Promise<void> => {
      await pluginReady;
      if (cancelled) {
        return;
      }
      const listening = [
        onEditorEvent('onDocumentContentReady', refreshInBackground),
        onEditorEvent('onChangeContentControl', refreshInBackground),
        onEditorEvent('onFocusContentControl', (control) => {
          setActivePortionId(portionIdOf(control));
        }),
        onEditorEvent('onBlurContentControl', () => {
          setActivePortionId(null);
        }),
      ];
      if (listening.includes(false)) {
        logProblem('Listening to the editor', new Error('The editor runtime offers no events'));
      }
      // Co-authors' changes to Custom XML parts raise no plugin event, so the
      // panel also rereads the document regularly.
      timer = setInterval(refreshInBackground, REFRESH_INTERVAL_MS);
      await refresh();
      if (cancelled) {
        return;
      }
      const editor = EDITORS[editorTypeOf(await pluginReady)];
      const { readActivePortion } = editor;
      if (readActivePortion !== null) {
        const followSelection = async (): Promise<void> => {
          const portionId = await readActivePortion();
          if (!cancelled) {
            setActivePortionId(portionId);
            setSelectionChanges((count) => count + 1);
          }
        };
        onSelectionChange(() => {
          followSelection().catch((error: unknown) => {
            logProblem('Reading the selection', error);
          });
        });
      }
      if (editor.hidesPanelOnLoad) {
        // The panel shows itself again once the editor has put its settings
        // in its place, which it does soon after the workbook loaded.
        for (const delay of PANEL_SHOW_DELAYS_MS) {
          showTimers.push(
            setTimeout(() => {
              showPanel().catch((error: unknown) => {
                logProblem('Showing the panel', error);
              });
            }, delay),
          );
        }
      }
    };
    start().catch((error: unknown) => {
      logProblem('Reading the document', error);
      if (!cancelled) {
        setRereadProblem(describeError(error));
      }
    });
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearInterval(timer);
      }
      for (const showTimer of showTimers) {
        clearTimeout(showTimer);
      }
      onSelectionChange(() => {});
    };
  }, [pluginReady, refresh]);

  return { state, activePortionId, selectionChanges, rereadProblem, refresh };
}

// The document label computed from the document's content. Two authors
// inserting at the same moment each write a document label that misses the
// other's portion, and the last writer wins: whoever may write and notices
// that the stored label or its page marking is stale rewrites both. So does
// the first author to open a labelled document that has no page marking yet,
// or a workbook with a sheet that has none. Nothing is written until the
// editor is known, nor while the author types in a cell of a workbook: the
// rewrite waits until they leave it.
export function useDocumentLabel(
  request: DocumentLabelRequest | null,
  stored: Pick<DocumentState, 'documentLabelCode' | 'pageMarking' | 'cellBeingEdited'> | null,
  canWrite: boolean,
  editor: EditorType | null,
): LabelView | null {
  const [label, setLabel] = useState<LabelView | null>(null);
  useEffect(() => {
    if (request === null) {
      return;
    }
    let cancelled = false;
    const compute = async (): Promise<void> => {
      // Until the editor is known, the label only shows: its binding, over
      // a text document's parts, goes nowhere.
      const computed = await documentLabelIn(editor ?? 'word', request);
      if (cancelled) {
        return;
      }
      setLabel(computed.label);
      const storedLabelCode = stored?.documentLabelCode ?? null;
      const pageMarking = stored?.pageMarking ?? null;
      const staleMarking = !showsPageMarkingOf(pageMarking, computed.label);
      const writable = canWrite && editor !== null && stored?.cellBeingEdited !== true;
      if (writable && storedLabelCode !== null && (storedLabelCode !== computed.label.code || staleMarking)) {
        await writeDocumentLabel(request, editor);
      }
    };
    compute().catch((error: unknown) => {
      logProblem('Computing the document label', error);
      if (!cancelled) {
        setLabel(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [request, stored, canWrite, editor]);
  return label;
}

// The portal's page around a workbook's editor shows its document label above
// and below it, which the spreadsheet editor leaves out on screen: the panel
// tells the page each label it computes. The hook only sends, hence no return
// value.
export function useScreenMarking(label: LabelView | null, editor: EditorType | null): void {
  useEffect(() => {
    if (label !== null && editor !== null && EDITORS[editor].screenMarked) {
      sendScreenMarking(label.marking);
    }
  }, [label, editor]);
}

const RETRY_INTERVAL_MS = 3_000;

// What the panel can show of each portion, by portion id, each portion shown
// as soon as it is read. A document that does not change re-renders nothing,
// so failures worth retrying get their own timer.
// Texts whose bound labels are among `unreadable` are forgotten, and shown as
// refused.
export function usePortionReadings(portions: StoredPortion[], reader: PortionReader | null, unreadable: ReadonlySet<string>): ReadonlyMap<string, PortionReading> {
  const [readings, setReadings] = useState<ReadonlyMap<string, PortionReading>>(new Map());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (reader === null) {
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    reader.forget(unreadable);
    reader.retain(portions);
    const ids = new Set(portions.map((portion) => portion.id));
    setReadings((previous) => new Map([...previous].filter(([id]) => ids.has(id))));
    const readOne = async (portion: StoredPortion): Promise<void> => {
      const reading = await reader.read(portion);
      if (cancelled) {
        return;
      }
      setReadings((previous) => new Map(previous).set(portion.id, reading));
      if (needsRetry(reading) && retry === null) {
        retry = setTimeout(() => {
          setAttempt((count) => count + 1);
        }, RETRY_INTERVAL_MS);
      }
    };
    for (const portion of portions) {
      readOne(portion).catch((error: unknown) => {
        logProblem('Reading a portion', error);
      });
    }
    return () => {
      cancelled = true;
      if (retry !== null) {
        clearTimeout(retry);
      }
    };
  }, [portions, reader, attempt, unreadable]);
  return readings;
}

const INSERT_ENTRY_ID = 'dcs-insert-portion';
const PROTECT_ENTRY_ID = 'dcs-protect-selection';
const INSERT_BUTTON_ID = 'dcs-insert-portion-button';

// What an entry point of the editor's menus asks the panel for.
export type EntryPointRequest = 'insertion' | 'protection';

// Entry points in the editor's own menus that lead to the panel's form: to
// insert a portion, and, in the context menu only, to protect the selection.
// `onRequest` must keep its identity across renders. The hook only wires the
// editor, hence no return value.
export function useMenuEntryPoints(
  pluginReady: Promise<PluginInfo>,
  enabled: boolean,
  onRequest: (request: EntryPointRequest) => void,
): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const wire = async (): Promise<void> => {
      await pluginReady;
      const entries = [
        { id: INSERT_ENTRY_ID, text: messages.contextMenuEntry },
        { id: PROTECT_ENTRY_ID, text: messages.protectionContextMenuEntry },
      ];
      const menuOffered = offerContextMenu(
        () => entries,
        (id) => {
          onRequest(id === PROTECT_ENTRY_ID ? 'protection' : 'insertion');
        },
      );
      const buttonAdded = await addInsertTabButton(
        { id: INSERT_BUTTON_ID, text: messages.toolbarButton, hint: messages.toolbarButtonHint, icon: 'resources/icon.svg' },
        () => {
          onRequest('insertion');
        },
      );
      if (!menuOffered || !buttonAdded) {
        logProblem('Adding the menu entry points', new Error('The editor runtime offers no menu API'));
      }
    };
    wire().catch((error: unknown) => {
      logProblem('Adding the menu entry points', error);
    });
  }, [pluginReady, enabled, onRequest]);
}

// The editor's content-control events carry the control, whose tag names the
// portion.
function portionIdOf(control: unknown): string | null {
  if (typeof control !== 'object' || control === null || !('Tag' in control) || typeof control.Tag !== 'string') {
    return null;
  }
  return parsePortionTag(control.Tag)?.id ?? null;
}

function sameState(left: DocumentState, right: DocumentState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// A failure worth retrying, or a label the policy service could not read yet.
function needsRetry(reading: PortionReading): boolean {
  if (reading.status === 'opened') {
    return reading.boundLabel.status === 'unchecked' || reading.partLabel.status === 'unchecked';
  }
  return reading.status === 'failed' && reading.retry;
}

// The bubble: the text of the portion that holds the cursor, shown next to
// it. The window only changes when what it shows changes, not at every
// reading of the document, or when the selection changes, where the panel
// follows it through the editor's calls: selecting a placeholder again brings
// back a window that Escape closed, as a click in a text document's portion
// does. The hook only drives the editor, hence no return value.
export function usePortionBubble(pluginReady: Promise<PluginInfo>, content: BubbleContent | null, selectionChanges: number): void {
  const [bubble, setBubble] = useState<PortionBubble | null>(null);
  useEffect(() => {
    let cancelled = false;
    const created = new PortionBubble();
    const wire = async (): Promise<void> => {
      await pluginReady;
      if (cancelled) {
        return;
      }
      if (!created.attach()) {
        logProblem('Showing portions at the cursor', new Error('The editor runtime offers no events'));
      }
      setBubble(created);
    };
    wire().catch((error: unknown) => {
      logProblem('Showing portions at the cursor', error);
    });
    return () => {
      cancelled = true;
      created.detach();
    };
  }, [pluginReady]);
  const contentKey = content === null ? null : JSON.stringify(content);
  useEffect(() => {
    if (bubble === null) {
      return;
    }
    if (content === null) {
      bubble.clear();
    } else {
      bubble.show(content);
    }
    // contentKey stands for content, compared by value.
  }, [bubble, contentKey, selectionChanges]);
}

export interface PortionLocksView {
  // Who else holds the lock of each portion of the document, by portion id.
  othersLocks: ReadonlyMap<string, LockHolder>;
  // The labels asked that the signed-in person may not read.
  unreadable: ReadonlySet<string>;
}

// No label, the same set on every render.
const NO_LABELS: ReadonlySet<string> = new Set();

// The portion locks of the document, reread as often as the document, and,
// among `labelCodes`, the labels the signed-in person may not read, which the
// policy service decides at each reading: a revocation applies at once in the
// panel. A reading that fails changes nothing.
export function usePortionLocks(documentId: string | null, userId: string | null, labelCodes: readonly string[]): PortionLocksView {
  const [locks, setLocks] = useState<ReadonlyMap<string, LockHolder>>(new Map());
  const [unreadable, setUnreadable] = useState<ReadonlySet<string>>(NO_LABELS);
  // The codes, compared by value.
  const asked = [...new Set(labelCodes)].sort().join('\n');
  useEffect(() => {
    if (documentId === null) {
      return;
    }
    const askedCodes = asked === '' ? [] : asked.split('\n');
    let cancelled = false;
    const reread = async (): Promise<void> => {
      const current = await fetchPortionLocks(documentId, askedCodes);
      const others = new Map([...current.locks].filter(([, holder]) => holder.id !== userId));
      const refused = new Set(askedCodes.filter((code) => !current.readable.has(code)));
      if (!cancelled) {
        setLocks((previous) => (sameLocks(previous, others) ? previous : others));
        setUnreadable((previous) => (sameCodes(previous, refused) ? previous : refused));
      }
    };
    const rereadInBackground = (): void => {
      reread().catch((error: unknown) => {
        logProblem('Reading the portion locks', error);
      });
    };
    rereadInBackground();
    const timer = setInterval(rereadInBackground, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [documentId, userId, asked]);
  return { othersLocks: locks, unreadable };
}

function sameLocks(left: ReadonlyMap<string, LockHolder>, right: ReadonlyMap<string, LockHolder>): boolean {
  return left.size === right.size && [...left].every(([portion, holder]) => right.get(portion)?.id === holder.id);
}

function sameCodes(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((code) => right.has(code));
}

// What the panel says next to one portion.
export interface PortionNotice {
  portionId: string;
  message: string;
}

// What an author does to a portion under its lock: change its text or its
// label, or delete it.
export type PortionEditKind = 'change' | 'deletion';

// The portion an author asks to change or delete, with its label and the
// text they read.
export interface PortionEditRequest {
  portion: StoredPortion;
  label: LabelView;
  text: string;
}

// A change under way, with the labels the portion may take, or a deletion
// awaiting its confirmation.
export type PortionEdit = (PortionEditRequest & { kind: 'change'; choices: LabelView[] }) | { kind: 'deletion'; portion: StoredPortion; label: LabelView };

export interface PortionEditView {
  // The portion changed or deleted in this panel, under its lock.
  underWay: PortionEdit | null;
  // Why the last change or deletion could not start or be written.
  notice: PortionNotice | null;
  start: (request: PortionEditRequest, kind: PortionEditKind) => void;
  save: (label: LabelView, text: string) => Promise<WriteResult>;
  confirmDeletion: () => Promise<WriteResult>;
  cancel: () => void;
}

// How the panel's log names the steps of a change and of a deletion.
const EDIT_STEPS: Record<PortionEditKind, { writing: string; reporting: string }> = {
  change: { writing: 'Changing a portion', reporting: 'Reporting a portion change' },
  deletion: { writing: 'Deleting a portion', reporting: 'Reporting a portion deletion' },
};

// A change or a deletion of a portion, under the portion lock the panel takes
// first, renews at half its lease and releases once the change is saved, the
// portion deleted or either dropped, or as the panel goes away. A clearance
// that no longer lets its person read the portion's label drops it at once,
// and releases the lock.
// `baseLabelCode` stands in for a document that has not stored its base label
// yet.
export function usePortionEdit(
  documentId: string | null,
  envelopes: EnvelopeClient | null,
  refresh: () => Promise<DocumentState>,
  baseLabelCode: string | null,
  editor: EditorType | null,
  unreadable: ReadonlySet<string>,
): PortionEditView {
  const [underWay, setUnderWay] = useState<(PortionEdit & { leaseMs: number }) | null>(null);
  const [notice, setNotice] = useState<PortionNotice | null>(null);
  // The portion whose lock the panel holds, cleared before any release so
  // that no renewal outlives it.
  const holding = useRef<string | null>(null);

  const start = useCallback(
    (request: PortionEditRequest, kind: PortionEditKind): void => {
      const portionId = request.portion.id;
      const take = async (): Promise<PortionNotice | null> => {
        if (documentId === null) {
          return { portionId, message: messages.lockFailed('the document is unknown') };
        }
        // Only a change offers labels.
        let choices: LabelView[] = [];
        try {
          choices = kind === 'change' ? await fetchPortionLabelChoices(request.label.policy, request.label.code) : [];
        } catch (error: unknown) {
          logProblem('Reading the labels a portion may take', error);
          return { portionId, message: messages.labelChoicesFailed(describeError(error)) };
        }
        const outcome = await takePortionLock(documentId, portionId, request.label.code, false);
        if (outcome.status === 'taken') {
          return { portionId, message: outcome.holder === null ? messages.lockLost : messages.beingChangedBy(outcome.holder.name) };
        }
        if (outcome.status === 'refused') {
          return { portionId, message: messages.changeRefused };
        }
        // The change or the deletion starts from what the document holds now,
        // which must be the version the last change wrote: an editor that has
        // not received it yet would write over it.
        const current = (await refresh()).portions.find((portion) => portion.id === portionId) ?? null;
        const version = current?.version ?? null;
        if (current === null || version !== request.portion.version || (outcome.version !== null && (version ?? 1) < outcome.version)) {
          await releasePortionLock(documentId, portionId, null);
          return { portionId, message: messages.portionChangedMeanwhile };
        }
        holding.current = portionId;
        const edit: PortionEdit = kind === 'change' ? { ...request, kind, choices } : { kind, portion: request.portion, label: request.label };
        setUnderWay({ ...edit, leaseMs: outcome.leaseMs });
        return null;
      };
      const run = async (): Promise<void> => {
        setNotice(await take());
      };
      setNotice(null);
      run().catch((error: unknown) => {
        logProblem('Taking a portion lock', error);
        setNotice({ portionId, message: messages.lockFailed(describeError(error)) });
      });
    },
    [documentId, refresh],
  );

  useEffect(() => {
    if (underWay === null || documentId === null) {
      return;
    }
    const { portion, label, leaseMs } = underWay;
    const renew = async (): Promise<void> => {
      const outcome = await takePortionLock(documentId, portion.id, label.code, true);
      if (holding.current === portion.id && outcome.status !== 'held') {
        holding.current = null;
        setUnderWay(null);
        setNotice({ portionId: portion.id, message: messages.lockLost });
      }
    };
    const timer = setInterval(() => {
      if (holding.current === portion.id) {
        renew().catch((error: unknown) => {
          logProblem('Renewing a portion lock', error);
        });
      }
    }, leaseMs / 2);
    const leave = (): void => {
      if (holding.current === portion.id) {
        releasePortionLockOnLeave(documentId, portion.id);
      }
    };
    window.addEventListener('pagehide', leave);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pagehide', leave);
    };
  }, [underWay, documentId]);

  const release = async (portionId: string, version: number | null): Promise<void> => {
    holding.current = null;
    setUnderWay(null);
    if (documentId !== null) {
      await releasePortionLock(documentId, portionId, version);
    }
  };

  const releaseAside = (portionId: string): void => {
    release(portionId, null).catch((error: unknown) => {
      logProblem('Releasing a portion lock', error);
    });
  };

  useEffect(() => {
    if (underWay === null || !unreadable.has(underWay.label.code) || holding.current !== underWay.portion.id) {
      return;
    }
    setNotice({ portionId: underWay.portion.id, message: messages.portionNoLongerReadable });
    releaseAside(underWay.portion.id);
    // releaseAside changes with every render; the labels decide.
  }, [underWay, unreadable]);

  // Writes with `writeWith` and the document's other labels, unless the
  // portion changed outside the panel since the lock was taken: writing would
  // drop that change. The lock is then released, with `nextVersionOnceWritten`
  // when something was written, and `report` tells the portal what was; but
  // while the author types in a cell of a workbook, the author keeps the lock
  // and the edit, to try again once out of the cell.
  const writeUnderLock = async (
    edit: PortionEdit,
    writeWith: (others: OtherLabels) => Promise<WriteResult>,
    nextVersionOnceWritten: number,
    report: (documentId: string) => Promise<void>,
  ): Promise<WriteResult> => {
    const { portion } = edit;
    const write = async (): Promise<WriteResult> => {
      const current = await refresh();
      // A revocation, or a lock that lapsed, dropped the change or the
      // deletion meanwhile.
      if (holding.current !== portion.id) {
        return { status: 'not-written' };
      }
      const base = current.baseLabelCode ?? baseLabelCode;
      if (base === null) {
        return { status: 'not-written' };
      }
      const now = current.portions.find((other) => other.id === portion.id);
      if (now === undefined || now.version !== portion.version || now.labelCode !== portion.labelCode) {
        return { status: 'changed-meanwhile' };
      }
      const portionLabelCodes = current.portions.filter((other) => other.id !== portion.id).map((other) => other.labelCode);
      return writeWith({ baseLabelCode: base, portionLabelCodes });
    };
    const steps = EDIT_STEPS[edit.kind];
    const result = await write().catch((error: unknown): WriteResult => {
      logProblem(steps.writing, error);
      return { status: 'not-written' };
    });
    if (result.status === 'cell-being-edited') {
      return result;
    }
    const dropped = holding.current !== portion.id;
    await release(portion.id, result.status === 'written' ? nextVersionOnceWritten : null).catch((error: unknown) => {
      logProblem('Releasing a portion lock', error);
    });
    if (result.status === 'written' && documentId !== null) {
      report(documentId).catch((error: unknown) => {
        logProblem(steps.reporting, error);
      });
    }
    await refresh().catch((error: unknown) => {
      logProblem('Rereading the document', error);
    });
    // What dropped a change or a deletion that was not written keeps saying so.
    if (!dropped || result.status === 'written') {
      const failure = writeFailureOf(edit.kind, result);
      setNotice(failure === null ? null : { portionId: portion.id, message: failure });
    }
    return result;
  };

  const save = async (label: LabelView, text: string): Promise<WriteResult> => {
    if (underWay?.kind !== 'change') {
      return { status: 'not-written' };
    }
    const { portion } = underWay;
    const version = nextVersion(portion);
    return writeUnderLock(
      underWay,
      async (others) =>
        envelopes === null || editor === null ? { status: 'not-written' } : changePortion({ portion, label, text }, others, envelopes, editor),
      version,
      async (id) => reportPortionChange(id, portion.id, { label: underWay.label.code, version: portion.version }, { label: label.code, version }),
    );
  };

  // A deletion counts as a version for the lock service: a co-author whose
  // editor has not received it yet cannot start changing the portion.
  const confirmDeletion = async (): Promise<WriteResult> => {
    if (underWay?.kind !== 'deletion') {
      return { status: 'not-written' };
    }
    const { portion, label } = underWay;
    return writeUnderLock(
      underWay,
      async (others) => (editor === null ? { status: 'not-written' } : deletePortion(portion, label.policy, others, editor)),
      nextVersion(portion),
      async (id) => reportPortionDeletion(id, portion.id, { label: label.code, version: portion.version }),
    );
  };

  const cancel = (): void => {
    if (underWay !== null) {
      releaseAside(underWay.portion.id);
    }
  };

  return { underWay, notice, start, save, confirmDeletion, cancel };
}
