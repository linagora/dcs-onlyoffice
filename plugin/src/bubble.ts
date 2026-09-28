import { type BubbleContent, type BubbleMessage, bubbleChannel, isBubbleMessage } from './bubble-channel.ts';
import { logProblem } from './log.ts';
import { messages } from './messages.ts';
import {
  callEditorMethod,
  lastCommandAnswerAt,
  newPluginWindow,
  offEditorEvent,
  onEditorEvent,
  onPluginButton,
  type PluginWindow,
} from './onlyoffice.ts';

const ESCAPE_KEY_CODE = 27;
const WINDOW_WIDTH = 380;
const WINDOW_MIN_HEIGHT = 64;
const WINDOW_MAX_HEIGHT = 260;
// Rough metrics of the page's text (bubble.css), to size the window before
// its page loads; a longer text scrolls.
const CHARACTERS_PER_LINE = 52;
const LINE_HEIGHT = 18;
const VERTICAL_PADDING = 30;
// The editor's click event comes before the cursor's move out of a portion.
const REOPEN_DELAY_MS = 250;
// The window follows the cursor once it stops moving on screen, as when the
// document scrolls. The cursor also moves as the window opens: those moves
// are ignored.
const SETTLE_MS = 300;
const OPENING_MOVES_MS = 600;
// As it ends each of the panel's commands, as when the panel rereads the
// document every few seconds, the editor places its cursor again and reports
// a move, a few tens of milliseconds after its answer, even when the cursor
// stays where it was. That report is ignored, unless the cursor is already
// moving.
const COMMAND_MOVE_MS = 300;
const EDITOR_EVENTS = ['onKeyDown', 'onClick', 'onTargetPositionChanged'] as const;

// The window that shows, next to the cursor, the text of the portion that
// holds it: the bubble. One at a time: showing another closes the previous one.
export class PortionBubble {
  #window: PluginWindow | null = null;
  #channel: BroadcastChannel | null = null;
  // What the portion that holds the cursor shows, even once the window is
  // closed, so that the window can come back.
  #content: BubbleContent | null = null;
  // Escape closes the window until the next click in the portion.
  #dismissed = false;
  #openedAt = 0;
  #settling: ReturnType<typeof setTimeout> | null = null;
  // The command answer whose reported move was ignored.
  #ignoredAnswerAt: number | null = null;

  // Listens to the editor; false when its runtime offers no events. The
  // editor tells the plugin of keys pressed in the document, and the window's
  // own handler of those pressed elsewhere in the editor.
  attach(): boolean {
    onPluginButton((_id, windowId) => {
      if (this.#window !== null && windowId === this.#window.id) {
        this.#dismiss();
      }
    });
    const listening = [
      onEditorEvent('onKeyDown', (key) => {
        if (typeof key === 'object' && key !== null && 'keyCode' in key && key.keyCode === ESCAPE_KEY_CODE) {
          this.#dismiss();
        }
      }),
      onEditorEvent('onClick', () => {
        setTimeout(() => {
          if (this.#window === null && this.#content !== null) {
            this.#dismissed = false;
            this.#open(this.#content);
          }
        }, REOPEN_DELAY_MS);
      }),
      onEditorEvent('onTargetPositionChanged', () => {
        this.#followCursor();
      }),
    ];
    return !listening.includes(false);
  }

  detach(): void {
    this.clear();
    for (const name of EDITOR_EVENTS) {
      offEditorEvent(name);
    }
    onPluginButton(() => {});
  }

  show(content: BubbleContent): void {
    this.#content = content;
    this.#dismissed = false;
    this.#open(content);
  }

  // Once the cursor has left every portion.
  clear(): void {
    this.#content = null;
    this.#close();
  }

  #dismiss(): void {
    this.#dismissed = true;
    this.#close();
  }

  #followCursor(): void {
    if (this.#content === null || this.#dismissed || Date.now() - this.#openedAt < OPENING_MOVES_MS) {
      return;
    }
    const answeredAt = lastCommandAnswerAt();
    if (answeredAt !== null && answeredAt !== this.#ignoredAnswerAt && Date.now() - answeredAt < COMMAND_MOVE_MS) {
      this.#ignoredAnswerAt = answeredAt;
      if (this.#settling === null) {
        return;
      }
    }
    this.#close();
    if (this.#settling !== null) {
      clearTimeout(this.#settling);
    }
    this.#settling = setTimeout(() => {
      this.#settling = null;
      if (this.#window === null && this.#content !== null && !this.#dismissed) {
        this.#open(this.#content);
      }
    }, SETTLE_MS);
  }

  #open(content: BubbleContent): void {
    this.#close();
    const opened = newPluginWindow();
    if (opened === null) {
      logProblem('Showing a portion at the cursor', new Error('The editor runtime offers no plugin windows'));
      return;
    }
    // The page asks for its content once it listens.
    const channel = bubbleChannel(opened.id);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isBubbleMessage(event.data) && event.data.type === 'ready') {
        channel.postMessage({ type: 'content', content } satisfies BubbleMessage);
      }
    };
    this.#window = opened;
    this.#channel = channel;
    this.#openedAt = Date.now();
    opened.show({
      url: 'bubble.html',
      description: messages.bubbleTitle,
      isVisual: true,
      isModal: false,
      isViewer: true,
      EditorsSupport: ['word'],
      buttons: [],
      size: [WINDOW_WIDTH, heightFor(content)],
      isCustomWindow: true,
      isTargeted: true,
    });
    // Keys go on to the document, not to the window.
    callEditorMethod('FocusEditor', []).catch((error: unknown) => {
      logProblem('Giving the focus back to the document', error);
    });
  }

  #close(): void {
    this.#channel?.close();
    this.#channel = null;
    this.#window?.close();
    this.#window = null;
  }
}

function heightFor(content: BubbleContent): number {
  const lines = content.text
    .split('\n')
    .reduce((count, paragraph) => count + Math.max(1, Math.ceil(paragraph.length / CHARACTERS_PER_LINE)), 0);
  const warningLines = content.warning === null ? 0 : Math.ceil(content.warning.length / CHARACTERS_PER_LINE);
  return Math.min(WINDOW_MAX_HEIGHT, Math.max(WINDOW_MIN_HEIGHT, VERTICAL_PADDING + (1 + warningLines + lines) * LINE_HEIGHT));
}
