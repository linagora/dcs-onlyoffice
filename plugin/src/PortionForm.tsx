import type { JSX, RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { SelectedContent, SelectionReading, SelectionRefusal } from './commands.ts';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import type { LabelView } from './policy.ts';
import { exceedsPortionTextLimit, PORTION_TEXT_LIMIT, textOfSelection, type WriteResult } from './portions.ts';

// A new portion, which the editor's menus may have asked for, typed in the
// form or, where the panel protects selected content, taken from it; or a
// change of a portion, starting from its label and text.
export type PortionFormPurpose =
  | { kind: 'insertion'; requested: boolean; hint: string; protection: ProtectionOffer }
  | { kind: 'change'; labelCode: string; text: string; onCancel: () => void };

export interface PortionFormProps {
  labels: LabelView[];
  // The labels the person may not read, which the form does not offer.
  unreadable: ReadonlySet<string>;
  purpose: PortionFormPurpose;
  onSubmit: (label: LabelView, text: string) => Promise<WriteResult>;
}

// Protected text is typed here, never in the document body: text typed in the
// body has already reached the co-editing server in clear.
export function PortionForm({ labels: allLabels, unreadable, purpose, onSubmit }: PortionFormProps): JSX.Element {
  const [code, setCode] = useState<string | null>(purpose.kind === 'change' ? purpose.labelCode : null);
  const [text, setText] = useState(purpose.kind === 'change' ? purpose.text : '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const labels = allLabels.filter((label) => !unreadable.has(label.code));
  const selected = labels.find((label) => label.code === code) ?? null;
  const tooLong = exceedsPortionTextLimit(text);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const focused = purpose.kind === 'change' || purpose.requested;

  // What was typed at a label the person may no longer read is erased, and
  // the form says why.
  useEffect(() => {
    if (code !== null && unreadable.has(code)) {
      setCode(null);
      if (text !== '') {
        setText('');
        setFailure(messages.typedTextErased);
      }
    }
  }, [code, unreadable, text]);

  useEffect(() => {
    if (focused) {
      textArea.current?.scrollIntoView({ block: 'nearest' });
      textArea.current?.focus();
    }
  }, [focused]);

  const submit = async (event: Event): Promise<boolean> => {
    event.preventDefault();
    if (selected === null || text.trim() === '' || tooLong) {
      return false;
    }
    setBusy(true);
    setFailure(null);
    const result = await onSubmit(selected, text).catch((error: unknown): WriteResult => {
      logProblem(purpose.kind === 'change' ? 'Changing a portion' : 'Inserting a portion', error);
      return { status: 'not-written' };
    });
    setBusy(false);
    setFailure(writeFailureOf(purpose.kind, result));
    if (result.status === 'written' && purpose.kind === 'insertion') {
      setText('');
    }
    return result.status === 'written';
  };

  return (
    <>
      <form class="portion-form" onSubmit={submit}>
        {purpose.kind === 'insertion' && purpose.requested && (
          <p class="hint" data-testid="insertion-requested">
            {purpose.hint}
          </p>
        )}
        <fieldset>
          <legend>{messages.labelLegend}</legend>
          {labels.map((label) => (
            <label key={label.code} class="label-option">
              <input
                type="radio"
                name="label"
                value={label.code}
                checked={code === label.code}
                onChange={() => {
                  setCode(label.code);
                }}
              />
              <span class="label-swatch" style={{ backgroundColor: label.marking.color ?? 'transparent' }} />
              <span data-testid="label-marking">{label.marking.text}</span>
            </label>
          ))}
        </fieldset>
        <label class="field">
          <span>{messages.portionText}</span>
          <textarea
            ref={textArea}
            rows={4}
            value={text}
            onInput={(event) => {
              setText(event.currentTarget.value);
            }}
          />
        </label>
        {tooLong && (
          <p class="error" data-testid="text-too-long">
            {messages.textTooLong(PORTION_TEXT_LIMIT)}
          </p>
        )}
        <div class="form-actions">
          <button type="submit" disabled={busy || selected === null || text.trim() === '' || tooLong}>
            {purpose.kind === 'change' ? messages.saveChangeButton : messages.insertButton}
          </button>
          {purpose.kind === 'change' && (
            <button type="button" disabled={busy} onClick={purpose.onCancel}>
              {messages.cancelButton}
            </button>
          )}
        </div>
        {failure !== null && (
          <p class="error" data-testid={purpose.kind === 'change' ? 'change-failure' : 'insertion-failure'}>
            {failure}
          </p>
        )}
      </form>
      {purpose.kind === 'insertion' && <SelectionProtection label={selected} {...purpose.protection} />}
    </>
  );
}

export interface PortionDeletionFormProps {
  onConfirm: () => Promise<WriteResult>;
  onCancel: () => void;
}

// A deletion waits for its author's confirmation, under the portion's lock.
// The form closes with the lock, whatever the outcome, and the panel says next
// to the portion why a deletion failed; but while the author types in a cell
// of a workbook, the form stays, under the lock, and says why.
export function PortionDeletionForm({ onConfirm, onCancel }: PortionDeletionFormProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const form = useShownForm(true);

  const confirm = async (event: Event): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    const result = await onConfirm().catch((error: unknown): WriteResult => {
      logProblem('Deleting a portion', error);
      return { status: 'not-written' };
    });
    if (result.status === 'cell-being-edited') {
      setBusy(false);
      setFailure(writeFailureOf('deletion', result));
    }
  };

  return (
    <form ref={form} class="portion-form" data-testid="deletion-confirmation" onSubmit={confirm}>
      <p>{messages.deletionQuestion}</p>
      <div class="form-actions">
        <button type="submit" disabled={busy}>
          {messages.confirmDeletionButton}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          {messages.cancelButton}
        </button>
      </div>
      {failure !== null && (
        <p class="error" data-testid="deletion-failure">
          {failure}
        </p>
      )}
    </form>
  );
}

// What the panel offers to protect selected content: how it reads the
// selection and protects it, and how many times the editor's context menu
// asked for it.
export interface ProtectionOffer {
  requests: number;
  onRead: () => Promise<SelectionReading | null>;
  onProtect: (label: LabelView, content: SelectedContent) => Promise<WriteResult>;
}

interface SelectionProtectionProps extends ProtectionOffer {
  // The label picked in the form above, null until the author picks one.
  label: LabelView | null;
}

// Content already in the document becomes a portion once its author has seen
// it, with the warning that it went through ONLYOFFICE in clear, and
// confirmed. The panel reads the selection when the author asks, in the panel
// or in the editor's context menu, and protects what it read under the label
// picked above, where the document must still hold it.
function SelectionProtection({ label, requests, onRead, onProtect }: SelectionProtectionProps): JSX.Element {
  const [content, setContent] = useState<SelectedContent | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Requests made before the form showed are not the author's latest wish.
  const handledRequests = useRef(requests);
  const confirmation = useShownForm(content);

  // The selection's content shows for confirmation, or why the panel refuses
  // it; a selection that cannot be read shows as unreadable.
  const read = (): void => {
    setBusy(true);
    setFailure(null);
    setContent(null);
    const show = async (): Promise<void> => {
      const reading = await onRead();
      setBusy(false);
      if (reading === null) {
        setFailure(messages.selectionUnreadable);
      } else if (reading.status === 'refused') {
        setFailure(refusalOf(reading.reason));
      } else {
        setContent(reading.content);
      }
    };
    show().catch((error: unknown) => {
      logProblem('Reading the selection', error);
      setBusy(false);
      setFailure(messages.selectionUnreadable);
    });
  };

  useEffect(() => {
    if (requests > handledRequests.current) {
      handledRequests.current = requests;
      read();
    }
  }, [requests]);

  const confirm = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (content === null || label === null) {
      return;
    }
    setBusy(true);
    setFailure(null);
    const result = await onProtect(label, content).catch((error: unknown): WriteResult => {
      logProblem('Protecting the selection', error);
      return { status: 'not-written' };
    });
    setBusy(false);
    setFailure(writeFailureOf('protection', result));
    // The content the author confirmed became the portion, or is no longer
    // what they confirmed.
    if (result.status === 'written' || result.status === 'selection-changed') {
      setContent(null);
    }
  };

  return (
    <div class="selection-protection">
      <div class="form-actions">
        <button type="button" disabled={busy || content !== null} onClick={read}>
          {messages.protectSelectionButton}
        </button>
      </div>
      {content !== null && (
        <form ref={confirmation} class="portion-form" data-testid="protection-confirmation" onSubmit={confirm}>
          <p>{messages.protectionQuestion}</p>
          <p class="warning" data-testid="protection-warning">
            {messages.protectionWarning}
          </p>
          <pre class="protection-preview" data-testid="protection-preview">
            {textOfSelection(content)}
          </pre>
          {label === null && <p class="hint">{messages.protectionLabelMissing}</p>}
          <div class="form-actions">
            <button type="submit" disabled={busy || label === null}>
              {messages.protectSelectionButton}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setContent(null);
                setFailure(null);
              }}
            >
              {messages.cancelButton}
            </button>
          </div>
        </form>
      )}
      {failure !== null && (
        <p class="error" data-testid="protection-failure">
          {failure}
        </p>
      )}
    </div>
  );
}

