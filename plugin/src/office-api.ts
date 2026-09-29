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
  RemoveAllElements(): boolean;
  GetText(): string;
  GetPosInParent(): number;
  GetInternalId(): string;
  SetJc(justification: 'left' | 'right' | 'center' | 'both'): boolean;
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
  GetElement(index: number): ApiDocumentElement | null;
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
}

export interface InternalWorksheet {
  userProtectedRanges: InternalUserProtectedRange[] | null;
  // Whether a range intersects a user protected range; with `notCheckUser`,
  // whoever may edit it.
  isUserProtectedRangesIntersection(range: unknown, userId: null, notCheckUser: true): boolean;
}

export interface InternalRange {
  bbox: unknown;
  // The merged area it intersects, null when none.
  hasMerged(): unknown;
}

export interface ApiRange {
  // A single cell's value, or a row of values per row of the range.
  GetValue(): unknown;
  // A single cell's formula, starting with "=", or its value.
  GetFormula(): string;
  // Calls back with each of the range's cells that holds anything.
  ForEach(callback: (cell: ApiRange) => void): boolean;
  SetValue(value: string): boolean;
  Merge(across: boolean): boolean;
  SetBold(bold: boolean): unknown;
  SetWrap(wrap: boolean): unknown;
  SetAlignHorizontal(alignment: 'center'): unknown;
  SetAlignVertical(alignment: 'center'): unknown;
  SetFontColor(color: ApiColor): unknown;
  SetBorders(edge: 'Top' | 'Bottom' | 'Left' | 'Right', style: 'Medium', color: ApiColor): boolean;
  GetAddress(rowAbsolute: boolean, columnAbsolute: boolean, style: 'xlA1', external: boolean): string | null;
  range: InternalRange;
}

// A worksheet gives the workbook's Custom XML parts, whichever sheet it is.
export interface ApiWorksheet {
  GetCustomXmlParts(): ApiCustomXmlParts;
  GetName(): string;
  GetSelection(): ApiRange;
  // The current user becomes the range's only editor.
  AddProtectedRange(title: string, reference: string): ApiProtectedRange;
  worksheet: InternalWorksheet;
}

export interface SpreadsheetApi {
  GetActiveSheet(): ApiWorksheet;
  GetSheets(): ApiWorksheet[];
  CreateColorFromRGB(red: number, green: number, blue: number): ApiColor;
}
