import type {
  CommandScope,
  DocumentSnapshot,
  PortionBlockScope,
  SelectionReading,
  SelectionReadingScope,
  SelectionScope,
  WriteOutcome,
} from './commands.ts';
import type { ApiRange, ApiWorksheet, InternalUserProtectedRange, SpreadsheetApi } from './office-api.ts';

// The commands the panel runs in the spreadsheet editor. As those of the
// text editor, each is serialised with toString() and runs in the editor's
// sandbox, where it may only use `Api` and `Asc.scope`.

declare const Api: SpreadsheetApi;
declare const Asc: { scope: CommandScope & SelectionScope & SelectionReadingScope };

// What a workbook holds of the panel's parts, its user protected ranges, on
// every sheet, which the portions' placeholders are, the centre section of
// every sheet's six headers and footers, where the page marking goes, and
// whether the author types in a cell.
export function readWorkbookCommand(): DocumentSnapshot {
  // A header or footer string's sections. Codes are "&" and one character,
  // "&&" an ampersand; text before any section code is centred. The write
  // command holds the same function, since a command can share none.
  const sectionsOf = (value: string): { L: string; C: string; R: string } => {
    const sections = { L: '', C: '', R: '' };
    let section: 'L' | 'C' | 'R' = 'C';
    for (let index = 0; index < value.length; index += 1) {
      const code = value[index] === '&' ? (value[index + 1] ?? '') : null;
      if (code === 'L' || code === 'C' || code === 'R') {
        section = code;
      } else {
        sections[section] += code === null ? (value[index] ?? '') : `&${code}`;
      }
      index += code === null ? 0 : 1;
    }
    return sections;
  };
  const parts = Api.GetActiveSheet().GetCustomXmlParts();
  return {
    controls: [],
    ranges: Api.GetSheets().flatMap((sheet) =>
      (sheet.worksheet.userProtectedRanges ?? []).map((range) => ({ title: range.name, reference: range.asc_getRef() ?? '' })),
    ),
    portionParts: parts.GetByNamespace(Asc.scope.portionNamespace).map((part) => part.GetXml()),
    documentParts: parts.GetByNamespace(Asc.scope.documentNamespace).map((part) => part.GetXml()),
    headersAndFooters: [],
    sheets: Api.GetSheets().map((sheet) => {
      const headerFooter = sheet.worksheet.headerFooter;
      const strings = [
        headerFooter.getOddHeader(),
        headerFooter.getOddFooter(),
        headerFooter.getEvenHeader(),
        headerFooter.getEvenFooter(),
        headerFooter.getFirstHeader(),
        headerFooter.getFirstFooter(),
      ];
      return {
        centres: strings.map((data) => (data === null ? null : sectionsOf(data.getStr()).C)),
        differentFirst: headerFooter.getDifferentFirst() === true,
        differentOddEven: headerFooter.getDifferentOddEven() === true,
      };
    }),
    cellBeingEdited: Api.GetActiveSheet().worksheet.workbook.oApi.asc_getCellEditMode(),
  };
}

