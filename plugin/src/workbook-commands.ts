import type { CommandScope, DocumentSnapshot, WriteOutcome } from './commands.ts';
import type { SpreadsheetApi } from './office-api.ts';

// The commands the panel runs in the spreadsheet editor. As those of the
// text editor, each is serialised with toString() and runs in the editor's
// sandbox, where it may only use `Api` and `Asc.scope`.

declare const Api: SpreadsheetApi;
declare const Asc: { scope: CommandScope };

// What a workbook holds of the panel's parts, its user protected ranges, on
// every sheet, which the portions' placeholders are, and the centre section
// of every sheet's six headers and footers, where the page marking goes.
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
  };
}

// One command writes a new portion into the selected cells, if there is one,
// with the document label's parts and the page marking of every sheet, so
// that a single undo reverts all of them. The placeholder merges the cells,
// shows the portion's marking in its label's colour, bold and bordered, and
// is a user protected range titled with the portion's id, which no one may
// edit through the editor (ADR 0006). Selected cells that hold a value, a
// formula, a merge or another portion are refused, and nothing is written.
// Changes and deletions of a workbook's portions are not written.
export function writeWorkbookLabellingCommand(): WriteOutcome {
  const scope = Asc.scope;
  const sheet = Api.GetActiveSheet();
  const parts = sheet.GetCustomXmlParts();
  const portion = scope.portion;
  if (portion !== null && portion.kind !== 'insertion') {
    return 'not-written';
  }
  if (portion !== null) {
    const selection = sheet.GetSelection();
    let occupied = selection.range.hasMerged() !== null || sheet.worksheet.isUserProtectedRangesIntersection(selection.range.bbox, null, true);
    // A formula counts even when its result is empty.
    selection.ForEach((cell) => {
      const value = cell.GetValue();
      occupied ||= cell.GetFormula().startsWith('=') || (value !== '' && value !== null && value !== undefined);
    });
    if (occupied) {
      return 'cells-occupied';
    }
    selection.Merge(false);
    selection.SetValue(portion.block.placeholder);
    selection.SetBold(true);
    selection.SetWrap(true);
    selection.SetAlignHorizontal('center');
    selection.SetAlignVertical('center');
    const hex = portion.block.color ?? '#000000';
    const [red, green, blue] = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
    const color = Api.CreateColorFromRGB(red ?? 0, green ?? 0, blue ?? 0);
    selection.SetFontColor(color);
    for (const edge of ['Top', 'Bottom', 'Left', 'Right'] as const) {
      selection.SetBorders(edge, 'Medium', color);
    }
    // A sheet's name is quoted in a reference, its quotes doubled.
    const reference = `'${sheet.GetName().replace(/'/g, "''")}'!${selection.GetAddress(true, true, 'xlA1', false) ?? ''}`;
    const range = sheet.AddProtectedRange(portion.id, reference);
    for (const editor of range.GetAllUsers() ?? []) {
      range.DeleteUser(editor.GetId());
    }
    parts.Add(portion.xml);
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
