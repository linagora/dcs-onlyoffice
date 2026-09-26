import type { JSX } from 'preact';
import type { LabelView } from './policy.ts';

export interface DocumentLabelProps {
  labels: LabelView[];
  baseLabelCode: string | null;
  documentLabel: LabelView | null;
  readOnly: boolean;
  onBaseLabelChange: (code: string) => Promise<boolean>;
}

// The base label covers the document's unprotected content; the document
// label follows from it and from the portions' labels.
export function DocumentLabel({ labels, baseLabelCode, documentLabel, readOnly, onBaseLabelChange }: DocumentLabelProps): JSX.Element {
  return (
    <section class="document-label" aria-labelledby="document-label-title">
      <h2 id="document-label-title">Document label</h2>
      {!readOnly && (
      <label class="field">
        <span>Base label</span>
        <select
          value={baseLabelCode ?? ''}
          onChange={(event) => {
            onBaseLabelChange(event.currentTarget.value).catch(() => false);
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
      <p class="document-marking">
        <span class="label-swatch" style={{ backgroundColor: documentLabel?.marking.color ?? 'transparent' }} />
        <span data-testid="document-label-marking">{documentLabel?.marking.text ?? '…'}</span>
      </p>
    </section>
  );
}
