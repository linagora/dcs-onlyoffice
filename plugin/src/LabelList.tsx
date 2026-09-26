import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fetchDefaultPolicyLabels, type LabelView } from './policy.ts';

type LabelsState = { status: 'loading' } | { status: 'failed'; reason: string } | { status: 'loaded'; labels: LabelView[] };

export function LabelList(): JSX.Element {
  const [state, setState] = useState<LabelsState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchDefaultPolicyLabels()
      .then((labels) => {
        if (!cancelled) {
          setState({ status: 'loaded', labels });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'failed', reason: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section class="labels" aria-labelledby="labels-title">
      <h2 id="labels-title">Labels</h2>
      {state.status === 'loading' && <p class="muted">Loading the policy…</p>}
      {state.status === 'failed' && <p class="error">The policy could not be loaded ({state.reason}).</p>}
      {state.status === 'loaded' && (
        <ul class="label-list">
          {state.labels.map((label) => (
            <li key={label.code} class="label-item" data-code={label.code}>
              <span class="label-swatch" style={{ backgroundColor: label.marking.color ?? 'transparent' }} />
              <span data-testid="label-marking">{label.marking.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
