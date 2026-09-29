// Every protected portion text the tests write carries the portion marker,
// so that the tests, and the CI after them, can search everything ONLYOFFICE
// handled for it. Letters only: encoding a URL leaves them as they are.
export const PORTION_MARKER = 'dcsportionmarker';

// Carried instead by the texts of unencrypted portions, which go through the
// Document Server by design: the searches must find it, or they would not
// see the path an envelope takes either.
export const CANARY_MARKER = 'dcscanarymarker';

declare const marked: unique symbol;

// A portion text that carries the portion marker.
export type MarkedText = string & { readonly [marked]: true };

// A portion text for a test: its words, a time that tells runs apart, and
// the marker.
export function markedText(words: string): MarkedText {
  return `${words} ${Date.now()} ${PORTION_MARKER}` as MarkedText; // SAFETY: it ends with the marker
}

// The text of an unencrypted portion, which carries the canary marker.
export function canaryText(words: string): string {
  return `${words} ${Date.now()} ${CANARY_MARKER}`;
}

// A portion's text for screenshots and videos, without the marker, which
// would show in them: they are not part of the suite whose traces the CI
// searches.
export function unmarkedText(text: string): MarkedText {
  return text as MarkedText; // SAFETY: screenshots and videos are not part of the suite whose traces the CI searches
}
