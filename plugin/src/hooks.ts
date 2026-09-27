import { useCallback, useEffect, useState } from 'preact/hooks';
import { describeError, logProblem } from './log.ts';
import { messages } from './messages.ts';
import { addInsertTabButton, offerContextMenu, onEditorEvent, type PluginInfo } from './onlyoffice.ts';
import { type DocumentLabelRequest, fetchDocumentLabel, type LabelView } from './policy.ts';
import { type DocumentState, parsePortionTag, readDocumentState, type StoredPortion, writeDocumentLabel } from './portions.ts';
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
// that the stored label is stale rewrites it.
export function useDocumentLabel(request: DocumentLabelRequest | null, storedLabelCode: string | null, canWrite: boolean): LabelView | null {
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
      if (canWrite && storedLabelCode !== null && storedLabelCode !== computed.label.code) {
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
  }, [request, storedLabelCode, canWrite]);
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
