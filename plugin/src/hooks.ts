import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { BubbleContent } from './bubble-channel.ts';
import { PortionBubble } from './bubble.ts';
import { describeError, logProblem } from './log.ts';
import { messages } from './messages.ts';
import { addInsertTabButton, offerContextMenu, onEditorEvent, type PluginInfo } from './onlyoffice.ts';
import type { EnvelopeClient } from './envelopes.ts';
import {
  type DocumentLabelRequest,
  fetchDocumentLabel,
  fetchPortionLocks,
  type LabelView,
  type LockHolder,
  releasePortionLock,
  releasePortionLockOnLeave,
  takePortionLock,
} from './policy.ts';
import { writeFailureOf } from './PortionForm.tsx';
import {
  changePortion,
  type DocumentState,
  parsePortionTag,
  type PortionChange,
  readDocumentState,
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

export interface DocumentStateView {
  state: DocumentState | null;
  activePortionId: string | null;
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
  const [rereadProblem, setRereadProblem] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<DocumentState> => {
    const current = await readDocumentState();
    // Only a real change re-renders, so that polling stays cheap.
    setState((previous) => (previous !== null && sameState(previous, current) ? previous : current));
    setRereadProblem(null);
    return current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
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
    };
  }, [pluginReady, refresh]);

  return { state, activePortionId, rereadProblem, refresh };
}

