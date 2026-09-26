import { escapeXml } from './adatp4774.ts';

export const BINDING_NAMESPACE = 'urn:nato:stanag:4778:bindinginformation:1:0';

const XMIME_NAMESPACE = 'http://www.w3.org/2005/05/xmlmime';

// Parts a DOCX saved by ONLYOFFICE always contains among those of ADatP-4778.2
// Tables 5-2 and 5-3. The portal lists the actual parts at every save.
export const DEFAULT_DOCUMENT_PARTS: readonly string[] = [
  'word/document.xml',
  'word/styles.xml',
  'word/footnotes.xml',
  'word/endnotes.xml',
  'docProps/core.xml',
  'docProps/app.xml',
];

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
// used. The binding is unsigned, which the profile allows.
export function serializeDocumentBinding(labelXml: string, parts: readonly string[]): string {
  const references = parts
    .map((part) => {
      const mediaType = MEDIA_TYPES[part.slice(part.lastIndexOf('.') + 1).toLowerCase()];
      const contentType = mediaType === undefined ? '' : ` xmime:contentType="${mediaType}"`;
      return `<mb:DataReference URI="pack:///${escapeXml(part)}"${contentType}/>`;
    })
    .join('');
  return (
    `<mb:BindingInformation xmlns:mb="${BINDING_NAMESPACE}" xmlns:xmime="${XMIME_NAMESPACE}">` +
    '<mb:MetadataBindingContainer><mb:MetadataBinding Id="mb-document">' +
    `<mb:Metadata>${labelXml}</mb:Metadata>` +
    references +
    '</mb:MetadataBinding></mb:MetadataBindingContainer></mb:BindingInformation>'
  );
}
