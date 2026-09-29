import type { SpreadsheetApi } from './office-api.ts';
import type { CommandScope, DocumentSnapshot } from './portions.ts';

// The commands the panel runs in the spreadsheet editor. As those of the
// text editor, each is serialised with toString() and runs in the editor's
// sandbox, where it may only use `Api` and `Asc.scope`.

declare const Api: SpreadsheetApi;
declare const Asc: { scope: CommandScope };

// What a workbook holds of the panel's parts, as the text editor's command
// reads a document: a workbook has neither placeholders nor page markings
// the panel reads.
export function readWorkbookCommand(): DocumentSnapshot {
  const parts = Api.GetActiveSheet().GetCustomXmlParts();
  return {
    controls: [],
    portionParts: parts.GetByNamespace(Asc.scope.portionNamespace).map((part) => part.GetXml()),
    documentParts: parts.GetByNamespace(Asc.scope.documentNamespace).map((part) => part.GetXml()),
    headersAndFooters: [],
  };
}

// One command writes the document label's parts, the ADatP-4778.2 binding
// and the base label's, so that a single undo reverts both.
export function writeWorkbookLabelCommand(): boolean {
  const parts = Api.GetActiveSheet().GetCustomXmlParts();
  for (const replacement of Asc.scope.replacements) {
    for (const existing of parts.GetByNamespace(replacement.namespace)) {
      existing.Delete();
    }
    parts.Add(replacement.xml);
  }
  return true;
}
