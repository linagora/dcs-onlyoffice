import { escapeXml } from './adatp4774.ts';

export const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';

const XMIME_NAMESPACE = 'http://www.w3.org/2005/05/xmlmime';
const PACK_PREFIX = 'pack:///';
// The Id of the whole-document MetadataBinding, which a signature references.
export const DOCUMENT_BINDING_ID = 'mb-document';

// Parts a DOCX saved by ONLYOFFICE always contains among those of ADatP-4778.2
// Tables 5-2 and 5-3, which the binding the panel writes references. Signing
// a binding references the parts the package holds instead; a binding that
// could not be signed keeps these, even in a workbook.
export const DEFAULT_DOCUMENT_PARTS: readonly string[] = [
  'word/document.xml',
  'word/styles.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'docProps/core.xml',
  'docProps/app.xml',
];

// ADatP-4778.2 Tables 5-2 and 5-3 for WordprocessingML, in reference order:
// the parts a whole-document binding references when the package holds them.
// The portal applies the same list at every save.
const WORDPROCESSING_BINDABLE_PARTS: readonly RegExp[] = [
  /^word\/document\.xml$/,
  /^word\/styles\.xml$/,
  /^word\/header\d*\.xml$/,
  /^word\/footer\d*\.xml$/,
  /^word\/footnotes\.xml$/,
  /^word\/endnotes\.xml$/,
  /^word\/comments\.xml$/,
  /^word\/commentsExtended\.xml$/,
  /^word\/media\/.+$/,
  /^docProps\/core\.xml$/,
  /^docProps\/app\.xml$/,
  /^docProps\/custom\.xml$/,
];

// ADatP-4778.2 Tables 5-2 and 5-3 for SpreadsheetML, in reference order. The
// table names chart styles styles<N>; Microsoft Excel and ONLYOFFICE write
// style<N>: both names count.
const SPREADSHEET_BINDABLE_PARTS: readonly RegExp[] = [
  /^xl\/workbook\.xml$/,
  /^xl\/styles\.xml$/,
  /^xl\/sharedStrings\.xml$/,
  /^xl\/worksheets\/sheet\d+\.xml$/,
  /^xl\/charts\/chart\d+\.xml$/,
  /^xl\/charts\/colors\d+\.xml$/,
  /^xl\/charts\/styles?\d+\.xml$/,
  /^xl\/pivotTables\/pivotTable\d+\.xml$/,
  /^xl\/comments\d+\.xml$/,
  /^xl\/media\/.+$/,
  /^docProps\/core\.xml$/,
  /^docProps\/app\.xml$/,
  /^docProps\/custom\.xml$/,
];

// The parts of a package, given by name, that its whole-document binding
// references: those of a workbook when the package holds a workbook part,
// else those of a text document.
export function bindablePartsOf(parts: readonly string[]): string[] {
  const table = parts.includes('xl/workbook.xml') ? SPREADSHEET_BINDABLE_PARTS : WORDPROCESSING_BINDABLE_PARTS;
  return table.flatMap((pattern) => parts.filter((part) => pattern.test(part)).sort());
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
};

// ADatP-4778.2 OOXML profile: one BindingInformation part whose DataReference
// elements point at package parts with pack:/// URIs; Data elements are not
// used. The panel writes the binding unsigned, which the profile allows; the
// policy service signs it again for each save the portal stores.
export function serializeDocumentBinding(labelXml: string, parts: readonly string[]): string {
  const references = parts
    .map((part) => {
      const mediaType = MEDIA_TYPES[part.slice(part.lastIndexOf('.') + 1).toLowerCase()];
      const contentType = mediaType === undefined ? '' : ` xmime:contentType="${mediaType}"`;
      return `<mb:DataReference URI="${escapeXml(packUri(part))}"${contentType}/>`;
    })
    .join('');
  return (
    `<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}" xmlns:xmime="${XMIME_NAMESPACE}">` +
    `<mb:MetadataBindingContainer><mb:MetadataBinding Id="${DOCUMENT_BINDING_ID}">` +
    `<mb:Metadata>${labelXml}</mb:Metadata>` +
    references +
    '</mb:MetadataBinding></mb:MetadataBindingContainer></mb:BindingInformation>'
  );
}

// The address of a package part, as DataReferences give it.
export function packUri(part: string): string {
  return `${PACK_PREFIX}${part}`;
}

// The package part a DataReference URI names, null for a URI outside the
// package.
export function packPartName(uri: string): string | null {
  return uri.startsWith(PACK_PREFIX) ? uri.slice(PACK_PREFIX.length) : null;
}