function refusalOf(reason: SelectionRefusal): string {
  switch (reason) {
    case 'cell-being-edited':
      return messages.cellBeingEdited;
    case 'several-areas':
      return messages.selectionHasSeveralAreas;
    case 'too-large':
      return messages.selectionTooLarge(PORTION_TEXT_LIMIT);
    case 'merge-portion-or-table':
      return messages.selectionHoldsMergePortionOrTable;
    case 'commented-cells':
      return messages.cellsHoldComment;
    case 'formula':
      return messages.selectionHoldsFormula;
    case 'empty-cells':
      return messages.cellsEmpty;
    case 'outside-body':
      return messages.selectionOutsideBody;
    case 'table':
      return messages.selectionHoldsTable;
    case 'drawing':
      return messages.selectionHoldsDrawing;
    case 'content-control':
      return messages.selectionHoldsContentControl;
    case 'commented-paragraphs':
      return messages.paragraphsHoldComment;
    case 'noted-paragraphs':
      return messages.paragraphsHoldNote;
    case 'empty-paragraphs':
      return messages.paragraphsEmpty;
  }
}

// A confirmation shows below the forms and the list, often beyond the panel's
// bottom: it scrolls into view whenever what it confirms changes.
function useShownForm(confirmed: unknown): RefObject<HTMLFormElement> {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.scrollIntoView({ block: 'nearest' });
  }, [confirmed]);
  return form;
}

