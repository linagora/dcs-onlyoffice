import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import type { LabelView } from './policy.ts';
import type { WriteResult } from './portions.ts';

// A new portion, which the editor's menus may have asked for, or a change of
// a portion, starting from its label and text.
export type PortionFormPurpose =
  | { kind: 'insertion'; requested: boolean }
  | { kind: 'change'; labelCode: string; text: string; onCancel: () => void };

export interface PortionFormProps {
  labels: LabelView[];
  purpose: PortionFormPurpose;
  onSubmit: (label: LabelView, text: string) => Promise<WriteResult>;
}

// Every change of a portion sends its whole part through co-editing, twice:
// a bounded text keeps it far below the Document Server's message limit.
const TEXT_LIMIT = 20_000;

// Protected text is typed here, never in the document body: text typed in the
// body has already reached the co-editing server in clear.
export function PortionForm({ labels, purpose, onSubmit }: PortionFormProps): JSX.Element {
  const [code, setCode] = useState<string | null>(purpose.kind === 'change' ? purpose.labelCode : null);
  const [text, setText] = useState(purpose.kind === 'change' ? purpose.text : '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const selected = labels.find((label) => label.code === code) ?? null;
  // Characters, not UTF-16 code units: an emoji counts once.
  const tooLong = Array.from(text).length > TEXT_LIMIT;
  const textArea = useRef<HTMLTextAreaElement>(null);
  const focused = purpose.kind === 'change' || purpose.requested;

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
    <form class="portion-form" onSubmit={submit}>
      {purpose.kind === 'insertion' && purpose.requested && (
        <p class="hint" data-testid="insertion-requested">
          {messages.insertionHint}
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
          {messages.textTooLong(TEXT_LIMIT)}
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
  );
}

// What went wrong with an insertion or a change, null when it was written.
export function writeFailureOf(kind: PortionFormPurpose['kind'], result: WriteResult): string | null {
  switch (result.status) {
    case 'written':
      return null;
    case 'not-encrypted':
      return kind === 'change' ? messages.changeEncryptionFailed(result.reason) : messages.encryptionFailed(result.reason);
    case 'not-written':
      return kind === 'change' ? messages.changeFailed : messages.insertionFailed;
  }
}
