import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { DocumentLabel } from './DocumentLabel.tsx';
import { type Identity, resolveIdentity } from './identity.ts';
import { onEditorEvent, type PluginInfo } from './onlyoffice.ts';
import { fetchDefaultPolicyLabels, fetchDocumentLabel, type LabelView } from './policy.ts';
import { PortionForm } from './PortionForm.tsx';
import { PortionList } from './PortionList.tsx';
import { applyBaseLabel, type DocumentState, insertPortion, readDocumentState } from './portions.ts';

export interface PanelProps {
  pluginReady: Promise<PluginInfo>;
}

type Loadable<T> = { status: 'loading' } | { status: 'failed'; reason: string } | { status: 'loaded'; value: T };

export function Panel({ pluginReady }: PanelProps): JSX.Element {
  const identity = useLoadable<Identity | null>(async () => resolveIdentity(await pluginReady), [pluginReady]);
  const labels = useLoadable<LabelView[]>(fetchDefaultPolicyLabels, []);
  const [documentState, setDocumentState] = useState<DocumentState | null>(null);
  const [documentLabel, setDocumentLabel] = useState<LabelView | null>(null);

  const labelList = labels.status === 'loaded' ? labels.value : [];
  const policy = labelList[0]?.policy ?? null;
  // Until the author picks one, the base label is the least restrictive.
  const baseLabelCode = documentState?.baseLabelCode ?? labelList[0]?.code ?? null;
  const portions = documentState?.portions ?? [];

  const refresh = useCallback(async (): Promise<DocumentState> => {
    const state = await readDocumentState();
    setDocumentState(state);
    return state;
  }, []);

  useEffect(() => {
    pluginReady
      .then(async () => {
        onEditorEvent('onDocumentContentReady', () => {
          refresh().catch(() => null);
        });
        return refresh();
      })
      .catch(() => null);
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
      .then((result) => {
        if (!cancelled) {
          setDocumentLabel(result.label);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDocumentLabel(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [policy, baseLabelCode, documentState]);

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
    return inserted;
  };

  const changeBaseLabel = async (code: string): Promise<boolean> => {
    if (policy === null) {
      return false;
    }
    const current = await refresh();
    const applied = await applyBaseLabel(
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
            onBaseLabelChange={changeBaseLabel}
          />
          <section aria-labelledby="new-portion-title">
            <h2 id="new-portion-title">New protected portion</h2>
            <PortionForm labels={labelList} onInsert={insert} />
          </section>
        </>
      )}
      <PortionList portions={portions} labels={labelList} />
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
