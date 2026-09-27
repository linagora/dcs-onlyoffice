import type { JSX } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import { DocumentLabel } from './DocumentLabel.tsx';
import { type EnvelopeClient, envelopeClientFor, unavailableOpener } from './envelopes.ts';
import { useDocumentLabel, useDocumentState, useInsertionEntryPoints, useLoadable, usePortionReadings } from './hooks.ts';
import { type Identity, resolveIdentity } from './identity.ts';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import { callEditorMethod, type PluginInfo } from './onlyoffice.ts';
import { type DocumentLabelRequest, fetchAllowedLabels, fetchDefaultPolicyLabels, type LabelView } from './policy.ts';
import { PortionForm } from './PortionForm.tsx';
import { PortionList } from './PortionList.tsx';
import { type InsertionResult, insertPortion, type StoredPortion, writeDocumentLabel } from './portions.ts';
import { PortionReader } from './readings.ts';

// One empty list, so that the portions' readings do not restart on every render.
const NO_PORTIONS: StoredPortion[] = [];

export interface PanelProps {
  pluginReady: Promise<PluginInfo>;
}

export function Panel({ pluginReady }: PanelProps): JSX.Element {
  const identity = useLoadable<Identity | null>(async () => resolveIdentity(await pluginReady), [pluginReady]);
  const viewMode = useLoadable<boolean>(async () => (await pluginReady).isViewMode === true, [pluginReady]);
  // Until the editor says otherwise, nothing that writes is offered.
  const readOnly = viewMode.status !== 'loaded' || viewMode.value;
  const labels = useLoadable<LabelView[]>(fetchDefaultPolicyLabels, []);
  const envelopes = useLoadable<EnvelopeClient>(async () => envelopeClientFor(await pluginReady), [pluginReady]);
  const reader = useMemo(
    () =>
      envelopes.status === 'loading'
        ? null
        : new PortionReader(envelopes.status === 'loaded' ? envelopes.value : unavailableOpener(envelopes.reason)),
    [envelopes],
  );
  const { state: documentState, activePortionId, rereadProblem, refresh } = useDocumentState(pluginReady);
  const [insertionRequested, setInsertionRequested] = useState(false);

  const labelList = labels.status === 'loaded' ? labels.value : [];
  const policy = labelList[0]?.policy ?? null;
  // New portions only offer the labels the person's clearance allows: an
  // author never writes what they could not read. Null until the policy is known.
  const allowedLabels = useLoadable<LabelView[] | null>(async () => (policy === null ? null : fetchAllowedLabels(policy)), [policy]);
  const offeredLabels = allowedLabels.status === 'loaded' ? allowedLabels.value : null;
  // Until the author picks one, the base label is the least restrictive.
  const baseLabelCode = documentState?.baseLabelCode ?? labelList[0]?.code ?? null;
  const portions = documentState?.portions ?? NO_PORTIONS;
  const readings = usePortionReadings(portions, reader);

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
  // The editor's menus only offer an insertion the panel can carry out.
  useInsertionEntryPoints(pluginReady, !readOnly && offeredLabels !== null && offeredLabels.length > 0, requestInsertion);

  const selectPortion = (portion: StoredPortion): void => {
    callEditorMethod('SelectContentControl', [portion.internalId]).catch((error: unknown) => {
      logProblem('Selecting a portion', error);
    });
  };

  const insert = async (label: LabelView, text: string): Promise<InsertionResult> => {
    if (envelopes.status === 'failed') {
      return { status: 'not-encrypted', reason: envelopes.reason };
    }
    if (baseLabelCode === null || envelopes.status === 'loading') {
      return { status: 'not-inserted' };
    }
    const current = await refresh();
    const result = await insertPortion(
      { label, text, baseLabelCode, existingLabelCodes: current.portions.map((portion) => portion.labelCode) },
      envelopes.value,
    );
    await refresh();
    if (result.status === 'inserted') {
      setInsertionRequested(false);
    }
    return result;
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
        {identity.status === 'loading' && <p class="muted">{messages.connecting}</p>}
        {(identity.status === 'failed' || (identity.status === 'loaded' && identity.value === null)) && (
          <p class="muted">{messages.unknownUser}</p>
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
          {messages.rereadWarning(rereadProblem)}
        </p>
      )}
      {labels.status === 'loading' && <p class="muted">{messages.loadingPolicy}</p>}
      {labels.status === 'failed' && <p class="error">{messages.policyFailed(labels.reason)}</p>}
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
              <h2 id="new-portion-title">{messages.newPortionTitle}</h2>
              {allowedLabels.status === 'failed' && <p class="error">{messages.allowedLabelsFailed(allowedLabels.reason)}</p>}
              {offeredLabels !== null && offeredLabels.length === 0 && (
                <p class="muted" data-testid="no-allowed-label">
                  {messages.noAllowedLabel}
                </p>
              )}
              {offeredLabels !== null && offeredLabels.length > 0 && (
                <PortionForm labels={offeredLabels} insertionRequested={insertionRequested} onInsert={insert} />
              )}
            </section>
          )}
        </>
      )}
      <PortionList portions={portions} readings={readings} labels={labelList} activePortionId={activePortionId} onSelect={selectPortion} />
    </main>
  );
}
