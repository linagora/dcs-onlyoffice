import JSZip from 'jszip';
import { inspectPackage, type PackageInspection } from './docx.ts';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// ADatP-4778.2 Tables 5-2 and 5-3 for SpreadsheetML, chart styles under the
// table's name and under the one Microsoft Excel and ONLYOFFICE write.
const BINDABLE_PART =
  /^(xl\/(workbook|styles|sharedStrings)\.xml|xl\/worksheets\/sheet\d+\.xml|xl\/charts\/(chart|colors|styles?)\d+\.xml|xl\/pivotTables\/pivotTable\d+\.xml|xl\/comments\d+\.xml|xl\/media\/.+|docProps\/(core|app|custom)\.xml)$/;

export type XlsxInspection = PackageInspection;

export async function inspectXlsx(xlsx: Buffer): Promise<XlsxInspection> {
  return inspectPackage(await JSZip.loadAsync(xlsx), BINDABLE_PART);
}
