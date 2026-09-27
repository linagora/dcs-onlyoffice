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
            const reading = readings.get(portion.id) ?? null;
            const check = shownLabelOf(portion, reading, labels);
            const label = check.shown;
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
                  <PortionBody reading={reading} labelWarning={check.warning} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface LabelCheck {
  // The label whose marking the portion shows.
  shown: LabelView | null;
  warning: string | null;
}

// The label whose marking a portion shows, next to it in the panel and in the
// bubble at the cursor, and the warning that goes with it.
export function shownLabelOf(portion: StoredPortion, reading: PortionReading | null, labels: LabelView[]): LabelCheck {
  const clearLabel = labels.find((candidate) => candidate.code === portion.labelCode) ?? null;
  return labelCheck(portion, clearLabel, reading);
}

// For a reader who opened the envelope, the label bound to it prevails over
// the label in clear, in the tag and in the part, which a co-author could have
// changed. Labels not read yet are checked at a later reading.
function labelCheck(portion: StoredPortion, clearLabel: LabelView | null, reading: PortionReading | null): LabelCheck {
  if (reading?.status !== 'opened' || reading.boundLabel.status === 'unchecked' || reading.partLabel.status === 'unchecked') {
    return { shown: clearLabel, warning: null };
  }
  if (reading.boundLabel.status === 'invalid') {
    return { shown: clearLabel, warning: messages.boundLabelUnreadable };
  }
  const bound = reading.boundLabel.label;
  const clearCodes = [portion.labelCode, portion.partLabelCode, reading.partLabel.status === 'read' ? reading.partLabel.label.code : null];
  return clearCodes.every((code) => code === bound.code) ? { shown: clearLabel, warning: null } : { shown: bound, warning: messages.labelMismatch };
}

function PortionBody({ reading, labelWarning }: { reading: PortionReading | null; labelWarning: string | null }): JSX.Element {
  if (reading === null) {
    return <Notice>{messages.decrypting}</Notice>;
  }
  switch (reading.status) {
    case 'opened':
      return (
        <>
          {labelWarning === null ? null : <Notice warning>{labelWarning}</Notice>}
          <PortionText text={reading.text} />
        </>
      );
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
