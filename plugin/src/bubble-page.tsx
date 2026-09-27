import { type JSX, render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { type BubbleContent, type BubbleMessage, bubbleChannel, isBubbleMessage } from './bubble-channel.ts';
import { language, messages } from './messages.ts';
import './bubble.css';

// The page of the window that the panel opens next to the cursor when the
// cursor enters a portion its reader may read. The editor gives the page its
// window id in the URL; the page then asks the panel for the portion's
// marking and text.

function Bubble({ channel }: { channel: BroadcastChannel }): JSX.Element | null {
  const [content, setContent] = useState<BubbleContent | null>(null);
  useEffect(() => {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isBubbleMessage(event.data) && event.data.type === 'content') {
        setContent(event.data.content);
      }
    };
    channel.postMessage({ type: 'ready' } satisfies BubbleMessage);
    return () => {
      channel.onmessage = null;
    };
  }, [channel]);
  if (content === null) {
    return null;
  }
  return (
    <article class="bubble" style={{ borderLeftColor: content.marking.color ?? undefined }} aria-label={messages.bubbleTitle}>
      <p class="bubble-marking">
        <span class="bubble-swatch" style={{ backgroundColor: content.marking.color ?? 'transparent' }} />
        <span data-testid="bubble-marking">{content.marking.text}</span>
      </p>
      {content.warning === null ? null : <p class="bubble-warning">{content.warning}</p>}
      <p class="bubble-text" data-testid="bubble-text">
        {content.text}
      </p>
    </article>
  );
}

document.documentElement.lang = language;
document.title = messages.bubbleTitle;

const windowId = new URLSearchParams(window.location.search).get('windowID');
const root = document.getElementById('bubble');
if (root === null || windowId === null) {
  throw new Error('The bubble page needs a #bubble element and a window id');
}
render(<Bubble channel={bubbleChannel(windowId)} />, root);
