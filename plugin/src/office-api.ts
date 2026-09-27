// The subset of the ONLYOFFICE Office JavaScript API used inside commands.
// These globals only exist in the editor's command sandbox.

export interface ApiColor {
  readonly kind?: 'color';
}

export interface ApiParagraph {
  AddText(text: string): unknown;
  GetText(): string;
  GetPosInParent(): number;
  GetInternalId(): string;
}

// Tables and block content controls also have an internal id.
export interface ApiDocumentElement {
  GetInternalId?(): string;
}

export interface ApiDocumentContent {
  GetElement(index: number): ApiParagraph | null;
}

export interface ApiBlockLvlSdt {
  SetTag(tag: string): boolean;
  SetAlias(alias: string): boolean;
  SetBorderColor(color: ApiColor): boolean;
  SetLock(lock: 'unlocked' | 'contentLocked' | 'sdtContentLocked' | 'sdtLocked'): boolean;
  GetContent(): ApiDocumentContent;
  GetInternalId(): string;
}

export interface ApiContentControl {
  GetTag(): string;
  GetInternalId(): string;
}

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
  GetAllContentControls(): ApiContentControl[];
  GetCustomXmlParts(): ApiCustomXmlParts;
}

export interface OfficeApi {
  GetDocument(): ApiDocument;
  CreateBlockLvlSdt(): ApiBlockLvlSdt;
  HexColor(hex: string): ApiColor;
}
