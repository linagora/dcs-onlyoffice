import type { JSX } from 'preact';
import { messages } from './messages.ts';
import type { LabelView } from './policy.ts';
import type { StoredPortion } from './portions.ts';
import type { PortionReading } from './readings.ts';

export interface PortionListProps {
  portions: StoredPortion[];
  // By portion id; a portion not read yet is being decrypted.
  readings: ReadonlyMap<string, PortionReading>;
  labels: LabelView[];
  activePortionId: string | null;
  onSelect: (portion: StoredPortion) => void;
}

export function PortionList({ portions, readings, labels, activePortionId, onSelect }: PortionListProps): JSX.Element {
  return (
    <section class="portions" aria-labelledby="portions-title">
      <h2 id="portions-title">{messages.portionsTitle}</h2>
      {portions.length === 0 ? (
        <p class="muted">{messages.noPortion}</p>
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
                  <PortionBody reading={readings.get(portion.id) ?? null} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function PortionBody({ reading }: { reading: PortionReading | null }): JSX.Element {
  if (reading === null) {
    return <Notice>{messages.decrypting}</Notice>;
  }
  switch (reading.status) {
    case 'opened':
      return <PortionText text={reading.text} />;
    case 'denied':
      return <Notice>{messages.accessDenied}</Notice>;
    case 'failed':
      return <Notice warning>{messages.couldNotDecrypt(reading.reason)}</Notice>;
    case 'unencrypted':
      return (
        <>
          <Notice warning>{messages.notEncrypted}</Notice>
          {reading.text === null ? <Notice>{messages.portionTextUnavailable}</Notice> : <PortionText text={reading.text} />}
        </>
      );
    case 'unavailable':
      return <Notice>{messages.portionTextUnavailable}</Notice>;
  }
}

function PortionText({ text }: { text: string }): JSX.Element {
  return (
    <span class="portion-text" data-testid="portion-text">
      {text}
    </span>
  );
}

function Notice({ warning = false, children }: { warning?: boolean; children: string }): JSX.Element {
  return (
    <span class={warning ? 'portion-notice warning' : 'portion-notice muted'} data-testid="portion-notice">
      {children}
    </span>
  );
}