// The selected cells whose content the panel protects, with their displayed
// values, as a copy from the grid gives them. The panel refuses them while
// the author types in a cell, since the editor holds back what they type;
// when the selection holds several blocks of cells, more cells than a
// portion's text can hold, a merge, a portion, a table or a pivot table,
// which clearing the cells would break, a comment, which would stay in clear,
// or a formula, which the author turns into its value first; and when the
// cells hold nothing at all.
export function readSelectionCommand(): SelectionReading {
  const sheet = Api.GetActiveSheet();
  if (sheet.worksheet.workbook.oApi.asc_getCellEditMode()) {
    return { status: 'refused', reason: 'cell-being-edited' };
  }
  const selection = sheet.GetSelection();
  if (selection.GetAreas().GetCount() > 1) {
    return { status: 'refused', reason: 'several-areas' };
  }
  // Counted before anything is read: a selected column holds a million cells.
  if (selection.GetCellsCount() > Asc.scope.cellLimit) {
    return { status: 'refused', reason: 'too-large' };
  }
  const { bbox } = selection.range;
  const worksheet = sheet.worksheet;
  if (
    selection.range.hasMerged() !== null ||
    worksheet.isUserProtectedRangesIntersection(bbox, null, true) ||
    worksheet.autoFilters.isIntersectionTable(bbox) === true ||
    worksheet.getPivotTablesIntersectingRange(bbox).length > 0
  ) {
    return { status: 'refused', reason: 'merge-portion-or-table' };
  }
  if (worksheet.aComments.some((comment) => !comment.asc_getDocumentFlag() && bbox.contains(comment.nCol, comment.nRow))) {
    return { status: 'refused', reason: 'comment' };
  }
  let formula = false;
  selection.ForEach((cell) => {
    formula ||= cell.GetFormula().startsWith('=');
  });
  if (formula) {
    return { status: 'refused', reason: 'formula' };
  }
  const text = selection.GetText();
  const texts = typeof text === 'string' ? [[text]] : text;
  if (texts.every((row) => row.every((value) => value.trim() === ''))) {
    return { status: 'refused', reason: 'empty' };
  }
  return { status: 'read', cells: { sheet: sheet.GetName(), address: selection.GetAddress(true, true, 'xlA1', false) ?? '', texts } };
}

