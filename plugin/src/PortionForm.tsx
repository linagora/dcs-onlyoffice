import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { logProblem } from './log.ts';
import type { LabelView } from './policy.ts';

export interface PortionFormProps {
  labels: LabelView[];
  insertionRequested: boolean;
  onInsert: (label: LabelView, text: string) => Promise<boolean>;
}

// Protected text is typed here, never in the document body: text typed in the
// body has already reached the co-editing server in clear.
export function PortionForm({ labels, insertionRequested, onInsert }: PortionFormProps): JSX.Element {
  const [code, setCode] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const selected = labels.find((label) => label.code === code) ?? null;
  const textArea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (insertionRequested) {
      textArea.current?.scrollIntoView({ block: 'nearest' });
      textArea.current?.focus();
    }
  }, [insertionRequested]);

  const submit = async (event: Event): Promise<boolean> => {
    event.preventDefault();
    if (selected === null || text.trim() === '') {
      return false;
    }
    setBusy(true);
    setFailed(false);
    const inserted = await onInsert(selected, text).catch((error: unknown) => {
      logProblem('Inserting a portion', error);
      return false;
    });
    setBusy(false);
    setFailed(!inserted);
    if (inserted) {
      setText('');
    }
    return inserted;
  };

  return (
    <form class="portion-form" onSubmit={submit}>
      {insertionRequested && (
        <p class="hint" data-testid="insertion-requested">
          Pick a label and type the text: the portion goes after the paragraph that holds the cursor.
        </p>
      )}
      <fieldset>
        <legend>Label</legend>
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
        <span>Portion text</span>
        <textarea
          ref={textArea}
          rows={4}
          value={text}
          onInput={(event) => {
            setText(event.currentTarget.value);
          }}
        />
      </label>
      <button type="submit" disabled={busy || selected === null || text.trim() === ''}>
        Insert protected portion
      </button>
      {failed && <p class="error">The portion could not be inserted.</p>}
    </form>
  );
}
