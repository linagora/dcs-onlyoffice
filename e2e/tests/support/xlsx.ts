import { DOMParser, type Element } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { inspectPackage, type PackageInspection, type RelationshipTargets, relationshipTargets } from './docx.ts';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// ADatP-4778.2 Tables 5-2 and 5-3 for SpreadsheetML, chart styles under the
// table's name and under the one Microsoft Excel and ONLYOFFICE write, and
// the parts that can hold a workbook's content that the tables leave out, as
// docs/research/onlyoffice-spreadsheets.md, section 11.4, lists them.
const BINDABLE_PART = new RegExp(
  '^(' +
    [
      String.raw`xl/(workbook|styles|sharedStrings|metadata|connections)\.xml`,
      String.raw`xl/worksheets/sheet\d+\.xml`,
      String.raw`xl/charts/(chart|colors|styles?)\d+\.xml`,
      String.raw`xl/pivotTables/pivotTable\d+\.xml`,
      String.raw`xl/comments\d+\.xml`,
      String.raw`xl/media/.+`,
      String.raw`docProps/(core|app|custom)\.xml`,
      String.raw`xl/threadedComments/threadedComment\d+\.xml`,
      String.raw`xl/persons/person\d*\.xml`,
      String.raw`xl/drawings/(drawing\d+\.xml|vmlDrawing\d+\.vml)`,
      String.raw`xl/diagrams/[^/]+\.xml`,
      String.raw`xl/charts/chartEx\d+\.xml`,
      String.raw`xl/pivotCache/pivotCache(Definition|Records)\d+\.xml`,
      String.raw`xl/tables/table\d+\.xml`,
      String.raw`xl/slicers/slicer\d+\.xml`,
      String.raw`xl/slicerCaches/slicerCache\d+\.xml`,
      String.raw`xl/externalLinks/externalLink\d+\.xml`,
      String.raw`xl/richData/[^/]+\.xml`,
      String.raw`xl/chartsheets/sheet\d+\.xml`,
      String.raw`xl/queryTables/queryTable\d+\.xml`,
      String.raw`xl/(embeddings|activeX|ctrlProps|ink)/.+`,
      String.raw`docProps/thumbnail\.[^/]+`,
    ].join('|') +
    ')$',
);
const SPREADSHEET_NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORKSHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/;
// The extension in which ONLYOFFICE writes a sheet's user protected ranges.
const USER_PROTECTED_RANGES_EXTENSION = '{231B7EB2-2AFC-4442-B178-5FFDF5851E7C}';

export interface UserProtectedRange {
  name: string | null;
  reference: string | null;
  // The ids of the users the range lists, whatever they may do.
  users: string[];
}

// A sheet's six header and footer strings, null where it has none, and
// whether first and even pages have their own.
export interface SheetHeadersAndFooters {
  strings: Record<HeaderFooterName, string | null>;
  differentFirst: boolean;
  differentOddEven: boolean;
}

export const HEADER_FOOTER_NAMES = ['oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter'] as const;
export type HeaderFooterName = (typeof HEADER_FOOTER_NAMES)[number];

// A link on a sheet's cells: the cells it covers, and the address its
// relationship targets, null for a place in the workbook.
export interface SheetLink {
  reference: string | null;
  target: string | null;
}

export interface WorksheetInspection {
  part: string;
  userProtectedRanges: UserProtectedRange[];
  mergedCells: string[];
  links: SheetLink[];
  headersAndFooters: SheetHeadersAndFooters;
  // The text of each cell that holds one, by reference, shared strings
  // resolved.
  cellTexts: Map<string, string>;
}

export interface XlsxInspection extends PackageInspection {
  worksheets: WorksheetInspection[];
}

// Whether every sheet of a stored workbook shows a centre section in its six
// headers and footers, with the flags that make them count.
export function everySheetShows(xlsx: XlsxInspection, centre: string): boolean {
  return (
    xlsx.worksheets.length > 0 &&
    xlsx.worksheets.every(
      ({ headersAndFooters }) =>
        headersAndFooters.differentFirst &&
        headersAndFooters.differentOddEven &&
        HEADER_FOOTER_NAMES.every((name) => headersAndFooters.strings[name]?.includes(centre) === true),
    )
  );
}

export async function inspectXlsx(xlsx: Buffer): Promise<XlsxInspection> {
  const zip = await JSZip.loadAsync(xlsx);
  const sharedStrings = await readSharedStrings(zip);
  const worksheets: WorksheetInspection[] = [];
  for (const part of Object.keys(zip.files).filter((name) => WORKSHEET_PART.test(name)).sort()) {
    const sheet = parse((await zip.file(part)?.async('string')) ?? '');
    worksheets.push(readWorksheet(part, sheet, sharedStrings, await relationshipTargets(zip, part)));
  }
  return { ...(await inspectPackage(zip, BINDABLE_PART)), worksheets };
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (xml === undefined) {
    return [];
  }
  return elements(parse(xml), 'si').map((item) =>
    elements(item, 't')
      .map((text) => text.textContent ?? '')
      .join(''),
  );
}

function readWorksheet(part: string, sheet: Element, sharedStrings: string[], targets: RelationshipTargets): WorksheetInspection {
  const extensions = elements(sheet, 'ext').filter((extension) => extension.getAttribute('uri') === USER_PROTECTED_RANGES_EXTENSION);
  const cellTexts = new Map<string, string>();
  for (const cell of elements(sheet, 'c')) {
    const value = elements(cell, 'v')[0]?.textContent ?? null;
    const inline = elements(cell, 't')
      .map((text) => text.textContent ?? '')
      .join('');
    const text = cell.getAttribute('t') === 's' ? (sharedStrings[Number(value)] ?? null) : cell.getAttribute('t') === 'inlineStr' ? inline : value;
    if (text !== null) {
      cellTexts.set(cell.getAttribute('r') ?? '', text);
    }
  }
  const headerFooter = elements(sheet, 'headerFooter')[0];
  const flag = (name: string): boolean => ['1', 'true'].includes(headerFooter?.getAttribute(name) ?? '');
  const strings = Object.fromEntries(
    HEADER_FOOTER_NAMES.map((name) => [name, headerFooter === undefined ? null : (elements(headerFooter, name)[0]?.textContent ?? null)]),
  ) as Record<HeaderFooterName, string | null>; // SAFETY: an entry for each name, built just above
  return {
    part,
    headersAndFooters: { strings, differentFirst: flag('differentFirst'), differentOddEven: flag('differentOddEven') },
    userProtectedRanges: extensions
      .flatMap((extension) => elements(extension, 'userProtectedRange'))
      .map((range) => ({
        name: range.getAttribute('name'),
        reference: range.getAttribute('sqref'),
        users: elements(range, 'user').map((user) => user.getAttribute('id') ?? ''),
      })),
    mergedCells: elements(sheet, 'mergeCell').map((merge) => merge.getAttribute('ref') ?? ''),
    links: elements(sheet, 'hyperlink').map((link) => ({
      reference: link.getAttribute('ref'),
      target: targets.get(link.getAttributeNS(RELATIONSHIP_NAMESPACE, 'id')) ?? null,
    })),
    cellTexts,
  };
}

function parse(xml: string): Element {
  const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
  if (root === null) {
    throw new Error('Unparsable XML part');
  }
  return root;
}

function elements(parent: Element, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS(SPREADSHEET_NAMESPACE, localName));
}
