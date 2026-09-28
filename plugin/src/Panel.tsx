import type { JSX } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import type { BubbleContent } from './bubble-channel.ts';
import { DocumentLabel } from './DocumentLabel.tsx';
import { type EnvelopeClient, envelopeClientFor, unavailableOpener } from './envelopes.ts';
import {
  useDocumentLabel,
  useDocumentState,
  useInsertionEntryPoints,
  useLoadable,
  usePortionBubble,
  type PortionNotice,
  usePortionChange,
  usePortionLocks,
  usePortionReadings,
} from './hooks.ts';
import { type Identity, resolveIdentity } from './identity.ts';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import { callEditorMethod, type PluginInfo } from './onlyoffice.ts';
import {
  type DocumentLabelRequest,
  fetchAllowedLabels,
  type LockHolder,
  fetchBaseLabelChoices,
  fetchDefaultPolicyLabels,
  fetchLabelOfAdatp4774,
  type LabelView,
} from './policy.ts';
import { documentIdOf, reportBaseLabelChange } from './portal.ts';
import { PortionForm } from './PortionForm.tsx';
import { PortionList, shownLabelOf } from './PortionList.tsx';
import { insertPortion, type StoredPortion, writeDocumentLabel, type WriteResult } from './portions.ts';
import { type PortionReading, PortionReader } from './readings.ts';

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
        : new PortionReader(envelopes.status === 'loaded' ? envelopes.value : unavailableOpener(envelopes.reason), fetchLabelOfAdatp4774),
    [envelopes],
  );
  const { state: documentState, activePortionId, rereadProblem, refresh } = useDocumentState(pluginReady);
  const [insertionRequested, setInsertionRequested] = useState(false);
  const editor = useLoadable<{ documentId: string | null; userId: string | null }>(async () => {
    const info = await pluginReady;
    return { documentId: documentIdOf(info), userId: typeof info.userId === 'string' ? info.userId : null };
  }, [pluginReady]);
  const documentId = editor.status === 'loaded' ? editor.value.documentId : null;
  const userId = editor.status === 'loaded' ? editor.value.userId : null;
  const othersLocks = usePortionLocks(documentId, userId);
  const change = usePortionChange(documentId, envelopes.status === 'loaded' ? envelopes.value : null, refresh);

  const labelList = labels.status === 'loaded' ? labels.value : [];
  const policy = labelList[0]?.policy ?? null;
  // New portions only offer the labels the person's clearance allows: an
  // author never writes what they could not read. Null until the policy is known.
  const allowedLabels = useLoadable<LabelView[] | null>(async () => (policy === null ? null : fetchAllowedLabels(policy)), [policy]);
  const offeredLabels = allowedLabels.status === 'loaded' ? allowedLabels.value : null;
  // Until the author picks one, the base label is the least restrictive.
  const storedBaseLabelCode = documentState?.baseLabelCode ?? null;
  const baseLabelCode = storedBaseLabelCode ?? labelList[0]?.code ?? null;
  // Lowering the base label is reserved to administrators cleared for it.
  // Until the choices for the current label are known, only it is offered.
  const documentLoaded = documentState !== null;
  const baseChoices = useLoadable<{ current: string | null; choices: LabelView[] } | null>(
    async () =>
      policy === null || !documentLoaded ? null : { current: storedBaseLabelCode, choices: await fetchBaseLabelChoices(policy, storedBaseLabelCode) },
    [policy, documentLoaded, storedBaseLabelCode],
  );
  const offeredBaseLabels =
    baseChoices.status === 'loaded' && baseChoices.value !== null && baseChoices.value.current === storedBaseLabelCode
      ? baseChoices.value.choices
      : labelList.filter((label) => label.code === baseLabelCode);
  const portions = documentState?.portions ?? NO_PORTIONS;
  const readings = usePortionReadings(portions, reader);

  const activePortion = portions.find((portion) => portion.id === activePortionId) ?? null;
  usePortionBubble(pluginReady, activePortion === null ? null : bubbleContentOf(activePortion, readings.get(activePortion.id) ?? null, labelList));

  const labelRequest = useMemo(
    (): DocumentLabelRequest | null =>
      policy === null || baseLabelCode === null || documentState === null
        ? null
        : { policy, baseLabelCode, portionLabelCodes: documentState.portions.map((portion) => portion.labelCode) },
    [policy, baseLabelCode, documentState],
  );
  const documentLabel = useDocumentLabel(labelRequest, documentState, !readOnly);

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

  const insert = async (label: LabelView, text: string): Promise<WriteResult> => {
    if (envelopes.status === 'failed') {
      return { status: 'not-encrypted', reason: envelopes.reason };
    }
    if (baseLabelCode === null || envelopes.status === 'loading') {
      return { status: 'not-written' };
    }
    const current = await refresh();
    const result = await insertPortion(
      { label, text, baseLabelCode, existingLabelCodes: current.portions.map((portion) => portion.labelCode) },
      envelopes.value,
    );
    await refresh();
    if (result.status === 'written') {
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
    const documentId = documentIdOf(await pluginReady);
    if (applied && documentId !== null) {
      reportBaseLabelChange(documentId, current.baseLabelCode, code).catch((error: unknown) => {
        logProblem('Reporting a base label change', error);
      });
    }
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
            labels={offeredBaseLabels}
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
                <PortionForm labels={offeredLabels} purpose={{ kind: 'insertion', requested: insertionRequested }} onSubmit={insert} />
              )}
            </section>
          )}
        </>
      )}
      <PortionList
        portions={portions}
        readings={readings}
        labels={labelList}
        activePortionId={activePortionId}
        onSelect={selectPortion}
        notices={portionNotices(othersLocks, change.notice)}
        lockedByOthers={new Set(othersLocks.keys())}
        onChangeRequest={readOnly || change.changing !== null ? null : change.start}
        changeForm={
          change.changing === null
            ? null
            : {
                portionId: change.changing.portion.id,
                form: (
                  <PortionForm
                    labels={[change.changing.label]}
                    purpose={{ kind: 'change', labelCode: change.changing.label.code, text: change.changing.text, onCancel: change.cancel }}
                    onSubmit={change.save}
                  />
                ),
              }
        }
      />
    </main>
  );
}

// What the bubble shows of the portion that holds the cursor: only a text its
// reader has, with the marking and the warning the panel shows next to it.
function bubbleContentOf(portion: StoredPortion, reading: PortionReading | null, labels: LabelView[]): BubbleContent | null {
  const text = reading?.status === 'opened' || reading?.status === 'unencrypted' ? reading.text : null;
  if (reading === null || text === null) {
    return null;
  }
  const shown = shownLabelOf(portion, reading, labels);
  return {
    marking: shown.shown?.marking ?? { text: portion.labelCode, color: null },
    text,
    warning: reading.status === 'unencrypted' ? messages.notEncrypted : shown.warning,
  };
}

// What the panel says next to a portion: who else is changing it, or why the
// last change of it could not start or be saved.
function portionNotices(othersLocks: ReadonlyMap<string, LockHolder>, notice: PortionNotice | null): ReadonlyMap<string, string> {
  const notices = new Map([...othersLocks].map(([portionId, holder]) => [portionId, messages.beingChangedBy(holder.name)]));
  if (notice !== null && !notices.has(notice.portionId)) {
    notices.set(notice.portionId, notice.message);
  }
  return notices;
}
