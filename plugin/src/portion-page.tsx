import type { JSX } from 'preact';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { EnvelopeClient } from './envelopes.ts';
import { field } from './json.ts';
import { describeError } from './log.ts';
import { messages } from './messages.ts';
import { fetchDefaultPolicyLabels, fetchLabelOfAdatp4774, type LabelView } from './policy.ts';
import { Notice, PortionBody, PortionMarking, shownLabelOf } from './PortionList.tsx';
import { type StoredPortion, storedPortionOf } from './portions.ts';
import { type PortionReading, PortionReader } from './readings.ts';

// One protected portion of a stored document, read outside the editor on its
// portion page. The portal took the access decision on the document, and
// hands over the portion as it stores it; the envelope opens here, in the
// reader's browser, as in the panel, and OpenTDF decides on the portion. The
// page has no timer: a reader retries a failure by reloading it.

type PortionView =
  | { status: 'reading' }
  | { status: 'gone' }
  | { status: 'failed'; reason: string }
  | { status: 'read'; portion: StoredPortion; reading: PortionReading; labels: LabelView[] };

// What the portal's page gives the script: the portion, and the OpenTDF
// platform that delivers its key.
interface PortionPageSettings {
  documentId: string;
  portionId: string;
  opentdfUrl: string;
}

async function readPortion({ documentId, portionId, opentdfUrl }: PortionPageSettings): Promise<PortionView> {
  const response = await fetch(`/documents/${encodeURIComponent(documentId)}/portions/${encodeURIComponent(portionId)}/part`, {
    credentials: 'same-origin',
  });
  if (response.status === 404) {
    return { status: 'gone' };
  }
  if (!response.ok) {
    return { status: 'failed', reason: `${response.status}` };
  }
  const body: unknown = await response.json();
  const placeholderLabelCode = field(body, 'placeholderLabelCode');
  const part = field(body, 'part');
  if (typeof placeholderLabelCode !== 'string' || (part !== null && typeof part !== 'string')) {
    return { status: 'failed', reason: 'unexpected portion answer' };
  }
  const portion = storedPortionOf(portionId, placeholderLabelCode, part);
  const reader = new PortionReader(new EnvelopeClient(opentdfUrl), fetchLabelOfAdatp4774);
  const [labels, reading] = await Promise.all([fetchDefaultPolicyLabels(), reader.read(portion)]);
  return { status: 'read', portion, reading, labels };
}

function PortionPage({ settings }: { settings: PortionPageSettings }): JSX.Element {
  const [view, setView] = useState<PortionView>({ status: 'reading' });
  useEffect(() => {
    const show = async (): Promise<void> => {
      setView(await readPortion(settings));
    };
    show().catch((error: unknown) => {
      setView({ status: 'failed', reason: describeError(error) });
    });
  }, [settings]);
  switch (view.status) {
    case 'reading':
      return (
        <span class="portion-notice muted" data-testid="portion-reading">
          {messages.decrypting}
        </span>
      );
    case 'gone':
      return <Notice>{messages.portionNoLongerStored}</Notice>;
    case 'failed':
      return (
        <>
          <Notice warning>{messages.portionPartFailed(view.reason)}</Notice>
          <ReloadHint />
        </>
      );
    case 'read': {
      const check = shownLabelOf(view.portion, view.reading, view.labels);
      return (
        <>
          <PortionMarking label={check.shown} labelCode={view.portion.labelCode} />
          <PortionBody reading={view.reading} labelWarning={check.warning} />
          {view.reading.status === 'failed' && view.reading.retry && <ReloadHint />}
        </>
      );
    }
  }
}

function ReloadHint(): JSX.Element {
  return <span class="portion-notice muted">{messages.reloadToRetry}</span>;
}

const root = document.getElementById('portion');
const { document: documentId, portion: portionId, opentdf: opentdfUrl } = root?.dataset ?? {};
if (root === null || documentId === undefined || portionId === undefined || opentdfUrl === undefined) {
  throw new Error('The portion page needs a #portion element that names its document, its portion and the OpenTDF platform');
}
render(<PortionPage settings={{ documentId, portionId, opentdfUrl }} />, root);