// The document label computed from the document's content. Two authors
// inserting at the same moment each write a document label that misses the
// other's portion, and the last writer wins: whoever may write and notices
// that the stored label or its page marking is stale rewrites both. So does
// the first author to open a labelled document that has no page marking yet.
export function useDocumentLabel(
  request: DocumentLabelRequest | null,
  stored: Pick<DocumentState, 'documentLabelCode' | 'pageMarking'> | null,
  canWrite: boolean,
): LabelView | null {
  const [label, setLabel] = useState<LabelView | null>(null);
  useEffect(() => {
    if (request === null) {
      return;
    }
    let cancelled = false;
    const compute = async (): Promise<void> => {
      const computed = await fetchDocumentLabel(request);
      if (cancelled) {
        return;
      }
      setLabel(computed.label);
      const storedLabelCode = stored?.documentLabelCode ?? null;
      const pageMarking = stored?.pageMarking ?? null;
      const stale =
        storedLabelCode !== computed.label.code || pageMarking?.labelCode !== computed.label.code || pageMarking.text !== computed.label.marking.text;
      if (canWrite && storedLabelCode !== null && stale) {
        await writeDocumentLabel(request);
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
  }, [request, stored, canWrite]);
  return label;
}

const RETRY_INTERVAL_MS = 3_000;

// What the panel can show of each portion, by portion id, each portion shown
// as soon as it is read. A document that does not change re-renders nothing,
// so failures worth retrying get their own timer.
export function usePortionReadings(portions: StoredPortion[], reader: PortionReader | null): ReadonlyMap<string, PortionReading> {
  const [readings, setReadings] = useState<ReadonlyMap<string, PortionReading>>(new Map());
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (reader === null) {
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
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
  }, [portions, reader, attempt]);
  return readings;
}

const INSERT_ENTRY_ID = 'dcs-insert-portion';
const INSERT_BUTTON_ID = 'dcs-insert-portion-button';

// Entry points in the editor's own menus that lead to the panel's form.
// `onRequest` must keep its identity across renders. The hook only wires the
// editor, hence no return value.
export function useInsertionEntryPoints(pluginReady: Promise<PluginInfo>, enabled: boolean, onRequest: () => void): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const wire = async (): Promise<void> => {
      await pluginReady;
      const menuOffered = offerContextMenu(() => [{ id: INSERT_ENTRY_ID, text: messages.contextMenuEntry }], onRequest);
      const buttonAdded = await addInsertTabButton(
        { id: INSERT_BUTTON_ID, text: messages.toolbarButton, hint: messages.toolbarButtonHint, icon: 'resources/icon.svg' },
        onRequest,
      );
      if (!menuOffered || !buttonAdded) {
        logProblem('Adding the insertion entry points', new Error('The editor runtime offers no menu API'));
      }
    };
    wire().catch((error: unknown) => {
      logProblem('Adding the insertion entry points', error);
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
// reading of the document. The hook only drives the editor, hence no return
// value.
export function usePortionBubble(pluginReady: Promise<PluginInfo>, content: BubbleContent | null): void {
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
  }, [bubble, contentKey]);
}

// Who else holds the lock of each portion of the document, by portion id,
// reread as often as the document.
export function usePortionLocks(documentId: string | null, userId: string | null): ReadonlyMap<string, LockHolder> {
  const [locks, setLocks] = useState<ReadonlyMap<string, LockHolder>>(new Map());
  useEffect(() => {
    if (documentId === null) {
      return;
    }
    let cancelled = false;
    const reread = async (): Promise<void> => {
      const current = await fetchPortionLocks(documentId);
      const others = new Map([...current].filter(([, holder]) => holder.id !== userId));
      if (!cancelled) {
        setLocks((previous) => (sameLocks(previous, others) ? previous : others));
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
  }, [documentId, userId]);
  return locks;
}

function sameLocks(left: ReadonlyMap<string, LockHolder>, right: ReadonlyMap<string, LockHolder>): boolean {
  return left.size === right.size && [...left].every(([portion, holder]) => right.get(portion)?.id === holder.id);
}

// What the panel says next to one portion.
export interface PortionNotice {
  portionId: string;
  message: string;
}

export interface PortionChangeView {
  // The portion changed in this panel, under its lock.
  changing: PortionChange | null;
  // Why the last change could not start or be saved.
  notice: PortionNotice | null;
  start: (change: PortionChange) => void;
  save: (label: LabelView, text: string) => Promise<WriteResult>;
  cancel: () => void;
}

// A change of a portion, under the portion lock the panel takes first, renews
// at half its lease and releases once the change is saved or dropped, or as
// the panel goes away.
export function usePortionChange(documentId: string | null, envelopes: EnvelopeClient | null, refresh: () => Promise<DocumentState>): PortionChangeView {
  const [changing, setChanging] = useState<(PortionChange & { leaseMs: number }) | null>(null);
  const [notice, setNotice] = useState<PortionNotice | null>(null);
  // The portion whose lock the panel holds, cleared before any release so
  // that no renewal outlives it.
  const holding = useRef<string | null>(null);

  const start = useCallback(
    (change: PortionChange): void => {
      const portionId = change.portion.id;
      const take = async (): Promise<PortionNotice | null> => {
        if (documentId === null) {
          return { portionId, message: messages.lockFailed('the document is unknown') };
        }
        const outcome = await takePortionLock(documentId, portionId, change.label.code, false);
        if (outcome.status === 'taken') {
          return { portionId, message: outcome.holder === null ? messages.lockLost : messages.beingChangedBy(outcome.holder.name) };
        }
        if (outcome.status === 'refused') {
          return { portionId, message: messages.changeRefused };
        }
        // The change starts from what the document holds now, which must be
        // the version the last change wrote: an editor that has not received
        // it yet would write over it.
        const current = (await refresh()).portions.find((portion) => portion.id === portionId) ?? null;
        const version = current?.version ?? null;
        if (current === null || version !== change.portion.version || (outcome.version !== null && (version ?? 1) < outcome.version)) {
          await releasePortionLock(documentId, portionId, null);
          return { portionId, message: messages.portionChangedMeanwhile };
        }
        holding.current = portionId;
        setChanging({ ...change, leaseMs: outcome.leaseMs });
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
    if (changing === null || documentId === null) {
      return;
    }
    const { portion, label, leaseMs } = changing;
    const renew = async (): Promise<void> => {
      const outcome = await takePortionLock(documentId, portion.id, label.code, true);
      if (holding.current === portion.id && outcome.status !== 'held') {
        holding.current = null;
        setChanging(null);
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
  }, [changing, documentId]);

  const release = async (portionId: string, version: number | null): Promise<void> => {
    holding.current = null;
    setChanging(null);
    if (documentId !== null) {
      await releasePortionLock(documentId, portionId, version);
    }
  };

  // Whatever happens, the lock is released, with the version written when the
  // change went through.
  const save = async (label: LabelView, text: string): Promise<WriteResult> => {
    if (changing === null) {
      return { status: 'not-written' };
    }
    const { portion } = changing;
    const write = async (): Promise<WriteResult> =>
      envelopes === null ? { status: 'not-written' } : changePortion({ portion, label, text }, envelopes);
    const result = await write().catch((error: unknown): WriteResult => {
      logProblem('Changing a portion', error);
      return { status: 'not-written' };
    });
    await release(portion.id, result.status === 'written' ? (portion.version ?? 1) + 1 : null).catch((error: unknown) => {
      logProblem('Releasing a portion lock', error);
    });
    await refresh().catch((error: unknown) => {
      logProblem('Rereading the document', error);
    });
    const failure = writeFailureOf('change', result);
    setNotice(failure === null ? null : { portionId: portion.id, message: failure });
    return result;
  };

  const cancel = (): void => {
    if (changing !== null) {
      release(changing.portion.id, null).catch((error: unknown) => {
        logProblem('Releasing a portion lock', error);
      });
    }
  };

  return { changing, notice, start, save, cancel };
}
