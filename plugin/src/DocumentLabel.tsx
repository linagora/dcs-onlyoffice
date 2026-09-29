import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { WriteOutcome } from './commands.ts';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import type { LabelView } from './policy.ts';

export interface DocumentLabelProps {
  labels: LabelView[];
  baseLabelCode: string | null;
  documentLabel: LabelView | null;
  readOnly: boolean;
  onBaseLabelChange: (code: string) => Promise<WriteOutcome>;
}

// The base label covers the document's unprotected content; the document
// label follows from it and from the portions' labels. A base label that is
// not written leaves the list on the current one.
export function DocumentLabel({ labels, baseLabelCode, documentLabel, readOnly, onBaseLabelChange }: DocumentLabelProps): JSX.Element {
  const [failure, setFailure] = useState<string | null>(null);

  const change = async (list: HTMLSelectElement): Promise<void> => {
    setFailure(null);
    const outcome = await onBaseLabelChange(list.value);
    if (outcome !== 'written') {
      list.value = baseLabelCode ?? '';
      setFailure(outcome === 'cell-being-edited' ? messages.cellBeingEdited : null);
    }
  };

  return (
    <section class="document-label" aria-labelledby="document-label-title">
      <h2 id="document-label-title">{messages.documentLabelTitle}</h2>
      {!readOnly && (
      <label class="field">
        <span>{messages.baseLabel}</span>
        <select
          value={baseLabelCode ?? ''}
          onChange={(event) => {
            change(event.currentTarget).catch((error: unknown) => {
              logProblem('Changing the base label', error);
            });
          }}
        >
          {labels.map((label) => (
            <option key={label.code} value={label.code}>
              {label.marking.text}
            </option>
          ))}
        </select>
      </label>
      )}
      {failure !== null && (
        <p class="error" data-testid="base-label-failure">
          {failure}
        </p>
      )}
      <p class="document-marking">
        <span class="label-swatch" style={{ backgroundColor: documentLabel?.marking.color ?? 'transparent' }} />
        <span data-testid="document-label-marking">{documentLabel?.marking.text ?? '…'}</span>
      </p>
    </section>
  );
}
