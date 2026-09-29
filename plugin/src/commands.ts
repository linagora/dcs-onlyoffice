// What the panel's editor commands take and give, in every editor: the
// scope they read as Asc.scope, and what reading a document gives. Commands
// run in the editor's sandbox, where they may only use these plain values.

export interface PartReplacement {
  namespace: string;
  xml: string;
}

// What a portion's placeholder block shows of its label.
export interface PortionBlockScope {
  tag: string;
  color: string | null;
  placeholder: string;
}

// A portion the command writes, with its part: a new one, or a new version
// of one the document holds; or one it deletes.
export type PortionWriteScope =
  | { kind: 'insertion'; id: string; alias: string; block: PortionBlockScope; xml: string }
  | { kind: 'change'; id: string; block: PortionBlockScope; xml: string }
  | { kind: 'deletion'; id: string };

export interface PageMarkingScope {
  tag: string;
  alias: string;
  text: string;
  color: string | null;
}

// What writing the document label writes: its parts and its page marking.
export interface DocumentLabelScope {
  replacements: PartReplacement[];
  pageMarking: PageMarkingScope;
}

export interface CommandScope extends DocumentLabelScope {
  portion: PortionWriteScope | null;
  portionNamespace: string;
  documentNamespace: string;
}

export type HeaderFooterKind = 'header' | 'footer';

// A block content control of a header or a footer, as far as the page marking
// goes: its text is null unless it holds a single paragraph.
export interface ControlSnapshot {
  tag: string;
  lock: string;
  text: string | null;
}

// A header or a footer that must hold the page marking: its blocks, null for
// those that are not content controls; null when it is missing.
export interface HeaderFooterSnapshot {
  kind: HeaderFooterKind;
  blocks: (ControlSnapshot | null)[] | null;
}

// What reading a document gives: its placeholders, a text document's content
// controls or a workbook's user protected ranges, the plugin's parts, and
// the headers and footers where the page marking goes.
export interface DocumentSnapshot {
  controls: { tag: string; internalId: string }[];
  ranges: { title: string; reference: string }[];
  portionParts: string[];
  documentParts: string[];
  headersAndFooters: HeaderFooterSnapshot[];
}

// What a command that writes gives: whether it wrote, or, in a workbook,
// that it refused selected cells that hold a value, a formula, a merge or a
// portion.
export type WriteOutcome = 'written' | 'not-written' | 'cells-occupied';
