// The subset of the ONLYOFFICE Office JavaScript API used inside commands:
// the text editor's, and the spreadsheet editor's. These globals only exist
// in the editor's command sandbox.

export interface ApiColor {
  readonly kind?: 'color';
}

export interface ApiRun {
  SetBold(bold: boolean): unknown;
  SetColor(color: ApiColor): unknown;
}

export interface ApiParagraph {
  GetClassType(): 'paragraph';
  AddText(text: string): ApiRun;
  // Makes the paragraph's whole content a link to the address.
  AddHyperlink(address: string): unknown;
  RemoveAllElements(): boolean;
  // Its text, list numbering included unless `Numbering` is false.
  GetText(options?: { Numbering?: boolean; NewLineSeparator?: string }): string;
  GetPosInParent(): number;
  GetInternalId(): string;
  SetJc(justification: 'left' | 'right' | 'center' | 'both'): boolean;
  // The table or the content control that holds it, null when none does.
  GetParentTable(): unknown;
  GetParentContentControl(): unknown;
  // Its images, shapes and charts.
  GetAllDrawingObjects(): unknown[];
  // Its whole text, null when it holds none.
  GetRange(): ApiTextRange | null;
  // The editor's own paragraph, which no public API reaches: its elements,
  // runs and the marks where comments start and end among them.
  Paragraph: InternalParagraph;
}

// A text document's paragraph in the editor's internal model: undocumented,
// it may change with any version of ONLYOFFICE.
export interface InternalParagraph {
  Content: InternalParagraphElement[];
}

// A mark where a comment starts or ends holds the comment's id, and a note's
// reference among a run's elements holds the note; runs, hyperlinks and the
// other elements hold neither, but may hold elements.
export interface InternalParagraphElement {
  CommentId?: unknown;
  Footnote?: unknown;
  Content?: InternalParagraphElement[];
}

// A range of a text document's content.
export interface ApiTextRange {
  // The paragraphs it touches, whole; null when it holds a locked content
  // control.
  GetAllParagraphs(): ApiParagraph[] | null;
  // Where it starts and ends among the document's characters.
  GetStartPos(): number;
  GetEndPos(): number;
}

export interface ApiTable {
  GetClassType(): 'table';
  GetInternalId(): string;
}

export type ContentControlLock = 'unlocked' | 'contentLocked' | 'sdtContentLocked' | 'sdtLocked';

export interface ApiBlockLvlSdt {
  GetClassType(): 'blockLvlSdt';
  SetTag(tag: string): boolean;
  GetTag(): string;
  SetAlias(alias: string): boolean;
  SetBorderColor(color: ApiColor): boolean;
  SetLock(lock: ContentControlLock): boolean;
  GetLock(): ContentControlLock;
  GetContent(): ApiDocumentContent;
  GetInternalId(): string;
  // Refused while the control is locked against deletion.
  Delete(keepContent: boolean): boolean;
}

// What the document, a header, a footer or a block content control holds.
export type ApiDocumentElement = ApiParagraph | ApiTable | ApiBlockLvlSdt;

// The content of a block content control, a header or a footer.
export interface ApiDocumentContent {
  GetElementsCount(): number;
  GetElement(index: number): ApiDocumentElement | null;
  AddElement(position: number, element: ApiBlockLvlSdt): boolean;
  Push(element: ApiBlockLvlSdt): boolean;
  RemoveElement(position: number): boolean;
}

// The headers and footers of a section: its default ones, the first page's
// and the even pages'.
export type HeaderFooterType = 'default' | 'title' | 'even';

export interface ApiSection {
  // With `create`, a missing header or footer is created, holding one empty
  // paragraph.
  GetHeader(type: HeaderFooterType, create: boolean): ApiDocumentContent | null;
  GetFooter(type: HeaderFooterType, create: boolean): ApiDocumentContent | null;
}

export interface ApiInlineLvlSdt {
  GetClassType(): 'inlineLvlSdt';
  GetTag(): string;
  GetInternalId(): string;
}

export type ApiContentControl = ApiBlockLvlSdt | ApiInlineLvlSdt;

export interface ApiCustomXmlPart {
  GetXml(): string;
  Delete(): boolean;
}

export interface ApiCustomXmlParts {
  Add(xml: string): ApiCustomXmlPart | null;
  GetByNamespace(namespace: string): ApiCustomXmlPart[];
}

export interface ApiDocument {
  InsertContent(content: ApiBlockLvlSdt[]): boolean;
  AddElement(position: number, element: ApiBlockLvlSdt): boolean;
  RemoveElement(position: number): boolean;
  GetElement(index: number): ApiDocumentElement | null;
  // The selection, null when there is none.
  GetRangeBySelect(): ApiTextRange | null;
  GetCurrentParagraph(): ApiParagraph | null;
  // Those of headers and footers too.
  GetAllContentControls(): ApiContentControl[];
  GetCustomXmlParts(): ApiCustomXmlParts;
  GetSections(): ApiSection[];
}

export interface OfficeApi {
  GetDocument(): ApiDocument;
  CreateBlockLvlSdt(): ApiBlockLvlSdt;
  HexColor(hex: string): ApiColor;
}

// A user protected range of the spreadsheet editor, and one of its users.
export interface ApiProtectedRangeUserInfo {
  GetId(): string;
}

export interface ApiProtectedRange {
  GetAllUsers(): ApiProtectedRangeUserInfo[] | null;
  DeleteUser(id: string): boolean;
}

