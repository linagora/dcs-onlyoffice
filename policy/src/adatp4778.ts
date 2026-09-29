import { escapeXml } from './adatp4774.ts';
import type { PackageKind } from './opc.ts';

export const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';

const XMIME_NAMESPACE = 'http://www.w3.org/2005/05/xmlmime';
const PACK_PREFIX = 'pack:///';
// The Id of the whole-document MetadataBinding, which a signature references.
export const DOCUMENT_BINDING_ID = 'mb-document';

// Parts a DOCX or an XLSX saved by ONLYOFFICE always contains among those of
// ADatP-4778.2 Tables 5-2 and 5-3, which the binding the panel writes
// references. Signing a binding references the parts the package holds
// instead; a binding that could not be signed keeps these.
export const DEFAULT_DOCUMENT_PARTS: Readonly<Record<PackageKind, readonly string[]>> = {
  'text-document': ['word/document.xml', 'word/styles.xml', 'word/footnotes.xml', 'word/endnotes.xml', 'docProps/core.xml', 'docProps/app.xml'],
  workbook: ['xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'docProps/core.xml', 'docProps/app.xml'],
};

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

// ADatP-4778.2 Tables 5-2 and 5-3 for SpreadsheetML, in reference order,
// then the parts that can hold a workbook's content that the tables leave
// out. The table names chart styles styles<N>; Microsoft Excel and ONLYOFFICE
// write style<N>: both names count.
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
  // Threaded comments, which Microsoft Excel shows instead of the legacy
  // ones, and their authors; drawings, which hold text boxes, and legacy VML
  // drawings; SmartArt diagrams and the charts of Excel 2016, which hold
  // text and values; pivot caches, which copy cell values; tables, slicers
  // and their caches; links to other workbooks, with the values they cache;
  // rich values and their metadata; chart sheets; queries and their
  // connections; and embedded objects. The theme, the calculation chain and
  // printer settings hold no content.
  /^xl\/threadedComments\/threadedComment\d+\.xml$/,
  /^xl\/persons\/person\d*\.xml$/,
  /^xl\/drawings\/drawing\d+\.xml$/,
  /^xl\/drawings\/vmlDrawing\d+\.vml$/,
  /^xl\/diagrams\/[^/]+\.xml$/,
  /^xl\/charts\/chartEx\d+\.xml$/,
  /^xl\/pivotCache\/pivotCache(?:Definition|Records)\d+\.xml$/,
  /^xl\/tables\/table\d+\.xml$/,
  /^xl\/slicers\/slicer\d+\.xml$/,
  /^xl\/slicerCaches\/slicerCache\d+\.xml$/,
  /^xl\/externalLinks\/externalLink\d+\.xml$/,
  /^xl\/richData\/[^/]+\.xml$/,
  /^xl\/metadata\.xml$/,
  /^xl\/chartsheets\/sheet\d+\.xml$/,
  /^xl\/queryTables\/queryTable\d+\.xml$/,
  /^xl\/connections\.xml$/,
  /^xl\/embeddings\/.+$/,
];

const BINDABLE_PARTS: Readonly<Record<PackageKind, readonly RegExp[]>> = {
  'text-document': WORDPROCESSING_BINDABLE_PARTS,
  workbook: SPREADSHEET_BINDABLE_PARTS,
};

// The parts of a package, given by name, that its whole-document binding
// references, by the package's format.
export function bindablePartsOf(parts: readonly string[], kind: PackageKind): string[] {
  return BINDABLE_PARTS[kind].flatMap((pattern) => parts.filter((part) => pattern.test(part)).sort());
}

// The content types of the parts that are not XML, which a DataReference
// states (ADatP-4778.2 Annex A), by extension: pictures, embedded objects and
// packages, and legacy VML drawings, which Office does not write as
// well-formed XML.
const NON_XML_CONTENT_TYPES: Readonly<Record<string, string>> = {
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
  bin: 'application/vnd.openxmlformats-officedocument.oleObject',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  doc: 'application/msword',
  ppt: 'application/vnd.ms-powerpoint',
  vml: 'application/vnd.openxmlformats-officedocument.vmlDrawing',
};

// ADatP-4778.2 OOXML profile: one BindingInformation part whose DataReference
// elements point at package parts with pack:/// URIs; Data elements are not
// used. The panel writes the binding unsigned, which the profile allows; the
// policy service signs it again for each save the portal stores.
export function serializeDocumentBinding(labelXml: string, parts: readonly string[]): string {
  const references = parts
    .map((part) => {
      const type = NON_XML_CONTENT_TYPES[part.slice(part.lastIndexOf('.') + 1).toLowerCase()];
      const contentType = type === undefined ? '' : ` xmime:contentType="${type}"`;
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
