import type { JSX } from 'preact';
import type { LabelView } from './policy.ts';
import type { StoredPortion } from './portions.ts';

export interface PortionListProps {
  portions: StoredPortion[];
  labels: LabelView[];
  activePortionId: string | null;
  onSelect: (portion: StoredPortion) => void;
}

export function PortionList({ portions, labels, activePortionId, onSelect }: PortionListProps): JSX.Element {
  return (
    <section class="portions" aria-labelledby="portions-title">
      <h2 id="portions-title">Protected portions</h2>
      {portions.length === 0 ? (
        <p class="muted">No protected portion yet.</p>
      ) : (
        <ul class="portion-list">
          {portions.map((portion) => {
            const label = labels.find((candidate) => candidate.code === portion.labelCode) ?? null;
            return (
              <li
                key={portion.id}
                class="portion-item"
                data-testid="portion-item"
                data-portion-id={portion.id}
                aria-current={portion.id === activePortionId ? 'true' : undefined}
              >
                <button
                  type="button"
                  class="portion-select"
                  onClick={() => {
                    onSelect(portion);
                  }}
                >
                  <span class="portion-marking">
                    <span class="label-swatch" style={{ backgroundColor: label?.marking.color ?? 'transparent' }} />
                    <span data-testid="portion-marking">{label?.marking.text ?? portion.labelCode}</span>
                  </span>
                  <span class="portion-text" data-testid="portion-text">
                    {portion.text ?? 'Content not available in this document.'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
