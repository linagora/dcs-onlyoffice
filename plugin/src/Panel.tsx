import type { JSX } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import { DocumentLabel } from './DocumentLabel.tsx';
import { useDocumentLabel, useDocumentState, useInsertionEntryPoints, useLoadable } from './hooks.ts';
import { type Identity, resolveIdentity } from './identity.ts';
import { logProblem } from './log.ts';
import { callEditorMethod, type PluginInfo } from './onlyoffice.ts';
import { type DocumentLabelRequest, fetchDefaultPolicyLabels, type LabelView } from './policy.ts';
import { PortionForm } from './PortionForm.tsx';
import { PortionList } from './PortionList.tsx';
import { insertPortion, type StoredPortion, writeDocumentLabel } from './portions.ts';

export interface PanelProps {
  pluginReady: Promise<PluginInfo>;
}

export function Panel({ pluginReady }: PanelProps): JSX.Element {
  const identity = useLoadable<Identity | null>(async () => resolveIdentity(await pluginReady), [pluginReady]);
  const viewMode = useLoadable<boolean>(async () => (await pluginReady).isViewMode === true, [pluginReady]);
  // Until the editor says otherwise, nothing that writes is offered.
  const readOnly = viewMode.status !== 'loaded' || viewMode.value;
  const labels = useLoadable<LabelView[]>(fetchDefaultPolicyLabels, []);
  const { state: documentState, activePortionId, rereadProblem, refresh } = useDocumentState(pluginReady);
  const [insertionRequested, setInsertionRequested] = useState(false);

  const labelList = labels.status === 'loaded' ? labels.value : [];
  const policy = labelList[0]?.policy ?? null;
  // Until the author picks one, the base label is the least restrictive.
  const baseLabelCode = documentState?.baseLabelCode ?? labelList[0]?.code ?? null;
  const portions = documentState?.portions ?? [];

  const labelRequest = useMemo(
    (): DocumentLabelRequest | null =>
      policy === null || baseLabelCode === null || documentState === null
        ? null
        : { policy, baseLabelCode, portionLabelCodes: documentState.portions.map((portion) => portion.labelCode) },
    [policy, baseLabelCode, documentState],
  );
  const documentLabel = useDocumentLabel(labelRequest, documentState?.documentLabelCode ?? null, !readOnly);

  const requestInsertion = useCallback((): void => {
    setInsertionRequested(true);
  }, []);
  useInsertionEntryPoints(pluginReady, !readOnly, requestInsertion);

  const selectPortion = (portion: StoredPortion): void => {
    callEditorMethod('SelectContentControl', [portion.internalId]).catch((error: unknown) => {
      logProblem('Selecting a portion', error);
    });
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
    const applied = await writeDocumentLabel({
      policy,
      baseLabelCode: code,
      portionLabelCodes: current.portions.map((portion) => portion.labelCode),
    });
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
      {rereadProblem !== null && (
        <p class="warning" role="status" data-testid="reread-warning">
          The document could not be reread, so this panel may be out of date ({rereadProblem}).
        </p>
      )}
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
