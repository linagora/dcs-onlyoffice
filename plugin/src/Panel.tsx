import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { type Identity, resolveIdentity } from './identity.ts';
import { onEditorEvent, type PluginInfo } from './onlyoffice.ts';
import { fetchDefaultPolicyLabels, type LabelView } from './policy.ts';
import { PortionForm } from './PortionForm.tsx';
import { PortionList } from './PortionList.tsx';
import { insertPortion, readPortions, type StoredPortion } from './portions.ts';

export interface PanelProps {
  pluginReady: Promise<PluginInfo>;
}

type Loadable<T> = { status: 'loading' } | { status: 'failed'; reason: string } | { status: 'loaded'; value: T };

export function Panel({ pluginReady }: PanelProps): JSX.Element {
  const identity = useLoadable<Identity | null>(async () => resolveIdentity(await pluginReady), [pluginReady]);
  const labels = useLoadable<LabelView[]>(fetchDefaultPolicyLabels, []);
  const [portions, setPortions] = useState<StoredPortion[]>([]);

  const refreshPortions = useCallback(async (): Promise<StoredPortion[]> => {
    const current = await readPortions();
    setPortions(current);
    return current;
  }, []);

  useEffect(() => {
    pluginReady
      .then(async () => {
        onEditorEvent('onDocumentContentReady', () => {
          refreshPortions().catch(() => []);
        });
        return refreshPortions();
      })
      .catch(() => []);
  }, [pluginReady, refreshPortions]);

  const insert = async (label: LabelView, text: string): Promise<boolean> => {
    const inserted = await insertPortion(label, text);
    await refreshPortions();
    return inserted;
  };

  const labelList = labels.status === 'loaded' ? labels.value : [];
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
      <section aria-labelledby="new-portion-title">
        <h2 id="new-portion-title">New protected portion</h2>
        {labels.status === 'loading' && <p class="muted">Loading the policy…</p>}
        {labels.status === 'failed' && <p class="error">The policy could not be loaded ({labels.reason}).</p>}
        {labels.status === 'loaded' && <PortionForm labels={labelList} onInsert={insert} />}
      </section>
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
