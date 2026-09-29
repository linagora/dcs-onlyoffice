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

// A worksheet gives the workbook's Custom XML parts, whichever sheet it is.
export interface ApiWorksheet {
  GetCustomXmlParts(): ApiCustomXmlParts;
}

export interface SpreadsheetApi {
  GetActiveSheet(): ApiWorksheet;
}
