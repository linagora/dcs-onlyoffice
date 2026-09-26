// The subset of the ONLYOFFICE Office JavaScript API used inside commands.
// These globals only exist in the editor's command sandbox.

export interface ApiColor {
  readonly kind?: 'color';
}

export interface ApiParagraph {
  AddText(text: string): unknown;
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
}

export interface ApiCustomXmlParts {
  Add(xml: string): ApiCustomXmlPart | null;
  GetByNamespace(namespace: string): ApiCustomXmlPart[];
}

export interface ApiDocument {
  InsertContent(content: ApiBlockLvlSdt[]): boolean;
  GetAllContentControls(): ApiContentControl[];
  GetCustomXmlParts(): ApiCustomXmlParts;
}

export interface OfficeApi {
  GetDocument(): ApiDocument;
  CreateBlockLvlSdt(): ApiBlockLvlSdt;
  HexColor(hex: string): ApiColor;
}
