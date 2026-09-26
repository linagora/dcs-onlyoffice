import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { DocumentLabel } from './DocumentLabel.tsx';
import { type Identity, resolveIdentity } from './identity.ts';
import { addInsertTabButton, callEditorMethod, offerContextMenu, onEditorEvent, type PluginInfo } from './onlyoffice.ts';
import { fetchDefaultPolicyLabels, fetchDocumentLabel, type LabelView } from './policy.ts';
import { PortionForm } from './PortionForm.tsx';
import { PortionList } from './PortionList.tsx';
import { type DocumentState, insertPortion, parsePortionTag, readDocumentState, type StoredPortion, writeDocumentLabel } from './portions.ts';

export interface PanelProps {
  pluginReady: Promise<PluginInfo>;
}

type Loadable<T> = { status: 'loading' } | { status: 'failed'; reason: string } | { status: 'loaded'; value: T };

const REFRESH_INTERVAL_MS = 3_000;
const INSERT_ENTRY_ID = 'dcs-insert-portion';
const INSERT_BUTTON_ID = 'dcs-insert-portion-button';

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

export function Panel({ pluginReady }: PanelProps): JSX.Element {
  const identity = useLoadable<Identity | null>(async () => resolveIdentity(await pluginReady), [pluginReady]);
  const viewMode = useLoadable<boolean>(async () => (await pluginReady).isViewMode === true, [pluginReady]);
  // Until the editor says otherwise, nothing that writes is offered.
  const readOnly = viewMode.status !== 'loaded' || viewMode.value;
  const labels = useLoadable<LabelView[]>(fetchDefaultPolicyLabels, []);
  const [documentState, setDocumentState] = useState<DocumentState | null>(null);
  const [documentLabel, setDocumentLabel] = useState<LabelView | null>(null);
  const [activePortionId, setActivePortionId] = useState<string | null>(null);
  const [insertionRequested, setInsertionRequested] = useState(false);

  const labelList = labels.status === 'loaded' ? labels.value : [];
  const policy = labelList[0]?.policy ?? null;
  // Until the author picks one, the base label is the least restrictive.
  const baseLabelCode = documentState?.baseLabelCode ?? labelList[0]?.code ?? null;
  const portions = documentState?.portions ?? [];

  const refresh = useCallback(async (): Promise<DocumentState> => {
    const state = await readDocumentState();
    // Only a real change re-renders, so that polling stays cheap.
    setDocumentState((previous) => (previous !== null && sameState(previous, state) ? previous : state));
    return state;
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    pluginReady
      .then(async () => {
        const refreshQuietly = (): void => {
          refresh().catch(() => null);
        };
        onEditorEvent('onDocumentContentReady', refreshQuietly);
        onEditorEvent('onChangeContentControl', refreshQuietly);
        onEditorEvent('onFocusContentControl', (control) => {
          setActivePortionId(portionIdOf(control));
        });
        onEditorEvent('onBlurContentControl', () => {
          setActivePortionId(null);
        });
        // Co-authors' changes to Custom XML parts raise no plugin event, so the
        // panel also rereads the document regularly.
        timer = setInterval(refreshQuietly, REFRESH_INTERVAL_MS);
        return refresh();
      })
      .catch(() => null);
    return () => {
      if (timer !== null) {
        clearInterval(timer);
      }
    };
  }, [pluginReady, refresh]);

  useEffect(() => {
    if (policy === null || baseLabelCode === null || documentState === null) {
      return;
    }
    let cancelled = false;
    fetchDocumentLabel(
      policy,
      baseLabelCode,
      documentState.portions.map((portion) => portion.labelCode),
    )
      .then(async (result) => {
        if (cancelled) {
          return null;
        }
        setDocumentLabel(result.label);
        // Two authors inserting at the same moment each write a document label
        // that misses the other's portion, and the last writer wins. Whoever
        // notices the stale label rewrites it from the document's content.
        const stale =
          !readOnly && documentState.documentLabelCode !== null && documentState.documentLabelCode !== result.label.code;
        return stale ? writeDocumentLabel(policy, baseLabelCode, documentState.portions.map((portion) => portion.labelCode)) : null;
      })
      .catch(() => {
        if (!cancelled) {
          setDocumentLabel(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [policy, baseLabelCode, documentState, readOnly]);

  // Entry points in the editor's own menus lead to the panel's form.
  useEffect(() => {
    if (readOnly) {
      return;
    }
    const request = (): void => {
      setInsertionRequested(true);
    };
    pluginReady
      .then(async () => {
        offerContextMenu(() => [{ id: INSERT_ENTRY_ID, text: 'Insert protected portion' }], request);
        return addInsertTabButton(
          { id: INSERT_BUTTON_ID, text: 'Protected portion', hint: 'Insert a protected portion', icon: 'resources/icon.svg' },
          request,
        );
      })
      .catch(() => false);
  }, [pluginReady, readOnly]);

  const selectPortion = (portion: StoredPortion): void => {
    callEditorMethod('SelectContentControl', [portion.internalId]).catch(() => null);
  };

  const insert = async (label: LabelView, text: string): Promise<boolean> => {
    if (baseLabelCode === null) {
      return false;
    }
    const current = await refresh();
    const inserted = await insertPortion({
      label,
      text,
      baseLabelCode,
      existingLabelCodes: current.portions.map((portion) => portion.labelCode),
    });
    await refresh();
    if (inserted) {
      setInsertionRequested(false);
    }
    return inserted;
  };

  const changeBaseLabel = async (code: string): Promise<boolean> => {
    if (policy === null) {
      return false;
    }
    const current = await refresh();
    const applied = await writeDocumentLabel(
      policy,
      code,
      current.portions.map((portion) => portion.labelCode),
    );
    await refresh();
    return applied;
  };

  return (
    <main class="panel">
      <section class="identity" data-testid="identity" data-source={identity.status === 'loaded' ? identity.value?.source : undefined}>
        {identity.status === 'loading' && <p class="muted">Connecting…</p>}
        {(identity.status === 'failed' || (identity.status === 'loaded' && identity.value === null)) && (
          <p class="muted">Signed-in user unknown</p>
        )}
        {identity.status === 'loaded' && identity.value !== null && (
          <>
            <span class="identity-name" data-testid="identity-name">
              {identity.value.name}
            </span>
            <span class="identity-account" data-testid="identity-account">
              {identity.value.account}
            </span>
          </>
        )}
      </section>
      {labels.status === 'loading' && <p class="muted">Loading the policy…</p>}
      {labels.status === 'failed' && <p class="error">The policy could not be loaded ({labels.reason}).</p>}
      {labels.status === 'loaded' && (
        <>
          <DocumentLabel
            labels={labelList}
            baseLabelCode={baseLabelCode}
            documentLabel={documentLabel}
            readOnly={readOnly}
            onBaseLabelChange={changeBaseLabel}
          />
          {!readOnly && (
            <section aria-labelledby="new-portion-title">
              <h2 id="new-portion-title">New protected portion</h2>
              <PortionForm labels={labelList} insertionRequested={insertionRequested} onInsert={insert} />
            </section>
          )}
        </>
      )}
      <PortionList portions={portions} labels={labelList} activePortionId={activePortionId} onSelect={selectPortion} />
    </main>
  );
}

function useLoadable<T>(load: () => Promise<T>, dependencies: readonly unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    load()
      .then((value) => {
        if (!cancelled) {
          setState({ status: 'loaded', value });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'failed', reason: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
    // The caller lists what `load` depends on.
  }, dependencies);
  return state;
}
