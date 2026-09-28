import type { Marking } from './policy.ts';

// What the panel and the bubble, the window it opens at the cursor, say to
// each other. They talk over a channel of the plugin's origin, which the
// editor's origin cannot join: a portion's text never goes through the editor.

export interface BubbleContent {
  marking: Marking;
  text: string;
  // A warning the panel shows next to the portion, if any.
  warning: string | null;
}

// The page asks for its content once it listens; the panel answers.
export type BubbleMessage = { type: 'ready' } | { type: 'content'; content: BubbleContent };

export function bubbleChannel(windowId: string): BroadcastChannel {
  return new BroadcastChannel(`dcs-portion-bubble:${windowId}`);
}

export function isBubbleMessage(value: unknown): value is BubbleMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  if (value.type === 'ready') {
    return true;
  }
  return value.type === 'content' && 'content' in value && isBubbleContent(value.content);
}

function isBubbleContent(value: unknown): value is BubbleContent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>; // SAFETY: object checked above
  const marking = candidate.marking;
  return (
    typeof candidate.text === 'string' &&
    (candidate.warning === null || typeof candidate.warning === 'string') &&
    typeof marking === 'object' &&
    marking !== null &&
    'text' in marking &&
    typeof marking.text === 'string' &&
    'color' in marking &&
    (marking.color === null || typeof marking.color === 'string')
  );
}
