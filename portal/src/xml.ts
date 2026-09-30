import { type Document, DOMParser } from '@xmldom/xmldom';

const BYTE_ORDER_MARK = '\uFEFF';

// Parses an XML part of a package. A byte order mark at the start of the
// text, which XML allows and Office writes in some parts, is left out.
export function parsePackageXml(text: string): Document {
  return new DOMParser().parseFromString(text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text, 'text/xml');
}