// The spreadsheet editor's internal model, which no public API reaches:
// undocumented, it may change with any version of ONLYOFFICE (ADR 0006).
export interface InternalUserProtectedRange {
  name: string;
  asc_getRef(): string | null;
  ref: { getName(): string };
  // Whether it holds a cell, given from 0.
  contains(column: number, row: number): boolean;
  // The model asks it before any edit of the range's cells, and before any
  // change of the range itself.
  isUserCanEdit(userId: string): boolean;
}

// One of a sheet's six header and footer strings.
export interface InternalHeaderFooterData {
  getStr(): string;
}

// A sheet's headers and footers, whose setters the editor's history records.
export interface InternalHeaderFooter {
  getOddHeader(): InternalHeaderFooterData | null;
  getOddFooter(): InternalHeaderFooterData | null;
  getEvenHeader(): InternalHeaderFooterData | null;
  getEvenFooter(): InternalHeaderFooterData | null;
  getFirstHeader(): InternalHeaderFooterData | null;
  getFirstFooter(): InternalHeaderFooterData | null;
  getDifferentFirst(): boolean | null;
  getDifferentOddEven(): boolean | null;
  setOddHeader(value: string): void;
  setOddFooter(value: string): void;
  setEvenHeader(value: string): void;
  setEvenFooter(value: string): void;
  setFirstHeader(value: string): void;
  setFirstFooter(value: string): void;
  setDifferentFirst(value: boolean): void;
  setDifferentOddEven(value: boolean): void;
}

export interface InternalWorksheet {
  userProtectedRanges: InternalUserProtectedRange[] | null;
  // The cell the selection starts from, from 0.
  selectionRange: { activeCell: { row: number; col: number } };
  // Changes a range, or removes it without `to`, in the editor's history.
  editUserProtectedRanges(from: InternalUserProtectedRange, to: null, addToHistory: true): unknown;
  headerFooter: InternalHeaderFooter;
  // Whether a range intersects a user protected range; with `notCheckUser`,
  // whoever may edit it.
  isUserProtectedRangesIntersection(range: unknown, userId: null, notCheckUser: true): boolean;
  // The sheet's comments: on a cell given from 0, unless on the whole
  // document.
  aComments: { nCol: number; nRow: number; asc_getDocumentFlag(): boolean }[];
  // true when a range intersects a table, null otherwise.
  autoFilters: { isIntersectionTable(range: unknown): true | null };
  getPivotTablesIntersectingRange(range: unknown): unknown[];
  // The editor itself, which tells whether its user types in a cell: a call
  // that a command's `Api` does not offer.
  workbook: { oApi: { asc_getCellEditMode(): boolean } };
}

export interface InternalRange {
  bbox: { contains(column: number, row: number): boolean };
  // The merged area it intersects, null when none.
  hasMerged(): unknown;
  // Links the range, in the editor's history; `withoutStyle` leaves its font
  // as it is.
  setHyperlink(link: InternalHyperlink, withoutStyle: boolean): void;
}

// A link on cells in the editor's model: the cells it covers, and the
// address it leads to.
export interface InternalHyperlink {
  Ref: InternalRange | null;
  Hyperlink: string | null;
}

export interface ApiRange {
  // A single cell's value, or a row of values per row of the range.
  GetValue(): unknown;
  // A single cell's displayed value, formatted, or a row of them per row of
  // the range.
  GetText(): string | string[][];
  GetCellsCount(): number;
  // The blocks of cells of a selection.
  GetAreas(): { GetCount(): number };
  // A single cell's formula, starting with "=", or its value.
  GetFormula(): string;
  // Calls back with each of the range's cells that holds anything.
  ForEach(callback: (cell: ApiRange) => void): boolean;
  SetValue(value: string): boolean;
  Merge(across: boolean): boolean;
  UnMerge(): boolean;
  // Clears the values and the formats, with the comments, the data
  // validation and the conditional formatting.
  Clear(): unknown;
  SetBold(bold: boolean): unknown;
  SetUnderline(underline: 'none' | 'single'): unknown;
  SetWrap(wrap: boolean): unknown;
  SetAlignHorizontal(alignment: 'center'): unknown;
  SetAlignVertical(alignment: 'center'): unknown;
  SetFontColor(color: ApiColor): unknown;
  SetBorders(edge: 'Top' | 'Bottom' | 'Left' | 'Right', style: 'Medium', color: ApiColor): boolean;
  GetAddress(rowAbsolute: boolean, columnAbsolute: boolean, style: 'xlA1', external: boolean): string | null;
  // Selects it, on the active sheet.
  Select(): unknown;
  range: InternalRange;
}

// A worksheet gives the workbook's Custom XML parts, whichever sheet it is.
export interface ApiWorksheet {
  GetCustomXmlParts(): ApiCustomXmlParts;
  GetName(): string;
  GetSelection(): ApiRange;
  GetRange(address: string): ApiRange;
  SetActive(): unknown;
  // The current user becomes the range's only editor.
  AddProtectedRange(title: string, reference: string): ApiProtectedRange;
  worksheet: InternalWorksheet;
}

export interface SpreadsheetApi {
  GetActiveSheet(): ApiWorksheet;
  GetSheets(): ApiWorksheet[];
  CreateColorFromRGB(red: number, green: number, blue: number): ApiColor;
}
