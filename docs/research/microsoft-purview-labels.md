# Microsoft Purview sensitivity labels in Word files: metadata, export, import and a demo tenant

Research notes compiled on 2026-09-28 for iteration 5, which maps the document label to a Microsoft Purview
sensitivity label. The portal writes the Purview label metadata into each saved DOCX (export), reads the Purview
label of an unencrypted Word file uploaded to it (import), and a Microsoft 365 demo tenant shows whether Word
displays the label.

**Scope.** Unencrypted WordprocessingML packages (`.docx`) and the two places that carry a sensitivity label in
them: custom document properties and the Sensitivity Label Information part. Encryption matters only to the
extent that an import has to recognise an encrypted file and refuse it. Labels that apply encryption or content
marking, email, PDF, auto-labelling and the MIP SDK API are out of scope. Nothing was run against a Microsoft 365
tenant or against Word: what needs them is collected in [Open questions](#8-open-questions-need-a-tenant-or-word).

Primary sources: Microsoft's open specifications ([MS-OFFCRYPTO] v14.0 of 2026-02-17, [MS-OI29500] v25.0 of
2026-08-18, [MS-CFB]), ECMA-376 5th edition, learn.microsoft.com pages (Purview, MIP SDK, Security & Compliance
PowerShell, Microsoft Graph, Microsoft Entra, Microsoft 365 Developer Program), and the source code of the Open XML
SDK, EPPlus, XlsxWriter, Apache Tika and ONLYOFFICE, pinned to commits. Every claim cites a URL, with the section
number for a specification and the anchor for a documentation page.

Conventions used below:

- **Mandated**: normative text of an open specification (shall, must) or its XML schema.
- **Guidance**: Microsoft product documentation on learn.microsoft.com. It describes product behaviour or
  recommends a practice; it is not a file format specification.
