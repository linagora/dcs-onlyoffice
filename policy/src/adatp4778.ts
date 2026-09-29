import type JSZip from 'jszip';
import { escapeXml } from './adatp4774.ts';
import { CONTENT_TYPES_PART, customXmlParts, mainPartOf, PACKAGE_RELATIONSHIPS_PART, type PackageKind, partNamesOf, RELATIONSHIPS_PART } from './opc.ts';

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

// ADatP-4778.2 Tables 5-2 and 5-3 for WordprocessingML, in reference order,
// then the parts that can hold a text document's content that the tables
// leave out.
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
  // The people who comment, and the comments' identifiers and extensible
  // form, which Word writes beside them; the glossary, which holds building
  // blocks and the placeholders of content controls, and its styles; charts,
  // their colours and styles, the charts of Word 2016 and the shapes drawn on
  // charts; SmartArt diagrams; embedded objects, ink and ActiveX controls;
  // and the thumbnail, a picture of the first page. The theme, the font
  // table, the settings, the web settings and the numbering definitions hold
  // no content.
  /^word\/people\.xml$/,
  /^word\/commentsIds\.xml$/,
  /^word\/commentsExtensible\.xml$/,
  /^word\/glossary\/(?:document|styles)\.xml$/,
  /^word\/charts\/(?:chart|chartEx|colors|styles?)\d+\.xml$/,
  /^word\/drawings\/[^/]+\.xml$/,
  /^word\/diagrams\/[^/]+\.xml$/,
  /^word\/embeddings\/.+$/,
  /^word\/ink\/.+$/,
  /^word\/activeX\/.+$/,
  /^docProps\/thumbnail\.[^/]+$/,
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
  // connections; embedded objects, ActiveX and form controls, and ink; and
  // the thumbnail, a picture of the first sheet. The theme, the calculation
  // chain and printer settings hold no content.
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
  /^xl\/activeX\/.+$/,
  /^xl\/ctrlProps\/.+$/,
  /^xl\/ink\/.+$/,
  /^docProps\/thumbnail\.[^/]+$/,
];

const BINDABLE_PARTS: Readonly<Record<PackageKind, readonly RegExp[]>> = {
  'text-document': WORDPROCESSING_BINDABLE_PARTS,
  workbook: SPREADSHEET_BINDABLE_PARTS,
};

// The folder where Office and ONLYOFFICE write the Custom XML parts and
// their properties parts.
const CUSTOM_XML_FOLDER = /^customXml\/[^/]+$/;

// The parts of a package that its whole-document binding references: those
// of ADatP-4778.2 Tables 5-2 and 5-3 and the others that can hold content, by
// the package's format; its Custom XML parts, which hold the base label and
// the portions, wherever they are; and its plumbing, the relationship parts
// and the content types, which a part added or re-targeted changes. The
// binding part holds the signature over the others: it is left out.
export async function bindablePartsOf(zip: JSZip, bindingPart: string | null): Promise<string[]> {
  const parts = partNamesOf(zip);
  const kind = (await mainPartOf(zip))?.kind ?? 'text-document';
  const related = await customXmlParts(zip);
  const customXml = parts.filter((part) => CUSTOM_XML_FOLDER.test(part) || related.includes(part)).sort();
  const plumbing = parts.filter((part) => part === PACKAGE_RELATIONSHIPS_PART || RELATIONSHIPS_PART.test(part) || part === CONTENT_TYPES_PART).sort();
  const referenced = [...partsMatching(parts, BINDABLE_PARTS[kind]), ...customXml, ...plumbing];
  return [...new Set(referenced)].filter((part) => part !== bindingPart);
}

// The parts that match each pattern in turn.
function partsMatching(parts: readonly string[], patterns: readonly RegExp[]): string[] {
  return patterns.flatMap((pattern) => parts.filter((part) => pattern.test(part)).sort());
}

// The content types of the parts that are not XML, by extension, for a part
// whose package declares none: pictures, embedded objects and packages, and
// legacy VML drawings, which Office does not write as well-formed XML.
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

// A content type of XML: application/xml, text/xml or one of their +xml
// forms.
const XML_CONTENT_TYPE = /^(?:application|text)\/(?:[^;]+\+)?xml\s*(?:;|$)/i;

// ADatP-4778.2 OOXML profile: one BindingInformation part whose DataReference
// elements point at package parts with pack:/// URIs; Data elements are not
// used. A reference to a part that is not XML states its content type, as
// Annex A requires: the one `contentTypes` gives, as the package declares it,
// or else the one its extension gives. The panel writes the binding
// unsigned, which the profile allows; the policy service signs it again for
// each save the portal stores.
export function serializeDocumentBinding(labelXml: string, parts: readonly string[], contentTypes: ReadonlyMap<string, string> = new Map()): string {
  const references = parts
    .map((part) => {
      const declared = contentTypes.get(part);
      const type = declared === undefined ? NON_XML_CONTENT_TYPES[part.slice(part.lastIndexOf('.') + 1).toLowerCase()] : declared;
      const contentType = type === undefined || XML_CONTENT_TYPE.test(type) ? '' : ` xmime:contentType="${escapeXml(type)}"`;
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

// The address of a package part, as DataReferences give it: absolute from
// the package root, each segment of the name percent-encoded as a URI
// component. The names Office and ONLYOFFICE write keep their spelling, but
// for the brackets of [Content_Types].xml, which a URI cannot hold;
// packPartName decodes the address back to the name exactly.
export function packUri(part: string): string {
  return `${PACK_PREFIX}${part.split('/').map(encodeURIComponent).join('/')}`;
}

// The package part a DataReference URI names, null for a URI outside the
// package or one that decodes to no name.
export function packPartName(uri: string): string | null {
  if (!uri.startsWith(PACK_PREFIX)) {
    return null;
  }
  try {
    return decodeURIComponent(uri.slice(PACK_PREFIX.length));
  } catch (error: unknown) {
    if (error instanceof URIError) {
      return null;
    }
    throw error;
  }
}