// What went wrong with an insertion, a protection of selected content, a
// change or a deletion, null when it was written. A deletion encrypts nothing.
export function writeFailureOf(kind: WriteKind, result: WriteResult): string | null {
  switch (result.status) {
    case 'written':
      return null;
    case 'not-encrypted':
      return WRITE_FAILURES[kind].notEncrypted(result.reason);
    case 'changed-meanwhile':
      return messages.portionChangedMeanwhile;
    case 'cells-occupied':
      return messages.cellsOccupied;
    case 'selection-changed':
      return messages.selectionChanged;
    case 'cell-being-edited':
      return messages.cellBeingEdited;
    case 'not-written':
      return WRITE_FAILURES[kind].notWritten;
  }
}

type WriteKind = 'insertion' | 'protection' | 'change' | 'deletion';

const WRITE_FAILURES: Record<WriteKind, { notEncrypted: (reason: string) => string; notWritten: string }> = {
  insertion: { notEncrypted: messages.encryptionFailed, notWritten: messages.insertionFailed },
  protection: { notEncrypted: messages.protectionEncryptionFailed, notWritten: messages.protectionFailed },
  change: { notEncrypted: messages.changeEncryptionFailed, notWritten: messages.changeFailed },
  deletion: { notEncrypted: messages.changeEncryptionFailed, notWritten: messages.deletionFailed },
};
