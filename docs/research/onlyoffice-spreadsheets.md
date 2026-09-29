# ONLYOFFICE Docs 9.4 spreadsheet editor: protected portions, locks, page marking and the binding in XLSX

Research notes compiled on 2026-09-28 for iteration 6, which brings the text editor's labelling functions to cells
and ranges of the spreadsheet editor, with the exit criterion that the demo scenario is replayed in a workbook.

**Scope.** The spreadsheet editor (editor type `cell`, XLSX) of ONLYOFFICE Docs Community Edition 9.4.0.1, seen from
the project's labelling panel plugin: how a protected portion can be identified, shown, locked and stored in a
workbook; what the editor's save path keeps; plugin events, windows and view mode; co-editing and undo; the paths
through which a value could reach ONLYOFFICE; the page marking in sheet headers and footers; the ADatP-4778.2 binding
of a SpreadsheetML package; Purview label metadata in an XLSX; and what in this repository is DOCX-specific. The
Document Server's deployment, JWT, callbacks and plugin loading are the same for both editors and are covered by
[onlyoffice-integration.md](onlyoffice-integration.md). XLSM, XLSB, ODS, CSV and the mobile editors are out of scope.
Nothing was run in a browser: what needs one is collected in [Open questions](#17-open-questions-need-a-live-editor).

**Sources.** ONLYOFFICE sdkjs, web-apps, core and server at tag `v9.4.0.129` (sdkjs `75b53d5`, web-apps `1993a6d`,
core `a016fc2`, server `13142e4`, the commits of [onlyoffice-integration.md](onlyoffice-integration.md#0-version-pinning)
and [microsoft-purview-labels.md](microsoft-purview-labels.md#1-sources)); the image `onlyoffice/documentserver:9.4.0.1`;
api.onlyoffice.com, which documents the latest release (9.4.1); ECMA-376 5th edition; [MS-OI29500] and
[MS-OFFCRYPTO]; the Open XML SPIF 2.1 schema; ADatP-4774, ADatP-4774.1, ADatP-4778, ADatP-4778.1 and ADatP-4778.2, the
same files as [labelling-standards.md](labelling-standards.md#1-sources) (checksums in
[section 16](#16-sha-256-of-the-documents-used)). Every claim carries a link, to the exact lines for source code. This
repository is linked at commit `2af1dd4` of `main`.

Conventions used below:

- **Mandated**: normative text of a standard or a specification (shall, must), or a constraint of its XML schema.
- **Guidance**: vendor documentation (api.onlyoffice.com; [MS-OI29500], Microsoft's statement of what Office does)
  and the informative ADatP-4774.1.
- **Implementation**: what code does, at the tag above or in this repository, which is not necessarily what its
  documentation says.
- **Tested**: checked during this research in throwaway containers of the image; the method is in
  [section 15](#15-how-the-tests-were-run).
- **Inference**: my reading, not stated by a source.
- **UNVERIFIED**: not confirmed by a primary source or a test.

## Key findings

1. **The plugin runs in the cell editor with two switches.** `EditorsSupport` must list `cell` in the plugin's
   `config.json` and in every `ShowWindow` variation, or the editor neither runs the plugin nor shows the window;
   `Asc.plugin.info.editorType` is `cell`. The right menu takes panel plugins as in the text editor, and, as in the
   text editor, it is only rendered in edit mode ([8](#8-panel-windows-and-view-mode)).
2. **No event follows the active cell.** None of the content-control events exists; `onTargetPositionChanged` fires
   only while a cell's or a shape's text is being edited, and `onClick` only on Ctrl+Space. What remains:
   `initOnSelectionChanged: true`, which calls the plugin's `init` again at every selection change, `onKeyDown` for
   every key, and `onChangeCurrentSheet`. Co-authors' changes raise nothing, so the 3-second reread stays
   ([6](#6-events-following-the-cursor-and-co-authors)).
3. **Custom XML parts work in an XLSX** (Tested). The spreadsheet API uses the text editor's classes and manager,
   reached through `ApiWorksheet.GetCustomXmlParts()`, which is workbook-wide despite its name. The editor's save path
   keeps `customXml/itemN.xml`, `itemPropsN.xml` and a relationship from `xl/workbook.xml`. The same serialiser
   defects apply: the item id loses its braces, and `&`, `<` or `"` in a value corrupt the part, which the next save
   truncates ([5](#5-custom-xml-parts-in-an-xlsx)).
4. **Two anchors follow the grid.** A hidden defined name (workbook or sheet scope) and an ONLYOFFICE user protected
   range both move with inserted rows and columns and survive save and reopen (Tested). A defined name's `comment` and
   cell metadata (`cm`) are dropped (Tested). Hidden names never show in the name manager or the name box. But
   `Api.AddDefName` goes through the user interface's path, which asks the server for a lock first: in co-editing the
   name is created after the command, outside its undo step (Implementation, [2](#2-identifying-a-portion)).
5. **The placeholder is a formatted, merged range** (Tested): `Merge`, `SetValue`, `SetFillColor`, `SetFontColor`,
   `SetBold`, `SetBorders`, alignment and wrap persist. Formulas that reference it get its stored value. A number
   format with a text section (`;;;"MARKING"`) can show the marking while the cell stores a token
   ([3](#3-the-placeholder)).
6. **No lock matches the text editor's locked content control** ([4](#4-locking)).
   - *User protected ranges* (ONLYOFFICE 8.1+, public API, per user, no password, an ONLYOFFICE-only worksheet
     extension) refuse typing, deleting, pasting, cutting, moving, filling, formatting, sorting, filtering and
     row or column deletion to every user who is not listed as an editor. A non-editor's plugin can still format the
     range, but its `SetValue` is silently skipped, and it cannot change the range, except through an `AddUser` quirk
     that changes only its own model (Tested with simulated users); the public API cannot remove a range at all.
     Enforcement is in each client only.
   - *Sheet protection* (ECMA-376, honoured by Excel, optional password) also refuses the plugin's own `ApiRange`
     writes (Tested), and 9.4 has no public API to protect, unprotect or unlock cells.
   - Deleting a whole sheet ignores both; only workbook structure protection stops it.
7. **The page marking can only go to print headers and footers.** A sheet has odd (default), first and even headers
   and footers, coloured with `&K` codes. There is no public API, but the internal model reachable from `callCommand`
   records history and persists (Tested). Excel limits each string to 255 characters; ONLYOFFICE's dialog enforces
   255, its model and save path do not (Tested). They are drawn only when printing, in print preview and in PDF: **the
   editor shows no page marking on screen** ([7](#7-page-marking-in-headers-and-footers)).
8. **Co-editing:** a plugin's command takes no cell lock, and the server relays changes without checking locks. In
   fast mode, the editor sends changes within 40 ms, but neither sends nor applies any while the local user is editing
   a cell. A command is one undo step; in view mode its writes are undone (Implementation,
   [9](#9-co-editing-and-undo)).
9. **The binding:** ADatP-4778.2 Table 5-2 lists `/xl/workbook.xml`, `/xl/styles.xml`, `/xl/sharedStrings.xml`,
   `/xl/worksheets/sheet<N>.xml`, `/xl/charts/chart<N>.xml`, `colors<N>.xml`, `styles<N>.xml`,
   `/xl/pivotTables/pivotTable<N>.xml`, `/xl/comments<N>.xml` and `/xl/media/*`, with the three `docProps` parts of
   Table 5-3. The binding part is related from `xl/workbook.xml`. Excel names chart style parts `style<N>.xml`, and
   ONLYOFFICE keeps that name. ONLYOFFICE writes several content-bearing parts the table omits (threaded comments,
   pivot cache records, drawings, tables). The header and footer strings live in the sheet parts, so the page marking
   is covered ([11](#11-the-adatp-47782-binding-of-a-spreadsheetml-package)).
10. **The standards say nothing about cells or spreadsheet markings** beyond "paragraphs, sections, figures and
    tables" and SPIF marking codes for the top and bottom of "the page or viewing area"
    ([11.4](#114-labelling-cells-or-ranges), [7.4](#74-what-the-standards-and-the-spif-say)).
11. **Purview:** the same two carriers as in a DOCX. ONLYOFFICE keeps `docProps/custom.xml` and drops
    `docMetadata/LabelInfo.xml` in an XLSX too (Tested) ([12](#12-purview-label-metadata-in-an-xlsx)).
12. **This repository:** the plugin's editor commands and snapshot parsing, its page-marking rules, the placeholder
    tag readers of the portal and the policy service, the demo document generator and the end-to-end DOCX inspector
    need a spreadsheet counterpart. Most of the rest needs a switch on file type. As it stands, the policy service
    would sign an XLSX with the base label alone, since it reads portion labels from `w:tag` elements
    ([13](#13-what-is-docx-specific-in-this-repository)).

---

## 1. From the text editor to the spreadsheet editor

| Function in the text editor today | Spreadsheet editor 9.4 | See |
|---|---|---|
| Placeholder: a locked block content control whose tag names the portion and its label | A merged, formatted range; no element carries a tag | [2](#2-identifying-a-portion), [3](#3-the-placeholder) |
| Lock: `sdtContentLocked`, lifted and restored inside one command | User protected range (per user, ONLYOFFICE-only) or sheet protection (whole sheet, no public API) | [4](#4-locking) |
| Portion part in Custom XML (envelope, label in clear) | Same parts, same API, reached from a worksheet | [5](#5-custom-xml-parts-in-an-xlsx) |
| Active portion from `onFocusContentControl` and `onBlurContentControl` | `init` called again at each selection change, then a read of the selection | [6](#6-events-following-the-cursor-and-co-authors) |
| Bubble: `ShowWindow` with `isTargeted`, following `onTargetPositionChanged` | Same method, placed at the top left of the selection; the event does not fire on cell moves | [8.2](#82-the-bubble-showwindow-with-istargeted) |
| Page marking: locked content controls in every header and footer, visible while editing | Header and footer strings per sheet, internal API only, visible in print output only | [7](#7-page-marking-in-headers-and-footers) |
| Binding over `word/` parts | Binding over `xl/` parts, related from the workbook | [11](#11-the-adatp-47782-binding-of-a-spreadsheetml-package) |
| One command, one undo step; writes undone in view mode | Same | [9](#9-co-editing-and-undo) |
| 3-second reread for co-authors' changes | Same need | [6](#6-events-following-the-cursor-and-co-authors) |
| Purview custom properties | Same | [12](#12-purview-label-metadata-in-an-xlsx) |

---

## 2. Identifying a portion

### 2.1 Candidates

What each candidate carrier does in 9.4, with how it was established:

| Carrier | Seen by users | Follows inserted rows and columns | Public API | Editor's save path | Excel |
|---|---|---|---|---|---|
| Hidden defined name, workbook scope | No (name manager, name box) | Yes (Tested) | Create, find by name; no list in CE | Kept: name, reference, `hidden` (Tested) | Standard |
| Hidden defined name, sheet scope (`localSheetId`) | No | Yes (Tested) | Create, list per sheet (hidden included) | Kept (Tested) | Standard |
| `definedName@comment` | Name manager | n/a | None | **Dropped** (Tested) | Standard |
| Cell metadata (`cm` and a custom `futureMetadata`) | No | n/a | None | **Dropped** (Tested) | Standard |
| Custom XML part | No | No position | Full (same as the text editor) | Kept (Tested) | Standard |
| User protected range (title, range, users) | Protect Range dialog | Yes (Tested) | Create, find, list, edit; no removal | Kept, ONLYOFFICE extension (Tested) | Preserved by the ECMA-376 model, not enforced (Inference) |
| Comment or note | Yes, an indicator on the cell | UNVERIFIED | `ApiRange.AddComment` | Kept, with a threaded comment (Tested) | Standard |

Sources for the table: [Tested](#153-results); name lists [s-wb-defnames-list], [s-wb-defname-byref]; user protected
ranges [s-ws-protranges], [c-upr-ext]; custom XML [5](#5-custom-xml-parts-in-an-xlsx); comments
[s-range-addcomment].

### 2.2 Defined names

- **Model.** A name has `name`, `ref`, `sheetId`, `hidden`, `type` and `isXLNM`, and nothing for a comment
  ([s-wb-defname]). x2t writes a comment into the editor binary ([c-defname-comment]), but the model cannot hold it,
  and no conversion that goes through the binary gives it back (Tested).
- **Hidden.** ECMA-376 defines `hidden` as "hidden in the user interface" ([ECMA-376-1][ecma1] §18.2.5 p. 1555,
  Mandated). ONLYOFFICE leaves hidden names out of the lists it shows ([s-wb-defnames-list], filter at L998) and out of
  the lookup of a name by its reference ([s-wb-defname-byref], filter at L954). `ApiRange.GetDefName`, which uses that
  lookup ([s-range-getdefname]), returned nothing for a hidden name's exact range (Tested).
- **Rules.** Office treats names beginning with `_xl` as restricted, limits names and comments to 255 characters, and
  requires a sheet-scoped name to be unique within its sheet ([MS-OI29500] [§2.1.568][oi-2.1.568], Guidance).
  ONLYOFFICE accepted `_xl_test` (Tested).
- **API** ([s-api-adddefname], [s-api-getdefname], [s-ws-defnames]):
  - `Api.AddDefName(name, ref, isHidden)` and `ApiWorksheet.AddDefName` create names; the sheet method sets
    `localSheetId` (Tested).
  - `Api.GetDefName(name)` finds hidden names of both scopes (Tested).
  - `ApiWorksheet.GetDefNames()` lists a sheet's own names, hidden ones included, but not the workbook's (Tested).
  - `Api.GetDefNames()` is documented for 9.4 "in paid ONLYOFFICE Docs editions" ([doc][a-o-getdefnames]); it is
    absent from the source at the tag (only `ApiWorksheet.GetDefNames` exists, [s-ws-defnames]) and from the image
    (Tested: `typeof Api.GetDefNames` is `undefined` in its builder, and the unminified `sdkjs/cell/sdk-all.js` has no
    `Api.GetDefNames`).
  - Names moved with inserted rows and columns (Tested: `$B$3:$D$4` became `$C$5:$E$6`).
- **Co-editing caveat (Implementation).** `Api.AddDefName` calls `private_AddDefName`, which hands the name to the
  user interface's `asc_setDefinedNames` ([s-api-privdefname], [s-capi-setdefnames]). That path asks for a lock on the
  name before changing the model ([s-wbv-editdefnames], [s-wsv-lockdefnames]). With one user the lock is granted at
  once; in co-editing the request goes to the server and the name is written in its callback
  ([s-coll-lock]), after the command's history transaction has closed. `asc_setDefinedNames` also does nothing while
  another lock request is pending (L3731-L3733 of [s-capi-setdefnames]). `ApiName.SetName` and `Delete` change the model
  directly, and `ApiName.SetRefersTo` changes the reference without any history record, so the change is never sent
  to co-authors ([s-name-methods]). **UNVERIFIED** live.

### 2.3 What the evidence supports (Inference)

- A **Custom XML part per portion** can keep what it keeps in a DOCX: the id, the label in clear and the envelope.
- The **cell anchor** has to move with the grid. A hidden sheet-scoped name `dcs_p_<id>` is standard and can be
  listed per sheet, but creating it through the public API is asynchronous in co-editing. A user protected range
  titled with the id is created synchronously, but only ONLYOFFICE understands it. Both could be written in the same
  command.
- The **label in clear that the policy service reads** from `w:tag` today ([13](#13-what-is-docx-specific-in-this-repository))
  needs an XLSX carrier, or the service has to read it from the portion parts.
- Two placeholders for one portion can appear. Copying a sheet copies its hidden sheet-scoped names, its headers
  and footers, its sheet protection and allow-edit ranges, but not its user protected ranges (Implementation:
  [s-wb-copysheet], [s-wb-copydefnames], [s-ws-copyfrom]): the copy's placeholders are unlocked. Copying cells copies a
  placeholder's value and format; moving or copying cells by dragging, which only a listed editor can do, carries the
  user protected ranges they contain (`_moveUserProtectedRange` in [s-ws-userprot]). The panel has to treat an anchor
  without a part, or a second anchor, as it treats a stray content control.

---

## 3. The placeholder

- **Writing it** (Tested): `ApiRange.Merge(false)`, `SetValue`, `SetFillColor` and `SetFontColor` with
  `Api.CreateColorFromRGB`, `SetBold`, `SetAlignHorizontal`, `SetAlignVertical`, `SetWrap`, and
  `SetBorders(position, style, color)` on a merged range all persisted through the editor's save path. `SetBorders`
  takes `"Top"`, `"Bottom"`, `"Left"`, `"Right"`, `"All"` and similar values; an unknown position is accepted and draws
  nothing ([s-range-format]).
- **Merged ranges.** `SetValue` writes the top-left cell of a merged area ([s-range-setvalue]). Selecting any cell of
  the area through `ApiRange.Select()` selected the whole area, with the top-left cell active (Tested,
  [s-range-select]). This is the counterpart of `SelectContentControl`.
- **What formulas see** (Tested): `=B3` returned the placeholder's text and `=LEN(B3)` its length. A portion therefore
  cannot feed a calculation.
- **Showing the marking without storing it** (Tested): with the number format `;;;"DIFFUSION RESTREINTE"`, whose
  fourth section applies to text, `GetText()` returned the marking while `GetValue()` and formulas returned the
  stored value. Such a cell could store a token and display the marking. The format is part of the cell's style, which
  a plugin can still change under a user protected range ([4.1](#41-user-protected-ranges)).
- **Colour** (Inference): the SPIF gives a classification colour as a W3C name or hex value ([ADatP-4774.1][4774.1]
  §3.5 p. 3-9, Guidance); `Api.CreateColorFromRGB` needs components.

---

## 4. Locking

### 4.1 User protected ranges

ONLYOFFICE's "Protect Range" feature, added to the API in 8.1 ([changelog][a-o-changelog]).

- **Model** ([s-upr-class], [s-upr-rights], [s-upr-userinfo], [s-ser-uprtype]):
  - A range has a title, a reference, a list of users with a type (`edit`, `view` or `notView`), and an "anyone" type
    that defaults to `view` ([s-upr-type]).
  - Only users listed with `edit` may edit: `isUserCanEdit` reads the user list and never the "anyone" type.
  - `notView` also hides the values from users without view rights: they are blanked in copied data
    ([s-clip-copy], [s-ser-copyvalue]) and in cell editing ([s-cell-valueforedit]).
- **File.** x2t writes the ranges into the worksheet's `extLst`, in an `ext` with the uri
  `{231B7EB2-2AFC-4442-B178-5FFDF5851E7C}` holding `<userProtectedRanges>`, without a namespace of its own
  ([c-upr-ext], [c-upr-xml]). Tested output:

  ```xml
  <extLst><ext uri="{231B7EB2-2AFC-4442-B178-5FFDF5851E7C}"><userProtectedRanges>
    <userProtectedRange name="dcs portion p-api" sqref="$B$8:$C$9">
      <users><user id="alice" name="Alice Martin" type="edit"/></users>
    </userProtectedRange>
  </userProtectedRanges></ext></extLst>
  ```

  ECMA-376 requires consumers to keep unprocessed extensions and write them out ([ECMA-376-1][ecma1] §18.2.7 p. 1559,
  Mandated), and [MS-OI29500] notes no exception for Excel ([§2.1.570][oi-2.1.570]). Excel does not enforce these
  ranges (Inference).
- **What a user who is not an editor cannot do** (Implementation):
  - type into a cell or enter it through the formula bar ([s-wbv-editcell], [s-wbv-formulabar]);
  - clear it with Delete ([s-wbv-empty]);
  - paste, format or apply any property of the selection ([s-wsv-selinfo], check at L16921);
  - cut it ([s-clip-cut]), drag it ([s-wsv-move]), fill over it ([s-wsv-fill]);
  - sort or filter across it ([s-wsv-sortinfo], [s-wsv-setsort], [s-wsv-autofilter]);
  - delete, hide or group its rows or columns, or resize them ([s-wsv-change], check at L17653-L17672);
  - use Replace All on a sheet, or a workbook, that holds such a range ([s-capi-replace]);
  - edit or delete the range in the Protect Range dialog, whose Edit and Delete buttons need `edit` as the current
    user's type, taken from the user's entry or, without one, from the range's "anyone" type ([w-sse-prdlg],
    [w-sse-prdlg-buttons]); the model refuses the change anyway for a user not listed as an editor
    ([s-ws-userprot], L14559-L14562).

  No password is involved. The ranges are evaluated in each browser against the user id of the editor configuration
  ([s-ws-userprot]); the server stores and relays changes without looking at them ([v-savechanges]).
- **What the plugin can do** (Tested with simulated users, [15.2](#152-docbuilder-scripts)):
  - `AddProtectedRange(title, ref)` adds the current user as the only editor ([s-ws-protranges]).
  - A listed editor's `SetValue` writes. A non-editor's `SetValue` returns `true` and writes nothing: the model skips
    cells the current user cannot edit ([s-range-setvalue-model], L18996-L18999).
  - A non-editor's `SetFillColor` and `SetNumberFormat` apply.
  - A non-editor's `SetAnyoneType` and `SetTitle` return `false`: `editUserProtectedRanges` refuses any change to a
    range the current user cannot edit ([s-ws-userprot], L14559-L14562).
  - There is no API to remove a range ([s-pr-exports]); the user interface's `asc_deleteUserProtectedRange` is not
    part of the Office API ([s-capi-deluserprot]).
  - A non-editor's `AddUser(self, …, "CanEdit")` returned a user object, although `editUserProtectedRanges` refused
    the change: `AddUser` had already pushed the user into the list array that `GetProtectedRange`'s clone shares with
    the model ([s-upr-clone] L73, [s-pr-adduser] L16230-L16240). After it, that user's `SetValue` wrote the cells
    (Tested). The refusal comes before the history record ([s-ws-userprot], L14559-L14562 and L14586-L14599), so the
    change would stay in that browser (Inference).
- **Interplay.** ONLYOFFICE refuses to protect or unprotect a sheet that has user protected ranges ([s-capi-protectsheet],
  L8364-L8367), and the Protect Range button is disabled on a protected sheet ([w-sse-wbprot]).

### 4.2 Sheet protection

- **Standard.** `sheetProtection` with an optional password hash ([ECMA-376-1][ecma1] §18.3.1.85, Mandated), and the
  `locked` attribute of each cell format's `protection` element (§18.8.33); Office's password attributes are described
  in [MS-OI29500] [§2.1.654][oi-2.1.654] (Guidance). Excel enforces both (Inference).
- **In ONLYOFFICE** (Implementation):
  - Editing locked cells is refused to everyone, and so is deleting rows or columns that contain locked cells even
    when row deletion is allowed ([s-wsv-change], L18182-L18190).
  - Lifting it with a password requires the password ([s-capi-protectsheet], L8406-L8447); without one, any editor
    can unprotect from the Protection tab.
- **The plugin** (Tested): on a protected sheet, `SetValue` on a locked cell returned `false`, and so did
  `SetFillColor`. The builder checks sheet protection in every write ([s-range-setvalue] L10281-L10284, and
  `_checkProtection` ([s-range-checkprot]), which the formatting methods call, for instance at L11013 and L11072 of
  [s-range-format]).
- **No public API** in 9.4 protects or unprotects a sheet or sets a cell's `locked` flag (search of
  [cell/apiBuilder.js][s-apibuilder]). Inside `callCommand`, `Api.GetActiveSheet().worksheet` is the internal model,
  whose `setProtectedSheet(props, addToHistory)` records history ([s-ws-sheetprot]); the sandbox hides only the names
  it lists ([s-macros-sandbox]). Using it would be an undocumented dependency. **UNVERIFIED** live.
- **Side effects** (Inference): every cell outside portions has to be unlocked for authors to keep working; sorting,
  inserting rows and pasting interact with locked cells; the protection belongs to the whole sheet.

### 4.3 Whole sheets

Deleting a sheet checks workbook structure protection and a sheet lock, not user protected ranges or sheet protection
([s-capi-deletesheet]). A co-author can delete a sheet with its portions unless the workbook structure is protected;
the portions' Custom XML parts then remain.

### 4.4 Compared with the text editor's lock (Inference)

| | Content control `sdtContentLocked` | User protected range | Sheet protection |
|---|---|---|---|
| Blocks every author's edits in the document | Yes | Only users not listed | Yes |
| Any author's plugin can lift and restore it in one command | Yes (`SetLock`) | No (only a listed editor) | Only through internal objects |
| Any author can lift it in the user interface | Yes (control settings) | No | Yes, unless a password is set |
| Public API | Yes | Yes, without removal | No |
| Understood by Microsoft Office | Yes | No | Yes |
| Scope | One control | One range | Whole sheet |

---

## 5. Custom XML parts in an XLSX

- **API.** `ApiWorksheet.GetCustomXmlParts()`, since 9.1 ([changelog][a-o-changelog], [doc][a-o-getcx]), returns the
  `ApiCustomXmlParts` class of the text editor, built on the workbook ([s-ws-customxml], [s-cx-api]); the cell bundle
  includes the text editor's custom XML code ([s-configs-cell]). The documentation says "associated with the current
  sheet"; the parts belong to the workbook, and `Sheet2` saw the parts of `Sheet1` (Tested).
- **Model and binary.** The workbook owns a `CustomXmlManager` ([s-wb-customxml]), written to and read from the editor
  binary like the text editor's ([s-ser-customs-write], [s-ser-customs-read]). x2t only takes the parts related from
  the workbook ("Customs from Workbook (todo - others)", [c-customs-write]) and writes them back as the workbook's
  ([c-customs-read]).
- **Through the editor's save path** (Tested):
  - `customXml/itemN.xml`, `customXml/itemPropsN.xml` and `customXml/_rels/itemN.xml.rels` were kept, with
    relationships of type `…/relationships/customXml` from `xl/_rels/workbook.xml.rels` (`Target="../customXml/item1.xml"`)
    and content type overrides for the properties parts.
  - The parts are numbered in the manager's order; parts added by the API took the next numbers.
  - `ds:itemID` lost its braces, as in a DOCX ([microsoft-purview-labels.md](microsoft-purview-labels.md#34-side-finding-the-customxml-item-id-loses-its-braces));
    `GetId()` still returned it with braces after reopening.
  - The namespaces found in the content were added to `schemaRefs`, and empty elements were written as start and end
    tags.
- **Escaping** (Tested; the serialiser is the text editor's, [s-cx-serialize]):
  - `R&amp;D &lt;x&gt;` added with `Add()` was saved as `R&D &lt;x&gt;`, which is not well-formed XML;
  - after `UpdateAttribute(…, 'q"r&s')` and `SetText("E&F<G")`, the part was saved as
    `<dcs:t … a="q"r&s"><dcs:v>E&F<G</dcs:v>…`;
  - reopening that file and saving it again left only `<dcs:v>E&F</dcs:v>`: the root and the rest were lost.

  The plugin already stores unencrypted text in base64 for this reason (`plugin/src/portions.ts` [contentOf][r-portions-content]).
  Label codes written through `escapeAttribute` ([r-portions-build]) would break the same way if they contained `&`
  or `"` (Inference), in a DOCX as in an XLSX.
- **Size.** A 200,000-character part was accepted and read back (Tested).
- **History and co-editing** (Implementation): the manager records its changes in `AscCommon.History`
  ([s-cx-history]), which in the cell editor is the spreadsheet history ([s-hist-add]); change classes with
  `WriteToBinary` are serialised for co-authors ([s-undoredo-serialize]). **UNVERIFIED** live.

---

## 6. Events: following the cursor, and co-authors

The cell editor declares one event of its own, `onChangeCurrentSheet` ([s-cell-events], [doc][a-p-sheetevent]); the
common events are listed in [s-base-events]. What reaches a plugin in the cell editor:

| Event | When it fires in the cell editor | Source |
|---|---|---|
| `onFocusContentControl`, `onBlurContentControl`, `onChangeContentControl` | Never | Text editor only |
| `onTargetPositionChanged` | When the hidden input moves: while a cell's or a shape's text is edited, not when the selection moves | [s-text2-move]; its only movers in the cell editor, [s-celleditor-move] and [s-drawdoc-move] |
| `onClick` | Only on Ctrl+Space; mouse clicks raise it in the text, presentation and PDF editors, not in the cell editor (search of the sdkjs tree) | [s-text2-click] |
| `onKeyDown` | Every key the editor's input receives | [s-text2-keydown] |
| `onChangeCurrentSheet` | When the active sheet changes, with its index | [s-capi-sheetevent] |
| `onContextMenuShow` | With `type: "Selection"` for cells | [s-capi-ctxmenu] |
| `onDocumentContentReady`, `onToolbarMenuClick`, `onContextMenuClick` | As in the text editor | [onlyoffice-integration.md](onlyoffice-integration.md#76-events) |

- **Selection changes.** Each worksheet selection change triggers `asc_onSelectionEnd` ([s-wbv-selchanged],
  L1310-L1311). The plugin manager answers by sending `init` again to every running plugin whose variation has
  `initOnSelectionChanged: true` ([s-plugins-selend], [s-plugins-selinit], [s-plugins-init]). The plugin replaces
  `Asc.plugin.info` and calls `Asc.plugin.init(data)` each time ([s-pbase-info], [s-pbase-init]). The documentation
  describes the option for "text selection events" ([doc][a-p-config], Guidance). With `initDataType: "none"`, no
  data comes with it; the plugin then reads the selection in a read-only command (`Api.GetSelection()`,
  `ApiWorksheet.GetActiveCell()`), and its `init` has to tolerate being called again.
- **`attachEditorEvent`** only subscribes to events the editor already sends to plugins: the cell editor adds none
  ([s-apibase-onattach], [doc][a-p-events]).
- **`Api.attachEvent("onWorksheetChange", …)`** ([s-api-attachevent], [doc][a-o-attachevent]) is a macro event,
  "not called for the undo/redo operations" ([s-api-wschange-doc]). The editor raises it from its own editing code
  and hands it to internal listeners and web-apps handlers ([s-capi-wschange], [s-capi-sendevent]); plugin frames
  only receive the events the plugin manager posts to them ([s-plugins-onevent]), so it does not reach the panel
  (Implementation).
- **Co-authors' changes** raise no plugin event in either editor: the 3-second reread of
  [hooks.ts][r-hooks-reread] remains the mechanism. A reread command with `isCalc = false` leaves no undo step, since
  an empty history point is removed at the end of the transaction ([s-hist-transaction], L1440-L1441).

---

## 7. Page marking in headers and footers

### 7.1 The format

- A worksheet's `headerFooter` holds `oddHeader`, `oddFooter`, `evenHeader`, `evenFooter`, `firstHeader` and
  `firstFooter`, with `differentOddEven` and `differentFirst` ([ECMA-376-1][ecma1] §18.3.1.46 pp. 1636-1639,
  Mandated). They appear "when printed or viewed in page layout view".
- Each string holds section codes (`&L`, `&C`, `&R`), font codes (`&"-,Bold"`, `&B`), and `&K` followed by an
  `RRGGBB` colour or a theme colour (same section, Mandated). Example: `&C&"-,Bold"&KE8590CDIFFUSION RESTREINTE`.
- ECMA-376 sets no length limit (`ST_Xstring`). Excel restricts each of the six to 255 characters ([MS-OI29500]
  [§2.1.618][oi-2.1.618], [§2.1.619][oi-2.1.619], [§2.1.621][oi-2.1.621], [§2.1.622][oi-2.1.622],
  [§2.1.633][oi-2.1.633], [§2.1.634][oi-2.1.634], Guidance). The limit counts codes too, and for `firstFooter`
  applies "after escaped sequences are replaced with characters".
- Office uses the odd header only when `differentOddEven` is false ([§2.1.619][oi-2.1.619], Guidance): with
  `differentOddEven` and `differentFirst`, all six strings have to be written.

### 7.2 In ONLYOFFICE

- **Model.** `CHeaderFooter` has the six strings and the two flags ([s-hf-model]); its setters record history, so
  their changes reach co-authors ([s-hf-setters], Implementation). Each worksheet has one ([s-ws-hfinit]).
- **No public API.** The Office API has page margins, orientation and print options but nothing for headers and
  footers ([s-apibuilder]). Inside `callCommand`,
  `Api.GetActiveSheet().worksheet.headerFooter.setOddHeader(…)`, `setDifferentFirst(true)` and the others worked and
  persisted (Tested); this relies on internal objects.
- **Length.** The dialog refuses more than 255 characters ([s-hf-checksave] L1435, [s-hf-max]); the model and the save
  path do not: a 302-character header set through the model, and a 310-character one read from a file, were kept
  (Tested). The page marking should be kept within 255 characters, codes included, for Excel (Inference).
- **Locks.** The dialog saves under a header/footer lock ([s-hf-destroy] L1374, [s-wsv-lockhf]); the model setters take
  none, so concurrent writers overwrite each other (Implementation).
- **Visibility.** Headers and footers are drawn only by `drawForPrint`, for printing, print preview and PDF output
  ([s-wsv-print], calls at L4010 and L4068). The View tab offers Normal and Page Break Preview, not Page Layout
  ([w-sse-viewtab]). **The editor shows no page marking on screen.**
- **Round trip** (Tested): six coloured strings with both flags kept their codes through the editor's save path
  (`&` escaped as `&amp;`, `"` as `&quot;`); XML special characters in the text survived.

### 7.3 Consequences (Inference)

- The marking goes into six strings per sheet. A sheet added by an author has none until the panel writes it, which
  the reread can detect, as it detects a stale marking in a DOCX.
- Any author can change or remove the strings from the dialog; nothing locks them.
- On screen, a reader sees the document label only in the panel. A marking visible while editing needs something else,
  such as a locked banner row, which would be content in the grid. That is a design decision.

### 7.4 What the standards and the SPIF say

- A document's marking is "normally written on the front coversheet and in page headers and footers"
  ([ADatP-4774][4774] §4.2 p. 4-1, descriptive text of the standard, not a requirement).
- SPIF 2.1 marking codes: `pageTop` and `pageBottom` display "on top of the page or viewing area" and "on bottom of
  the page or viewing area"; `documentStart` and `documentEnd` at the start and end of the document; `inputTitle` on a
  GUI element's title; `waterMark` behind the main text ([SPIF 2.1][spif21], simple type `markingCode`, Mandated for
  the values; [ADatP-4774.1][4774.1] Table 6 p. 3-9, Guidance). The demo policy uses `pageTopBottom`
  ([demo-fr.spif.xml][r-spif]).
- Nothing in ADatP-4774, 4774.1, 4778, 4778.1 or 4778.2 addresses spreadsheets beyond naming them as data objects
  (search of the five documents).

---

## 8. Panel, windows and view mode

### 8.1 The panel

- **Editor support.** The plugin manager refuses a plugin whose variation does not list the editor, `cell` for the
  spreadsheet editor ([s-plugins-support]); web-apps hides it ([w-plugins-visible], editor name at
  [w-plugins-editor]). `Asc.plugin.info.editorType` is `cell` ([s-apibase-editorname]).
- **Right panel.** web-apps adds a `panelRight` plugin to the right menu through the same controller code in both
  editors ([w-plugins-panel], [w-sse-rightmenu]).
- **Toolbar and context menu.** The Insert tab's id is `ins` in both editors ([w-sse-toolbar]); cells give
  `onContextMenuShow` the type `Selection` ([s-capi-ctxmenu]).
- **View mode.** The right menu is only set up and rendered in edit mode ([w-sse-main-edit] L1722-L1752,
  [w-sse-viewport]), as in the text editor, where the portal therefore loads a left panel in view mode
  ([r-editor-config] L40-L42). Keeping that variant for workbooks is the safe choice (Inference). Commands' writes are
  undone in view mode: the transaction's end undoes the last action when the editor cannot edit ([s-capi-builder],
  [s-hist-transaction] L1442-L1444, [s-hist-actionlock]).

### 8.2 The bubble: `ShowWindow` with `isTargeted`

- **Visibility.** web-apps shows a plugin window only if its variation's `EditorsSupport` lists the editor
  ([w-plugins-apiwindow], L1267). The bubble passes `EditorsSupport: ['word']` ([r-bubble] L154).
- **Placement.** With `isTargeted`, `ShowWindow` asks `getTargetOnBodyCoords()` for the target and places the window
  10 pixels to the right of it and below it, or above it when there is no room ([s-apibase-plugins-showwindow]). In the
  cell editor the target is ([s-apibase-target], spreadsheet branch):
  - the text cursor while a cell is edited;
  - the text cursor in a shape;
  - otherwise the page position of the top-left cell of the selection's last range, from `getSelectionCoords`
    ([s-wsv-selcoords]), with a target height of 0.

  The window therefore opens 10 pixels inside the selected cell or merged area, over the placeholder itself
  (Inference). The position is computed once, when the window opens.
- **Following the cursor** (Inference): since `onTargetPositionChanged` and `onClick` do not fire on cell moves
  ([6](#6-events-following-the-cursor-and-co-authors)), the bubble would close and reopen from the `init` that a
  selection change triggers, and dismiss on `onKeyDown` Escape as today.

---

## 9. Co-editing and undo

### 9.1 How changes travel

- **Fast mode.** The editor's autosave timer runs every 40 ms ([s-apibase-autosave]); with co-authors in fast mode,
  each tick sends the local changes and applies others' ([s-capi-autosave] L6791-L6792, [s-wbv-fastcoedit]).
- **Strict mode.** Changes go out when the author saves: "Use the 'Save' button to sync the changes you and others
  make" ([w-sse-strict], Guidance). The portal forces fast mode ([r-editor-config] L92).
- **Cell editing.** While the local user edits a cell (or tracks a shape), nothing is sent and nothing is applied
  ([s-capi-autosave], L6787-L6789). A co-author typing in a cell receives portion changes, and sends theirs, only
  when they leave the cell.
- **After sending**, the local history is cleared in co-editing ([s-coll-send], L383-L384).

### 9.2 Locks

- **The editor's own locks.** Before an edit, the user interface asks the server for locks on ranges, objects, sheets
  or names ([s-coll-lock]). The server grants a range lock unless it intersects another user's
  ([v-getlock], [v-checklock-excel], [v-compare-excel]). Co-authors see locked cells and cannot edit them.
- **A plugin's command takes no lock.** The builder methods change the model directly
  ([s-range-setvalue-model]), and the end of the command only checks view mode ([s-hist-actionlock]). The server
  stores and relays changes without checking them against locks ([v-savechanges], L3630-L3646). A plugin can therefore
  write a range another user has locked; the last write wins (Inference). Portion cells protected from users are not
  exposed to this.
- **Exceptions inside a command:** `Api.AddDefName` requests a lock ([2.2](#22-defined-names)); the header/footer
  dialog takes one, the model setters used by a plugin do not ([7.2](#72-in-onlyoffice)).

### 9.3 Undo

- **One command, one step.** `callCommand` opens a history point and a transaction before the code runs
  ([s-capi-builder] L7265-L7269, L7289-L7296), and nested `Create_NewPoint` calls do nothing inside a transaction
  ([s-hist-newpoint]). The transaction ends after the code ([s-capi-builder] L7297-L7316), so everything the command
  changes is one undo step, as in the text editor (Implementation). The asynchronous name creation of
  [2.2](#22-defined-names) is the exception.
- **Undo in fast co-editing.** When the local history is empty and others are editing, Ctrl+Z asks for an undo of the
  user's own changes through the collaborative history ([s-wbv-undo] L3501-L3509). web-apps still has a message saying
  that "Undo/Redo functions are disabled for the Fast co-editing mode" ([w-sse-undo-msg]), whose event sdkjs no longer
  raises (search of the sdkjs tree). Whether an author can undo a plugin's command in co-editing is **UNVERIFIED**.

---

## 10. Keeping portion text out of ONLYOFFICE

As in the text editor, the text never enters the workbook if it is typed and shown only in the panel and the bubble;
what ONLYOFFICE holds is the placeholder, the anchors and the envelope. What spreadsheet features do with a placeholder
cell (Implementation unless marked):

| Feature | What it sees or does | Source |
|---|---|---|
| Formulas, charts, pivot tables | The stored value: the placeholder's text or token (Tested for formulas); a portion cannot be a number in a calculation | [3](#3-the-placeholder) |
| Formula bar | The active cell's text; blank for users a `notView` range hides it from | [s-wbv-selchanged] L1297-L1305, [s-cell-valueforedit] |
| Autofilter lists, find, spell checking, autocomplete | Cell texts only, hence the placeholder (Inference); filtering across a protected range and Replace All in a sheet holding one are refused | [s-wsv-autofilter], [s-capi-replace] |
| Sorting | Refused when the sorted range crosses a user protected range; otherwise the placeholder's value would move away from its anchor (Inference) | [s-wsv-sortinfo], [s-wsv-setsort] |
| Copy | Allowed; copies value and format, not anchors; `notView` values are blanked | [s-clip-copy], [s-ser-copyvalue] |
| Paste, cut, drag, fill into the portion | Refused under a user protected range | [4.1](#41-user-protected-ranges) |
| Print, PDF, download | Placeholder and headers only | [s-wsv-print] |

Risks specific to workbooks (Inference):

- Authors used to cells expect values to compute. Anything computed from a portion's text would have to be a portion
  too, entered in the panel.
- An author allowed to edit a protected range (a listed editor) can type into the placeholder cell; the text then goes
  to ONLYOFFICE, as text typed in a DOCX body would.
- The bubble and the panel must keep writing nothing through editor methods that insert text (`PasteText`,
  `InputText`), as today.

---

## 11. The ADatP-4778.2 binding of a SpreadsheetML package

### 11.1 Parts a whole-document binding references

ADatP-4778.2 Table 5-2, "Microsoft Excel" rows ([ADatP-4778.2][4778.2] p. 5-4, Mandated when present), with
Table 5-3 (p. 5-5):

| Package file | Description in the table |
|---|---|
| `/xl/workbook.xml` | The workbook |
| `/xl/styles.xml` | The styles within the workbook |
| `/xl/sharedStrings.xml` | The strings shared between worksheets |
| `/xl/worksheets/sheet<N>.xml` | The worksheets within the workbook |
| `/xl/charts/chart<N>.xml` | The charts on a worksheet |
| `/xl/charts/colors<N>.xml` | The colors of a chart on a worksheet |
| `/xl/charts/styles<N>.xml` | The style of a chart on a worksheet |
| `/xl/pivotTables/pivotTable<N>.xml` | The pivotTables on a worksheet |
| `/xl/comments<N>.xml` | The comments on a worksheet |
| `/xl/media/*` | The media embedded on the worksheets |
| `/docProps/core.xml`, `/docProps/app.xml`, `/docProps/custom.xml` | Table 5-3, common document properties |

"Additional package files … MAY be referenced" (p. 5-4). The other rules of chapter 5 are unchanged for workbooks
([labelling-standards.md](labelling-standards.md#42-what-the-profile-mandates-full-list-chapter-5-is-short)).

### 11.2 Where the binding part goes

- A Custom XML Data Storage part "shall be the target of an implicit relationship in … a Workbook (§12.3.23) part in a
  SpreadsheetML package" ([ECMA-376-1][ecma1] §15.2.5 pp. 145-146, Mandated). For an XLSX: `customXml/itemN.xml`
  related from `xl/_rels/workbook.xml.rels`, with the optional properties part as in a DOCX
  ([labelling-standards.md](labelling-standards.md#45-recommended-complete-part-and-package-plumbing-tested)).
- ONLYOFFICE keeps it exactly there (Tested, [5](#5-custom-xml-parts-in-an-xlsx)).

### 11.3 What ONLYOFFICE writes, against the table (Tested)

A workbook with a chart, a comment, an image and a pivot table, and a workbook made by Microsoft Excel 16 with a
chart, a chart sheet, a table and a slicer ([c-excel-sample]), both through the editor's save path:

| In Table 5-2 or 5-3 | Not in the tables, but holding content or layout |
|---|---|
| `xl/workbook.xml`, `xl/styles.xml`, `xl/sharedStrings.xml`, `xl/worksheets/sheet1.xml`… | `xl/threadedComments/threadedComment1.xml` (the comment's text, again), `xl/persons/person.xml` |
| `xl/charts/chart1.xml`; `colors1.xml` and `style1.xml` when the input had them | `xl/pivotCache/pivotCacheDefinition1.xml`, `pivotCacheRecords1.xml` (copies of cell values) |
| `xl/pivotTables/pivotTable1.xml` | `xl/drawings/drawing1.xml` (positions of charts and pictures), `xl/drawings/vmlDrawing1.vml` |
| `xl/comments1.xml` | `xl/tables/table1.xml`, `xl/slicers/slicer1.xml`, `xl/slicerCaches/slicerCache1.xml` |
| `xl/media/image1.png` | `xl/metadata.xml`, `xl/theme/theme1.xml` |
| `docProps/core.xml`, `docProps/app.xml`, `docProps/custom.xml` | `xl/theme/theme.xml`, which no relationship references |

Observations:

- **`style<N>` versus `styles<N>`.** Excel's own file names the chart style part `xl/charts/style1.xml` (relationship
  type `…/2011/relationships/chartStyle`), and ONLYOFFICE keeps that name ([c-excel-sample], Tested). A pattern taken
  literally from the table (`styles<N>.xml`) would miss it (Inference).
- **Chart sheets.** Excel's `xl/chartsheets/sheet1.xml` is not in the table; ONLYOFFICE's output had no
  `xl/chartsheets` folder, only worksheets (Tested).
- **Orphan theme.** Every conversion from the editor binary to XLSX added `xl/theme/theme.xml`, a default theme that no
  relationship references, next to the referenced `theme1.xml` (Tested). It matters only to a check that lists every
  part (Inference).
- **Page marking.** The header and footer strings are inside `xl/worksheets/sheet<N>.xml`, so a binding over the
  table's parts covers the page marking.
- **Rewritten at each save.** `docProps/app.xml` (application `ONLYOFFICE/9.4.0.129`) and `docProps/core.xml`
  (modification time) change at every save, as in a DOCX (Tested).

### 11.4 Labelling cells or ranges

- ADatP-4774 lets labels be bound to "portions of the information, including paragraphs, sections, figures and
  tables" ([ADatP-4774][4774] §4.2 p. 4-2); nothing names cells or ranges.
- ADatP-4778 gives "a spreadsheet" as an example of a data object ([ADatP-4778][4778] §3.1 p. 3-1).
- ADatP-4778.2 lists bindings "to elements within a package part" as possible future profiles (§5.2 p. 5-1).
- Inference: a portion-level `DataReference` into `xl/worksheets/sheet<N>.xml` would need an XPath selecting cells by
  address, which inserted rows break, or a reference through a defined name. Neither is standardised; the envelope's
  bound label remains the portion-level binding, as in a DOCX.

---

## 12. Purview label metadata in an XLSX

- The carriers are the same as in a DOCX: the Sensitivity Label Information part is a package-level part, "the target
  of a relationship in the package-relationship item" ([MS-OI29500] [§3.4.1.5][oi-3.4.1.5]), and the custom
  properties sit in the shared `docProps/custom.xml` ([MS-OFFCRYPTO] [§2.6.2][oc-2.6.2], [§2.6.3][oc-2.6.3]). The rules
  of [microsoft-purview-labels.md](microsoft-purview-labels.md#key-findings) apply unchanged.
- **Tested:** through the editor's save path, the seven `MSIP_Label_…` properties were kept unchanged, and
  `docMetadata/LabelInfo.xml`, its override and its package relationship were dropped. Only the direct XLSX-to-XLSX
  conversion, which the editor does not use, kept LabelInfo.
- The spreadsheet API has `Api.GetCustomProperties()` since 9.0 ([s-api-customprops]).

---

## 13. What is DOCX-specific in this repository

A read-only inventory at `main` (`2af1dd4`). **P**: needs a spreadsheet counterpart; **S**: needs a switch on file or
editor type; **R**: reusable as is.

| Area | Item | Kind |
|---|---|---|
| Plugin | `EditorsSupport: ["word"]` and the content-control events in [config.json][r-config] (L35-L57) | S, P |
| Plugin | The typed text-document API of [office-api.ts][r-office-api] (paragraphs, block controls, sections, `ApiDocument`) | P |
| Plugin | The write command ([portions.ts][r-portions-write] L173 onwards): `Api.GetDocument()`, `CreateBlockLvlSdt`, `SetLock('sdtContentLocked')`, insertion after the current paragraph, deletion, and the page marking in every section's headers and footers | P |
| Plugin | The read command and snapshot parsing ([portions.ts][r-portions-read] L368-L409, L690-L736) and the page-marking rules (L540-L571) | P |
| Plugin | The active portion from content-control events and the tag reader ([hooks.ts][r-hooks-events] L102-L111, L254-L259); `SelectContentControl` in [Panel.tsx][r-panel] L111 | P |
| Plugin | The bubble's events and window variation ([bubble.ts][r-bubble] L56-L81, L154) | P, S |
| Plugin | The command queue, context menu, Insert tab (`ins` exists in both editors), panel, envelopes, bubble page, part builders | R |
| Portal | `.docx` storage, templates, MIME type and download ([documents.ts][r-documents] L19-L26; [server.ts][r-server] L158-L159; [document-server-routes.ts][r-dsroutes] L51) | S |
| Portal | `fileType: 'docx'`, `documentType: 'word'` ([editor-config.ts][r-editor-config] L12, L18, L80, L86) | S |
| Portal | The WordprocessingML part list of the binding refresh ([binding.ts][r-binding] L9-L23) | S |
| Portal | Portion labels read from `w:tag` in `word/` parts, feeding access decisions and the journal ([document-labels.ts][r-doclabels] L27-L29, L50-L59) | P |
| Portal | The DOCX MIME type of the signature requests ([binding-signature.ts][r-bindsig] L81) | S |
| Policy | `DEFAULT_DOCUMENT_PARTS` (`word/…`, [adatp4778.ts][r-adatp4778] L10-L19), used when no part list is sent ([server.ts][r-policy-server] L467) | S |
| Policy | The DOCX-only body parser and portion codes read from `w:tag` ([package-signing.ts][r-pkgsign] L10-L14, L54-L56, L116-L125, L175-L184): on an XLSX no portion is found, so `/bindings/sign` computes the label from the base label alone | P |
| Policy | Labels, roll-up, SPIF, OpenTDF, access decisions, portion locks, XML signature | R |
| Deploy | The demo generator built on the `docx` library ([generate-documents.ts][r-demo] L3-L73) and the one demo DOCX; the seeding glob `*.docx` ([init.sh][r-init] L13) | P, S |
| End-to-end | The DOCX inspector ([docx.ts][r-e2e-docx] L72-L117), sandbox helpers on `Api.GetDocument()` ([plugin.ts][r-e2e-plugin] L32-L50, L183-L420), clicks in the text body ([portions.ts][r-e2e-portions] L16), typing and text reading ([documents.ts][r-e2e-documents] L199-L221, L256-L271), and the cursor and keyboard steps of the specs | P |
| End-to-end | Frames by name, OpenTDF, envelopes, signatures, traces, the Document Server search (any archive) | R |
| Glossary | "Upload: A DOCX brought into the portal from outside" ([CONTEXT.md][r-context] L61-L62) | S |

Sizing (Inference): the bulk is the plugin's two editor commands and their parsing, the page-marking design, the
placeholder readers of the portal and the policy service, and the end-to-end helpers; the portal, the policy service
and the deployment otherwise need a file-type switch and per-format part lists.

---

## 14. Documentation versus code at 9.4.0.129

| Topic | Documentation | Code at the tag, or test |
|---|---|---|
| `ApiWorksheet.GetCustomXmlParts` | Parts "within the current sheet" ([doc][a-o-getcx]) | The workbook's parts, from any sheet ([s-ws-customxml], Tested) |
| `Api.GetDefNames` | Added in 9.4, "available in paid ONLYOFFICE Docs editions" ([doc][a-o-getdefnames]) | Absent from the source and the CE image (Tested) |
| `ApiProtectedRange.AddUser` | Returns null "if a user doesn't have permission to modify the protected range" ([doc][a-o-adduser]) | Never returns null for valid arguments; mutates the model's user list ([s-pr-adduser], Tested) |
| `ApiName.SetRefersTo` | Sets the reference | No history record ([s-name-methods]) |
| `initOnSelectionChanged` | Watches "text selection events" ([doc][a-p-config]) | Every worksheet selection change in the cell editor ([s-wbv-selchanged]) |
| Undo in fast co-editing | web-apps message: disabled ([w-sse-undo-msg]) | Requested through the collaborative history ([s-wbv-undo]) |

---

## 15. How the tests were run

The scratch files were kept outside the repository and were not added to it.

### 15.1 Containers and conversions

Containers of `onlyoffice/documentserver:9.4.0.1` (arm64, index `sha256:3ab6ebc7c605…`) were started with
`docker run --rm --network none -v "$PWD:/work" --entrypoint /bin/bash onlyoffice/documentserver:9.4.0.1 /work/run.sh`,
with no published port. As in [microsoft-purview-labels.md](microsoft-purview-labels.md#a3-onlyoffice-round-trips),
the script generated the fonts as `documentserver-generate-allfonts.sh` does, then ran `x2t` with an XML parameter
file (`m_sFileFrom`, `m_sFileTo`, `m_nFormatTo`, `m_bFromChanges`, `m_sThemeDir`) and `docbuilder`. Format codes:
`257` for XLSX and `8194` for the spreadsheet editor binary ([c-formats]).

| Path | Through sdkjs |
|---|---|
| XLSX to `Editor.bin`, then `Editor.bin` with an empty `changes/` to XLSX, `m_bFromChanges=true`: **the editor's save path** | Yes |
| `Editor.bin` to XLSX without changes | No |
| XLSX to XLSX directly (unzip and zip) | No |
| `docbuilder` open and save; `docbuilder` scripts using the Office API, whose outputs then went through the editor's save path | Yes |

Test files, built with Python's `zipfile`; the SpreadsheetML parts of `probe.xlsx` were valid against the ECMA-376
Transitional `sml.xsd` (`xmllint`, libxml2 2.9.13):

- `probe.xlsx`: two sheets; hidden workbook and sheet names, one with a `comment`; two Custom XML parts (a
  `BindingInformation` and a portion part) with properties parts, related from the workbook; the seven
  `MSIP_Label_…` properties and a `docMetadata/LabelInfo.xml` part; a merged, filled, bordered placeholder; formulas
  referencing it; a cell with `cm="1"` and a custom `futureMetadata` type; six coloured headers and footers with both
  flags on the first sheet; sheet protection, an unlocked cell and a `protectedRange` on the second.
- `longhf.xlsx`: a 310-character header and a footer holding `&`, `<`, `>`, quotes and `é`.
- The Excel file `OOXML/test/ExampleFiles/xlsx2xlsb/simple2.xlsx` of the ONLYOFFICE core repository
  ([c-excel-sample]), whose `docProps/app.xml` names Microsoft Excel 16.0300.

### 15.2 docbuilder scripts

The scripts ran `tryit(name, fn)` steps and wrote each result into a new sheet of the saved workbook, which was then
read back. To simulate users, a script replaced the editor's document information before each step, as the
editor fills it from `editorConfig.user` ([s-upr-rights] reads it through `Asc.editor.DocInfo`):

```js
function asUser(id, name) {
  var info = new Asc.asc_CDocInfo(), user = new Asc.asc_CUserInfo();
  user.put_Id(id); user.put_FullName(name); info.put_UserInfo(user);
  Asc.editor.DocInfo = info;
}
```

docbuilder runs without co-editing, without the user interface and with the history off, so locks, undo and events
could not be observed there.

### 15.3 Results

| Check | Result |
|---|---|
| Custom XML parts after the save path | Kept, related from `xl/workbook.xml`; ids without braces; `schemaRefs` extended |
| Custom XML parts with `&`, `<`, `"` | Malformed after saving; truncated to one element after reopening and saving |
| `GetCustomXmlParts()` from the second sheet | Same two parts as from the first |
| Defined names after the save path | Name, reference, `hidden`, `localSheetId` kept; `comment` dropped |
| Rows and a column inserted above and before the placeholder | Names, the user protected range, the merge and formulas moved by the same offset |
| `ApiRange.GetDefName` on a hidden name's range | Nothing found |
| `Api.GetDefNames` | `undefined`; no `Api.GetDefNames` in `sdkjs/cell/sdk-all.js` |
| Cell metadata | `cm` dropped through sdkjs; the `futureMetadata` payload dropped by every conversion except the direct one |
| Placeholder formatting through the API | Kept |
| Sheet protection | `SetValue` and `SetFillColor` on a locked cell returned `false`; on an unlocked cell `SetValue` wrote |
| User protected range, current user an editor | `SetValue` wrote |
| User protected range, current user not an editor | `SetValue` returned `true` and wrote nothing; `SetFillColor` and `SetNumberFormat` applied; `SetAnyoneType` and `SetTitle` returned `false`; `AddUser(self)` made the user an editor in that editor's model |
| User protected ranges after the save path | Kept in the worksheet extension, users and type included |
| Headers and footers | Kept through the save path; set through the internal model and kept; 302 and 310 characters kept |
| `docProps/custom.xml`, LabelInfo | Custom properties kept; LabelInfo, its override and relationship dropped |
| Parts written for a chart, a comment, an image, a pivot table | See [11.3](#113-what-onlyoffice-writes-against-the-table-tested) |
| Bundles against the source | `isTargeted`, `getTargetOnBodyCoords`, the user-protected-range check of `Range.setValue` and `onChangeCurrentSheet` found in `sdkjs/cell/sdk-all*.js` |

Not covered: the browser editor, co-editing, the Document Server's own save through the callback, force-save, the
amd64 image, and Microsoft Excel.

---

## 16. SHA-256 of the documents used

```text
592a0da5d0786848743ab024417626f5c8cdcc015c0bfa9c18c0995e8cdafbf9  ADatP-4774 EDA V1 E.pdf
c3d43da53aeb211aee06753882b0d83f32577b825de5f251b562e77dc86671eb  ADatP-4774.1 EDA V1 E.pdf
45dd56e33eb67ffcd486bb42755a283f2fe8596bb660887bf9cbdb574060863e  ADatP-4778 EDA V1 E.pdf
1000a7594133d951ca8f3739a5b55cdfe4fd6be8525f1911cbda31dcf6d48067  ADatP-4778.1 EDA V1 E.pdf
778376bdeecbc63b8612508876fbefa7c53ebbe558debe1bd5b48dbb2e669033  ADatP-4778.2_EDA_V1_E.pdf
bd710416630bb559db66813dc1bb48cedd10a9f181666afd36488a9908e7a4d5  xmlspif.org/schema/2017/12/xmlspif.xsd (SPIF 2.1)
9d0bcad9cf06054785b03762fcfadbf6bab7e54a5f9d69434e34b7fd464d4129  ECMA-376-1_5th_edition_december_2016.zip
b297063cce0ac79d10a8efd382b0f90f3b9fd6615fac7f01c88f0288e5fa7372  [MS-OI29500].pdf (v25.0, 2026-08-18)
65a20fdaef2b24cabd0c783620a46d339a98b33effffa9ca6da7795e9635ddf0  [MS-OFFCRYPTO].pdf (v14.0, 2026-02-17)
```

---

## 17. Open questions (need a live editor)

1. **Following the cursor.** Does `initOnSelectionChanged` re-run `init` for a `panelRight` plugin on every click and
   arrow key, including in view mode? Is `onKeyDown` delivered while navigating the grid? How fast can a read-only
   selection command answer?
2. **Bubble placement.** Where does `ShowWindow` with `isTargeted` open for a merged placeholder, with frozen panes,
   zoom and scrolling? Is the placeholder hidden under it?
3. **View mode.** Does adding a `panelRight` plugin crash the spreadsheet viewer as it does the text viewer? Do a
   command's writes get undone silently?
4. **User protected ranges in co-editing.** Are creation, users and type propagated to a second browser, and enforced
   there for that user? What do the Protect Range dialog and its user list offer when the portal handles no editor
   event but `onDocumentReady` ([r-portal-editorjs])? What does a non-editor see in the dialog?
5. **Plugin writes under protection.** Does a non-editor's `SetValue` behave as in the builder (silently skipped) in
   the browser? Does a number-format placeholder render as the marking and print?
6. **Defined names in co-editing.** Does `Api.AddDefName` inside `callCommand` create the name after the command, in a
   separate undo step, and what happens when two co-authors create names at once?
7. **Custom XML in co-editing.** Do parts added, changed and deleted in one browser reach the other? Does the other
   author's Ctrl+Z revert them?
8. **Undo.** Is one plugin command one undo step for its author, alone and in fast co-editing, including the header
   and footer changes and the protected range?
9. **Cell editing.** How long can a co-author typing in a cell delay a portion change, and does a plugin command
   during that time conflict with the open cell editor?
10. **Sheet protection through internal objects.** Does `worksheet.setProtectedSheet` inside `callCommand` lift and
    restore protection within one step, propagate, and leave the Protection tab consistent?
11. **Deleting and copying sheets.** What do co-authors see when a sheet holding portions is deleted, duplicated or
    moved to another workbook?
12. **Headers.** Does the print preview show the coloured marking on first, odd and even pages? Does Excel open a
    workbook whose header exceeds 255 characters, and keep the ONLYOFFICE protected-range extension on save?
13. **No-plaintext check.** Does the existing search of co-editing traffic, saved files and the Document Server's
    working files cover XLSX parts and spreadsheet change records as it covers DOCX ones?

## 18. Answered with a live editor

ONLYOFFICE 9.4 on the standalone stack, in Chromium, with two browsers in fast co-editing, on 29 September 2026. The
end-to-end test an answer names guards it; the other answers were checked once, by hand or with a throwaway test.

- **1. Following the cursor.** With `initOnSelectionChanged`, the editor calls the panel's `init` again at each
  change of the selection, whether the name box's search, a mouse click or an arrow key moves it, in the editor and in
  the viewer; a read-only command then tells which range holds the active cell.
  [workbook-selection.spec.ts](../../e2e/tests/workbook-selection.spec.ts) guards the name box and the arrow keys, in
  the editor and in the viewer; mouse clicks were checked by hand. The panel's rereads, every 3 seconds, make no such
  call.
- **2. Bubble placement, in part.** With `isTargeted`, the bubble opens 10 pixels inside the top-left corner of the
  selected placeholder's merged area, over its marking; tried by hand at 100% zoom, without frozen panes or
  scrolling. The tests check that it opens, stays open through rereads, and opens again when the placeholder is
  selected once Escape has closed it, not where.
- **3. View mode.** The left panel that the portal loads for a read-only session runs in the spreadsheet viewer: it
  shows the document label and sends the editor no command that writes, and the stored file stays as it was
  ([workbook.spec.ts](../../e2e/tests/workbook.spec.ts)). A right panel in the spreadsheet viewer was not tried: the
  portal never loads one there.
- **4. User protected ranges in co-editing.** A range created in one browser reaches the other live, and each editor
  enforces it for its own user: typing into it is refused, with the warning "This range is not allowed for editing.",
  one per key typed, while typing elsewhere works ([workbook-portions.spec.ts](../../e2e/tests/workbook-portions.spec.ts)).
  A range that lists no editor, made with `AddProtectedRange` then `DeleteUser` in one command, is saved as
  `<userProtectedRange name="…" sqref="…">` without users, and stays without editors once the file is reopened.
- **Lifting a range's lock (ADR 0006).** In a command, `Asc` holds only `scope`: the SDK's classes are out of reach.
  `Api.GetActiveSheet().worksheet` is the internal model, whose names are not mangled. Shadowing `isUserCanEdit` on
  the range's object, `worksheet.getUserProtectedRangeByName(title).obj`, for the command lets it write the range's
  cells: the write reaches the co-author, the lift enters no history, and the range keeps no editor. Removing the range
  with `worksheet.editUserProtectedRanges(range, null, true)` after the same lift reaches the co-author too.
- **8. Undo.** For one author, one undo takes back a whole portion command, an insertion's placeholder, range, part,
  document label and page marking included ([workbook-portions.spec.ts](../../e2e/tests/workbook-portions.spec.ts)); a
  throwaway test found the same of a lifted change and of a range's removal, which a redo brought back. In fast
  co-editing, the editor keeps no local history: an undo asks the co-editing history to reverse the author's last set of
  changes, which it does only when it can reverse every change of the set, and otherwise does nothing
  (`CCollaborativeHistory.GetReverseOwnChanges`). A change of a portion's text alone, which only replaces parts, comes
  undone for both authors; an insertion, a change of label, which also rewrites the placeholder's cells and the page
  marking, and a deletion stay whole, never half undone
  ([workbook-co-editing.spec.ts](../../e2e/tests/workbook-co-editing.spec.ts)); in a throwaway test, a redo after such
  an undo did nothing. The policy service then refuses to change the undone portion for the minute it remembers the
  version the change wrote.
- **9. Cell editing.** While a co-author types in a cell, their editor holds back every change that reaches them, a
  portion's included, until they leave the cell: over 25 seconds, nothing arrived; once they left it, the change
  reached their panel within about 2 seconds, and what they had typed stayed. A command runs while its author types in
  a cell, without closing the cell editor, but what it writes stays in their browser until they leave the cell.
  Meanwhile, the policy service refuses the other authors a change of the same portion, for the minute it remembers the
  version; after that minute, another author's change and the held one both reached the workbook, which kept two parts
  for one portion, each editor showing one of them. A command learns that its author types in a cell from the editor
  itself, `worksheet.workbook.oApi.asc_getCellEditMode()`, since a command's `Api` does not offer the call; the panel
  writes nothing meanwhile ([workbook-co-editing.spec.ts](../../e2e/tests/workbook-co-editing.spec.ts)).
- **12. Headers, in part.** Once the panel has written the page marking, the print preview of a workbook three pages
  long shows it, bold and in its label's colour, centred in the header and the footer of the first page, of the even
  page and of the odd one, beside the template's left and right sections
  ([workbook-page-marking.spec.ts](../../e2e/tests/workbook-page-marking.spec.ts) guards the strings the preview draws
  from). On A4 in portrait, the long marking of a workbook that holds a more restrictive portion ran into the template's
  left header and right footer; in landscape, where the template now prints, it leaves them clear (checked in the print
  preview of the demo's replay). Whether Microsoft Excel opens a header longer than 255 characters, and keeps the
  protected ranges, is left to a check in Excel.
- **13. No-plaintext check.** The search of the Document Server's working files opens every ZIP archive by its
  signature, XLSX files and the spreadsheet editor's change archives included; after the workbook tests, it found no
  portion text ([search-document-server.ts](../../e2e/scripts/search-document-server.ts)).

<!-- Links -->

[4774]: https://www.jedi-sec.us/downloads/MISC_PDF/ADatP-4774%20EDA%20V1%20E.pdf
[4774.1]: https://www.jedi-sec.us/downloads/MISC_PDF/ADatP-4774.1%20EDA%20V1%20E.pdf
[4778]: https://www.jedi-sec.us/downloads/MISC_PDF/ADatP-4778%20EDA%20V1%20E.pdf
[4778.2]: https://storage.nisp.nw3.dk/ADatP-4778.2_EDA_V1_E.pdf
[spif21]: http://www.xmlspif.org/schema/2017/12/xmlspif.xsd
[ecma1]: https://ecma-international.org/wp-content/uploads/ECMA-376-1_5th_edition_december_2016.zip
[MS-OI29500]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/1fd4a662-8623-49c0-82f0-18fa91b413b8
[MS-OFFCRYPTO]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/3c34d72a-1a61-4b52-a893-196f9157f083
[oi-2.1.568]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/16c3c118-f358-493d-a99f-4c85ca834c00
[oi-2.1.570]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/acddb526-fd6c-4835-a83c-bdc9f0924045
[oi-2.1.618]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/7843ab18-de4c-4bf1-8c84-b20a414d6e4f
[oi-2.1.619]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/c167a243-45ad-4def-816e-7032fb1adf5c
[oi-2.1.621]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/18f72dee-6909-4641-8127-73fff1ce7be4
[oi-2.1.622]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/9ec6794e-9c71-422d-a396-ac2934bb3a35
[oi-2.1.633]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/18a8d655-24df-4375-aa11-33c30b9ee92c
[oi-2.1.634]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/f477f387-b861-4166-b849-4e35f8cc5a95
[oi-2.1.654]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/15197a02-26f7-4a37-ab9c-7de4d4894ea5
[oi-3.4.1.5]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/c0599e21-b77f-475e-99e0-bd647f60bcbb
[oc-2.6.2]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/0c4ec12d-aba0-4dd4-8fd1-710da6735219
[oc-2.6.3]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/13939de6-c833-44ab-b213-e0088bf02341

[a-p-config]: https://api.onlyoffice.com/docs/plugins/configuration/
[a-p-events]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/overview/how-to-attach-events/
[a-p-sheetevent]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/spreadsheet-api/Events/onChangeCurrentSheet/
[a-o-getcx]: https://api.onlyoffice.com/docs/office-api/usage-api/spreadsheet-api/ApiWorksheet/Methods/GetCustomXmlParts/
[a-o-getdefnames]: https://api.onlyoffice.com/docs/office-api/usage-api/spreadsheet-api/Api/Methods/GetDefNames/
[a-o-adduser]: https://api.onlyoffice.com/docs/office-api/usage-api/spreadsheet-api/ApiProtectedRange/Methods/AddUser/
[a-o-attachevent]: https://api.onlyoffice.com/docs/office-api/usage-api/spreadsheet-api/Api/Methods/attachEvent/
[a-o-changelog]: https://api.onlyoffice.com/docs/office-api/more-information/changelog/

[s-apibuilder]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js
[s-api-wschange-doc]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L73-L78
[s-api-adddefname]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L1011-L1024
[s-api-getdefname]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L1026-L1062
[s-api-attachevent]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L7822-L7835
[s-api-customprops]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L8162-L8172
[s-ws-defnames]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L9015-L9061
[s-ws-protranges]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L9577-L9670
[s-ws-customxml]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L9706-L9722
[s-range-setvalue]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L10267-L10337
[s-range-format]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L11002-L11085
[s-range-addcomment]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L11149-L11169
[s-range-getdefname]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L11187-L11202
[s-range-select]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L11231-L11264
[s-range-checkprot]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L11750-L11760
[s-name-methods]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L13993-L14052
[s-pr-adduser]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L16199-L16244
[s-pr-exports]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L28489-L28495
[s-api-privdefname]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L29407-L29425
[s-capi-sendevent]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L145-L148
[s-capi-sheetevent]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L1707-L1710
[s-capi-setdefnames]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L3728-L3735
[s-capi-deletesheet]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L4023-L4067
[s-capi-replace]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L4383-L4400
[s-capi-ctxmenu]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L5561-L5572
[s-capi-autosave]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L6786-L6838
[s-capi-builder]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L7265-L7316
[s-capi-protectsheet]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L8356-L8451
[s-capi-wschange]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L9078-L9100
[s-capi-deluserprot]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/api.js#L9240-L9250
[s-cell-events]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/plugin-events.js#L36-L45
[s-hist-newpoint]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/History.js#L1095-L1098
[s-hist-add]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/History.js#L1177-L1265
[s-hist-transaction]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/History.js#L1409-L1459
[s-hist-actionlock]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/History.js#L1646-L1653
[s-coll-lock]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/CollaborativeEditing.js#L163-L256
[s-coll-send]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/CollaborativeEditing.js#L300-L420
[s-undoredo-serialize]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/UndoRedo.js#L75-L131
[s-wb-defname]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L457-L469
[s-wb-defname-byref]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L952-L966
[s-wb-defnames-list]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L994-L1036
[s-wb-copydefnames]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L1163-L1184
[s-wb-customxml]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L3247-L3253
[s-wb-copysheet]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L3967-L3983
[s-ws-hfinit]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L6948
[s-ws-copyfrom]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L7096-L7244
[s-ws-sheetprot]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L13751-L13828
[s-ws-userprot]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L14557-L14811
[s-cell-valueforedit]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L16128-L16151
[s-range-setvalue-model]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Workbook.js#L18970-L19029
[s-upr-class]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/protectRange.js#L40-L58
[s-upr-clone]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/protectRange.js#L68-L85
[s-upr-rights]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/protectRange.js#L206-L254
[s-upr-type]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/protectRange.js#L345-L347
[s-upr-userinfo]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/protectRange.js#L352-L372
[s-ser-uprtype]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Serialize.js#L1302-L1306
[s-ser-copyvalue]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Serialize.js#L6849-L6853
[s-ser-customs-write]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Serialize.js#L7853-L7856
[s-ser-customs-read]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/Serialize.js#L14011-L14013
[s-hf-destroy]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/HeaderFooter.js#L1352-L1391
[s-hf-checksave]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/HeaderFooter.js#L1393-L1466
[s-hf-model]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/WorkbookElems.js#L13847-L13862
[s-hf-setters]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/WorkbookElems.js#L13991-L14093
[s-hf-max]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/commonDefines.js#L2200
[s-clip-copy]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/clipboard.js#L349
[s-clip-cut]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/clipboard.js#L2119-L2159
[s-wsv-print]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L3978-L4068
[s-wsv-sortinfo]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L13176-L13246
[s-wsv-fill]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L15185-L15190
[s-wsv-move]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L15928-L15948
[s-wsv-selinfo]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L16327-L17009
[s-wsv-lockhf]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L17160-L17164
[s-wsv-lockdefnames]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L17197-L17201
[s-wsv-change]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L17428-L18319
[s-wsv-autofilter]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L20314-L20383
[s-wsv-setsort]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L25754-L25824
[s-wsv-selcoords]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorksheetView.js#L27936-L27994
[s-wbv-formulabar]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorkbookView.js#L630-L646
[s-wbv-selchanged]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorkbookView.js#L1291-L1320
[s-wbv-editcell]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorkbookView.js#L2264-L2291
[s-wbv-empty]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorkbookView.js#L2368-L2385
[s-wbv-undo]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorkbookView.js#L3497-L3536
[s-wbv-editdefnames]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorkbookView.js#L3818-L3881
[s-wbv-fastcoedit]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/WorkbookView.js#L6737-L6765
[s-plugins-support]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L504-L531
[s-plugins-selinit]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L639-L652
[s-plugins-onevent]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L655-L707
[s-plugins-init]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L1268-L1358
[s-plugins-selend]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L1938-L1940
[s-pbase-info]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins/plugin_base.js#L640-L641
[s-pbase-init]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins/plugin_base.js#L770-L775
[s-apibase-editorname]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L474-L492
[s-apibase-autosave]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L1508-L1516
[s-apibase-target]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L4172-L4279
[s-apibase-onattach]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L6064-L6066
[s-apibase-plugins-showwindow]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase_plugins.js#L2207-L2291
[s-base-events]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/base-plugin-events.js#L38-L93
[s-text2-keydown]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/text_input2.js#L187-L240
[s-text2-click]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/text_input2.js#L355-L359
[s-text2-move]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/text_input2.js#L1216-L1280
[s-celleditor-move]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/view/CellEditorView.js#L1891
[s-drawdoc-move]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/model/DrawingObjects/DrawingDocument.js#L535
[s-macros-sandbox]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/macros.js#L443-L535
[s-cx-api]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L6675-L6788
[s-cx-serialize]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml.js#L672-L678
[s-cx-history]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml-manager.js#L58-L113
[s-configs-cell]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/configs/cell.json#L395-L408

[w-plugins-editor]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L135
[w-plugins-visible]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L920-L928
[w-plugins-apiwindow]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L1255-L1278
[w-plugins-panel]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L1310-L1376
[w-sse-rightmenu]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/controller/RightMenu.js#L528-L531
[w-sse-main-edit]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/controller/Main.js#L1720-L1753
[w-sse-viewport]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/view/Viewport.js#L194-L202
[w-sse-toolbar]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/view/Toolbar.js#L819-L824
[w-sse-prdlg]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/view/ProtectedRangesManagerDlg.js#L170-L226
[w-sse-prdlg-buttons]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/view/ProtectedRangesManagerDlg.js#L410-L418
[w-sse-wbprot]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/view/WBProtection.js#L195-L205
[w-sse-viewtab]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/view/ViewTab.js#L300-L320
[w-sse-undo-msg]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/app/controller/Main.js#L3290-L3300
[w-sse-strict]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/spreadsheeteditor/main/locale/en.json#L3504

[c-formats]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/Common/OfficeFileFormats.h#L85-L153
[c-defname-comment]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Sheets/Reader/BinaryWriterS.cpp#L3862-L3866
[c-customs-write]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Sheets/Reader/BinaryWriterS.cpp#L9386-L9390
[c-customs-read]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Sheets/Writer/BinaryReaderS.cpp#L8717-L8771
[c-upr-ext]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Sheets/Writer/BinaryReaderS.cpp#L4670-L4691
[c-upr-xml]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/XlsxFormat/Worksheets/WorksheetChildOther.cpp#L4852-L4942
[c-excel-sample]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/test/ExampleFiles/xlsx2xlsb/simple2.xlsx

[v-compare-excel]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L2526-L2562
[v-getlock]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L3525-L3576
[v-savechanges]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L3585-L3747
[v-checklock-excel]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L3813-L3870

[r-config]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/public/config.json#L35-L57
[r-office-api]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/office-api.ts#L1-L100
[r-portions-write]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/portions.ts#L173-L366
[r-portions-read]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/portions.ts#L368-L409
[r-portions-build]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/portions.ts#L575-L592
[r-portions-content]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/portions.ts#L663-L675
[r-hooks-reread]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/hooks.ts#L115-L117
[r-hooks-events]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/hooks.ts#L102-L111
[r-panel]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/Panel.tsx#L110-L114
[r-bubble]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/plugin/src/bubble.ts#L56-L159
[r-documents]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/portal/src/documents.ts#L19-L26
[r-server]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/portal/src/server.ts#L145-L161
[r-dsroutes]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/portal/src/document-server-routes.ts#L39-L52
[r-editor-config]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/portal/src/editor-config.ts#L10-L99
[r-binding]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/portal/src/binding.ts#L9-L23
[r-doclabels]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/portal/src/document-labels.ts#L27-L59
[r-bindsig]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/portal/src/binding-signature.ts#L78-L92
[r-adatp4778]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/policy/src/adatp4778.ts#L10-L19
[r-policy-server]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/policy/src/server.ts#L460-L468
[r-pkgsign]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/policy/src/package-signing.ts#L10-L184
[r-demo]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/deploy/demo/generate-documents.ts#L3-L73
[r-init]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/deploy/init/init.sh#L11-L21
[r-spif]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/deploy/spif/demo-fr.spif.xml#L14-L22
[r-e2e-docx]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/e2e/tests/support/docx.ts#L72-L117
[r-e2e-plugin]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/e2e/tests/support/plugin.ts#L32-L420
[r-e2e-portions]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/e2e/tests/support/portions.ts#L14-L19
[r-e2e-documents]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/e2e/tests/support/documents.ts#L199-L271
[r-context]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/CONTEXT.md#L61-L62
[r-portal-editorjs]: https://github.com/linagora/dcs-onlyoffice/blob/2af1dd44d74c21c1a9616932e85f79964d236034/portal/public/editor.js#L8-L12
