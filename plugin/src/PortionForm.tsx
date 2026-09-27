import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import type { LabelView } from './policy.ts';
import type { InsertionResult } from './portions.ts';

export interface PortionFormProps {
  labels: LabelView[];
  insertionRequested: boolean;
  onInsert: (label: LabelView, text: string) => Promise<InsertionResult>;
}

// Every change of a portion sends its whole part through co-editing, twice:
// a bounded text keeps it far below the Document Server's message limit.
const TEXT_LIMIT = 20_000;

// Protected text is typed here, never in the document body: text typed in the
// body has already reached the co-editing server in clear.
export function PortionForm({ labels, insertionRequested, onInsert }: PortionFormProps): JSX.Element {
  const [code, setCode] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const selected = labels.find((label) => label.code === code) ?? null;
  // Characters, not UTF-16 code units: an emoji counts once.
  const tooLong = Array.from(text).length > TEXT_LIMIT;
  const textArea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (insertionRequested) {
      textArea.current?.scrollIntoView({ block: 'nearest' });
      textArea.current?.focus();
    }
  }, [insertionRequested]);

  const submit = async (event: Event): Promise<boolean> => {
    event.preventDefault();
    if (selected === null || text.trim() === '' || tooLong) {
      return false;
    }
    setBusy(true);
    setFailure(null);
    const result = await onInsert(selected, text).catch((error: unknown): InsertionResult => {
      logProblem('Inserting a portion', error);
      return { status: 'not-inserted' };
    });
    setBusy(false);
    setFailure(failureOf(result));
    if (result.status === 'inserted') {
      setText('');
    }
    return result.status === 'inserted';
  };

  return (
    <form class="portion-form" onSubmit={submit}>
      {insertionRequested && (
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
      <button type="submit" disabled={busy || selected === null || text.trim() === '' || tooLong}>
        {messages.insertButton}
      </button>
      {failure !== null && (
        <p class="error" data-testid="insertion-failure">
          {failure}
        </p>
      )}
    </form>
  );
}

function failureOf(result: InsertionResult): string | null {
  switch (result.status) {
    case 'inserted':
      return null;
    case 'not-encrypted':
      return messages.encryptionFailed(result.reason);
    case 'not-inserted':
      return messages.insertionFailed;
  }
}
