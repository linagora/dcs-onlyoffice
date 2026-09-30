import { DOMParser, type Element } from '@xmldom/xmldom';

const ELEMENT_NODE = 1;
const BYTE_ORDER_MARK = '\uFEFF';

export type ParsedXml = { ok: true; root: Element } | { ok: false; error: string };

// Parses a document that must be well-formed and carry no DTD: refusing DTDs
// rules out entity expansion attacks. A byte order mark at the start of the
// text, which XML allows and Office writes in some package parts, is left
// out.
export function parseXml(text: string): ParsedXml {
  const xml = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  if (/<!DOCTYPE/i.test(xml)) {
    return { ok: false, error: 'DTDs are not allowed' };
  }
  const problems: string[] = [];
  try {
    const document = new DOMParser({
      onError: (level, message) => {
        if (level !== 'warning') {
          problems.push(message);
        }
      },
    }).parseFromString(xml, 'text/xml');
    const root = document.documentElement;
    if (problems.length === 0 && root !== null) {
      return { ok: true, root };
    }
  } catch (error: unknown) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return { ok: false, error: `not well-formed XML (${problems.join('; ')})` };
}

// The child elements of an element, in any namespace.
export function childElements(parent: Element): Element[] {
  const result: Element[] = [];
  for (let node = parent.firstChild; node !== null; node = node.nextSibling) {
    if (node.nodeType === ELEMENT_NODE) {
      result.push(node as Element); // SAFETY: nodeType identifies an element
    }
  }
  return result;
}

// The child elements with this namespace and local name.
export function childrenNamed(parent: Element, namespace: string, localName: string): Element[] {
  return childElements(parent).filter((element) => element.namespaceURI === namespace && element.localName === localName);
}