- **Implementation**: what open source code does, which is not necessarily what a specification says.
- **Tested**: checked during this research with `xmllint`, the Open XML SDK 3.5.1, `curl`, or the
  `onlyoffice/documentserver:9.4.0.1` image. The methods are in [appendix A](#appendix-a-how-the-tests-were-run).
- **Inference**: my reading, not stated by a source.
- **UNVERIFIED**: not confirmed by a primary source or a test.

All identifiers in the examples are fictional: tenant `00000000-0000-0000-0000-000000000000`, label
`11111111-2222-3333-4444-555555555555`.

## Key findings

1. **Two places carry the label** of an unencrypted DOCX ([MS-OFFCRYPTO] [§2.6.2][oc-2.6.2], [§2.6.3][oc-2.6.3]):
   - the custom document properties `MSIP_Label_<label GUID>_<attribute>` in `docProps/custom.xml`, the original
     location;
   - the Sensitivity Label Information part `/docMetadata/LabelInfo.xml`, root `clbl:labelList` in
     `http://schemas.microsoft.com/office/2020/mipLabelMetadata`, target of a package relationship of type
     `http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels`.

   Office moves a tenant's labels to the part when that tenant turns on co-authoring for encrypted files, a
   setting that is off by default. From then on, "labeling information for unencrypted files is no longer saved in
   custom properties" ([Purview][pv-coauth-meta]; [default off][pv-spo-limits]).
2. **Which one wins** is decided per tenant (`siteId`). If the reader knows its tenant opted in, or does not know
   the policy, a `label` element of the part wins for its tenant, and custom properties count only for tenants
   without an element. If the reader knows its tenant did not opt in, it reads custom properties only
   ([MS-OFFCRYPTO] §2.6.3, Mandated).
3. **Export**: the seven custom properties `Enabled`, `SetDate`, `Method`, `Name`, `SiteId`, `ActionId` and
   `ContentBits`, all `vt:lpwstr`, are read by Word whether or not the tenant opted in, according to §2.6.3. The
   LabelInfo part is optional. If the portal writes it, its content type must be
   `application/vnd.ms-office.classificationlabels+xml`, as Office writes it: [MS-OI29500] §3.4.1.5 says
   `application/xml`, but the Open XML SDK refuses to open a package with that content type (Tested).
4. **ONLYOFFICE Docs 9.4 keeps `docProps/custom.xml`** through every save, with names, values and types unchanged
   but `pid`s renumbered. **It always drops `docMetadata/LabelInfo.xml`**, its content type override and its
   relationship (Tested, and from the code). No ONLYOFFICE repository mentions MSIP or sensitivity labels. Editors
   can delete custom properties in File > Info, so the portal has to rewrite the Purview metadata at each save.
5. **Signature**: `docProps/custom.xml` is in ADatP-4778.2 Table 5-3, so the portal must write the Purview
   properties before the policy service signs. `docMetadata/LabelInfo.xml`, `_rels/.rels` and
   `[Content_Types].xml` are not in Tables 5-2 or 5-3. A LabelInfo part added after signing would change the label
   Word shows in an opted-in tenant without invalidating the signature. The platform's binding now references
   `_rels/.rels` and `[Content_Types].xml`, which adding the part changes (Implementation, #91).
6. **Import**: refuse compound files (encrypted or legacy binary) with a message that says which. For each tenant,
   read its LabelInfo element first, then its custom properties if it has no element. A `removed="1"` element means
   no label for that tenant. Keep only the configured tenant's label for the mapping; identify it by id, never by
   `Name`.
7. **Word** (Guidance): it shows the name of a label from the reader's own tenant, even if the label is not
   published to the reader; it never shows labels of other tenants; it does not insert a label's header, footer or
   watermark when the label was set outside Office.
8. **Demo tenant**: manual labelling needs Microsoft 365 E3/E5/Business Premium, Office 365 E3/E5 or equivalent.
   Word for the web needs the file in SharePoint or OneDrive, with sensitivity labels enabled for them. A tenant
   comes from the Developer Program (an E5 sandbox for Visual Studio Professional or Enterprise subscribers and
   eligible partners, with a mandatory billing account) or from a one-month trial with 25 licences. Security &
   Compliance PowerShell does not run on macOS or Linux. Tenants created since 2025-10-01 get default labels and
   label groups instead of parent labels.

---

## 1. Sources

| Short name | Document | Version or commit | Notes |
|---|---|---|---|
| [MS-OFFCRYPTO] | *Office Document Cryptography Structure* ([landing page][oc], [PDF][oc-pdf]) | v14.0, 2026-02-17 | §2.6 sensitivity labels; §2.1 to §2.3 data spaces and encryption |
| [MS-OI29500] | *Office Implementation Information for ISO/IEC 29500 Standards Support* ([landing page][oi], [PDF][oi-pdf]) | v25.0, 2026-08-18 | §2.1.31 and §2.1.1724 custom properties; §3.4.1.5 label part; §3.11.2 label properties |
| [MS-CFB] | *Compound File Binary File Format*, §2.2 ([page][cfb]) | page of 2021-06-24 | Signature of compound files |
| ECMA-376 | Office Open XML 5th ed., Part 1 (2016) and Part 4 Transitional (2016) ([Ecma][ecma376]) | | Custom properties part and schema |
| MIP SDK | [Label metadata in the MIP SDK][mip-md] | updated 2026-09-21 | Guidance: names and meaning of the properties |
| Purview | [co-authoring][pv-coauth] (2026-01-14), [Office apps][pv-office] (2026-06-30), [SharePoint and OneDrive][pv-spo] (2026-08-07), [sensitivity labels][pv-labels] (2026-04-15), [create labels][pv-create] (2026-05-26), [auto-labelling][pv-auto] (2026-09-18) | | Guidance |
| Open XML SDK | [dotnet/Open-XML-SDK][oxsdk], Microsoft's own OOXML library (MIT) | commit `431ab05` (2026-08-18); NuGet 3.5.1 for the tests | Declares the label part |
| EPPlus | [EPPlusSoftware/EPPlus][epplus] | commit `84fd0dd` (branch `develop8`) | Writes the label part |
| XlsxWriter | [jmcnamara/XlsxWriter][xlsxwriter] (BSD-2) | commit `5d4606d` | Writes the custom properties |
| Apache Tika | [apache/tika][tika] (Apache-2.0) | commit `df85810` | Detects encrypted Office files |
| ONLYOFFICE | sdkjs, core, web-apps and server (AGPL-3.0) | tag `v9.4.0.129`: sdkjs `75b53d5`, core `a016fc2`, web-apps `1993a6d`, server `13142e4` | Same tag as [onlyoffice-integration.md](onlyoffice-integration.md#0-version-pinning) |

The specifications were downloaded as PDF on 2026-09-28; their checksums are in
[appendix B](#appendix-b-sha-256-of-the-specifications-used). The learn.microsoft.com section pages give the same
text.

---

## 2. Label metadata in a DOCX (question A)

### 2.1 Custom document properties `MSIP_Label_<GUID>_*`

**The part** (ECMA-376, Mandated):

- Transitional names: root `Properties` in `http://schemas.openxmlformats.org/officeDocument/2006/custom-properties`,
  values in `vt:` = `http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes`, package relationship
  `http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties`, content type
  `application/vnd.openxmlformats-officedocument.custom-properties+xml` ([ECMA-376-4][ecma4] §13.2.11 p. 28;
  [ECMA-376-1][ecma1] §15.2.12.2 pp. 152-153).
- "A package shall contain at most one Custom File Properties part, and that part shall be the target of a
  relationship in the package-relationship item" (ECMA-376-1 §15.2.12.2). The name `docProps/custom.xml` is only
  customary.
- Each `property` has `fmtid`, `pid` and `name`, and one `vt:` child (ECMA-376-1 §22.3.2.2 p. 3732).

**Office restrictions** ([MS-OI29500] [§2.1.1724][oi-2.1.1724], Mandated for interoperability with Office):

- only `bool`, `filetime`, `empty`, `i4`, `lpstr`, `lpwstr` and `r8` values when `fmtid` is
  `{D5CDD505-2E9C-101B-9397-08002B2CF9AE}`;
- `pid` at least 2;
- "Office requires that the name attribute be a case-insensitive unique name".

**The label properties.** The MIP SDK builds each name as `DefinedPrefix_ElementType_GlobalIdentifier_AttributeName`,
which gives `MSIP_Label_<label GUID>_<attribute>`. "An object can only have one label from the same organization"
([MIP SDK][mip-md], Guidance). The attributes:

| Attribute | Value | "Mandatory" (MIP SDK) | Meaning (MIP SDK) |
|---|---|---|---|
| `Enabled` | `true` or `false` | Yes | Whether the label is in effect. "DLP products typically validate the existence of this key." |
| `SiteId` | GUID | Yes | "Microsoft Entra tenant ID" |
| `ActionId` | GUID | Yes, but "Removed in MIP SDK 1.8 and later" | Changes each time a label is set; audit logs chain the old and new values |
| `Method` | `Standard` or `Privileged` | No | Standard: "applied by default or automatically"; Privileged: "manually selected" |
| `SetDate` | "Extended ISO 8601 Date Format" | No | When the label was set |
| `Name` | string | No | "Label unique name within the tenant. It doesn't necessarily correspond to display name." |
| `ContentBits` | integer | No | Bitmask of the content marking applied: header `0x1`, footer `0x2`, watermark `0x4`, encryption `0x8` |

Formats (Guidance: from Microsoft's examples, since no specification defines the value grammar):

- Every value is a `vt:lpwstr`, including `Enabled` and `ContentBits` ([MS-OI29500] [§3.11.2][oi-3.11.2] examples
  for Excel, PowerPoint and Word; [MIP SDK][mip-md] example).
- The GUID in the name and the `SiteId` value are lowercase without braces in every Microsoft example.
- `Enabled` is `true` in these examples, but `True` in a Microsoft Graph example, where `SetDate` is even
  `1/1/0001 12:00:00 AM` ([Graph PowerShell beta][graph-beta-extract]). `SetDate` is `2018-09-24T21:38:47-0800`
  in [MS-OI29500] §3.11.2: the offset has no colon, so it is not the extended format that the MIP SDK names.
  *Inference*: a reader must parse these values leniently, and a writer should use `YYYY-MM-DDThh:mm:ssZ`, as
  XlsxWriter does ([example][xw-example]).
- "To maintain compatibility across common applications, the maximum length for each key and value is 255
  characters" ([MIP SDK #extending metadata][mip-md-ext]).
- Custom attributes keep the prefix (`MSIP_Label_<GUID>_GeneratedBy`), and a replaced attribute takes a version
  suffix (`MSIP_Label_GUID_EnabledV2`) ([MIP SDK][mip-md]). A reader should ignore attribute names it does not
  know (*Inference*).

**Other properties Office writes** ([MS-OI29500] [§3.11.2][oi-3.11.2]):

- `Sensitivity`, "set to the GUID of the label ID applied to the file" ("may").
- For Word only, when a label applies marking: `ClassificationContentMarkingHeaderText`, `…HeaderFontProps` and
  `…HeaderShapeIds` (hexadecimal shape ids, continued in `…ShapeIds-1`, `-2`…), the same for the footer, and
  `ClassificationWatermarkText`, `…FontProps` and `…ShapeIds`.
- Older clients wrote other label keys: [MS-OFFCRYPTO] §2.6.3 mentions "parent labels, Application, Owner, Name,
  SetDate, and others" in custom properties.

**What Word needs to recognise a label** is not documented beyond the MIP SDK "Mandatory" column (`Enabled`,
`SiteId` and, for older readers, `ActionId`). **UNVERIFIED**: see [open question 1](#8-open-questions-need-a-tenant-or-word).

**Tested**: a `docProps/custom.xml` with the seven properties validates against the ECMA-376 Transitional schema,
and the Open XML SDK reads them ([appendix A](#appendix-a-how-the-tests-were-run)).

**Implementation**: XlsxWriter writes the same seven properties as `vt:lpwstr` through its public API, with values
copied from a file that Office labelled ([example][xw-example]; [documentation][xw-doc]).

### 2.2 The Sensitivity Label Information part `docMetadata/LabelInfo.xml`

**Package plumbing:**

| Item | Value | Source |
|---|---|---|
| Relationship source | The package-relationship item `/_rels/.rels`; "A package is permitted to contain at most one Sensitivity Label Information part" | [MS-OI29500] [§3.4.1.5][oi-3.4.1.5] (Mandated) |
| Relationship type | `http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels` | §3.4.1.5 (Mandated) |
| Part name | `/docMetadata/LabelInfo.xml` in every example; not mandated, so find it through the relationship | §3.4.1.5 example; [Open XML SDK][oxsdk-part] target `docMetadata/LabelInfo` |
| Root | `labelList` in `http://schemas.microsoft.com/office/2020/mipLabelMetadata` | §3.4.1.5; [MS-OFFCRYPTO] §2.6.4.1, §2.6.4.3 |
| XML declaration | "shall comprise of an xml preprocessor directive", for example `<?xml version="1.0" encoding="utf-8" standalone="yes"?>` | [MS-OFFCRYPTO] [§2.6.4.2][oc-2.6.4.2] (Mandated) |
| Content type | The specification says `application/xml`. Office, the Open XML SDK and EPPlus use an `Override` with `application/vnd.ms-office.classificationlabels+xml` | §3.4.1.5 versus [Open XML SDK][oxsdk-part], [EPPlus][epplus-ct] and [a Word file published by Microsoft][ms-sample-ct] |

**Tested**: the Open XML SDK 3.5.1 refuses to open a package whose LabelInfo part has the content type
`application/xml` ("an invalid part with an unexpected content type", expected
`application/vnd.ms-office.classificationlabels+xml`). Writers should use the `vnd` type; readers should find the
part by relationship type and accept either content type (*Inference*).

**Schema** ([MS-OFFCRYPTO] [§2.6.4][oc-2.6.4], Mandated), summarised:

```text
clbl:labelList                          root, exactly one
  clbl:label            0..n            CT_ClassificationLabel
    @id                 xsd:string      required
    @enabled            xsd:boolean     required
    @method             xsd:string      required
    @siteId             ST_ClassificationGuid  required   pattern \{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}
    @contentBits        xsd:unsignedInt optional
    @removed            xsd:boolean     required
  clbl:extLst           0..1
    clbl:ext            0..n            @uri (xsd:token, required, not empty) + one element of any namespace
```

**Rules for each `label`** ([§2.6.5.4][oc-2.6.5.4], Mandated; "ought" is a recommendation):

- The attributes "shall be written in the order presented": `id`, `enabled`, `method`, `siteId`, `contentBits`,
  `removed`. Values are case sensitive unless stated otherwise. Optional attributes are omitted, never empty,
  except `method` on a removed label.
- `id`: the label id from the policy, never empty, "shall be written in lowercase"; a GUID "ought to be written as
  a ST_ClassificationGuid", that is braced. For a removed label it "ought to be set to the same value as siteId".
- `enabled`: removed labels "ought not to be enabled".
- `method`: "ought to be" `Standard` or `Privileged`, and "shall be empty (method="") if the removed attribute is
  1". When converting from another source, use Standard for default and automatic labels, and Privileged for
  labels the user chose, including recommended and mandatory labelling.
- `siteId`: the tenant. "There shall only be at most one label element with a given siteId." When the source has
  a parent and a child label, only the child is kept.
- `contentBits`: decimal, OR of Header 1, Footer 2, Watermark 4 and Encryption 8, "the types of content marking
  that ought to be applied". Other bits are ignored on read and not set on write. It "ought" to be omitted for
  removed labels.
- `removed`: `1` means the label is not applied. Instead of deleting the element, a writer keeps one element with
  `removed` for the tenant, so that its labels "shall not be converted from older locations", such as custom
  properties.
- `extLst`: content that is not understood "shall be preserved" ([§2.6.4.5][oc-2.6.4.5]). No extension is
  defined yet ([§2.6.6][oc-2.6.6]).
- An implementation "might write an empty labelList element" when there is no label ([§2.6.2][oc-2.6.2]).

**Canonical form.** SharePoint Online and a client may edit the part at the same time, so "the two writers
involved must be written cooperatively" to produce identical bytes. These "stricter rules" are implemented in the
MIP SDK 1.7 but not published ([MS-OI29500] [§3.4.1.5][oi-3.4.1.5]). The examples in [§3.12][oc-3.12] and a file
written by Word ([sample][ms-sample-li]) share one shape: no whitespace between elements, attributes in the order
above, `" />"` with a space, and, in the example, `label` elements in ascending `id` order (*Inference*: the order
is not stated as a rule). Written in that shape, with fictional ids:

```xml
<?xml version="1.0" encoding="utf-8" standalone="yes"?><clbl:labelList xmlns:clbl="http://schemas.microsoft.com/office/2020/mipLabelMetadata"><clbl:label id="{11111111-2222-3333-4444-555555555555}" enabled="1" method="Privileged" siteId="{00000000-0000-0000-0000-000000000000}" contentBits="0" removed="0" /></clbl:labelList>
```

A removed label for the same tenant, as in the §3.12 example:

```xml
<clbl:label id="{00000000-0000-0000-0000-000000000000}" enabled="0" method="" siteId="{00000000-0000-0000-0000-000000000000}" removed="1" />
```

**Tested** ([appendix A](#appendix-a-how-the-tests-were-run)):

- The schema as printed in §2.6.4 has **no `targetNamespace`**, so it cannot validate a document in the `clbl`
  namespace. With the namespace added, the fictional example and the first §3.12 example validate. The second
  §3.12 example (`extLst`) still fails, because `xsd:any` is strict; it validates with `processContents="lax"`.
- Against that repaired schema, an uppercase or unbraced `siteId` fails the pattern. The Open XML SDK is more
  lenient on case (pattern `[0-9A-Fa-f]`, [schema data][oxsdk-schema]) but also rejects an unbraced `siteId`, and
  reports a missing `removed`.
- EPPlus writes the attributes in another order (`id`, `removed`, `enabled`, `siteId`, `method`, `contentBits`)
  and does not lowercase the ids ([EPPlus][epplus-write]): an implementation that departs from §2.6.5.4.

### 2.3 When Office writes which location, and which one wins

**The switch is a tenant setting** (Guidance):

- "After you enable the setting for co-authoring, labeling information for unencrypted files is no longer saved in
  custom properties." Files labeled earlier are converted "the next time the file is opened and saved"
  ([Purview][pv-coauth-meta]).
- Off by default: "By default, Office desktop apps and mobile apps don't support co-authoring for files that are
  labeled with encryption" ([SharePoint and OneDrive, Limitations][pv-spo-limits]).
- It is turned on in the Purview portal (Settings > Solution settings > Information Protection > Co-authoring for
  files with sensitivity labels), and turned off only with `Set-PolicyConfig -EnableLabelCoauth:$false`, which
  loses the new-location metadata of unencrypted files ([Purview][pv-coauth-howto]; [Set-PolicyConfig][set-policyconfig]).
- The MIP SDK 1.7 and later reads the new location first and falls back to the old one; its next write goes to
  the new location ([MIP SDK][mip-md-coauth]).
- This setting is what [MS-OFFCRYPTO] calls a policy that "opts in to the LabelInfo stream": the Purview page
  points to §2.6.3 for the metadata change (*Inference* from that link).

**The rules** ([MS-OFFCRYPTO] [§2.6.3][oc-2.6.3], Mandated), applied to each label, that is to each tenant:

| | Reading | Writing |
|---|---|---|
| Policy opts in | Read the LabelInfo part first; read custom properties only for tenants that have no `label` element | Write the LabelInfo part; keep that tenant's custom properties "as-is ... even if the sensitivity label was removed or changed" |
| Policy known, does not opt in | Read custom properties only; "shall not read" the LabelInfo part for that tenant | Write custom properties |
| Policy unknown | Infer opt-in per tenant from the presence of its metadata in the LabelInfo part | Write where the metadata was found |

Further rules of §2.6.3:

- Opted in, with metadata only in custom properties: the metadata is written "as-is" to custom properties **and**
  to the LabelInfo part, converted (`True` becomes `enabled="1"`, `Auto` becomes `method="Standard"`; `Name`,
  `SetDate`, parent labels and the like are not carried over).
- A label element in the part and no custom properties for the same tenant "shall not result in the transfer" to
  custom properties, "since it would render older or unaware implementations ... unable to remove sensitivity
  label metadata".
- A reader that removes a label it read from the part writes `removed="1"`, which later readers take as "do not
  read custom properties for that tenant".

*Inference*: a file saved by Word in an opted-in tenant can carry stale custom properties that contradict the
part. A reader that looks at custom properties first shows the wrong label.

**Encrypted files.** When rights management is applied and the publishing licence is present, the metadata goes
into a `LabelInfo` stream of the `\0x06DataSpaces\TransformInfo` storage; readers ignore label metadata inside
the encrypted package when that stream exists ([§2.6.2][oc-2.6.2]; [MS-OI29500] [§3.4.1.5][oi-3.4.1.5]). In every
case, "the label defined in the publishing license shall be construed to be the label applied to the content"
([§2.6.1][oc-2.6.1]).

### 2.4 Meaning of `Method`, `ContentBits`, `ActionId`, `SetDate` and `removed`

- **`Method`**: Standard is a default or automatic label, Privileged a label the user chose ([MIP SDK][mip-md];
  [§2.6.5.4][oc-2.6.5.4]). It matters to automatic labelling: "When content has been manually labeled, that label
  won't be replaced by automatic labeling", while a lower-priority label that was applied automatically is
  replaced by a higher-priority one ([auto-labelling][pv-auto]).
- **`ContentBits`**: the MIP SDK describes it as the marking "applied to content based on policy and client
  capabilities", while [§2.6.5.4][oc-2.6.5.4] speaks of marking "that ought to be applied". The MIP SDK adds that
  Word compares it on **Save** with what the policy computes and adds the missing marking, but "This feature
  requires the Microsoft Purview Information Protection client" ([MIP SDK #ContentBits][mip-md-bits]).
- **`ActionId`**: a new GUID each time a label is set, so that audit logs can chain labelling actions. The MIP SDK
  1.8 and later no longer writes it ([MIP SDK][mip-md]), but it appears in all of Office's examples
  ([MS-OI29500] §3.11.2).
- **`SetDate`**: when the label was set ([MIP SDK][mip-md]). It has no counterpart in the LabelInfo part.
- **`removed`**: exists only in the LabelInfo part (see [2.2](#22-the-sensitivity-label-information-part-docmetadatalabelinfoxml)).
  In custom properties a label is removed by deleting its properties, and `Enabled` other than `true` means it is
  not in effect (*Inference*: no document states how a removal is written there).

### 2.5 What Word does with the label (question A.4)

| Case | Word desktop | Word for the web | Source (Guidance) |
|---|---|---|---|
| Label of the reader's own tenant | Shows the label name, on the status bar for example, "even if that label isn't published to them" | Same, for a file in SharePoint or OneDrive once labels are enabled there | [labels #what-label-policies-can-do][pv-labels-policies]; [Office apps #external users][pv-office-external]; [SharePoint and OneDrive][pv-spo] |
| Label of another tenant | Not shown; "each organization can apply and see their own label"; guests do not see it | Same | [Office apps #external users][pv-office-external] |
| Label id unknown to the tenant (a deleted label) | "the label information in the metadata remains, but without the label ID to name mapping, users don't see the applied label name" | Label not shown, not in the Sensitivity column; "users will assume a file isn't labeled" | [create labels #removing-and-deleting-labels][pv-create-delete] |
| Label with header, footer or watermark in its policy, set outside Office (`ContentBits` 0) | "The content markings aren't automatically applied when you open those documents in Office apps"; the user can re-apply the label to get them | Same | [Office apps #content marking][pv-office-marking] |
| Label set before labels were enabled in SharePoint and OneDrive | n/a | "The labels aren't recognized" until the file is downloaded and uploaded again | [SharePoint and OneDrive #limitations][pv-spo-limits] |

The portal's export is the "outside Office" case: Word will show the label if its id and tenant match, but will not
add the Purview marking. What Word does on the next Save when `ContentBits` is lower than the policy requires is
**UNVERIFIED**: the MIP SDK describes that reconciliation only for the Information Protection client.

### 2.6 Recognising a file that Purview encrypted (question A.5)

- An OPC package is a ZIP file (`PK\x03\x04`). An encrypted OOXML document is an OLE compound file: "Encrypted
  ECMA-376 documents ... contain the entire document as a single stream (1) in an OLE compound file"
  ([MS-OFFCRYPTO] [§1.3.3.4][oc-1.3.3.4]). Its first eight bytes are `D0 CF 11 E0 A1 B1 1A E1` ([MS-CFB]
  [§2.2][cfb]), whatever the file extension.
- **Rights management encryption**, the one sensitivity labels apply (the specification ties label metadata to
  the IRM publishing licence, [§2.6.1][oc-2.6.1], [§2.6.2][oc-2.6.2]): the `\0x06DataSpaces\DataSpaceMap` stream
  has exactly one entry, `DRMEncryptedDataSpace`, which points at the `EncryptedPackage` stream. The
  `\0x06DataSpaces\TransformInfo\DRMEncryptedTransform` storage holds a `0x06Primary` stream whose transform id is
  `{C73DFACD-061F-43B0-8B64-0C620D2A8B50}` (`Microsoft.Metadata.DRMTransform`), followed by the XrML signed
  issuance licence ([§2.2.1][oc-2.2.1], [§2.2.4][oc-2.2.4], [§2.2.6][oc-2.2.6], Mandated).
- **Password encryption**: the map entry is `StrongEncryptionDataSpace`, the transform is
  `StrongEncryptionTransform` (`{FF9A3F03-56EF-4613-BDD5-5A41C1D07246}`), and an `EncryptionInfo` stream is present
  ([§2.3.4.1][oc-2.3.4.1], [§2.3.4.3][oc-2.3.4.3]).
- Apache Tika detects the same cases from stream names ([POIFSContainerDetector L411-L444][tika-detect],
  Implementation):
  - `\u0006DataSpaces` with a `\tDRMDataSpace` below it: a DRM-encrypted binary Office file;
  - `EncryptedPackage` and `EncryptionInfo`: a password-protected OOXML file;
  - `EncryptedPackage` and `\u0006DataSpaces` with `DRMEncryptedDataSpace` below it, but no `EncryptionInfo`: a
    DRM-encrypted OOXML file.
- To name the label in the refusal without decrypting, read the `LabelInfo` stream in
  `\0x06DataSpaces\TransformInfo` when it exists ([§2.6.2][oc-2.6.2]). Encrypted files may also carry a root
  `\x05DocumentSummaryInformation` stream ([§2.9][oc-2.9]); whether it holds the `MSIP_Label_` properties is
  **UNVERIFIED**.
- A compound file with neither structure is a legacy binary document (`.doc`) or another OLE file. SharePoint can
  extract a label from a `.doc` ([SharePoint and OneDrive #supported-file-types][pv-spo-types]), but the portal
  imports DOCX only.

---

## 3. ONLYOFFICE Docs 9.4 and the label metadata (question E)

All links point at tag `v9.4.0.129`. The round trips were run in throwaway containers of
`onlyoffice/documentserver:9.4.0.1` ([appendix A.3](#a3-onlyoffice-round-trips)).

### 3.1 Custom properties are kept

- **Read on open.** x2t finds the part through its package relationship ([FileFactory.cpp L146-L150][c-ff-cp]) and
  reads `fmtid`, `pid`, `name` and `linkTarget` verbatim ([HeadingVariant.cpp L650-L667][c-hv-read]), with every
  docPropsVTypes value type ([L145-L199][c-hv-types]). It puts them in the editor binary as table 18
  ([BinaryWriterD.cpp L9986-L9996][c-bw-cp]), which sdkjs loads into `Document.CustomProperties`
  ([Serialize2.js L8089-L8094][s-ser-read]). *Inference*: a `custom.xml` without its relationship is ignored.
- **Written on save.** sdkjs writes the table when there is at least one property ([Serialize2.js L1964-L1973][s-ser-write]),
  and x2t writes `docProps/custom.xml` ([DocxSerializer.cpp L466-L469][c-docx-ser]) and the relationship `rId4`
  ([DocumentRelsWriter.cpp L44-L65][c-rels]).
- **Renumbered `pid`s.** sdkjs sets `pid` to 2, 3… in list order before each save ([Format.js L14894-L14908][s-pid]).
  The order, names, `fmtid` values and `vt:lpwstr` values are kept.
- **Tested**: the seven `MSIP_Label_…` properties came out unchanged, as `vt:lpwstr`, on every path, including the
  editor's save path through sdkjs. A `Name` value with `&`, `<`, `>`, quotes and `é` survived. Two unrelated
  defects: a `vt:ui4` above 2^31 comes out negative through sdkjs ([Format.js L15355-L15358][s-ui4]), and a
  `vt:r8` 1.5 comes out as `1.500000`.
- **Editors can change them.** File > Info lists the properties with a delete button and an edit dialog
  ([FileMenuPanels.js L2053-L2100][w-info]); each change is an undoable action ([Document.js L28516-L28544][s-doc-cp]).

This settles the point that [onlyoffice-integration.md](onlyoffice-integration.md#10-custom-document-properties-90)
left **UNVERIFIED**: x2t does write the properties to `docProps/custom.xml`.

### 3.2 The LabelInfo part is dropped

- A relationship of an unknown type becomes an `UnknowTypeFile` ([FileFactory.cpp L204][c-ff-unknown]), whose
  `read` and `write` do nothing ([UnknowTypeFile.cpp L50-L55][c-unknown]).
- The editor binary has no table for unknown parts ([Serialize2.js L67-L89][s-tables]).
- `_rels/.rels` is written from a fixed template: `officeDocument`, `core-properties`, `extended-properties`, and
  `custom-properties` when there are custom properties ([DocumentRelsWriter.cpp L44-L65][c-rels]).
- **Tested**: after the editor's save path, the part, its `Override` and its relationship were all gone. The
  project's `customXml` part survived. Only a direct x2t DOCX-to-DOCX conversion, which unzips and zips again
  ([ASCConverters.cpp L672-L682][c-direct], [L311-L378][c-direct-zip]), kept LabelInfo, and the editor never
  saves that way.

### 3.3 No mention of Purview, and a public API that can read the properties

- None of sdkjs, core, web-apps or server contains `MSIP`, `MSIP_Label`, `sensitivity label`, `LabelInfo`,
  `classificationlabels`, `mipLabelMetadata`, `2020/02/relationships`, `Purview`, `Information Protection` or
  `docMetadata` (every text file of the four trees grepped, case-insensitively and with word boundaries; the only
  hits are unrelated uses of "sensitivity" and base64 data). None of their 85 OOXML test files carries a
  `docMetadata` part or an `MSIP_Label_` property.
- The Office JavaScript API has `ApiDocument.GetCustomProperties()` "@since 9.0.0" and `ApiCustomProperties.Add`
  and `Get` ([apiBuilder.js L10180-L10189][s-api-get], [L30385-L30446][s-api-cp]). `Add` infers the type from the
  JavaScript value, so a string gives `vt:lpwstr`. There is no list or delete method. **Tested**: `Get` returned the
  `Name` and `Enabled` values as strings. A plugin could therefore show the Purview label, but not remove it.
- `AddProperty` compares names with `===` ([Format.js L14947-L14956][s-addprop]), which is case sensitive, while
  Office requires names to be unique without regard to case.

### 3.4 Side finding: the `customXml` item id loses its braces

After a save through the model, `customXml/itemProps1.xml` has `ds:itemID="D549412A-…"` without braces
([CustomXml.cpp L195-L200][c-itemid], Tested), while the ECMA-376 `ST_Guid` type is braced. This concerns the
project's own binding part, not Purview; whether Word minds is **UNVERIFIED** ([open question 13](#8-open-questions-need-a-tenant-or-word)).

---

## 4. The ADatP-4778.2 binding signature (question D)

What [labelling-standards.md](labelling-standards.md#42-what-the-profile-mandates-full-list-chapter-5-is-short)
records: a whole-document binding SHALL reference every present part of Table 5-2 and the document-properties
parts of Table 5-3 (`/docProps/core.xml`, `/docProps/app.xml`, `/docProps/custom.xml`), and "Additional parts MAY
be referenced". The portal lists the parts present at each save, and the policy service signs SHA-384 digests of
their bytes ([ADR 0004](../adr/0004-the-policy-service-signs-the-document-label-binding.md)).

Implications (*Inference* from these rules and from sections 2 and 3):

1. **Write the Purview properties before signing.** They sit in `docProps/custom.xml`, a referenced part. The save
   pipeline has to be: file from the Document Server, then the Purview properties, then the refreshed reference
   list, then the signature. Written later, for instance when a file is downloaded, they invalidate the signature,
   and the stored-file check reports `docProps/custom.xml` among the parts changed since signing.
2. **The part always exists once the portal writes it.** ONLYOFFICE writes `custom.xml` only when there are
   properties (section 3.1). The portal already lists the parts present at each save, so a `custom.xml` created
   before that step is referenced. `DEFAULT_DOCUMENT_PARTS` in `policy/src/adatp4778.ts` leaves it out, because it
   lists the parts "a DOCX saved by ONLYOFFICE always contains".
3. **The LabelInfo part is not covered.** It is in neither Table 5-2 nor Table 5-3, and neither are `_rels/.rels`
   and `[Content_Types].xml`. Anyone who can write the stored file could add a LabelInfo part, its relationship
   and its override without changing a digest. Word in an opted-in tenant would then show that label rather than
   the signed one (section 2.3). ONLYOFFICE never produces the part (section 3.2), so a stored file that has one
   was changed by the portal or by someone else. Options for the project:
   - if the portal writes the part, reference `pack:///docMetadata/LabelInfo.xml` as an additional part;
   - also reference `pack:///_rels/.rels`, which ONLYOFFICE rewrites from a template at each save;
   - make the stored-file check report a `classificationlabels` relationship that the binding does not cover.

   The platform's binding now references `_rels/.rels` and `[Content_Types].xml`
   ([labelling-standards.md 4.9](labelling-standards.md#49-what-the-platforms-binding-references); Implementation,
   #91): a LabelInfo part added after signing changes them, so the stored-file check reports them as changed, and
   still names the part.
4. A file saved by Word rewrites `docProps/*`, so its binding no longer verifies. This is expected
   ([labelling-standards.md 4.6](labelling-standards.md#46-signing-a-docx-binding)); the portal signs again at its
   own next save.

---

## 5. Export: what the portal writes at each save

Input: the document label computed by the policy service, and a mapping to a Purview label of the configured
tenant (tenant id, label id, label `Name`), or to no Purview label. Everything below happens before the reference
list is refreshed and signed (section 4).

1. **Find or create `docProps/custom.xml`** through the package relationship. When it is missing, create it, add
   the relationship to `/_rels/.rels` with an unused `Id`, and add
   `<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>`.
2. **Remove this tenant's label properties**: every `MSIP_Label_<GUID>_*` property whose group has a `SiteId`
   equal to the tenant, compared without case and braces. Keep other tenants' groups and every other property.
   This undoes both a user's edit in File > Info and a stale Word label.
3. **Write the new group**, unless the mapping gives no Purview label: seven `vt:lpwstr` properties with the
   standard `fmtid`, unique `pid`s of at least 2, and names unique without regard to case
   ([MS-OI29500] §2.1.1724). The values:
   - `Enabled`: `true`.
   - `SetDate`: now, as `YYYY-MM-DDThh:mm:ssZ` in UTC, unless the incoming file already has this label id enabled
     for the tenant; then keep its value, since ONLYOFFICE keeps the properties between saves.
   - `Method`: `Privileged` (*Inference*, a decision for the project). The authors chose the labels the document
     label is computed from, and Privileged keeps automatic labelling from replacing the label.
   - `Name`: the label's `Name` from `Get-Label`, not its display name ([MIP SDK][mip-md]). What Word itself
     writes here is **UNVERIFIED**.
   - `SiteId`: the tenant id, lowercase, no braces.
   - `ActionId`: a new random GUID when the label changes, the incoming value otherwise.
   - `ContentBits`: `0`. The page marking is the project's own content, not Word's marking shapes.
   - Escape the values for XML.
4. **LabelInfo.** After an ONLYOFFICE save there is none (section 3.2). According to §2.3, Word reads the custom
   properties whether the tenant opted in or not, so the first version can write only them.
   - If the project also writes the part, for readers that know only the new location: write it with the same
     label, in the shape of section 2.2, with the `vnd` content type, and reference it in the binding (section 4).
   - If the incoming file still has a part (a Word file stored but not yet saved by ONLYOFFICE): replace this
     tenant's element, or write `removed="1"` when there is no Purview label, and keep other elements and `extLst`.
5. **Several partner tenants.** A mapping may give a label in several tenants. One group of properties per tenant
   is allowed: each organisation sees its own label ([Office apps][pv-office-external];
   [Graph example with three tenants][graph-extract]).
6. **`Sensitivity` property.** It is optional ([MS-OI29500] §3.11.2) and no documented reader depends on it. Do
   not write it until the ground-truth file of [7.5](#75-test-procedure) shows that Word writes it.

The resulting part, with fictional ids (formatted here; the portal can write it on one line):

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"
    xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2"
      name="MSIP_Label_11111111-2222-3333-4444-555555555555_Enabled"><vt:lpwstr>true</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3"
      name="MSIP_Label_11111111-2222-3333-4444-555555555555_SetDate"><vt:lpwstr>2026-09-28T12:00:00Z</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="4"
      name="MSIP_Label_11111111-2222-3333-4444-555555555555_Method"><vt:lpwstr>Privileged</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="5"
      name="MSIP_Label_11111111-2222-3333-4444-555555555555_Name"><vt:lpwstr>Demo Label</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="6"
      name="MSIP_Label_11111111-2222-3333-4444-555555555555_SiteId"><vt:lpwstr>00000000-0000-0000-0000-000000000000</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="7"
      name="MSIP_Label_11111111-2222-3333-4444-555555555555_ActionId"><vt:lpwstr>aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="8"
      name="MSIP_Label_11111111-2222-3333-4444-555555555555_ContentBits"><vt:lpwstr>0</vt:lpwstr></property>
</Properties>
```

With the optional LabelInfo part, the package also has:

```xml
<!-- [Content_Types].xml -->
<Override PartName="/docMetadata/LabelInfo.xml" ContentType="application/vnd.ms-office.classificationlabels+xml"/>
<!-- _rels/.rels -->
<Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2020/02/relationships/classificationlabels"
    Target="docMetadata/LabelInfo.xml"/>
```

---

## 6. Import rules (question C)

1. **Container.** A ZIP file goes on. A compound file is refused, with a message that names the case from
   [2.6](#26-recognising-a-file-that-purview-encrypted-question-a5): rights management encryption, password
   encryption, or another compound file such as a legacy `.doc`. Do not try to decrypt.
2. **Find the parts by relationship type** in `/_rels/.rels`: `custom-properties` (Transitional, or Strict
   `http://purl.oclc.org/ooxml/officeDocument/relationships/customProperties`) and `classificationlabels`. Names
   are only customary.
3. **Read the LabelInfo part**, if any: check the namespace; for each `label`, normalise `id` and `siteId` by
   removing braces and lowercasing (the Open XML SDK accepts uppercase, so files may have it). More than one
   element for a `siteId` breaks §2.6.5.4; treat that tenant as unreadable.
4. **Read the custom properties**: names matching
   `^MSIP_Label_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(.+)$` without regard to case,
   grouped by GUID. Take the text of `vt:lpwstr`, and accept `vt:lpstr` and `vt:bool` too. A group is an applied
   label when `Enabled` is `true` without regard to case and `SiteId` is a GUID, braced or not. Ignore attributes
   you do not know.
5. **Decide per tenant** ([MS-OFFCRYPTO] §2.6.3, read cases 1 and 3):
   - the tenant has a `label` element: it decides. `removed="1"`, or `enabled` other than 1, means no label, and
     that tenant's custom properties are ignored;
   - the tenant has no element: its custom property groups decide.

   If the portal is configured to know that its tenant has not turned co-authoring on, read only the custom
   properties for that tenant (case 2), as Word in that tenant does.
6. **Keep the configured tenant's label** for the mapping. Log the others. ONLYOFFICE will keep other tenants'
   custom properties and drop their LabelInfo elements at the first save (section 3).
7. **More than one enabled group for the configured tenant** in custom properties, such as a parent and a child
   written by an old client: keep the groups whose label id is in the mapping table. Anything other than exactly
   one is ambiguous, and the project has to decide whether to refuse the file or ask the user.
8. **Map the (tenant, label id) pair** to a label of the security policy. An id missing from the mapping (a label
   created since, or deleted) is unmapped; the fallback is a decision for the project.
9. **Informative only**: `Name` (it may be stale, and is not the display name), `SetDate`, `ActionId`, `Method`,
   `Sensitivity`. `ContentBits` with bit 1, 2 or 4 set, or `Classification…ShapeIds` properties, tell that Word put
   marking shapes in the headers, footers or background of the file; the portal may warn about them.

---

## 7. A demo tenant (question B)

### 7.1 Licences

- **Manual labelling** is included in Microsoft 365 E5, A5, G5, E3, A3, G3, F1, F3 and Business Premium; OneDrive
  for Business (Plan 2); Enterprise Mobility + Security E3 and E5; Office 365 E5, A5, E3 and A3; AIP Plan 1 and
  Plan 2 ([Purview service description #sensitivity-labeling][pv-sd], 2026-08-03). Office 365 E1, Business Basic
  and Business Standard are not in that row.
- Licensing counts consumers too: "Any user benefiting from the service requires a license"
  ([#which-users-need-a-license][pv-sd-users]). "Admins also need a license to manage sensitivity labels"
  ([get started #licensing][pv-getstarted]). Whether Word shows a label name to an unlicensed user is
  **UNVERIFIED**.
- **Word desktop**: a subscription edition is needed ("Sensitivity labels aren't supported for standalone editions
  of Office", [Office apps #support][pv-office-support]). Manual labelling needs Current Channel or Monthly
  Enterprise Channel 1910+, Semi-Annual Enterprise Channel 2002+, or Mac 16.21+ ([minimum versions][pv-versions]).
  Business Premium includes Microsoft 365 Apps for business.
- **Word for the web**: labels must be enabled for Office files in SharePoint and OneDrive
  ([Office apps #SharePoint and OneDrive][pv-office-spo]). This takes "about 15 minutes" and is done in one of
  three ways ([SharePoint and OneDrive #opt-in][pv-spo-optin]):
  - the Purview portal, Solutions > Information Protection > Sensitivity labels, **Turn on now**, signed in as a
    global administrator;
  - `Set-SPOTenant -EnableAIPIntegration $true` in the SharePoint Online Management Shell;
  - `Set-PolicyConfig -EnableSpoAipMigration $true` in Security & Compliance PowerShell ([Set-PolicyConfig][set-policyconfig-spo]).

  The documentation covers Word for the web only for files in SharePoint and OneDrive, and a file labelled before
  the feature was on must be uploaded again ([#limitations][pv-spo-limits]).

### 7.2 Getting a tenant

| Option | Who | Duration and size | Limits | Source |
|---|---|---|---|---|
| Microsoft 365 Developer Program, E5 sandbox | Visual Studio Professional or Enterprise subscribers; companies in the ISV Success Program or eligible tiers of the Microsoft AI Cloud Partner Program (Solutions Partners, Action Pack and others); not Microsoft employees. Other members get only "tools, documentation, training" | 25 user licences, "up to 90 days", renewed with development activity; "Microsoft may require tenants to be recreated every 90 days" | A billing account is "mandatory ... and can't be bypassed": a Microsoft Customer Agreement account with an active Azure subscription. The sandbox itself is free; development use only | [FAQ #who-qualifies][dev-faq-who], [#expiry][dev-faq-expiry], [#billing][dev-faq-billing]; [get started #billing][dev-start-billing] |
| Business trial (Business Premium) | Anyone; "You don't need an existing Microsoft account" | "Try free for 1 month"; "All trial subscriptions include 25 free licenses"; trial-only tenants "limited to 30 days and 300 GB" | "renews to an annual term subscription by default, unless you turn off recurring billing" (*Inference*: a card is on file) | [Try or buy][trybuy] |
| Microsoft 365 E5 trial | Anyone, from the E5 product page, with phone verification | "25 user licenses to use for a month" | Card requirement **UNVERIFIED** | [Defender XDR lab #E5 trial][xdr-lab] |
| Microsoft Purview Suite trial | An existing tenant with Microsoft 365 E3, or Office 365 E3 plus EMS E3 | 90 days, 25 licences, one extension | Does not create a tenant | [Purview trial][pv-trial] |

*Inference*: for a demo of Word desktop and Word for the web without encryption, a Business Premium trial is
enough and needs no programme membership. The Developer Program sandbox lasts longer and includes E5, but only
for eligible members.

### 7.3 Labels, sublabels and policies with Security & Compliance PowerShell

- **Where it runs**: module ExchangeOnlineManagement, current release 3.10.1; from 3.10.0 on, PowerShell 7 must be
  7.6 or later, and Windows PowerShell 5.1 is not affected ([Exchange Online PowerShell #current-release][exo-release]).
  "Connect-IPPSSession and therefore Security & Compliance PowerShell isn't available in PowerShell 7 on macOS
  clients", nor on Linux ([#macos][exo-macos], [#linux][exo-linux]). A tester on a Mac needs a Windows machine or
  the Purview portal.
- **Roles**: the Information Protection role groups, the Sensitivity Label Administrator role or Compliance
  Administrator ([get started #permissions][pv-perms]).
- **New tenants**: "Migration is automatic if you have a new tenant beginning October 1, 2025": parent labels are
  replaced by label groups, which cannot be published or applied, only the labels in them
  ([migrate][pv-migrate]; [labels #sublabels][pv-labels-sub]). Default labels "are now automatically created for
  new customers who have an eligible license". Their policy publishes them to all users, applies General \ All
  Employees (unrestricted) to unlabeled documents, and asks for a justification to remove or lower a label
  ([default labels][pv-defaults]). *Inference*: for the tests, remove that default label from the policy and give
  the demo labels names that cannot collide with "Confidential" and the like.
- **Limits** (Guidance): a tenant can have "1,000+" labels, 500 when the label's encryption names users and
  permissions; "effectiveness is noticeably reduced when users have more than five main labels or more than five
  sublabels per main label" ([labels #limitations][pv-labels-limits]).
- **Cmdlets** ([New-Label][new-label], [New-LabelPolicy][new-labelpolicy]):
  - `New-Label` requires `-Name` (unique, at most 64 characters), `-DisplayName` and `-Tooltip`.
  - `-ParentId` takes the parent's name, distinguished name or GUID. `-IsLabelGroup` exists, but its description
    is an unfilled placeholder, and its use with `-ParentId` under the modern scheme is **UNVERIFIED**.
  - `-ContentType` takes `File`, `Email`, `Site`, `UnifiedGroup`, `PurviewAssets`, `Teamwork` and
    `SchematizedData`, and values can be combined.
  - A label has no encryption and no marking when the `Encryption*`, `ApplyContentMarking*` and
    `ApplyWaterMarking*` parameters are left out (defaults "None").
  - `New-LabelPolicy -Name -Labels` takes names, distinguished names or GUIDs. With the classic scheme, a policy
    that publishes a sublabel must also contain its parent ([create labels #publish][pv-create-publish]).
  - No documented `-AdvancedSettings` key sets the default label for documents or mandatory labelling (the
    `-Settings` parameter is "reserved for internal Microsoft use"); set them in the portal's policy wizard.

A script to run on Windows (names are examples; the first `New-Label` depends on the label scheme of the tenant):

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Connect-IPPSSession -UserPrincipalName admin@<tenant>.onmicrosoft.com

# Tenant created since 2025-10-01 (modern scheme): a label group. -IsLabelGroup is UNVERIFIED; the
# documented way is the portal's "+ Create > Label group". Classic scheme: drop -IsLabelGroup to create
# a parent label instead.
New-Label -Name "DCS-Demo" -DisplayName "DCS Demo" -Tooltip "Labels mapped from the demonstrator" -ContentType "File, Email" -IsLabelGroup

# Sublabels without encryption or marking.
New-Label -Name "DCS-Demo-Restricted" -DisplayName "DCS Restricted" -Tooltip "Maps a restricted document label" -ContentType "File, Email" -ParentId "DCS-Demo"
New-Label -Name "DCS-Demo-Confidential" -DisplayName "DCS Confidential" -Tooltip "Maps a confidential document label" -ContentType "File, Email" -ParentId "DCS-Demo"

# Publish to the test users (ExchangeLocation "All" publishes to everyone).
New-LabelPolicy -Name "DCS Demo" -Labels "DCS-Demo-Restricted","DCS-Demo-Confidential" -ExchangeLocation "tester1@<tenant>.onmicrosoft.com","tester2@<tenant>.onmicrosoft.com"

# Ids for the portal's mapping, and the policy's distribution.
Get-Label | Format-Table -Property DisplayName, Name, Guid, ContentType
Get-LabelPolicy -Identity "DCS Demo" | Format-List Name, Labels, DistributionStatus
Disconnect-ExchangeOnline
```

- **Ids**: `Get-Label | Format-Table -Property DisplayName, Name, Guid, ContentType` is the documented way to read a
  label's GUID ([create labels #PowerShell tips][pv-create-tips]); SharePoint searches use the same GUID in
  `InformationProtectionLabelId:<GUID>` ([SharePoint and OneDrive #search][pv-spo-search]). No current page
  mentions `ImmutableId`, and whether the GUID Word writes equals `Guid` is **UNVERIFIED** until the ground-truth
  file of [7.5](#75-test-procedure) is read.
- **`Priority`**: `Set-Label -Priority` says "A higher integer value indicates a higher priority"
  ([Set-Label][set-label-priority]), while Graph says "Lower numbers indicate higher priority"
  ([resource][graph-label-res]). The two contradict each other; the demo does not need priorities.
- **Delay** (Guidance): "allow 24 hours for the changes to propagate through the services"; for Word, Excel and
  PowerPoint on the web, new labels "might ... replicate within the hour"; changes that depend on group membership
  take 24 to 48 hours ([create labels #when to expect][pv-create-delay]). For SharePoint and OneDrive, publish to a
  few test users and "wait for at least one hour" before testing there ([SharePoint and OneDrive #publishing][pv-spo-publishing]).
  The Office label cache on Windows is `%localappdata%\Microsoft\Office\CLP` (renamed to force a reload), documented
  only in the Outlook troubleshooting section ([labels missing #outlook][labels-missing]); no cache location is
  documented for the Mac.

### 7.4 Where to read the tenant id and the label ids

- **Tenant id (`SiteId`)**: Microsoft Entra admin center, Entra ID > Overview > Properties > **Tenant ID**
  ([find tenant][find-tenant]); Microsoft Graph `organization.id`, "The tenant ID" ([organization][graph-org]); the
  OpenID Connect discovery document `https://login.microsoftonline.com/<domain>/v2.0/.well-known/openid-configuration`,
  whose `issuer` contains the tenant GUID ([OIDC][oidc]; **Tested**, [appendix A.5](#a5-tenant-id-from-the-discovery-document)).
  A path in the Microsoft 365 admin center is not documented.
- **Label ids**: `Get-Label` (`Guid`, on Windows), or Microsoft Graph v1.0
  `GET /security/dataSecurityAndGovernance/sensitivityLabels` with `SensitivityLabel.Read`, whose `id` is the label
  GUID and whose `isAppliable` is false for a parent with children ([list][graph-labels], [resource][graph-label-res]).
  Graph works from any platform, for example in Graph Explorer. Whether the Purview portal shows the GUID is
  **UNVERIFIED**.

### 7.5 Test procedure

1. Get a tenant (7.2) and assign licences to the administrator and two test users.
2. Install Microsoft 365 Apps on the test machine and sign in to Word with a test user.
3. Adjust the default policy: no default label for documents, no justification prompt for the test users.
4. Create the demo labels and the policy (7.3), then enable labels for SharePoint and OneDrive (7.1) **before**
   uploading any labelled file. Wait until Word's Sensitivity button lists the demo labels.
5. **Ground truth**: in Word, apply each demo label to a new document, save it locally, unzip it, and record: the
   label GUIDs, the location Word used (`docProps/custom.xml` or `docMetadata/LabelInfo.xml`), the exact property
   set and formats (`Name`, `SetDate`, `ActionId`, `Sensitivity`). Compare the GUIDs with `Get-Label`.
6. Configure the portal's mapping with the tenant id and the label ids.
7. **Export**: download a file saved by the portal; open it in Word desktop and read the label on the status bar
   and the Sensitivity button. Upload it to OneDrive, open it in Word for the web, and check the label there, in
   the Sensitivity column, and with `POST /me/drive/root:/<path>:/extractSensitivityLabels` in Graph Explorer
   ([extractSensitivityLabels][graph-extract], permission `Files.Read.All`).
8. **Negative cases**: the same file with the fictional tenant id `00000000-0000-0000-0000-000000000000`, and with
   an unknown label GUID; Word should show no label.
9. **Import**: label a document in Word, upload it to the portal, and check the mapped document label; then try a
   file encrypted by a label with encryption (created only for this test) and a password-protected file.
10. **Last**, because it cannot be undone in the portal: turn on co-authoring for files with sensitivity labels,
    wait 24 hours ([Purview][pv-coauth-howto]), and repeat steps 5, 7 and 9.

---

## 8. Open questions (need a tenant or Word)

1. **Minimal property set**: which of the seven custom properties Word needs to show a label (for example without
   `ActionId`, `SetDate` or `Method`), and whether it needs `Sensitivity`.
2. **Locations in practice**: whether Word shows a label written only in custom properties, only in the LabelInfo
   part, or in both, with co-authoring off and on. §2.3 predicts custom properties only (off), and all three
   (on). Also whether Word writes the canonical form of 2.2 byte for byte, and sorts `label` elements by `id`.
3. **Stale metadata**: what Word shows when custom properties and the LabelInfo part disagree for the same tenant,
   in each tenant mode.
4. **Name and method**: whether Word shows the tenant's display name whatever the `Name` value; what Word writes in
   `Name` (unique name or display name); whether `Method` changes anything a user sees, such as the justification
   prompt when lowering a label.
5. **Content marking**: with a label whose policy has a header or footer and `ContentBits` 0, confirm that Word
   adds no marking on open, and observe what it does on Save.
6. **Other tenants and unknown labels**: confirm that Word shows nothing for a label of another tenant, or of an
   unknown GUID in the reader's tenant, and that it keeps those properties when it saves.
7. **Word for the web**: how long after upload the label appears; whether `extractSensitivityLabels` returns it
   for a file with custom properties only; whether a LabelInfo part is added when SharePoint processes the file.
8. **Ids**: whether the GUID Word writes equals `Get-Label`'s `Guid`, whether `ImmutableId` exists and equals it,
   and whether the Purview portal shows it.
9. **Label groups in PowerShell**: whether `New-Label -IsLabelGroup` then `-ParentId <group>` builds a group and
   its labels in a tenant with the modern scheme; what scope a label gets without `-ContentType`.
10. **Tenant defaults**: whether a trial or developer tenant gets the default labels and policy; the initial value
    of `EnableLabelCoauth` (the output of `Get-PolicyConfig` is not documented).
11. **Delays**: how long a new label takes to reach Word desktop and Word for the web; where the label cache lives
    on a Mac.
12. **Licences and trials**: whether an unlicensed user, or a Business Standard user, sees label names; whether the
    E5 and Business Premium trials require a card.
13. **ONLYOFFICE output in Word**: whether Word opens without complaint a DOCX saved by ONLYOFFICE whose
    `customXml` item id has no braces (3.4), and keeps the project's binding part and the `MSIP_Label_` properties
    when it saves.
14. **Encrypted files**: whether the root `\x05DocumentSummaryInformation` stream of a Purview-encrypted DOCX
    carries the `MSIP_Label_` properties, and whether a `LabelInfo` stream is present with co-authoring off.

---

## Appendix A. How the tests were run

The scratch files were kept outside the repository and were not added to it.

### A.1 Test files

A Python script built minimal WordprocessingML packages with the fictional ids: `docProps/custom.xml` with the
seven properties of section 5, `docMetadata/LabelInfo.xml` in the form of section 2.2 with its `Override` and its
package relationship, or both. Variants: LabelInfo typed `application/xml` by the `Default` only; uppercase ids;
unbraced ids; no `removed` attribute; wrong namespace; the two [MS-OFFCRYPTO] §3.12 examples.

### A.2 Schemas (`xmllint`, libxml2 2.9.13)

- `docProps/custom.xml` against ECMA-376 Transitional `shared-documentPropertiesCustom.xsd`: valid.
- LabelInfo against the §2.6.4 schema transcribed from the PDF:
  - as printed: every document fails ("No matching global declaration available for the validation root"),
    because the schema has no `targetNamespace`;
  - with `targetNamespace` and a default namespace added: the section 2.2 example and the first §3.12 example are
    valid; the §3.12 `extLst` example fails ("demanded by the strict wildcard");
  - with `processContents="lax"` added as well: all three are valid, and an uppercase or unbraced `siteId` fails
    the pattern.

### A.3 ONLYOFFICE round trips

Containers of `onlyoffice/documentserver:9.4.0.1` (arm64, index `sha256:3ab6ebc7…`) were started with
`docker run --rm --network none -v "$PWD/work:/work" --entrypoint /bin/bash onlyoffice/documentserver:9.4.0.1 /work/run.sh`,
with no published port. The script generated the fonts as `documentserver-generate-allfonts.sh` does, then ran
`x2t` with an XML parameter file (`m_sFileFrom`, `m_sFileTo`, `m_nFormatTo`, `m_bFromChanges`, `m_sThemeDir`) and
`docbuilder`. Three inputs were used: the seven properties and the LabelInfo part of the "both" file of A.1 plus a
`customXml` part like the project's binding part; the same with sparse `pid`s and extra `vt:bool`, `vt:i4`,
`vt:filetime`, `vt:lpstr`, `vt:r8` and `vt:ui4` properties; and a `Name` value with `&`, `<`, `>`, quotes and `é`.

| Path | Through sdkjs | `MSIP_Label_` properties | `pid` | LabelInfo part, override, relationship | `customXml` part |
|---|---|---|---|---|---|
| DOCX to `Editor.bin` (8193), then `Editor.bin` plus an empty `changes/` to DOCX (65) with `m_bFromChanges=true`: the editor's save path | yes | kept, `vt:lpwstr` | renumbered | lost | kept |
| `Editor.bin` to DOCX without changes | no | kept | kept | lost | kept |
| DOCX to DOCX directly | no (unzip, zip) | kept | kept | kept | kept |
| `docbuilder` open and save | no (the JavaScript worker starts only when a command runs) | kept | kept | lost | kept |
| `docbuilder` open, `GetCustomProperties().Get/Add`, a new paragraph, save | yes | kept; `Add` on an existing name changes it in place | renumbered | lost | kept |

Not covered: a real save from the browser editor through the callback, change records produced in the browser
(such as a user deleting a property), force-save, DOCM and DOTX, the amd64 image, and whether Word accepts the
output.

### A.4 Open XML SDK

A .NET 10 console program with `DocumentFormat.OpenXml` 3.5.1 opened each file with `WordprocessingDocument.Open`,
read `LabelInfoPart` and `CustomFilePropertiesPart`, and ran `OpenXmlValidator` with `FileFormatVersions.Microsoft365`:

- the custom-properties-only, LabelInfo-only and "both" files: parts found, 0 validation errors;
- LabelInfo typed `application/xml`: the package does not open (`OpenXmlPackageException`, "unexpected content
  type ... Expected Content Type=application/vnd.ms-office.classificationlabels+xml");
- uppercase `siteId`: 0 errors; unbraced `siteId`: a pattern error; no `removed`: "The required attribute
  'removed' is missing"; wrong namespace: the root element cannot be loaded;
- the two §3.12 examples: the five labels of the first one read back, and neither has a validation error (the SDK
  accepts the `extLst` example that the strict schema rejects);
- the file saved by ONLYOFFICE through sdkjs: the seven properties read back, no `LabelInfoPart`.

### A.5 Tenant id from the discovery document

`curl -s https://login.microsoftonline.com/<domain>/v2.0/.well-known/openid-configuration` for a public domain
returned `"issuer": "https://login.microsoftonline.com/<tenant-guid>/v2.0"`; the GUID is not reproduced here.

---

## Appendix B. SHA-256 of the specifications used

```text
65a20fdaef2b24cabd0c783620a46d339a98b33effffa9ca6da7795e9635ddf0  [MS-OFFCRYPTO].pdf (v14.0, 2026-02-17)
b297063cce0ac79d10a8efd382b0f90f3b9fd6615fac7f01c88f0288e5fa7372  [MS-OI29500].pdf (v25.0, 2026-08-18)
9d0bcad9cf06054785b03762fcfadbf6bab7e54a5f9d69434e34b7fd464d4129  ECMA-376-1_5th_edition_december_2016.zip
bd25da1109f73762356596918bf5ff8b74a1331642dba5f1c1d1dfc6bed34ecd  ECMA-376-4_5th_edition_december_2016.zip
```

[oc]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/3c34d72a-1a61-4b52-a893-196f9157f083
[oc-pdf]: https://officeprotocoldocs-f5hpbjgea6b8gneq.b02.azurefd.net/files/MS-OFFCRYPTO/%5bMS-OFFCRYPTO%5d.pdf
[oc-1.3.3.4]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/2995dc93-0564-468c-891a-d950464479fb
[oc-2.2.1]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/dd37820d-8056-4460-86c0-066953c64743
[oc-2.2.4]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/dc6708bb-e852-44b1-acba-f74614155191
[oc-2.2.6]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/fc0b604a-db9c-477d-9835-2fc0e2aa50ac
[oc-2.3.4.1]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/982d0ba2-aac1-48bc-91c9-02d3ce1a292d
[oc-2.3.4.3]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/74830503-01e0-4749-8123-07ee3b01b376
[oc-2.6.1]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/9c2ee962-71ec-4dd3-8d00-37f4f864982a
[oc-2.6.2]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/0c4ec12d-aba0-4dd4-8fd1-710da6735219
[oc-2.6.3]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/13939de6-c833-44ab-b213-e0088bf02341
[oc-2.6.4]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/b75503d0-ada1-4eca-adc1-adeb643ab813
[oc-2.6.4.2]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/d7af30a4-e9e9-40ac-b428-c272ed2a0d11
[oc-2.6.4.5]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/792c5bdb-5931-4818-a238-776039c414f8
[oc-2.6.5.4]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/80e2b2e1-bd48-415d-a3b9-aa61a108f651
[oc-2.6.6]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/a50fb40f-8d20-4ec9-93a9-29553b74be0c
[oc-2.9]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/b7a9eb30-34bd-447c-8776-e6a5c9c35d48
[oc-3.12]: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-offcrypto/8d6d414d-ac0b-40ee-ac87-af2e6401c128
[oi]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/1fd4a662-8623-49c0-82f0-18fa91b413b8
[oi-pdf]: https://officeprotocoldocs-f5hpbjgea6b8gneq.b02.azurefd.net/files/MS-OI29500/%5bMS-OI29500%5d.pdf
[oi-2.1.1724]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/dd236d15-5c66-4553-b1bb-cdbf1680bf1b
[oi-3.4.1.5]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/c0599e21-b77f-475e-99e0-bd647f60bcbb
[oi-3.11.2]: https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/85388ac6-fb55-4017-828c-2680e3ab22ba
[cfb]: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/05060311-bfce-4b12-874d-71fd4ce63aea
[ecma376]: https://ecma-international.org/publications-and-standards/standards/ecma-376/
[ecma1]: https://ecma-international.org/wp-content/uploads/ECMA-376-1_5th_edition_december_2016.zip
[ecma4]: https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip
[mip-md]: https://learn.microsoft.com/en-us/information-protection/develop/concept-mip-metadata
[mip-md-ext]: https://learn.microsoft.com/en-us/information-protection/develop/concept-mip-metadata#extending-metadata-with-custom-attributes
[mip-md-bits]: https://learn.microsoft.com/en-us/information-protection/develop/concept-mip-metadata#contentbits
[mip-md-coauth]: https://learn.microsoft.com/en-us/information-protection/develop/concept-mip-metadata#support-for-protected-coauthoring
[pv-coauth]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-coauthoring
[pv-coauth-meta]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-coauthoring#metadata-changes-for-sensitivity-labels
[pv-coauth-howto]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-coauthoring#how-to-enable-co-authoring-for-files-with-sensitivity-labels
[pv-office]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-office-apps
[pv-office-support]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-office-apps#sensitivity-labeling-support-in-apps
[pv-office-spo]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-office-apps#support-for-sharepoint-and-onedrive-files-protected-by-sensitivity-labels
[pv-office-external]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-office-apps#support-for-external-users-and-labeled-content
[pv-office-marking]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-office-apps#when-office-apps-apply-content-marking-and-encryption
[pv-spo]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files
[pv-spo-limits]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files#limitations
[pv-spo-types]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files#supported-file-types
[pv-spo-optin]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files#how-to-enable-sensitivity-labels-for-sharepoint-and-onedrive-opt-in
[pv-spo-publishing]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files#publishing-and-changing-sensitivity-labels
[pv-spo-search]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files#search-for-documents-by-sensitivity-label
[pv-labels]: https://learn.microsoft.com/en-us/purview/sensitivity-labels
[pv-labels-policies]: https://learn.microsoft.com/en-us/purview/sensitivity-labels#what-label-policies-can-do
[pv-labels-limits]: https://learn.microsoft.com/en-us/purview/sensitivity-labels#sensitivity-label-limitations-per-tenant
[pv-labels-sub]: https://learn.microsoft.com/en-us/purview/sensitivity-labels#sublabels-that-use-parent-labels-or-label-groups
[pv-create]: https://learn.microsoft.com/en-us/purview/create-sensitivity-labels
[pv-create-delete]: https://learn.microsoft.com/en-us/purview/create-sensitivity-labels#removing-and-deleting-labels
[pv-create-delay]: https://learn.microsoft.com/en-us/purview/create-sensitivity-labels#when-to-expect-new-labels-and-changes-to-take-effect
[pv-create-tips]: https://learn.microsoft.com/en-us/purview/create-sensitivity-labels#powershell-tips-for-specifying-the-advanced-settings
[pv-create-publish]: https://learn.microsoft.com/en-us/purview/create-sensitivity-labels#publish-sensitivity-labels-by-creating-a-label-policy
[pv-auto]: https://learn.microsoft.com/en-us/purview/apply-sensitivity-label-automatically#will-an-existing-label-be-overridden
[pv-defaults]: https://learn.microsoft.com/en-us/purview/default-sensitivity-labels-policies#default-sensitivity-label-policy
[pv-migrate]: https://learn.microsoft.com/en-us/purview/migrate-sensitivity-label-scheme
[pv-versions]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-versions#sensitivity-label-capabilities-in-word-excel-and-powerpoint
[pv-sd]: https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description#microsoft-purview-information-protection-sensitivity-labeling
[pv-sd-users]: https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description#which-users-need-a-license
[pv-getstarted]: https://learn.microsoft.com/en-us/purview/get-started-with-sensitivity-labels#licensing-and-billing-requirements-for-sensitivity-labels
[pv-perms]: https://learn.microsoft.com/en-us/purview/get-started-with-sensitivity-labels#permissions-required-to-create-and-manage-sensitivity-labels
[pv-trial]: https://learn.microsoft.com/en-us/purview/purview-trial#eligibility-and-licensing
[labels-missing]: https://learn.microsoft.com/en-us/troubleshoot/microsoft-365/purview/sensitivity-labels/sensitivity-labels-missing#outlook
[set-policyconfig]: https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-policyconfig?view=exchange-ps#-enablelabelcoauth
[set-policyconfig-spo]: https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-policyconfig?view=exchange-ps#-enablespoaipmigration
[new-label]: https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-label?view=exchange-ps
[new-labelpolicy]: https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-labelpolicy?view=exchange-ps
[set-label-priority]: https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-label?view=exchange-ps#-priority
[exo-release]: https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2?view=exchange-ps#current-release
[exo-macos]: https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2?view=exchange-ps#macos-support-for-the-module
[exo-linux]: https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2?view=exchange-ps#linux-support-for-the-module
[dev-faq-who]: https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq#who-qualifies-for-a-microsoft-365-e5-developer-subscription-
[dev-faq-expiry]: https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq#how-long-is-my-subscription-good-for--and-when-does-it-expire-
[dev-faq-billing]: https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq#why-am-i-being-asked-to-create-a-billing-account-
[dev-start-billing]: https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-get-started#billing-account-requirement
[trybuy]: https://learn.microsoft.com/en-us/microsoft-365/commerce/try-or-buy-microsoft-365#try-a-free-trial-subscription
[xdr-lab]: https://learn.microsoft.com/en-us/defender-xdr/setup-m365deval#create-a-microsoft-365-e5-trial-tenant
[find-tenant]: https://learn.microsoft.com/en-us/entra/fundamentals/how-to-find-tenant#find-tenant-id-through-the-microsoft-entra-admin-center
[oidc]: https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc#fetch-the-openid-configuration-document
[graph-org]: https://learn.microsoft.com/en-us/graph/api/resources/organization?view=graph-rest-1.0#properties
[graph-labels]: https://learn.microsoft.com/en-us/graph/api/tenantdatasecurityandgovernance-list-sensitivitylabels?view=graph-rest-1.0
[graph-label-res]: https://learn.microsoft.com/en-us/graph/api/resources/security-sensitivitylabel?view=graph-rest-1.0#properties
[graph-extract]: https://learn.microsoft.com/en-us/graph/api/driveitem-extractsensitivitylabels?view=graph-rest-1.0
[graph-beta-extract]: https://learn.microsoft.com/en-us/powershell/module/microsoft.graph.beta.security/invoke-mgbetaextractusersecurityinformationprotectionsensitivitylabelcontentlabel?view=graph-powershell-beta
[oxsdk]: https://github.com/dotnet/Open-XML-SDK/tree/431ab05cf160248cc3885a4a766026d4f8243792
[oxsdk-part]: https://github.com/dotnet/Open-XML-SDK/blob/431ab05cf160248cc3885a4a766026d4f8243792/data/parts/LabelInfoPart.json#L1-L13
[oxsdk-schema]: https://github.com/dotnet/Open-XML-SDK/blob/431ab05cf160248cc3885a4a766026d4f8243792/data/schemas/schemas_microsoft_com_office_2020_mipLabelMetadata.json#L134-L152
[epplus]: https://github.com/EPPlusSoftware/EPPlus/tree/84fd0ddf86958e2af02cfc73a3a203848c8b0b1c
[epplus-ct]: https://github.com/EPPlusSoftware/EPPlus/blob/84fd0ddf86958e2af02cfc73a3a203848c8b0b1c/src/EPPlus/Constants/ContentTypes.cs#L63
[epplus-write]: https://github.com/EPPlusSoftware/EPPlus/blob/84fd0ddf86958e2af02cfc73a3a203848c8b0b1c/src/EPPlus/SensitivityLabels/ExcelSensibilityLabelCollection.cs#L207-L238
[xlsxwriter]: https://github.com/jmcnamara/XlsxWriter/tree/5d4606d89a955226d2d0825a0f44309043ae7251
[xw-example]: https://github.com/jmcnamara/XlsxWriter/blob/5d4606d89a955226d2d0825a0f44309043ae7251/examples/sensitivity_label.py#L14-L28
[xw-doc]: https://github.com/jmcnamara/XlsxWriter/blob/5d4606d89a955226d2d0825a0f44309043ae7251/dev/docs/source/workbook.rst#L569-L691
[tika]: https://github.com/apache/tika/tree/df85810303bdd51e4a7f5accbcfb0d659b922631
[tika-detect]: https://github.com/apache/tika/blob/df85810303bdd51e4a7f5accbcfb0d659b922631/tika-parsers/tika-parsers-standard/tika-parsers-standard-modules/tika-parser-microsoft-module/src/main/java/org/apache/tika/detect/microsoft/POIFSContainerDetector.java#L411-L444
[ms-sample-ct]: https://github.com/microsoft/PPCC25-ALM/blob/f58c88052f7284c7a0e758a66b0794f227ec798d/docs/labs/lab3/source/Lab3_extracted/%5BContent_Types%5D.xml
[ms-sample-li]: https://github.com/microsoft/PPCC25-ALM/blob/f58c88052f7284c7a0e758a66b0794f227ec798d/docs/labs/lab3/source/Lab3_extracted/docMetadata/LabelInfo.xml
[c-ff-cp]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/DocxFormat/FileFactory.cpp#L146-L150
[c-ff-unknown]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/DocxFormat/FileFactory.cpp#L204
[c-unknown]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/DocxFormat/UnknowTypeFile.cpp#L50-L55
[c-hv-types]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/PPTXFormat/Logic/HeadingVariant.cpp#L145-L199
[c-hv-read]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/PPTXFormat/Logic/HeadingVariant.cpp#L650-L667
[c-bw-cp]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Document/BinWriter/BinaryWriterD.cpp#L9986-L9996
[c-docx-ser]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Document/DocWrapper/DocxSerializer.cpp#L466-L469
[c-rels]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Document/BinReader/DocumentRelsWriter.cpp#L44-L65
[c-direct]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/X2tConverter/src/ASCConverters.cpp#L672-L682
[c-direct-zip]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/X2tConverter/src/ASCConverters.cpp#L311-L378
[c-itemid]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/DocxFormat/CustomXml.cpp#L195-L200
[s-tables]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Serialize2.js#L67-L89
[s-ser-write]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Serialize2.js#L1964-L1973
[s-ser-read]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Serialize2.js#L8089-L8094
[s-pid]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/Drawings/Format/Format.js#L14894-L14908
[s-addprop]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/Drawings/Format/Format.js#L14947-L14956
[s-ui4]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/Drawings/Format/Format.js#L15355-L15358
[s-doc-cp]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Document.js#L28516-L28544
[s-api-get]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L10180-L10189
[s-api-cp]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L30385-L30446
[w-info]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/documenteditor/main/app/view/FileMenuPanels.js#L2053-L2100