// One command writes a new portion into the selected cells or in place of the
// cells whose content the panel protects, a portion's change or its deletion,
// if there is one, with the document label's parts and the page marking of
// every sheet, in one step of the editor's history. The placeholder merges
// the cells, shows the portion's marking in its label's colour, bold and
// bordered, and is a user protected range titled with the portion's id, which
// no one may edit through the editor (ADR 0006). Selected cells that hold a
// value, a formula, a merge or another portion are refused, and nothing is
// written; nor is anything when the cells to protect no longer show what the
// panel read, when the portion to change or delete is gone, or when the
// editor refuses to remove its range.
export function writeWorkbookLabellingCommand(): WriteOutcome {
  const scope = Asc.scope;
  const sheet = Api.GetActiveSheet();
  // The editor holds back whatever changes while its user types in a cell,
  // until they leave it: another author could meanwhile change the same
  // portion, and the workbook would end up with both versions.
  if (sheet.worksheet.workbook.oApi.asc_getCellEditMode()) {
    return 'cell-being-edited';
  }
  const parts = sheet.GetCustomXmlParts();
  const portion = scope.portion;
  // An insertion and a change show the marking alike.
  const showMarking = (cells: ApiRange, block: PortionBlockScope): void => {
    cells.SetValue(block.placeholder);
    cells.SetBold(true);
    cells.SetWrap(true);
    cells.SetAlignHorizontal('center');
    cells.SetAlignVertical('center');
    const hex = block.color ?? '#000000';
    const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
    const color = Api.CreateColorFromRGB(red ?? 0, green ?? 0, blue ?? 0);
    cells.SetFontColor(color);
    for (const edge of ['Top', 'Bottom', 'Left', 'Right'] as const) {
      cells.SetBorders(edge, 'Medium', color);
    }
  };
  if (portion !== null && (portion.kind === 'change' || portion.kind === 'deletion')) {
    // The portion's placeholder, a range titled with its id on any sheet,
    // and its part, found by the id its root element names however the
    // editor serialises it, as the text editor's command finds it, since a
    // command can share nothing with another.
    let placeholderSheet: ApiWorksheet | null = null;
    let protectedRange: InternalUserProtectedRange | null = null;
    for (const candidate of Api.GetSheets()) {
      const found = (candidate.worksheet.userProtectedRanges ?? []).find((range) => range.name === portion.id) ?? null;
      if (found !== null) {
        placeholderSheet = candidate;
        protectedRange = found;
        break;
      }
    }
    const portionParts = parts
      .GetByNamespace(scope.portionNamespace)
      .filter((part) => /<(?:[\w-]+:)?portion\b[^>]*?\sid=["']([^"']*)["']/.exec(part.GetXml())?.[1] === portion.id);
    if (placeholderSheet === null || protectedRange === null || portionParts.length === 0) {
      return 'not-written';
    }
    // The model asks the range before any edit of its cells or of itself:
    // answering yes for this command lifts its lock in this browser only,
    // outside the editor's history, so that co-authors never see it lifted.
    protectedRange.isUserCanEdit = () => true;
    try {
      const cells = placeholderSheet.GetRange(protectedRange.ref.getName());
      if (portion.kind === 'change') {
        // The new part goes in before the old one goes, so that the
        // envelope is never missing.
        parts.Add(portion.xml);
        for (const part of portionParts) {
          part.Delete();
        }
        showMarking(cells, portion.block);
      } else {
        // The range goes first: should the editor refuse to remove it,
        // nothing is written, and the portion stays whole.
        if (placeholderSheet.worksheet.editUserProtectedRanges(protectedRange, null, true) === false) {
          return 'not-written';
        }
        cells.UnMerge();
        cells.Clear();
        for (const part of portionParts) {
          part.Delete();
        }
      }
    } finally {
      Reflect.deleteProperty(protectedRange, 'isUserCanEdit');
    }
  }
  // Cells that hold a merge or a portion's range, whoever may edit it, and
  // cells that hold a formula, even one whose result is empty, take no
  // portion.
  const holdsMergeOrPortion = (cellsSheet: ApiWorksheet, cells: ApiRange): boolean =>
    cells.range.hasMerged() !== null || cellsSheet.worksheet.isUserProtectedRangesIntersection(cells.range.bbox, null, true);
  const holdsFormula = (cells: ApiRange): boolean => {
    let formula = false;
    cells.ForEach((cell) => {
      formula ||= cell.GetFormula().startsWith('=');
    });
    return formula;
  };
  // An insertion and a protection make the placeholder alike, in empty cells.
  const addPlaceholder = (cellsSheet: ApiWorksheet, cells: ApiRange, added: { id: string; block: PortionBlockScope; xml: string }): void => {
    cells.Merge(false);
    showMarking(cells, added.block);
    // A sheet's name is quoted in a reference, its quotes doubled.
    const reference = `'${cellsSheet.GetName().replace(/'/g, "''")}'!${cells.GetAddress(true, true, 'xlA1', false) ?? ''}`;
    const created = cellsSheet.AddProtectedRange(added.id, reference);
    for (const editor of created.GetAllUsers() ?? []) {
      created.DeleteUser(editor.GetId());
    }
    parts.Add(added.xml);
  };
  if (portion !== null && portion.kind === 'insertion') {
    const selection = sheet.GetSelection();
    let occupied = holdsMergeOrPortion(sheet, selection) || holdsFormula(selection);
    selection.ForEach((cell) => {
      const value = cell.GetValue();
      occupied ||= value !== '' && value !== null && value !== undefined;
    });
    if (occupied) {
      return 'cells-occupied';
    }
    addPlaceholder(sheet, selection, portion);
  }
  if (portion !== null && portion.kind === 'protection') {
    // The cells the author confirmed, wherever the selection went since: they
    // must still show what the panel read, which the portion's envelope
    // holds, with nothing that the panel refuses, which a co-author may have
    // added since.
    const { sheet: sheetName, address, texts } = portion.cells;
    const cellsSheet = Api.GetSheets().find((candidate) => candidate.GetName() === sheetName) ?? null;
    if (cellsSheet === null) {
      return 'selection-changed';
    }
    const confirmed = cellsSheet.GetRange(address);
    const shown = confirmed.GetText();
    const { bbox } = confirmed.range;
    const worksheet = cellsSheet.worksheet;
    const unchanged =
      JSON.stringify(typeof shown === 'string' ? [[shown]] : shown) === JSON.stringify(texts) &&
      worksheet.autoFilters.isIntersectionTable(bbox) !== true &&
      worksheet.getPivotTablesIntersectingRange(bbox).length === 0 &&
      !worksheet.aComments.some((comment) => !comment.asc_getDocumentFlag() && bbox.contains(comment.nCol, comment.nRow));
    if (!unchanged || holdsMergeOrPortion(cellsSheet, confirmed) || holdsFormula(confirmed)) {
      return 'selection-changed';
    }
    // Their data validation and conditional formatting go with their content.
    confirmed.Clear();
    addPlaceholder(cellsSheet, confirmed, portion);
  }
  for (const replacement of scope.replacements) {
    for (const existing of parts.GetByNamespace(replacement.namespace)) {
      existing.Delete();
    }
    parts.Add(replacement.xml);
  }
  // The page marking goes in the centre of each sheet's six headers and
  // footers, which Microsoft Excel allows up to 255 characters each, codes
  // included: the left and right sections stay as long as they fit, the
  // right one giving way first. A marking too long to fit on its own is
  // written whole. Even and first pages that printed the odd pages' strings
  // start from them; those that had their own keep theirs, empty or not.
  const sectionsOf = (value: string): { L: string; C: string; R: string } => {
    const sections = { L: '', C: '', R: '' };
    let section: 'L' | 'C' | 'R' = 'C';
    for (let index = 0; index < value.length; index += 1) {
      const code = value[index] === '&' ? (value[index + 1] ?? '') : null;
      if (code === 'L' || code === 'C' || code === 'R') {
        section = code;
      } else {
        sections[section] += code === null ? (value[index] ?? '') : `&${code}`;
      }
      index += code === null ? 0 : 1;
    }
    return sections;
  };
  const centre = scope.pageMarking.headerFooterCentre;
  const marked = (current: string): string => {
    const { L, R } = sectionsOf(current);
    const compose = (left: string, right: string): string => `${left === '' ? '' : `&L${left}`}&C${centre}${right === '' ? '' : `&R${right}`}`;
    const candidates = [compose(L, R), compose(L, ''), compose('', R), compose('', '')];
    return candidates.find((candidate) => candidate.length <= 255) ?? compose('', '');
  };
  for (const sheet of Api.GetSheets()) {
    const headerFooter = sheet.worksheet.headerFooter;
    const oddHeader = headerFooter.getOddHeader()?.getStr() ?? '';
    const oddFooter = headerFooter.getOddFooter()?.getStr() ?? '';
    const ownEven = headerFooter.getDifferentOddEven() === true;
    const ownFirst = headerFooter.getDifferentFirst() === true;
    headerFooter.setOddHeader(marked(oddHeader));
    headerFooter.setOddFooter(marked(oddFooter));
    headerFooter.setEvenHeader(marked(ownEven ? (headerFooter.getEvenHeader()?.getStr() ?? '') : oddHeader));
    headerFooter.setEvenFooter(marked(ownEven ? (headerFooter.getEvenFooter()?.getStr() ?? '') : oddFooter));
    headerFooter.setFirstHeader(marked(ownFirst ? (headerFooter.getFirstHeader()?.getStr() ?? '') : oddHeader));
    headerFooter.setFirstFooter(marked(ownFirst ? (headerFooter.getFirstFooter()?.getStr() ?? '') : oddFooter));
    headerFooter.setDifferentFirst(true);
    headerFooter.setDifferentOddEven(true);
  }
  return 'written';
}

// The title of the user protected range, a portion's placeholder, that holds
// the active sheet's active cell; null when none does.
export function placeholderAtActiveCellCommand(): string | null {
  const worksheet = Api.GetActiveSheet().worksheet;
  const { row, col } = worksheet.selectionRange.activeCell;
  return (worksheet.userProtectedRanges ?? []).find((range) => range.contains(col, row))?.name ?? null;
}

// Selects a portion's placeholder, on whichever sheet it is, which becomes
// the active one; false when no sheet holds it.
export function selectPlaceholderCommand(): boolean {
  for (const sheet of Api.GetSheets()) {
    const range = (sheet.worksheet.userProtectedRanges ?? []).find((candidate) => candidate.name === Asc.scope.rangeTitle);
    if (range !== undefined) {
      sheet.SetActive();
      sheet.GetRange(range.ref.getName()).Select();
      return true;
    }
  }
  return false;
}
