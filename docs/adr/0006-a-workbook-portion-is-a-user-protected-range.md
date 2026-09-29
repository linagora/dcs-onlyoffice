# A workbook portion is an ONLYOFFICE user protected range, which the panel lifts to write it

In a workbook, a protected portion's placeholder is a range of cells, and nothing in SpreadsheetML plays the part of the text editor's locked content control, which both marks where a portion sits and keeps authors from typing into it. The placeholder is therefore an ONLYOFFICE user protected range, titled with the portion's id, that lets no author edit it through the editor: it follows inserted rows and columns, and the spreadsheet editor refuses typing, pasting, cutting, sorting or deleting rows over it. As a text document's placeholder, it changes only through the labelling panel: any author who can read the portion changes or deletes it under the portion lock, and the panel lifts the range's lock and restores it within its own editor command, through the editor's internal model, since the public API lets no one but a range's editors write it, change it or remove it. The portion's Custom XML part stays as in a text document, with its id, its label in clear and its envelope; a portion counts, for the document label, access and the journal, when both its range and its part are present.

## Considered Options

- **The inserting author as the range's only editor**, through the public API alone: only that author could then change or delete the portion, unlike in a text document, where any author who can read it does. It remains the fallback should the editor's internal model not let the panel lift the lock.
- **Every person cleared for the portion's label as the range's editors**: the file would carry the names of the people cleared for each label, which ages with the clearance directory.
- **Sheet protection**, which Microsoft Excel also honours: it locks the whole sheet, so every other cell would have to be unlocked, including the ones authors add later; it refuses the panel's own writes; and ONLYOFFICE 9.4 has no public API to lift and restore it.
- **A hidden defined name** as the anchor, which is standard: the public API creates it through the user interface's path, which waits for a server lock in co-editing, so the name appears after the command and outside its undo step; and it locks nothing.
- **No lock**, the panel repairing a changed placeholder afterwards: an author could type protected text into the cells, which would then reach ONLYOFFICE.

## Consequences

- The panel relies on undocumented parts of the editor's internal model to lift a range's lock, to restore it and to remove a range, as it does for sheet headers and footers; the end-to-end tests guard them, and a new version of ONLYOFFICE may break them.
- The range is an ONLYOFFICE extension: Microsoft Excel keeps it in the file but does not enforce it, and each browser enforces it for its own user.
- A co-author who deletes a whole sheet removes its portions' ranges, and the next save logs them as removed.
