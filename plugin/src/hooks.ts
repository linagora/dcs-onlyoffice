import { useCallback, useEffect, useState } from 'preact/hooks';
import { describeError, logProblem } from './log.ts';
import { addInsertTabButton, offerContextMenu, onEditorEvent, type PluginInfo } from './onlyoffice.ts';
import { type DocumentLabelRequest, fetchDocumentLabel, type LabelView } from './policy.ts';
import { type DocumentState, parsePortionTag, readDocumentState, writeDocumentLabel } from './portions.ts';

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
  // Rereads the document at once and returns what it holds.
  refresh: () => Promise<DocumentState>;
}

// The document's portions and labels, kept current: the editor's events cover
// the local author, regular rereading covers co-authors.
export function useDocumentState(pluginReady: Promise<PluginInfo>): DocumentStateView {
  const [state, setState] = useState<DocumentState | null>(null);
  const [activePortionId, setActivePortionId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<DocumentState> => {
    const current = await readDocumentState();
    // Only a real change re-renders, so that polling stays cheap.
    setState((previous) => (previous !== null && sameState(previous, current) ? previous : current));
    return current;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const refreshInBackground = (): void => {
      refresh().catch((error: unknown) => {
        logProblem('Rereading the document', error);
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
    });
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearInterval(timer);
      }
    };
  }, [pluginReady, refresh]);

  return { state, activePortionId, refresh };
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
      const menuOffered = offerContextMenu(() => [{ id: INSERT_ENTRY_ID, text: 'Insert protected portion' }], onRequest);
      const buttonAdded = await addInsertTabButton(
        { id: INSERT_BUTTON_ID, text: 'Protected portion', hint: 'Insert a protected portion', icon: 'resources/icon.svg' },
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
