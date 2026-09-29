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

// A portion the command writes, with its part: a new one, where the author
// asked for it or in place of selected content that the panel protects; a new
// version of one the document holds; or one it deletes.
export type PortionWriteScope =
  | { kind: 'insertion'; id: string; alias: string; block: PortionBlockScope; xml: string }
  | { kind: 'protection'; id: string; alias: string; block: PortionBlockScope; xml: string; content: SelectedContent }
  | { kind: 'change'; id: string; block: PortionBlockScope; xml: string }
  | { kind: 'deletion'; id: string };

// Selected content that the panel protects: a workbook's cells, or a text
// document's paragraphs.
export type SelectedContent = SelectedCells | SelectedParagraphs;

// Selected cells of a workbook: their sheet, their address and their
// displayed values, row by row.
export interface SelectedCells {
  kind: 'cells';
  sheet: string;
  address: string;
  texts: string[][];
}

// Whole paragraphs of a text document's body, which follow each other: the
// position of the first among the body's elements, and the plain text of each.
export interface SelectedParagraphs {
  kind: 'paragraphs';
  position: number;
  texts: string[];
}

// Why the panel refuses to protect selected content. In a workbook: the
// author types in a cell, or the selection holds several blocks of cells,
// more cells than a portion's text can hold, a merge, a portion, a table or a
// pivot table, a comment, a formula, or nothing. In a text document: the
// selection lies outside the document's body, or holds a table, an image or a
// shape, a locked content control, a comment, a note, more than a portion's
// text can hold, or no text.
export type SelectionRefusal =
  | 'cell-being-edited'
  | 'several-areas'
  | 'too-large'
  | 'merge-portion-or-table'
  | 'commented-cells'
  | 'formula'
  | 'empty-cells'
  | 'outside-body'
  | 'table'
  | 'drawing'
  | 'content-control'
  | 'commented-paragraphs'
  | 'noted-paragraphs'
  | 'empty-paragraphs';

// What reading the selection gives: the selected content, or why the panel
// refuses it.
export type SelectionReading = { status: 'read'; content: SelectedContent } | { status: 'refused'; reason: SelectionRefusal };

// What reading the selection takes: the most cells it may hold.
export interface SelectionReadingScope {
  cellLimit: number;
}

export interface PageMarkingScope {
  tag: string;
  alias: string;
  text: string;
  color: string | null;
  // The centre section that shows it in a workbook's headers and footers.
  headerFooterCentre: string;
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

// A sheet's six header and footer strings, as far as the page marking goes:
// the centre section of each, null where the sheet has none, and whether
// first and even pages have their own.
export interface SheetSnapshot {
  centres: (string | null)[];
  differentFirst: boolean;
  differentOddEven: boolean;
}

// What reading a document gives: its placeholders, a text document's content
// controls or a workbook's user protected ranges, the plugin's parts, where
// the page marking goes, a text document's headers and footers or a
// workbook's sheets, and whether the author types in a cell of a workbook.
export interface DocumentSnapshot {
  controls: { tag: string; internalId: string }[];
  ranges: { title: string; reference: string }[];
  portionParts: string[];
  documentParts: string[];
  headersAndFooters: HeaderFooterSnapshot[];
  sheets: SheetSnapshot[];
  cellBeingEdited: boolean;
}

// What selecting a workbook's placeholder takes: its range's title, the
// portion's id.
export interface SelectionScope {
  rangeTitle: string;
}

// What a command that writes gives: whether it wrote, or that the content to
// protect changed since the panel read it, or, in a workbook, that it refused
// selected cells that hold a value, a formula, a merge or a portion, or that
// it wrote nothing while the author types in a cell.
export type WriteOutcome = 'written' | 'not-written' | 'cells-occupied' | 'selection-changed' | 'cell-being-edited';
