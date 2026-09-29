# A protected portion in a workbook is an ONLYOFFICE user protected range

In a workbook, a protected portion's placeholder is a range of cells, and nothing in SpreadsheetML plays the part of the text editor's locked content control, which both marks where a portion sits and keeps authors from typing into it. The placeholder is therefore an ONLYOFFICE user protected range, titled with the portion's id, whose only editor is the author who inserted the portion: it follows inserted rows and columns, the spreadsheet editor refuses every other author typing, pasting, cutting, sorting or deleting rows over it, and the labelling panel creates it within the insertion's own editor command. The portion's Custom XML part stays as in a text document, with its id, its label in clear and its envelope; a portion counts, for the document label, access and the journal, when both its range and its part are present.

## Considered Options

- **Sheet protection**, which Microsoft Excel also honours: it locks the whole sheet, so every other cell would have to be unlocked, including the ones authors add later; it refuses the panel's own writes; and ONLYOFFICE 9.4 has no public API to lift and restore it within a command.
- **A hidden defined name** as the anchor, which is standard: the public API creates it through the user interface's path, which waits for a server lock in co-editing, so the name appears after the command and outside its undo step; and it locks nothing.
- **No lock**, the panel repairing a changed placeholder afterwards: an author could type protected text into the cell, which would then reach ONLYOFFICE.

## Consequences

- Only the author who inserted a portion can change or delete it; other authors who can read it see it in the panel and the bubble.
- The range is an ONLYOFFICE extension: Microsoft Excel keeps it in the file but does not enforce it, and each browser enforces it for its own user.
- The public API cannot remove a range, so deleting a portion relies on the editor's internal model, which the end-to-end tests guard.
- A co-author who deletes a whole sheet removes its portions' ranges, and the next save logs them as removed.
