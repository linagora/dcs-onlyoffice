import type { JSX } from 'preact';
import { useCallback, useMemo, useState } from 'preact/hooks';
import type { BubbleContent } from './bubble-channel.ts';
import type { SelectedContent, WriteOutcome } from './commands.ts';
import { DocumentLabel } from './DocumentLabel.tsx';
import { type EnvelopeClient, envelopeClientFor, unavailableOpener } from './envelopes.ts';
import {
  type EntryPointRequest,
  useDocumentLabel,
  useDocumentState,
  useMenuEntryPoints,
  useScreenMarking,
  useLoadable,
  usePortionBubble,
  type PortionNotice,
  usePortionEdit,
  usePortionLocks,
  usePortionReadings,
} from './hooks.ts';
import { type Identity, resolveIdentity } from './identity.ts';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import { type EditorType, editorTypeOf, type PluginInfo } from './onlyoffice.ts';
import {
  type DocumentLabelRequest,
  fetchAllowedLabels,
  type LockHolder,
  fetchBaseLabelChoices,
  fetchDefaultPolicyLabels,
  fetchLabelOfAdatp4774,
  type LabelView,
} from './policy.ts';
import { documentIdOf, reportBaseLabelChange, reportExistingContentProtection } from './portal.ts';
import { PortionDeletionForm, PortionForm, type ProtectionOffer } from './PortionForm.tsx';
import { PortionList, shownLabelOf } from './PortionList.tsx';
import {
  EDITORS,
  insertPortion,
  type OtherLabels,
  protectSelection,
  readSelection,
  type StoredPortion,
  writeDocumentLabel,
  type WriteResult,
} from './portions.ts';
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
  const { state: documentState, activePortionId, selectionChanges, rereadProblem, refresh } = useDocumentState(pluginReady);
  const [insertionRequested, setInsertionRequested] = useState(false);
  // How many times the editor's context menu asked to protect the selection.
  const [protectionRequests, setProtectionRequests] = useState(0);
  const editorInfo = useLoadable<{ type: EditorType; documentId: string | null; userId: string | null }>(async () => {
    const info = await pluginReady;
    return { type: editorTypeOf(info), documentId: documentIdOf(info), userId: typeof info.userId === 'string' ? info.userId : null };
  }, [pluginReady]);
  const editorType = editorInfo.status === 'loaded' ? editorInfo.value.type : null;
  const documentId = editorInfo.status === 'loaded' ? editorInfo.value.documentId : null;
  const userId = editorInfo.status === 'loaded' ? editorInfo.value.userId : null;
  const editor = editorType === null ? null : EDITORS[editorType];
  // The hint the insertion form gives, null when the panel offers none.
  const insertionHint = !readOnly && editor !== null && editor.insertsPortions ? editor.insertionHint : null;
  const offersPortions = insertionHint !== null;

  const labelList = labels.status === 'loaded' ? labels.value : [];
  const policy = labelList[0]?.policy ?? null;
  // New portions only offer the labels the person's clearance allows: an
  // author never writes what they could not read. Null until the policy is known.
  const allowedLabels = useLoadable<LabelView[] | null>(async () => (policy === null ? null : fetchAllowedLabels(policy)), [policy]);
  const offeredLabels = allowedLabels.status === 'loaded' ? allowedLabels.value : null;
  // Until the author picks one, the base label is the least restrictive.
  const storedBaseLabelCode = documentState?.baseLabelCode ?? null;
  const baseLabelCode = storedBaseLabelCode ?? labelList[0]?.code ?? null;
  const portions = documentState?.portions ?? NO_PORTIONS;
  // Who else is changing the portions, and which labels the person may no
  // longer read, among those of the policy, which the forms offer, those of
  // the portions and those bound to what the panel read: a revocation applies
  // at once.
  const { othersLocks, unreadable } = usePortionLocks(documentId, userId, [
    ...labelList.map((label) => label.code),
    ...portions.map((portion) => portion.labelCode),
    ...(reader?.boundLabelCodes() ?? []),
  ]);
  const edit = usePortionEdit(documentId, envelopes.status === 'loaded' ? envelopes.value : null, refresh, baseLabelCode, editorType, unreadable);
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
  const readings = usePortionReadings(portions, reader, unreadable);

  const activePortion = portions.find((portion) => portion.id === activePortionId) ?? null;
  usePortionBubble(pluginReady, activePortion === null ? null : bubbleContentOf(activePortion, readings.get(activePortion.id) ?? null, labelList), selectionChanges);

  const labelRequest = useMemo(
    (): DocumentLabelRequest | null =>
      policy === null || baseLabelCode === null || documentState === null
        ? null
        : { policy, baseLabelCode, portionLabelCodes: documentState.portions.map((portion) => portion.labelCode) },
    [policy, baseLabelCode, documentState],
  );
  const documentLabel = useDocumentLabel(labelRequest, documentState, !readOnly, editorType);
  useScreenMarking(documentLabel, editorType);

  const requestFromMenu = useCallback((request: EntryPointRequest): void => {
    if (request === 'insertion') {
      setInsertionRequested(true);
    } else {
      setProtectionRequests((count) => count + 1);
    }
  }, []);
  // The editor's menus only offer what the panel can carry out.
  useMenuEntryPoints(pluginReady, offersPortions && offeredLabels !== null && offeredLabels.length > 0, requestFromMenu);

  const selectPortion = (portion: StoredPortion): void => {
    editor?.selectPlaceholder(portion).catch((error: unknown) => {
      logProblem('Selecting a portion', error);
    });
  };

  // A new portion is sealed with the envelopes and computed with the
  // document's other labels, read afresh; the panel reads the document again
  // once it is written.
  const writeNewPortion = async (
    write: (others: OtherLabels, client: EnvelopeClient, editorType: EditorType) => Promise<WriteResult>,
  ): Promise<WriteResult> => {
    if (envelopes.status === 'failed') {
      return { status: 'not-encrypted', reason: envelopes.reason };
    }
    if (baseLabelCode === null || envelopes.status === 'loading') {
      return { status: 'not-written' };
    }
    const current = await refresh();
    const others = { baseLabelCode, portionLabelCodes: current.portions.map((portion) => portion.labelCode) };
    const result = await write(others, envelopes.value, editorTypeOf(await pluginReady));
    await refresh();
    return result;
  };

  const insert = async (label: LabelView, text: string): Promise<WriteResult> => {
    const result = await writeNewPortion(async (others, client, editorType) => insertPortion({ label, text }, others, client, editorType));
    if (result.status === 'written') {
      setInsertionRequested(false);
    }
    return result;
  };

  const protect = async (label: LabelView, content: SelectedContent): Promise<WriteResult> =>
    writeNewPortion(async (others, client, editorType) => {
      const written = await protectSelection({ label, content }, others, client, editorType);
      if (written.result.status === 'written' && documentId !== null) {
        reportExistingContentProtection(documentId, written.portionId, written.state).catch((error: unknown) => {
          logProblem('Reporting a protection of existing content', error);
        });
      }
      return written.result;
    });
  const protectionOffer: ProtectionOffer = {
    requests: protectionRequests,
    onRead: async () => readSelection(editorTypeOf(await pluginReady)),
    onProtect: protect,
  };

  const changeBaseLabel = async (code: string): Promise<WriteOutcome> => {
    if (policy === null) {
      return 'not-written';
    }
    const current = await refresh();
    const outcome = await writeDocumentLabel(
      { policy, baseLabelCode: code, portionLabelCodes: current.portions.map((portion) => portion.labelCode) },
      editorTypeOf(await pluginReady),
    );
    await refresh();
    const documentId = documentIdOf(await pluginReady);
    if (outcome === 'written' && documentId !== null) {
      reportBaseLabelChange(documentId, current.baseLabelCode, code).catch((error: unknown) => {
        logProblem('Reporting a base label change', error);
      });
    }
    return outcome;
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
          {insertionHint !== null && (
            <section aria-labelledby="new-portion-title">
              <h2 id="new-portion-title">{messages.newPortionTitle}</h2>
              {allowedLabels.status === 'failed' && <p class="error">{messages.allowedLabelsFailed(allowedLabels.reason)}</p>}
              {offeredLabels !== null && offeredLabels.length === 0 && (
                <p class="muted" data-testid="no-allowed-label">
                  {messages.noAllowedLabel}
                </p>
              )}
              {offeredLabels !== null && offeredLabels.length > 0 && (
                <PortionForm
                  labels={offeredLabels}
                  unreadable={unreadable}
                  purpose={{ kind: 'insertion', requested: insertionRequested, hint: insertionHint, protection: protectionOffer }}
                  onSubmit={insert}
                />
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
        notices={portionNotices(othersLocks, edit.notice)}
        lockedByOthers={new Set(othersLocks.keys())}
        onEditRequest={readOnly || edit.underWay !== null || editor === null || !editor.editsPortions ? null : edit.start}
        editForm={
          edit.underWay === null
            ? null
            : {
                portionId: edit.underWay.portion.id,
                form:
                  edit.underWay.kind === 'change' ? (
                    <PortionForm
                      labels={edit.underWay.choices}
                      unreadable={unreadable}
                      purpose={{ kind: 'change', labelCode: edit.underWay.label.code, text: edit.underWay.text, onCancel: edit.cancel }}
                      onSubmit={edit.save}
                    />
                  ) : (
                    <PortionDeletionForm onConfirm={edit.confirmDeletion} onCancel={edit.cancel} />
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
// last change or deletion of it could not start or be written.
function portionNotices(othersLocks: ReadonlyMap<string, LockHolder>, notice: PortionNotice | null): ReadonlyMap<string, string> {
  const notices = new Map([...othersLocks].map(([portionId, holder]) => [portionId, messages.beingChangedBy(holder.name)]));
  if (notice !== null && !notices.has(notice.portionId)) {
    notices.set(notice.portionId, notice.message);
  }
  return notices;
}
