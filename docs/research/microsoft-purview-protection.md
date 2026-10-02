# Microsoft Purview protection: DLP, sensitivity labels with encryption, Double Key Encryption and reading portions in Office

Research notes compiled on 2026-10-01 for iteration 10, which explores making the protection of the platform's
documents interoperable with Microsoft 365, beyond the sensitivity label the platform already writes as metadata
([microsoft-purview-labels.md](microsoft-purview-labels.md); [Interoperability with Microsoft 365](../microsoft-365.md)).
Four tracks are examined:

- **A.** Purview data loss prevention (DLP) rules that use the sensitivity labels the platform writes, without encryption.
- **B.** Sensitivity labels with encryption whose rights go to Microsoft Entra groups that the platform keeps in step
  with its clearance directory (one group per label of the security policy), Microsoft applying such a label to the
  files the platform exports.
- **C.** Double Key Encryption (DKE), with a key service run by the platform's operator that asks the policy service for
  the access decision at each opening, as OpenTDF's KAS does.
- **D.** Reading protected portions from a Microsoft environment: first without any Office add-in, then, only if
  needed, with the smallest read-only Office add-in that reads the envelopes in the Custom XML parts and opens them with
  the OpenTDF web SDK.

**Scope.** Microsoft 365 commercial cloud; Word and Excel on Windows, Mac and the web; DOCX and XLSX. PowerPoint,
Outlook, national clouds and prices other than Microsoft's published ones are out of scope. Trials in a trial tenant
settled part of what needs one ([section 11](#11-tenant-trials)); the rest is collected in
[Open questions](#10-open-questions-need-a-tenant).

Primary sources only: learn.microsoft.com (Purview, Microsoft Graph v1.0 and beta reference, MIP SDK, DKE, Office
Add-ins and their requirement sets, Microsoft Entra, Defender for Office 365, service descriptions), support.microsoft.com
where learn.microsoft.com says nothing about what a Word or Excel user sees, the Open XML SDK reference for the
WordprocessingML schema, Microsoft's DKE reference service on GitHub, the OpenTDF repositories, and ONLYOFFICE sdkjs at
the tag the platform pins. Vendor pages appear only as prior art ([section 9](#9-prior-art-question-8)). Pages were read
on 2026-10-01; [section 1](#1-sources) gives their last update.

Conventions used below:

- **Mandated**: normative text of ISO/IEC 29500-1, here as the Open XML SDK reference reproduces it.
- **Guidance**: Microsoft product documentation (learn.microsoft.com, support.microsoft.com). It describes product
  behaviour or recommends a practice; it is not a contract.
- **Implementation**: what source code does (DKE reference service, OpenTDF web SDK, ONLYOFFICE), or what a vendor
  documents about its own product.
- **Inference**: my reading, not stated by a source.
- **Tested**: seen in the trial tenant, as [section 11](#11-tenant-trials) describes.
- **UNVERIFIED**: confirmed neither by a primary source nor by a trial.

All identifiers in the examples are fictional: tenant `00000000-0000-0000-0000-000000000000`, label
`11111111-2222-3333-4444-555555555555`, group `22222222-3333-4444-5555-666666666666`, host `portail.dcs.example`.

## Key findings

| Track | Feasible | Main cost | Revocation after a clearance change | Biggest limit |
|---|---|---|---|---|
| A. DLP on labels | Yes, now (Tested) | DLP policies in the tenant; nothing new in the platform | Not applicable: nothing is encrypted | Acts only in Microsoft 365 locations and on onboarded devices |
| B. Labels with encryption | Yes | Group sync, a MIP SDK sidecar or a metered Graph call, encrypting labels in the tenant | Up to about three hours with offline access Never, longer otherwise | Rights follow Entra groups, not the platform's decision; encrypted in Word, a platform file is no longer processed by SharePoint (Tested) |
| C. DKE | Yes, desktop only | E5-class licences, a key service, a MIP SDK sidecar | At each decrypt request, if Office does not cache (**UNVERIFIED**) | No Office for the web, co-authoring, search, eDiscovery or content DLP |
| D. Reading portions | Yes, with links (Tested on Mac and the web); an add-in is optional | A portal page per portion; optionally a small task pane | At each opening, by OpenTDF | The text shows in a browser tab or task pane, never in the document |

1. **A, DLP, is feasible now at low cost.** A sensitivity label is a DLP condition for Exchange email and attachments,
   SharePoint, OneDrive and devices. Actions: restrict access in SharePoint and OneDrive (no "block download" action),
   audit or block copying, printing and uploading on onboarded devices. Business Premium includes DLP for Exchange,
   SharePoint and OneDrive; endpoint DLP needs E5-class licences (Guidance). A "Document property is" condition could
   act on a custom property carrying the platform's categories (*Inference*). [Section 8](#8-dlp-with-sensitivity-labels-question-7).
   **Tested**: a rule on the labels DIFFUSION RESTREINTE and above refused to share a platform document outside the
   organisation about a quarter of an hour after it was turned on, and Word for the web showed its policy tip.
2. **B, labels with encryption, works, but Microsoft decides from group membership, late.** Rights go to mail-enabled
   security groups, distribution groups or Microsoft 365 groups, and Graph can manage only the Microsoft 365 groups
   among them. Group membership is cached "up to three hours"; a use licence lasts 30 days by default, set per label to
   never, a number of days or always; whoever encrypts keeps Full Control (Guidance). Microsoft applies the label through
   the MIP SDK (C++, .NET, Java preview; Ubuntu, RHEL, Debian; no Node.js binding) or Graph `assignSensitivityLabel` on a
   SharePoint or OneDrive copy (protected, metered, USD 0.00185 per call). SharePoint "can't process some files"
   encrypted in Office desktop apps that hold Custom XML parts, as every platform file does; whether this applies to the
   MIP SDK or Graph is **UNVERIFIED**. **Tested**: encrypted in Word for Mac, a platform file is no longer processed:
   Office for the web refuses to open it, even for whoever encrypted it, search does not see its words and OneDrive shows
   no label ([section 11](#11-tenant-trials)).
3. **C, DKE, decides per request, at the highest cost.** DKE needs Microsoft 365 E5-class licences, not Business
   Premium; Word on Windows 2307+ and Mac 16.85+, not Office for the web; no co-authoring, AutoSave or SharePoint
   processing (Guidance). Microsoft's reference key service authorises each decrypt call with a replaceable authorizer,
   so a key service can ask the policy service each time, per user and per key, hence one key per label (*Inference*
   from the code). Whether Office caches what the key service returns is **UNVERIFIED**.
4. **D can start with no Office add-in (D1).** A hyperlink may sit in a content control's paragraph (Mandated); Word
   desktop follows links with Ctrl+click, Word for the web lets readers "follow hyperlinks", Excel follows cell links,
   and Safe Links lets a clean URL through at click time (Guidance). A link from each placeholder to a portal page that
   decrypts the portion in the browser keeps OpenTDF's decision at each opening, with no Office code (*Inference*).
   **Tested**: ONLYOFFICE keeps the link in the `sdtContentLocked` placeholder, and Word and Excel for Mac and for the
   web follow it to the portion page: Word for Mac through Safe Links' check page, Excel for Mac after a warning, the
   web apps directly. Protected View, on Windows only, was not tried.
5. **No other add-in-free route keeps the text out of the file (D2)**: fields store their result and do not update on
   the web, embedded objects show as placeholders, video embeds accept a few sites, `WEBSERVICE` writes into a cell.
6. **The smallest read-only add-in (D3) still declares read/write access.** `customXmlParts` (WordApi 1.4: web,
   Windows 2208+, Mac 16.64+) and `contentControls.getByTag` (WordApi 1.1) suffice, but application-specific APIs need
   the read/write document permission "even when your code only reads data" (Guidance). For a demo the user sideloads
   it; an administrator's centralized deployment takes up to 24 hours.
7. **Encrypting-label metadata on an unencrypted file** stays unencrypted in Office desktop and mobile apps, and
   SharePoint and OneDrive encrypt it at the next access, in the documented case of a label edited to add encryption
   (Guidance); for metadata the platform writes, **UNVERIFIED** ([section 5](#5-encrypting-label-metadata-on-an-unencrypted-file-question-4)).
8. **Prior art**: nothing in OpenTDF; no Microsoft feature calls an external decision point; one vendor's DKE key
   service evaluates OPA policies ([section 9](#9-prior-art-question-8)).
9. **A save in Word for the web breaks the binding's signature** (Tested): a platform document saved again by Word for
   the web from OneDrive keeps its three Custom XML parts byte for byte, with the placeholder's link and the
   `MSIP_Label_*` values, but Word for the web writes 18 other parts again, the body, headers, footers and styles among
   them, and SharePoint adds three Custom XML parts of its own, so the policy service reports the copy as altered
   ([section 11](#11-tenant-trials)).

The facts that most change the choice: **revocation**, hours for B (group cache, use licence, owner exception) against
each opening for D, and for C if Office does not cache; **licences and reach**, C needs E5-class licences and loses Office
for the web, while A, B and D work with Business Premium except endpoint DLP and perhaps B's MIP SDK path
([4.5](#45-licences)); **development**, D1 needs a portal page and links, B and C a MIP SDK sidecar beside the Node.js
services (or, for B, a metered Graph call on a SharePoint copy).

---

## 1. Sources

| Short name | Document | Last update | Notes |
|---|---|---|---|
| Graph | [assignSensitivityLabel][graph-assign], [extractSensitivityLabels][graph-extract], [metered APIs][graph-metered-list], [groups][graph-groups], [add members][graph-add-member], [beta sensitivityLabel][graph-beta-label] | 2026-08-19, 2026-07-24, 2026-04-03, 2026-07-09, 2026-06-19, 2025-12-03 | Guidance |
| MIP SDK | [setup][mip-setup-platforms], [release history][mip-history], [API permissions][mip-perms], [delegation][mip-delegation], [file handler][mip-file-types], [cache][mip-cache], [FAQ][mip-faq-labels] | 2026-09-21 to 2026-09-24 | Guidance; SDK 1.18.148 of 2026-09-04 |
| Purview | [encryption][pv-enc-now], [users and groups][rms-cache], [usage rights][rms-uselicense], [SharePoint and OneDrive][pv-spo], [Office apps][pv-office-marking], [versions][pv-versions], [co-authoring][pv-coauth-meta], [DLP reference][dlp-ref-actions], [labels in DLP][dlp-label], [service description][pv-sd-labels], [when labels take effect][pv-create-when] | 2026-05-14 to 2026-09-30 | Guidance |
| DKE | [overview][dke], [setup][dke-setup-access], [FAQ][dke-faq-apps] | 2026-05-18, 2026-09-19, 2025-11-18 | Guidance |
| DKE service | [Azure-Samples/DoubleKeyEncryptionService][dke-repo] (MIT, .NET 8) | commit `f5034bc` (2026-08-21) | Implementation |
| Office Add-ins | [Word requirement sets][word-reqsets], [permissions][addin-perms], [runtimes][addin-browsers], [dialog][addin-dialog], [NAA][addin-naa], [sideloading][addin-sideload-web], [centralized deployment][addin-central] | 2025-12-03 to 2026-09-30 | Guidance |
| Open XML SDK | [Hyperlink][oxsdk-hyperlink], [LockingValues][oxsdk-locking], [SimpleField][oxsdk-fldsimple] | 2024-01-12 | Reproduces ISO/IEC 29500-1 |
| OpenTDF | [web-sdk][websdk-readme] (BSD-3-Clause-Clear) | tag `sdk-v0.21.0`, commit `829c530` | Implementation |
| ONLYOFFICE | sdkjs, word and cell builder API | tag `v9.4.0.129`, as in [onlyoffice-integration.md](onlyoffice-integration.md#0-version-pinning) | Implementation |

---

## 2. Microsoft Graph (question 1)

### 2.1 `assignSensitivityLabel`

- **Call** (Guidance, [reference][graph-assign]): `POST /drives/{drive-id}/items/{item-id}/assignSensitivityLabel` (also
  under `/me`, `/sites`, `/groups`, `/users`), with `sensitivityLabelId` (empty to remove), optional `assignmentMethod`
  (`standard`, `privileged`, `auto`), `justificationText` ("Required when downgrading or removing a label") and
  `appliedByUser` (app-only). Permissions: `Files.ReadWrite.All` or `Sites.ReadWrite.All`, delegated (work or school
  account) or application; global cloud only.
- **Asynchronous** ([#response][graph-assign-resp]): `202 Accepted` with a `Location` monitor URL, which "doesn't
  require authentication, because the URL is short-lived and unique to the original caller" and reports `status` and
  `percentageComplete` ([long-running actions][graph-lro]).
- **Encryption.** The page never says that the label's encryption is applied. It says that "some IRM Protected
  sensitivity labels can't be updated in app-only mode and need delegated user access to validate if the user has proper
  rights" (`Not Supported`), and lists `423 Locked` codes `fileDoubleKeyEncrypted`, `fileDecryptionNotSupported`,
  `fileDecryptionDeferred`; a call "might be rejected ... if the file type isn't supported, or the file is double
  encrypted" ([#response][graph-assign-resp], [reference][graph-assign]). With labels enabled for SharePoint and
  OneDrive, "when users download or access these files ..., the sensitivity label and any encryption settings from the
  label are enforced" ([SharePoint and OneDrive][pv-spo]); labels apply to `.docx`, `.docm`, `.xlsx`, `.xlsm`, `.xlsb`,
  `.pptx`, `.ppsx` ([types][pv-spo-types]). *Inference*: a label with encryption assigned this way, preferably in
  delegated mode, protects the copy a reader downloads; that the downloaded bytes are encrypted is **UNVERIFIED**.
- **Protected and metered.** It is "considered as protected. Protected APIs require you to have more validations,
  beyond permission and consent" ([reference][graph-assign]), and costs USD 0.00185 per call ([metered list][graph-metered-list]).
  The app registration must be tied to an Azure subscription through a `Microsoft.GraphServices/accounts` resource;
  confidential clients only, no managed identities ([setup][graph-metered-setup]). How to request the "more
  validations" is not linked from these pages: **UNVERIFIED**.
- *Inference*: for the platform, each export means an upload to a drive of the tenant, a metered call, polling, and a
  download, with an Azure subscription for billing.

### 2.2 `extractSensitivityLabels`

`POST .../extractSensitivityLabels` returns `200 OK` with `labels[]` (`sensitivityLabelId`, `assignmentMethod`,
`tenantId`), reading "the content stream of the file" when the stored metadata is stale; `Files.Read.All` delegated or
application; same `423` codes; available in national clouds; not metered (Guidance, [reference][graph-extract],
[metered list][graph-metered-list]).

### 2.3 No Graph API encrypts a file outside SharePoint and OneDrive

The beta `sensitivityLabel` methods (`evaluateApplication`, `evaluateRemoval`, `extractContentLabel`,
`computeRightsAndInheritance` and others) "compute the set of actions required to apply the label" and return actions,
not content; beta APIs are not supported in production ([beta reference][graph-beta-label]). Outside SharePoint and
OneDrive, Microsoft encrypts files with the MIP SDK ([section 3](#3-the-mip-sdk-question-2)) or the Purview
Information Protection client, which "runs on Windows only" ([client][ipc]). *Inference*: no Graph endpoint takes a
file and returns it encrypted; as an absence, this is **UNVERIFIED** beyond the pages read.

---

## 3. The MIP SDK (question 2)

- **Platforms** (Guidance, [setup][mip-setup-platforms]): Ubuntu 22.04 and 24.04 (C++, Java in preview, .NET
  packages); RHEL 8 and 9, Debian 10 and 11, macOS (C++); Windows (C++, .NET, Java in preview); Android and iOS (C++,
  Protection and Policy SDKs only). Linux needs curl, libsecret, OpenSSL, UUID, and GMIME and libgsf for the File SDK
  ([dependencies][mip-setup-deps]). A C API is documented too. Each GA version is supported "for one year after the
  next GA version is released"; the latest is 1.18.148 of 2026-09-04 ([history][mip-history]).
- **Containers** are not mentioned (**UNVERIFIED**). The plaintext on-disk cache suits "a Linux daemon running on a
  server"; the encrypted cache on Ubuntu "Requires `SecretService` and `LinuxEncryptedCache` feature flag"; an
  in-memory cache exists ([cache][mip-cache], [encryption][mip-cache-linux]). *Inference*: the in-memory or on-disk
  cache avoids needing a desktop keyring in a container.
- **Node.js**: no Node.js or JavaScript binding is documented. *Inference*: a Node.js service would call a sidecar built
  on the .NET or Java wrapper, or the C API through a foreign function interface; no Microsoft source describes this.
- **Authentication**: the application implements `mip::AuthDelegate::AcquireOAuth2Token`, given the authority,
  resource, claims and scopes ([concept][mip-auth]). Application permissions, all with admin consent: `Content.Writer`
  (for "line-of-business applications that apply classification labels to files on export"; "the owner of the
  protected files is the service principal identity", [Content.Writer][mip-perms-writer]), `Content.DelegatedWriter`,
  `Content.DelegatedReader`, `Content.SuperUser`, `UnifiedPolicy.Tenant.Read`; delegated: `user_impersonation`,
  `UnifiedPolicy.User.Read` ([permissions][mip-perms]). A service acts as a user through `DelegatedUserEmail`
  ([delegation][mip-delegation]).
- **Applying a label with encryption to a local file**: `FileHandler::SetLabel(label, labelingOptions,
  protectionSettings)` then `CommitAsync(outputFile)`, which writes a copy ([commit][mip-file-commit]); Office OPC and
  legacy formats, PDF, PFILE and XMP files are supported ([types][mip-file-types]). The SDK sets `contentBits` but
  applies no header, footer or watermark ([FAQ][mip-faq-marking]); it publishes offline by default, except with DKE,
  which "must make a service call to fetch the public key at publishing" ([offline publishing][mip-offline]).
- **Decrypting**: `RemoveProtection()` then commit, after an access check for `EXPORT` or `OWNER`, "your
  responsibility" ([remove protection][mip-file-remove]). As the user who has rights: a delegated consumption with
  `Content.DelegatedReader`. As super user: `Content.SuperUser` lets an application "decrypt all content protected for
  the specific tenant" ([Content.SuperUser][mip-perms-super]); the tenant's super user feature is off by default
  ([super users][pv-superuser]); whether the application needs it on is **UNVERIFIED**. The issuer always has Full
  Control ([issuer][rms-owner]); *Inference*: the platform could decrypt at upload an export it encrypted itself.
- **Limits**: 500 sensitivity labels with encryption ([FAQ][mip-faq-labels]); 7,500 Rights Management requests per 10
  seconds for a whole organisation ([FAQ][mip-faq-throttling]).
- **Licensing and terms**: releasing an application "to the public" requires an Information Protection Integration
  Agreement; "You don't need this agreement for applications intended only for internal use" ([IPIA][mip-setup-ipia]).
  The service description lists the SDK "for all platforms ... and Linux" under AIP Premium P1 and P2, not under
  Purview Information Protection for Office 365 ([AIP][aip-sd]). The licence terms of the binaries were not read:
  **UNVERIFIED**.

---

## 4. Sensitivity labels with encryption (question 3)

### 4.1 Groups that can receive rights

- A label that assigns permissions now can name "Any specific user or email-enabled security group, distribution group,
  or Microsoft 365 group in Microsoft Entra ID. The Microsoft 365 group can have static or dynamic membership"; "You also
  can't use a security group that isn't email-enabled" (Guidance, [users or groups][pv-enc-groups]); the service matches
  the group's email address in a verified domain ([groups][rms-groups]).
- Graph manages Microsoft 365 groups and security groups; mail-enabled security groups and distribution groups are
  "No (read-only)" there, Microsoft 365 groups come with "Outlook conversations and calendar" and "SharePoint files and
  team site", and dynamic membership needs Entra ID P1 per user ([groups][graph-groups]), which Business Premium includes
  ([Entra licensing][entra-licensing]). A member is added with `POST /groups/{id}/members/$ref` and
  `GroupMember.ReadWrite.All`, 20 at most per `PATCH` ([add members][graph-add-member]). Dynamic membership changes "are
  typically processed within a few hours ... Processing can take more than 24 hours" ([dynamic groups][entra-dynamic]).
- Exchange Online PowerShell runs on Ubuntu 22.04 and 24.04 with PowerShell 7.6, Security & Compliance PowerShell does
  not ([Linux][exo-linux]); `New-Label -EncryptionRightsDefinitions "Identity1:Rights1,Rights2;..."` defines a label's
  rights ([New-Label][new-label-rights]), from Windows only ([microsoft-purview-labels.md 7.3](microsoft-purview-labels.md#73-labels-sublabels-and-policies-with-security--compliance-powershell)).
- *Inference*: a platform on Linux would keep one Microsoft 365 group per label through Graph, with their mailboxes and
  sites, or mail-enabled security groups through Exchange Online PowerShell; dynamic groups are too slow for revocation.

### 4.2 How fast a removal stops someone

- **Group cache**: "any changes to group membership in Microsoft Entra ID can take up to three hours to take effect
  when these groups are used by the Azure Rights Management service and this time period is subject to change"
  (Guidance, [caching][rms-cache]).
- **Use licence**: "For the duration of the use license, the user isn't reauthenticated or reauthorized"; the tenant
  default is 30 days, set with `Set-AipServiceMaxUseLicenseValidityTime` ([use licence][rms-uselicense]). A label that
  assigns permissions now sets it through **Allow offline access**: Never, Always, or a number of days; "when that
  threshold is reached, users must be reauthenticated and their access is logged", and "user group membership is
  reevaluated". Microsoft recommends 7 days for sensitive data, Never so that removed users "won't be able to open it",
  and warns that with Always they may open it "for up to 30 days ... after their access is removed"
  ([permissions now][pv-enc-now], [offline access][pv-enc-offline]).
- **Exceptions**: the Rights Management issuer "can always access the document or email offline" and "can still open a
  document after it's revoked"; the owner, by default the user who encrypted, keeps Full Control ([issuer][rms-owner]).
  Revoking a document needs it registered by Office for Windows 2402+, and "users will continue to be able to access the
  documents that have been revoked until the offline policy period expires" ([track and revoke][track-revoke]).
- *Inference*: with offline access Never, a removal from a group takes effect at the next opening within about three
  hours; with N days, up to N days later. The platform applies a revocation within seconds to a minute
  ([CONTEXT.md](../../CONTEXT.md)). Encrypting with the platform's service principal (`Content.Writer`) keeps exporting
  users from becoming owners.

### 4.3 What Word supports

| | Word for Windows | Word for Mac | Word for the web |
|---|---|---|---|
| Labels that assign permissions now | Current Channel 1910+, Semi-Annual 2002+ | 16.21+ | Yes, once labels are enabled for SharePoint and OneDrive |
| Co-authoring encrypted files | 2107+ (Semi-Annual 2202+) | 16.51+ | Yes |
| Double Key Encryption | 2307+ (Monthly 2309+, Semi-Annual 2308+) | 16.85+ | Not available |
| Track and revoke | 2402+ | Not available | Not available |

Source: [capabilities table][pv-versions] (Guidance). Windows can apply encrypting labels offline; macOS, iOS and Android
must be online to apply them; nobody needs to be online to open ([considerations][pv-enc-consider]).

Office for the web opens and edits encrypted files stored in SharePoint or OneDrive once labels are enabled there, except
encryption with an expiry other than Never, DKE, an on-premises key or a template applied outside a label; it does not
print, download, export or copy them; it does not prevent screen captures; and "SharePoint and OneDrive can't process
some files that are labeled and encrypted from Office desktop apps when these files contain Power Query data, data stored
by custom add-ins, or custom XML parts", while "Files that are labeled and encrypted only in Office for the web aren't
affected" (Guidance, [limitations][pv-spo-limits]). An uploader needs at least the View right, otherwise "the upload is
successful but the service doesn't recognize the label" ([SharePoint and OneDrive][pv-spo]). *Inference*: every platform
file has Custom XML parts. **Tested**: one encrypted in Word for Mac is not processed ([section 11](#11-tenant-trials));
whether SharePoint processes one encrypted by the MIP SDK or by Graph is **UNVERIFIED**.

### 4.4 Co-authoring of encrypted files

Off by default: desktop apps then open encrypted files in exclusive mode, without AutoSave
([considerations][pv-enc-consider]). An Information Protection Admin turns it on in the Purview portal and waits 24
hours; it needs labels enabled for SharePoint and OneDrive, Microsoft 365 Apps for Windows 2107 (Semi-Annual 2202),
macOS 16.51, iOS 2.58, Android 16.0.14931, and MIP SDK 1.7 in applications ([prerequisites][pv-coauth-prereq]); not with
an expiry or DKE ([limitations][pv-coauth-limits]). "After you enable the setting for co-authoring, labeling information
for unencrypted files is no longer saved in custom properties" ([metadata][pv-coauth-meta]); only
`Set-PolicyConfig -EnableLabelCoauth:$false` turns it off, losing that metadata ([disable][pv-coauth-disable]). The
platform already reads the Sensitivity Label Information part first at upload
([microsoft-365.md](../microsoft-365.md#in-the-microsoft-365-tenant)).

### 4.5 Licences

- Manual sensitivity labelling: Microsoft 365 E5/A5/G5/E3/A3/G3/F1/F3/Business Premium, OneDrive Plan 2, EMS E3/E5,
  Office 365 E5/A5/E3/A3, AIP Plan 1 and 2; Message Encryption, "built on Azure Rights Management", is listed for
  Business Premium (Guidance, [labelling][pv-sd-labels], [message encryption][pv-sd-ome]). No row separates labels with
  encryption, and the same page says that "Sensitivity labeling, including automatic or policy‑based labeling, requires
  a Microsoft 365 E5 license" in a paragraph about the scanner.
- The Rights Management service is activated automatically for subscriptions obtained since February 2018
  ([activation][activate-rms]).
- The MIP SDK is listed under AIP Premium P1 and P2 ([AIP][aip-sd]); that Microsoft 365 Business includes AIP Premium
  P1 is stated only in an archived 2018 post ([archive][m365b-aip-2018]): **UNVERIFIED** today.
- *Inference*: Business Premium covers labels with encryption applied in Office; the MIP SDK path needs confirmation
  ([open question 5](#10-open-questions-need-a-tenant)).

---

## 5. Encrypting label metadata on an unencrypted file (question 4)

- Labelling outside Office normally encrypts: "Solutions that apply sensitivity labels to files outside Office apps do so
  by applying labeling metadata to the file. In this scenario, content marking ... isn't inserted into the file but
  encryption is applied" (Guidance, [Office apps][pv-office-marking]).
- **Office desktop and mobile**, for a label edited to add encryption: "when you open previously labeled and unencrypted
  documents or emails in Office Desktop or Office Mobile, those items remain unencrypted unless you remove the label and
  reapply it" (Guidance, [editing labels][pv-enc-edit]).
- **SharePoint and OneDrive** with labels enabled: "the new encryption status of files automatically change when these
  files are next accessed ... files that were previously unencrypted become encrypted" ([editing labels][pv-enc-edit]),
  and encryption a user removed "will be automatically restored the next time the document is accessed or downloaded"
  ([IRM options][pv-office-irm]).
- *Inference*: Word would show the label and leave a local copy unencrypted, while SharePoint and OneDrive would encrypt
  it at the next access, making "write the metadata, upload, download" a third way to have Microsoft encrypt an export.
  Neither is documented for metadata a third party writes, nor what Word does on Save: **UNVERIFIED**. Turning the
  labels of the current label mapping into labels with encryption would, by the same statement, encrypt the platform's
  files already in SharePoint and OneDrive at their next access.
- A library default label is no shortcut: it never overrides a manually applied label ([default label][pv-default-label]),
  and the platform writes `Method` `Privileged`, the manual method.

---

## 6. Double Key Encryption (question 5)

### 6.1 Clients and lost features

- The capabilities table lists DKE for Word, Excel and PowerPoint on Windows (Current Channel 2307+, Monthly Enterprise
  2309+, Semi-Annual 2308+), Mac 16.85+, iOS 2.85+ and Android 16.0.18227+, and "Not available" on the web
  ([versions][pv-versions]). The DKE page (updated 2026-05-18) still names only "Microsoft 365 Apps for enterprise
  clients on Windows" ([environments][dke-envs]), and the FAQ the desktop apps on Windows ([FAQ][dke-faq-apps]); the
  table is the most recent (*Inference*). Windows clients that apply DKE labels need a `DoubleKeyProtection` registry flag
  ([client set-up][dke-setup-clients]).
- Lost (Guidance, [features][dke-features], [adoption][dke-adopt]): co-authoring and AutoSave; SharePoint and OneDrive
  processing, so no Office for the web, "coauthoring, eDiscovery, data loss prevention, and search"; default library
  labels; Loop; Teams meetings; mail flow rules that need the attachment's content; Delve, content search and indexing,
  and Copilot. A label cannot become DKE after creation ([FAQ][dke-faq-convert]). Graph returns `fileDoubleKeyEncrypted`
  ([assign][graph-assign-resp], [extract][graph-extract]).
- Licence: "Double Key Encryption comes with Microsoft 365 E5" ([licensing][dke-licence]); the service description lists
  Microsoft 365 E5/A5/G5, Purview Suite, E5 Information Protection and Governance and EMS E5 ([DKE][pv-sd-dke]). Business
  Premium is not listed.

### 6.2 Protocol and reference implementation

Microsoft's reference key service ([repository][dke-repo], Implementation, ASP.NET Core on .NET 8):

- `GET /{keyName}` returns the public key, without authentication, as `{"key":{"kty":"RSA","n":"...","e":65537,
  "alg":"RS256","kid":"https://<host>/<keyName>/<keyId>"},"cache":{"exp":"..."}}`
  ([routes][dke-routes], [controller][dke-controller], [sample][dke-pubkey-json]).
- `POST /{keyName}/{keyId}/Decrypt`, with a bearer token, takes `{"alg":"RSA-OAEP-256","value":"<base64>"}` and returns
  `{"value":"<base64>"}`, or `403` when the authorizer refuses ([key manager][dke-keymanager], [request][dke-decrypt-req],
  [response][dke-decrypt-resp]).
- The token is a Microsoft Entra token whose audience is the service's host name ([JWT set-up][dke-jwt]) and whose
  issuer is the tenant ([tenant settings][dke-setup-tenant]); Office gets it through the key store's app registration,
  which exposes a `user_impersonation` scope to the Office client ID `d3590ed6-52b3-4102-aeff-aad2292ab01c` (Guidance,
  [register][dke-setup-register]).
- Each decrypt call runs `IAuthorizer.CanUserAccessKey(ClaimsPrincipal user, KeyStoreData key)` ([interface][dke-authorizer]).
  Two authorizers ship: `EmailAuthorizer` checks the `email` or `upn` claim against a list ([email][dke-email]);
  `RoleAuthorizer` reads the `onprem_sid` claim and the user's Active Directory `memberOf` over LDAP ([role][dke-role]).
  The documentation offers email or role authorization, "only one of these authentication methods at a time"
  ([access settings][dke-setup-access]).
- Test keys are "only supported for testing" ([code][dke-testkeys]); production services run "in a third-party cloud or
  ... an on-premises system", with HSMs from Entrust, Thales or Utimaco ([deploy][dke-setup-deploy], [partners][dke-setup-partners]).

### 6.3 Can the platform's key service decide at each opening?

- *Inference* from the code: replacing the authorizer with a call to the policy service gives an access decision at each
  decrypt request, for the Entra user (email, UPN or object id in the token) and the requested key. The request carries
  no document identifier, so a per-label decision needs one key, hence one DKE label, per label of the security policy,
  and the platform must map Entra identities to its clearance directory.
- The Azure half still applies: an external user needs "the required permission to access your key in your Double Key
  Encryption service" and "in Microsoft Azure" ([FAQ][dke-faq-external]), so the label's own rights (users or groups,
  [section 4](#4-sensitivity-labels-with-encryption-question-3)) gate access too (*Inference*).
- Caching: Office caches the Azure public key 30 days and the DKE public key "for as long you configured it"
  ([step 2][dke-step2], [step 4][dke-step4]). Nothing read says whether Office calls `Decrypt` at every opening or
  keeps the unwrapped key or a use licence: **UNVERIFIED**, and decisive for track C.
- Exports would be encrypted server-side with the MIP SDK, which supports DKE from 1.7 ([adoption][dke-adopt]) and needs
  the key service online when publishing ([offline publishing][mip-offline]).

---

## 7. Reading portions from a Microsoft environment (track D, question 6)

### 7.1 Links instead of an add-in (D1)

- **File format.** `w:hyperlink` (§17.16.22) may appear in `w:p` (§17.3.1.22) and in `w:sdtContent` (§17.5.2.36)
  (Mandated, [Hyperlink][oxsdk-hyperlink]); `sdtContentLocked` means "Contents Cannot Be Edited At Runtime And SDT
  Cannot Be Deleted" ([LockingValues][oxsdk-locking]). *Inference*: the placeholder's paragraph inside the locked
  content control can hold a link, and the lock is about editing, not following. **Tested**: Word for Mac and Word for
  the web follow a link inside a `sdtContentLocked` control ([section 11](#11-tenant-trials)).
- **ONLYOFFICE** (Implementation, tag `v9.4.0.129`): `ApiParagraph.AddHyperlink(sLink, sScreenTipText, sBookmarkName)`
  in the document editor ([AddHyperlink][oo-addhyperlink]) and `ApiWorksheet.SetHyperlink(sRange, sAddress, ...)` in the
  spreadsheet editor ([SetHyperlink][oo-sethyperlink]); a link longer than `c_nMaxHyperlinkLength`, 2083, is refused
  ([constant][oo-maxlink]). ONLYOFFICE keeps a link inside the locked placeholder through its save path: the portal's
  stored file holds it (Tested).
- **Word desktop**: "By default, Word and Outlook require you to press Ctrl when you click to follow a hyperlink"
  (Guidance, [support][sup-ctrl-click]); the option is shown for Windows, Word for Mac is **UNVERIFIED**. **Word for the
  web**: "Insert, edit, and follow hyperlinks"; content controls "may appear as placeholders and cannot be edited or
  updated" ([differences][sup-web-diff]); how a reader clicks there is not described (**UNVERIFIED**). **Excel**:
  `HYPERLINK` is "valid for web addresses (URLs) only" in Excel for the web, where one clicks "when the pointer is a
  pointing hand" ([HYPERLINK][sup-hyperlink-fn]).
- **Warnings and policy.** Office warns when "you select a hyperlink or an object that links to an executable file",
  also in Protected View ([warnings][hyperlink-warning], archived), where downloaded files open "read only"
  ([Protected View][sup-protected-view]); following an HTTPS link there is **UNVERIFIED**. Safe Links checks clicks in
  Word, Excel and PowerPoint on Windows, Mac and the web, and "If the URL is considered safe, the user is taken to the
  website"; the Built-in protection preset applies it to every user of a tenant with at least one Defender for Office
  365 licence, which Business Premium and Microsoft 365 E3 include; Office web apps ignore the "Do not rewrite" list, so
  the Tenant Allow/Block List is the way to allow a URL everywhere ([Office apps][safe-links-office],
  [preset][safe-links-builtin], [plans][mdo-about]). No default policy blocking external HTTPS links was found (an
  absence, **UNVERIFIED**). **Tested**, with Built-in protection on: Word for Mac showed Safe Links' check page, then
  the portion page; Excel for Mac showed a warning, then the page; Word and Excel for the web opened it with no
  warning. Following an HTTPS link in Protected View stays **UNVERIFIED**: Windows was not tried.
- **Design** (*Inference*): the link opens a portal page (`https://portail.dcs.example/...` with document and portion
  identifiers) in the reader's browser, where the portal is first-party: sign-in and relay
  ([ADR 0001](../adr/0001-opentdf-calls-through-a-portal-relay.md)) work as they are, the page decrypts as the bubble
  does, and OpenTDF decides at each opening, revocation included. The link reveals identifiers, not text. An envelope
  does not fit in 2083 characters, so the page reads it from the stored document: an older copy shows the current
  portion, and a document deleted from the portal is no longer readable, unless the reader drops the file on the page,
  which reads its Custom XML part in the browser.

### 7.2 Other add-in-free routes (D2)

- **Fields** (`INCLUDETEXT`, `INCLUDEPICTURE` and the like): a field keeps its "current field result" in the document
  (Mandated example, [SimpleField][oxsdk-fldsimple]), and Word for the web shows fields as placeholders that "cannot be
  edited or updated" ([differences][sup-web-diff]). They would write the portion's text into the file.
- **Embedded objects**: OLE objects "may appear as placeholders and cannot be edited, moved, or resized" in Word for the
  web ([differences][sup-web-diff]).
- **Web content**: Word embeds online video from "YouTube, SlideShare, Vimeo, TED, SharePoint, OneDrive for Business",
  not arbitrary pages ([online video][sup-online-video]).
- **Excel `WEBSERVICE`** puts the response in a cell, "relies on Windows operating system features, so it will not
  return results on Mac", and allows 2048-character URLs ([WEBSERVICE][sup-webservice]).
- *Inference*: links are the only add-in-free route that keeps a portion's text out of the file.

### 7.3 The smallest read-only add-in (D3)

- **Model**: a task pane, "interface surfaces that typically appear on the right side of the window"
  ([task panes][addin-taskpane]); it runs in an iframe with the HTML5 `sandbox` attribute in Office on the web, Edge
  WebView2 on Windows and Safari WKWebView on Mac ([web clients][addin-security-web], [runtimes][addin-browsers]), under
  the same-origin policy, with CORS or a server proxy for other origins ([same origin][addin-sop]). HTTPS is required for
  Office on the web ([hosting][addin-manifest-https]).
- **APIs** (Guidance): `Word.Document.customXmlParts` and `CustomXmlPartCollection.getByNamespace`, then
  `CustomXmlPart.getXml()` (WordApi 1.4, [document][word-document], [collection][word-cxpc], [part][word-cxp]);
  `document.contentControls`, `ContentControlCollection.getByTag(tag)`, `ContentControl.tag` and `.text` (WordApi 1.1,
  [collection][word-ccc], [control][word-cc]). WordApi 1.4: web, Windows 2208 (build 15601.20148), Mac 16.64; WordApi
  1.1: web, Windows 1509, Mac 15.19 ([requirement sets][word-reqsets]). *Inference*: getting the parts in
  `urn:linagora:dcs:portion:1` and the placeholders by tag is enough to list the portions and show their text in the pane.
- **Permission**: "If your add-in uses the application-specific APIs, declare the read/write document permission in the
  manifest. This requirement applies even when your code only reads data"; the Common API's `CustomXmlParts` also needs
  it ([permissions][addin-perms]). *Inference*: the add-in is read-only because it calls no write method, not because
  of its manifest.
- **WebCrypto and the OpenTDF web SDK**: the SDK decrypts with `crypto.subtle` (Implementation,
  [decrypt][websdk-decrypt], [key agreement][websdk-keyagreement]) and takes the access token from an interceptor the
  application supplies ([README][websdk-readme]). No Office page mentions WebCrypto; *Inference*: the three runtimes
  provide it on HTTPS; **UNVERIFIED** in practice.
- **Token**: the relay relies on a portal session cookie, but in Office on the web the add-in is a third-party iframe:
  blocked third-party cookies "will prevent your add-in from using any such cookies" ([SSO][addin-sso-cookies]), and
  Chromium 115+ partitions storage. The documented route to a non-Microsoft identity provider is the Office dialog API,
  a separate window whose first page is on the add-in's domain, returning a token with `messageParent`
  ([dialog][addin-dialog], [external][addin-external]). Nested app authentication serves Microsoft Entra and Microsoft
  accounts only and, on the web, "only for documents that are opened from Microsoft SharePoint Online and OneDrive"
  ([NAA][addin-naa], [requirement set][addin-naa-reqset]).
- **Deployment for a demo** (Guidance): sideloading is done by the user: on the web, Home > Add-ins > More Settings >
  Upload My Add-in, kept in the browser's local storage ([web][addin-sideload-web]); on Mac, the manifest copied to
  `~/Library/Containers/com.microsoft.Word/Data/Documents/wef` ([Mac][addin-sideload-mac]); on Windows, a shared-folder
  catalog, "not supported for production" ([network share][addin-sideload-share]). Centralized deployment reaches Word
  on Windows 1704+, Mac 15.34+ and the web for users with Exchange Online mailboxes, in "up to 24 hours", through users,
  Microsoft 365 groups, distribution lists, dynamic and security groups, but not "non-mail-enabled security groups" or
  nested groups ([centralized deployment][addin-central]). Whether a tenant can block **Upload My Add-in** is **UNVERIFIED**.
- **With track B**: the usage right `OBJMODEL` "Enables the option to run macros or perform other programmatic or
  remote access to the content" ([usage rights][rms-rights]), and Outlook add-ins do not activate on items whose label
  sets "Allow programmatic access" to false ([Outlook][addin-security-outlook]); what Word does with an add-in on a file
  without that right is **UNVERIFIED**.

### 7.4 Excel

`Workbook.customXmlParts` and `getByNamespace` are ExcelApi 1.5: web, Windows 1703, Mac 15.36
([workbook][excel-workbook], [collection][excel-cxpc], [requirement sets][excel-reqsets]). Excel has no content
controls: a workbook placeholder is an ONLYOFFICE user protected range kept in a worksheet `extLst` extension, which
Excel keeps but does not enforce ([onlyoffice-spreadsheets.md 4.1](onlyoffice-spreadsheets.md#41-user-protected-ranges);
[ADR 0006](../adr/0006-a-workbook-portion-is-a-user-protected-range.md)). *Inference*: Office.js exposes no such
extension, so an Excel add-in could list portions from their parts but not find their cells without a platform change,
such as a defined name per portion; a cell link (D1) needs no such change. **Tested**: Excel for Mac follows the
placeholder's cell link after a warning, and Excel for the web opens it in a new tab ([section 11](#11-tenant-trials)).

---

## 8. DLP with sensitivity labels (question 7)

- **Conditions** (Guidance, [labels as conditions][dlp-label]): a label is a "Content contains" condition for Exchange
  messages and attachments, SharePoint and OneDrive items, Teams attachments (through SharePoint and OneDrive), devices,
  Defender for Cloud Apps (preview) and inline web traffic. File types: Exchange `.docx`, `.xlsx`, `.pptx`, `.pdf`,
  `.pfile`; SharePoint and OneDrive `.docx`, `.xlsx`, `.pptx`, `.pdf`; devices the same as Exchange
  ([#supported-file-types][dlp-label-types]). "DLP's ability to detect sensitivity labels in SharePoint and OneDrive is
  limited", with a pointer to the SharePoint limitations ([#supported-items][dlp-label]).
- **Actions** ([actions][dlp-ref-actions]):
  - SharePoint and OneDrive: "Restrict access or encrypt the content": "Block everyone. Only the content owner, last
    modifier, and site admin will continue to have access", block people outside the organisation, or block given
    external domains or users (preview) ([SharePoint][dlp-ref-spo]). Guests are blocked "right after detection".
  - Exchange: restrict access, encrypt, redirect, ask for approval, quarantine, add disclaimers and more.
  - Devices (onboarded Windows and macOS): Audit, Block with override or Block for uploads to restricted cloud domains,
    pasting into browsers, copying to the clipboard, USB or a network share, printing, Bluetooth, RDP and restricted
    apps ([devices][dlp-ref-devices]).
  - No "block download" action is listed for SharePoint or OneDrive (an absence, *Inference*).
- **Policy tips**: Outlook on the web, Outlook for Windows, SharePoint and OneDrive; not endpoints
  ([#support-policy-tips][dlp-label-tips]).
- **Platform-specific properties**: "Document property is" exists for SharePoint, OneDrive and endpoints
  ([SharePoint][dlp-ref-cond-spo], [endpoints][dlp-ref-cond-endpoint]); in SharePoint "Any document property can be used,
  as long as the property has a corresponding managed property", and only new or edited content is indexed
  ([properties][dlp-fci]). *Inference*: a custom property with the document label's categories, written before signing
  as the `MSIP_Label_*` properties are, would let DLP act on what sensitivity labels cannot express.
- **Licences**: DLP for Exchange, SharePoint and OneDrive is in Microsoft 365 E5/A5/G5/E3/A3/G3 and Business Premium,
  among others ([service description][pv-sd-dlp]); endpoint DLP, on Windows 10 and 11 and macOS 10.15+, needs Microsoft 365
  E5-class or Purview Suite licences ([endpoint DLP][pv-sd-edlp]).
- Turning on co-authoring keeps DLP label conditions working ([prerequisites][pv-coauth-prereq]).
- **Tested** ([section 11](#11-tenant-trials)): a policy for SharePoint sites and OneDrive accounts, "Content contains"
  the sensitivity labels DIFFUSION RESTREINTE and above, with "Block only people outside your organization" and a
  policy tip, acted on the label the platform writes: about a quarter of an hour after the policy was turned on, and
  minutes after the platform document was uploaded to OneDrive, sharing it with an address outside the organisation
  was refused, and Word for the web showed the policy tip.

---

## 9. Prior art (question 8)

- **OpenTDF**: a GitHub code search of the `opentdf` organisation on 2026-10-01 for `purview`, `MSIP`, `"double key"`
  and `sensitivity label` found no integration; the only hits used "label" in another sense (Implementation).
- **Microsoft, adjacent features** (Guidance): a SharePoint library label that extends SharePoint permissions to
  downloaded copies, which cannot be opened offline or once the user's permission is gone ([extend permissions][pv-extend],
  [limitations][pv-extend-limits]; E5-class with SharePoint Advanced Management, [service description][pv-sd-extend]);
  information barriers, two-way restrictions between segments of users in Teams, SharePoint and OneDrive ([IB][ib]);
  Conditional Access on Microsoft Rights Management Services, app ID `00000012-0000-0000-c000-000000000000`
  ([Entra configuration][enc-entra-ca]); Adaptive Protection's insider risk levels as DLP conditions
  ([adaptive][dlp-ref-adaptive]). *Inference*: none consults an external decision point or ZTDF.
- **DKE key services**: Microsoft lists Entrust, Thales and Utimaco HSM integrations ([partners][dke-setup-partners]).
  Stormshield documents a KMaaS DKE module exposing the public key and decryption endpoints, DKE policies written for OPA
  (`policy-dke.wasm`, `policy-dke.data.json`) with an OPA server mode, and ZTDF support in its SDK (Implementation,
  vendor documentation: [DKE][ss-dke], [OPA][ss-opa], [ZTDF][ss-ztdf]); a remote policy decision point for DKE appears
  only in release notes that could not be retrieved: **UNVERIFIED**. It is the closest prior art to track C.
- **Virtru** describes a deployment where its platform "recognizes these Purview classifications and automatically
  initiates TDF ... protection" (vendor case study, [Virtru][virtru-va]); the mechanism is **UNVERIFIED**.

---

## 10. Open questions (need a tenant)

1. **Encrypting label as metadata only**: a platform file whose custom properties name a label with encryption, opened
   and saved in Word for Windows, Mac and the web, and downloaded from SharePoint and OneDrive: is it encrypted?
2. **Graph**: `assignSensitivityLabel` with such a label on a platform file, app-only and delegated: downloaded bytes,
   Office for the web, cost; how the "protected API" validation is requested.
3. **MIP SDK** on Linux with `Content.Writer`: does SharePoint process the file (Custom XML parts), does Office for the
   web open it, do the binding, portions and `MSIP_Label_*` properties survive, can the platform decrypt it at upload as
   issuer, does it run in a container with an in-memory cache, does `Content.SuperUser` need the super user feature.
4. **Revocation timing**: a reader removed from a label's group, with offline access Never then 1 day: when do Word
   desktop and Word for the web refuse the file?
5. **Groups and licences**: Microsoft 365 groups created through Graph as rights holders and their side effects;
   whether Business Premium covers labels with encryption applied by a service principal through the MIP SDK.
6. **DKE**: does Office call `Decrypt` at each opening; which claims the token carries; Mac apply and open; does DLP
   still see the label of a DKE file in SharePoint.
7. **D1 links**: does Word (Windows, Mac, web) follow a link inside a `sdtContentLocked` placeholder, in normal and
   Protected View; Safe Links prompts; Excel and a link on a merged, protected placeholder; ONLYOFFICE keeping both links
   through save and co-editing. *Answered for Mac and the web in normal view ([section 11](#11-tenant-trials)); Windows
   and Protected View remain.*
8. **D3 add-in**: `getByNamespace("urn:linagora:dcs:portion:1")` and `getByTag` on platform files in Word for the web,
   Windows and Mac; WebCrypto and the OpenTDF web SDK in each runtime; the dialog token flow; Word without `OBJMODEL` on
   a file with a label with encryption; whether a tenant blocks **Upload My Add-in**.
9. **DLP**: "Document property is" on a platform custom property, through a SharePoint managed property and on an
   onboarded device; how long SharePoint takes to see the label of an uploaded platform file. *The label was seen
   within minutes of the upload ([section 11](#11-tenant-trials)); "Document property is" remains.*

---

## 11. Tenant trials

On 2026-10-01 and 2026-10-02 the trials of [#159](https://github.com/linagora/dcs-onlyoffice/issues/159) ran in a
Microsoft 365 Business Premium trial tenant whose four sensitivity labels without encryption map the demo policy's
labels, as [microsoft-365.md](../microsoft-365.md) describes, with co-authoring of labelled files off and Defender
for Office 365's Built-in protection on. The platform files were a DOCX and an XLSX downloaded from the hosted
stack's portal, each with the base label DIFFUSION RESTREINTE, one portion DIFFUSION RESTREINTE – SPÉCIAL FRANCE
whose placeholder links to its portion page, a signed binding, and the sensitivity label the platform writes:
DIFFUSION RESTREINTE, since the informative category that a more restrictive portion adds to the document label has
no sensitivity label ([ADR 0005](../adr/0005-a-document-sensitivity-label-follows-its-document-label.md)). They
were opened from disk in Word and Excel for Mac, and from OneDrive in Word and Excel for the web. Windows was not
tried. What follows is Tested.

| Trial | Seen | Documentation |
|---|---|---|
| Opening in Word for Mac | A bar showed the document's sensitivity label | The label is the metadata the platform writes ([microsoft-365.md](../microsoft-365.md)) |
| Link in Word for Mac | Safe Links' check page ("Liens fiables" in the tenant's French interface), then the portion page, which showed the portion | Safe Links checks clicks in Office apps; Mac has no Protected View ([7.1](#71-links-instead-of-an-add-in-d1)) |
| Link in Excel for Mac | A warning, then the portion page with the portion | Office warns about some links ([7.1](#71-links-instead-of-an-add-in-d1)) |
| Link in Word for the web | The portion page, with no warning | Readers "follow hyperlinks" ([7.1](#71-links-instead-of-an-add-in-d1)) |
| Link in Excel for the web | The portion page in a new tab, with no warning | One clicks "when the pointer is a pointing hand" ([7.1](#71-links-instead-of-an-add-in-d1)) |
| Portion page for a tenant account | A tenant test account that followed the link from Word for the web, in a private window, reached the portal's sign-in page; signed in with a platform account cleared for the portion, the page showed it | The portal is first-party: its sign-in and relay work as they are (*Inference*, [7.1](#71-links-instead-of-an-add-in-d1)) |
| DLP rule (track A) | About a quarter of an hour after the rule was turned on, sharing the platform document with an address outside the organisation was refused, with a message saying that the item contains sensitive information and cannot be shared with people outside the organisation. Word for the web showed the policy tip. OneDrive's list had no sensitivity column; its details pane showed the label | Guests are blocked "right after detection"; policy tips in SharePoint and OneDrive ([8](#8-dlp-with-sensitivity-labels-question-7)) |
| Save in Word for the web, without encryption | The copy keeps the platform's three Custom XML parts and their relationships byte for byte, the placeholder's link and the seven `MSIP_Label_*` values. Word for the web wrote 18 other parts again and dropped one; SharePoint added a content type schema, form templates and a properties part as Custom XML parts, a `ContentTypeId` custom property and `[trash]` entries. The policy service reports the copy as altered, with 28 parts changed since signing | None found |
| Publishing the label with encryption | Published to the administrator and to a test group created the same day. About 13 hours later it showed, in Word for the web and, after signing in again, in Word for Mac, for the administrator, whom the policy names, but not for a test account that the policy reaches through the group | "allow 24 hours" for labels to propagate; Office for the web "within the hour"; "24-48 hours" for configurations that depend on a new group ([when labels take effect][pv-create-when]) |
| Label with encryption applied in Word for Mac (track B) | The administrator encrypted the platform document and saved it to OneDrive, which then served an encrypted container. OneDrive's details pane showed no sensitivity label. Word for the web refused to open it, for a test account in the group and for the administrator alike, saying that the document is protected by Information Rights Management and holds special properties that Word does not support in a browser, and is to be opened in Word desktop. Search did not find its words | SharePoint and OneDrive "can't process some files that are labeled and encrypted from Office desktop apps when these files contain ... custom XML parts" ([4.3](#43-what-word-supports)) |
| Encryption removed in Word for Mac | Labelled DIFFUSION RESTREINTE again and saved as a copy, the document is a plain package again. The platform's three Custom XML parts keep their content byte for byte under other part names; the placeholder's link stays; the `MSIP_Label_*` properties get a new `ActionId` and `SetDate`, and a `Tag`. The policy service reports the copy as altered, with 33 parts changed since signing | None found |
| Removal from the group | Not measured: no reader could open the file encrypted in Word for Mac in Word for the web, where the trial measures the delay | Up to three hours ([4.2](#42-how-fast-a-removal-stops-someone)) |

*Inference*: a platform file encrypted in a desktop app also escapes track A's DLP rule, since SharePoint does not see
its label; not tried.

Still to try: the label applied in Word for the web, whose files Microsoft says SharePoint processes; whether a reader
in the group then opens the platform document in Word for the web with its placeholders and links, and the delay before
a removal from the group stops that reader.

Deviation found: the editors' own download goes around the portal, with no access decision, signature check or journal
entry ([#165](https://github.com/linagora/dcs-onlyoffice/issues/165)).

[graph-assign]: https://learn.microsoft.com/en-us/graph/api/driveitem-assignsensitivitylabel?view=graph-rest-1.0
[graph-assign-resp]: https://learn.microsoft.com/en-us/graph/api/driveitem-assignsensitivitylabel?view=graph-rest-1.0#response
[graph-extract]: https://learn.microsoft.com/en-us/graph/api/driveitem-extractsensitivitylabels?view=graph-rest-1.0#response
[graph-metered-list]: https://learn.microsoft.com/en-us/graph/metered-api-list
[graph-metered-setup]: https://learn.microsoft.com/en-us/graph/metered-api-setup#known-limitations
[graph-lro]: https://learn.microsoft.com/en-us/graph/long-running-actions-overview#retrieve-a-status-report-from-the-monitor-url
[graph-beta-label]: https://learn.microsoft.com/en-us/graph/api/resources/security-sensitivitylabel?view=graph-rest-beta#methods
[graph-groups]: https://learn.microsoft.com/en-us/graph/api/resources/groups-overview?view=graph-rest-1.0#types-of-groups-supported-in-microsoft-graph
[graph-add-member]: https://learn.microsoft.com/en-us/graph/api/group-post-members?view=graph-rest-1.0#response
[entra-dynamic]: https://learn.microsoft.com/en-us/entra/identity/users/manage-dynamic-group#overview
[entra-licensing]: https://learn.microsoft.com/en-us/entra/fundamentals/licensing#microsoft-entra-licensing-options
[exo-linux]: https://learn.microsoft.com/en-us/powershell/exchange/exchange-online-powershell-v2?view=exchange-ps#linux-support-for-the-module
[new-label-rights]: https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-label?view=exchange-ps#-encryptionrightsdefinitions
[mip-setup-platforms]: https://learn.microsoft.com/en-us/information-protection/develop/setup-configure-mip#configure-your-client-workstation
[mip-setup-ipia]: https://learn.microsoft.com/en-us/information-protection/develop/setup-configure-mip#request-an-information-protection-integration-agreement-ipia
[mip-setup-deps]: https://learn.microsoft.com/en-us/information-protection/develop/setup-configure-mip#ensure-your-app-has-the-required-dependencies
[mip-history]: https://learn.microsoft.com/en-us/information-protection/develop/version-release-history#release-history
[mip-auth]: https://learn.microsoft.com/en-us/information-protection/develop/concept-authentication-cpp
[mip-perms]: https://learn.microsoft.com/en-us/information-protection/develop/concept-api-permissions#application-permissions
[mip-perms-writer]: https://learn.microsoft.com/en-us/information-protection/develop/concept-api-permissions#contentwriter
[mip-perms-super]: https://learn.microsoft.com/en-us/information-protection/develop/concept-api-permissions#contentsuperuser
[mip-delegation]: https://learn.microsoft.com/en-us/information-protection/develop/concept-delegation#required-permissions
[mip-file-types]: https://learn.microsoft.com/en-us/information-protection/develop/concept-handler-file-cpp#supported-file-types
[mip-file-commit]: https://learn.microsoft.com/en-us/information-protection/develop/concept-handler-file-cpp#commit-changes
[mip-file-remove]: https://learn.microsoft.com/en-us/information-protection/develop/concept-handler-file-cpp#remove-protection
[mip-cache]: https://learn.microsoft.com/en-us/information-protection/develop/concept-cache-storage#when-to-use-each-type
[mip-cache-linux]: https://learn.microsoft.com/en-us/information-protection/develop/concept-cache-storage#supported-platforms-for-encryption
[mip-offline]: https://learn.microsoft.com/en-us/information-protection/develop/concept-offline-publishing#not-supported
[mip-faq-labels]: https://learn.microsoft.com/en-us/information-protection/develop/faq#how-many-labels-are-supported-by-mip-sdk
[mip-faq-marking]: https://learn.microsoft.com/en-us/information-protection/develop/faq#does-the-mip-sdk-support-content-marking
[mip-faq-throttling]: https://learn.microsoft.com/en-us/information-protection/develop/faq#are-there-any-service-based-throttling-limits-when-using-the-mip-sdk
[aip-sd]: https://learn.microsoft.com/en-us/office365/servicedescriptions/azure-information-protection#feature-availability
[m365b-aip-2018]: https://learn.microsoft.com/en-us/archive/blogs/ausoemteam/new-microsoft-365-business-capabilities-azure-information-protection-premium-p1
[pv-superuser]: https://learn.microsoft.com/en-us/purview/encryption-super-users#configuration-for-the-super-user-feature
[ipc]: https://learn.microsoft.com/en-us/purview/information-protection-client
[pv-enc-edit]: https://learn.microsoft.com/en-us/purview/encryption-sensitivity-labels#editing-labels-to-newly-apply-encryption-or-change-existing-encryption-settings
[pv-enc-now]: https://learn.microsoft.com/en-us/purview/encryption-sensitivity-labels#assign-permissions-now
[pv-enc-offline]: https://learn.microsoft.com/en-us/purview/encryption-sensitivity-labels#rights-management-use-license-for-offline-access
[pv-enc-groups]: https://learn.microsoft.com/en-us/purview/encryption-sensitivity-labels#add-users-or-groups
[pv-enc-consider]: https://learn.microsoft.com/en-us/purview/encryption-sensitivity-labels#considerations-for-encrypted-content
[rms-groups]: https://learn.microsoft.com/en-us/purview/rights-management-users-groups#azure-rights-management-service-requirements-for-group-accounts
[rms-cache]: https://learn.microsoft.com/en-us/purview/rights-management-users-groups#group-membership-caching
[rms-rights]: https://learn.microsoft.com/en-us/purview/rights-management-usage-rights#usage-rights-and-descriptions
[rms-owner]: https://learn.microsoft.com/en-us/purview/rights-management-usage-rights#rights-management-issuer-and-rights-management-owner
[rms-uselicense]: https://learn.microsoft.com/en-us/purview/rights-management-usage-rights#rights-management-use-license
[track-revoke]: https://learn.microsoft.com/en-us/purview/track-and-revoke-admin#revoke-document-access-from-powershell
[pv-spo]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files
[pv-spo-types]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files#supported-file-types
[pv-spo-limits]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-onedrive-files#limitations
[pv-create-when]: https://learn.microsoft.com/en-us/purview/create-sensitivity-labels#when-to-expect-new-labels-and-changes-to-take-effect
[pv-office-marking]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-office-apps#when-office-apps-apply-content-marking-and-encryption
[pv-office-irm]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-office-apps#information-rights-management-irm-options-and-sensitivity-labels
[pv-versions]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-versions#sensitivity-label-capabilities-in-word-excel-and-powerpoint
[pv-coauth-meta]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-coauthoring#metadata-changes-for-sensitivity-labels
[pv-coauth-prereq]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-coauthoring#prerequisites
[pv-coauth-limits]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-coauthoring#limitations
[pv-coauth-disable]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-coauthoring#if-you-need-to-disable-this-feature
[pv-sd-dlp]: https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description#which-licenses-provide-the-rights-for-a-user-to-benefit-from-the-service
[pv-sd-edlp]: https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description#microsoft-data-loss-prevention-endpoint-data-loss-protection-dlp
[pv-sd-dke]: https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description#microsoft-purview-information-protection-double-key-encryption
[pv-sd-labels]: https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description#microsoft-purview-information-protection-sensitivity-labeling
[pv-sd-ome]: https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description#microsoft-purview-information-protection-message-encryption
[pv-sd-extend]: https://learn.microsoft.com/en-us/office365/servicedescriptions/microsoft-365-service-descriptions/microsoft-365-tenantlevel-services-licensing-guidance/microsoft-purview-service-description#microsoft-purview-information-protection
[activate-rms]: https://learn.microsoft.com/en-us/purview/activate-rights-management-service#automatic-activation-for-the-azure-rights-management-service
[enc-entra-ca]: https://learn.microsoft.com/en-us/purview/encryption-azure-ad-configuration#conditional-access-policies-and-encrypted-documents
[pv-default-label]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-default-label#will-an-existing-label-be-overridden
[pv-extend]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-extend-permissions
[pv-extend-limits]: https://learn.microsoft.com/en-us/purview/sensitivity-labels-sharepoint-extend-permissions#limitations
[ib]: https://learn.microsoft.com/en-us/purview/information-barriers
[dke]: https://learn.microsoft.com/en-us/purview/double-key-encryption
[dke-features]: https://learn.microsoft.com/en-us/purview/double-key-encryption#sensitivity-label-features-that-dont-support-dke
[dke-adopt]: https://learn.microsoft.com/en-us/purview/double-key-encryption#when-your-organization-should-adopt-dke
[dke-step2]: https://learn.microsoft.com/en-us/purview/double-key-encryption#step-2-collect-and-cache-the-public-key-for-the-azure-rights-management-service
[dke-step4]: https://learn.microsoft.com/en-us/purview/double-key-encryption#step-4-collect-and-cache-the-dke-key
[dke-licence]: https://learn.microsoft.com/en-us/purview/double-key-encryption#licensing-requirements-for-dke
[dke-envs]: https://learn.microsoft.com/en-us/purview/double-key-encryption#supported-environments-for-storing-and-viewing-dke-protected-content
[dke-setup-access]: https://learn.microsoft.com/en-us/purview/double-key-encryption-setup#key-access-settings
[dke-setup-tenant]: https://learn.microsoft.com/en-us/purview/double-key-encryption-setup#tenant-and-key-settings
[dke-setup-deploy]: https://learn.microsoft.com/en-us/purview/double-key-encryption-setup#deploy-the-dke-service-and-publish-the-key-store
[dke-setup-register]: https://learn.microsoft.com/en-us/purview/double-key-encryption-setup#register-your-key-store
[dke-setup-partners]: https://learn.microsoft.com/en-us/purview/double-key-encryption-setup#other-deployment-options
[dke-setup-clients]: https://learn.microsoft.com/en-us/purview/double-key-encryption-setup#set-up-clients-to-apply-dke-sensitivity-labels
[dke-faq-apps]: https://learn.microsoft.com/en-us/purview/double-key-encryption-faq#what-microsoft-365-apps-can-i-use-with-dke
[dke-faq-external]: https://learn.microsoft.com/en-us/purview/double-key-encryption-faq#can-double-key-encrypted-documents-be-shared-externally
[dke-faq-convert]: https://learn.microsoft.com/en-us/purview/double-key-encryption-faq#can-i-convert-a-non-dke-label-to-a-dke-label
[dke-repo]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/tree/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf
[dke-routes]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Startup.cs#L45-L56
[dke-jwt]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Startup.cs#L83-L98
[dke-controller]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Controllers/KeysController.cs#L21-L58
[dke-keymanager]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Models/KeyManager.cs#L42-L60
[dke-testkeys]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Startup.cs#L69-L72
[dke-authorizer]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Models/Authorizer.cs#L7-L10
[dke-email]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Models/EmailAuthorizer.cs#L22-L51
[dke-role]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Models/RoleAuthorizer.cs#L36-L95
[dke-pubkey-json]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Protocols/PublicKey.Response.json
[dke-decrypt-req]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Protocols/Decrypt.Request.json
[dke-decrypt-resp]: https://github.com/Azure-Samples/DoubleKeyEncryptionService/blob/f5034bc0ae349310b5aa1ff6a6eac6dae71cdecf/src/customer-key-store/Protocols/Decrypt.Response.json
[oxsdk-hyperlink]: https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.hyperlink?view=openxml-3.0.1
[oxsdk-locking]: https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.lockingvalues?view=openxml-3.0.1
[oxsdk-fldsimple]: https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.simplefield?view=openxml-3.0.1
[oo-addhyperlink]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L10920-L10960
[oo-sethyperlink]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/cell/apiBuilder.js#L9100-L9115
[oo-maxlink]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/commonDefines.js#L461
[sup-ctrl-click]: https://support.microsoft.com/en-us/office/remove-or-turn-off-hyperlinks-027b4e8c-38f8-432c-b57f-6c8b67ebe3b0
[sup-web-diff]: https://support.microsoft.com/en-us/word/differences-between-using-a-document-in-the-browser-and-in-word
[sup-hyperlink-fn]: https://support.microsoft.com/en-us/office/hyperlink-function-333c7ce6-c5ae-4164-9c47-7de9b76f577f
[sup-protected-view]: https://support.microsoft.com/en-us/office/what-is-protected-view-d6f09ac7-e6b9-4495-8e43-2bbcdbcb6653
[sup-online-video]: https://support.microsoft.com/en-us/office/insert-an-online-video-in-word-bf11b812-0243-4f53-a1f9-432fbf7ace2c
[sup-webservice]: https://support.microsoft.com/en-us/office/webservice-function-0546a35a-ecc6-4739-aed7-c0b7ce1562c4
[hyperlink-warning]: https://learn.microsoft.com/en-us/previous-versions/troubleshoot/microsoft-365/microsoft-365-apps/office-suite-problems/enable-disable-hyperlink-warning
[safe-links-office]: https://learn.microsoft.com/en-us/defender-office-365/safe-links-about#safe-links-settings-for-office-apps
[safe-links-builtin]: https://learn.microsoft.com/en-us/defender-office-365/safe-links-about
[mdo-about]: https://learn.microsoft.com/en-us/defender-office-365/mdo-about
[word-reqsets]: https://learn.microsoft.com/en-us/javascript/api/requirement-sets/word/word-api-requirement-sets#requirement-set-availability
[word-document]: https://learn.microsoft.com/en-us/javascript/api/word/word.document?view=word-js-preview
[word-cxp]: https://learn.microsoft.com/en-us/javascript/api/word/word.customxmlpart?view=word-js-preview
[word-cxpc]: https://learn.microsoft.com/en-us/javascript/api/word/word.customxmlpartcollection?view=word-js-preview
[word-ccc]: https://learn.microsoft.com/en-us/javascript/api/word/word.contentcontrolcollection?view=word-js-preview
[word-cc]: https://learn.microsoft.com/en-us/javascript/api/word/word.contentcontrol?view=word-js-preview
[excel-reqsets]: https://learn.microsoft.com/en-us/javascript/api/requirement-sets/excel/excel-api-requirement-sets#requirement-set-availability
[excel-workbook]: https://learn.microsoft.com/en-us/javascript/api/excel/excel.workbook?view=excel-js-preview
[excel-cxpc]: https://learn.microsoft.com/en-us/javascript/api/excel/excel.customxmlpartcollection?view=excel-js-preview
[addin-taskpane]: https://learn.microsoft.com/en-us/office/dev/add-ins/design/task-pane-add-ins
[addin-browsers]: https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/browsers-used-by-office-web-add-ins#browsers-by-platform
[addin-security-web]: https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/privacy-and-security#web-clients
[addin-security-outlook]: https://learn.microsoft.com/en-us/office/dev/add-ins/concepts/privacy-and-security#end-users-perspective-in-outlook
[addin-sop]: https://learn.microsoft.com/en-us/office/dev/add-ins/develop/addressing-same-origin-policy-limitations
[addin-manifest-https]: https://learn.microsoft.com/en-us/office/dev/add-ins/develop/add-in-manifests#hosting-requirements
[addin-perms]: https://learn.microsoft.com/en-us/office/dev/add-ins/develop/requesting-permissions-for-api-use-in-content-and-task-pane-add-ins#permissions-model
[addin-dialog]: https://learn.microsoft.com/en-us/office/dev/add-ins/develop/auth-with-office-dialog-api
[addin-external]: https://learn.microsoft.com/en-us/office/dev/add-ins/develop/auth-external-add-ins#middleman-services
[addin-naa]: https://learn.microsoft.com/en-us/office/dev/add-ins/develop/enable-nested-app-authentication-in-your-add-in#naa-supported-accounts-and-hosts
[addin-naa-reqset]: https://learn.microsoft.com/en-us/javascript/api/requirement-sets/common/nested-app-auth-requirement-sets#supported-accounts-and-hosts
[addin-sso-cookies]: https://learn.microsoft.com/en-us/office/dev/add-ins/develop/sso-in-office-add-ins#google-chrome-third-party-cookie-support
[addin-sideload-web]: https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing#manually-sideload-an-add-in-to-office-on-the-web
[addin-sideload-mac]: https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-an-office-add-in-on-mac#sideload-an-add-in-in-office-on-mac
[addin-sideload-share]: https://learn.microsoft.com/en-us/office/dev/add-ins/testing/create-a-network-shared-folder-catalog-for-task-pane-and-content-add-ins
[addin-central]: https://learn.microsoft.com/en-us/microsoft-365/admin/manage/centralized-deployment-of-add-ins?view=o365-worldwide#before-you-begin
[websdk-readme]: https://github.com/opentdf/web-sdk/blob/sdk-v0.21.0/README.md
[websdk-decrypt]: https://github.com/opentdf/web-sdk/blob/sdk-v0.21.0/lib/src/crypto/decrypt.ts#L21
[websdk-keyagreement]: https://github.com/opentdf/web-sdk/blob/sdk-v0.21.0/lib/src/crypto/keyAgreement.ts#L110-L129
[dlp-label]: https://learn.microsoft.com/en-us/purview/dlp-sensitivity-label-as-condition#supported-items
[dlp-label-types]: https://learn.microsoft.com/en-us/purview/dlp-sensitivity-label-as-condition#supported-file-types
[dlp-label-tips]: https://learn.microsoft.com/en-us/purview/dlp-sensitivity-label-as-condition#support-policy-tips
[dlp-ref-actions]: https://learn.microsoft.com/en-us/purview/dlp-policy-reference#actions
[dlp-ref-spo]: https://learn.microsoft.com/en-us/purview/dlp-policy-reference#supported-actions-sharepoint
[dlp-ref-devices]: https://learn.microsoft.com/en-us/purview/dlp-policy-reference#supported-actions-devices
[dlp-ref-cond-spo]: https://learn.microsoft.com/en-us/purview/dlp-policy-reference#conditions-sharepoint-supports
[dlp-ref-cond-endpoint]: https://learn.microsoft.com/en-us/purview/dlp-policy-reference#conditions-supported-for-endpoints
[dlp-ref-adaptive]: https://learn.microsoft.com/en-us/purview/dlp-policy-reference#adaptive-protection-in-microsoft-purview
[dlp-fci]: https://learn.microsoft.com/en-us/purview/dlp-protect-documents-that-have-fci-or-other-properties#before-you-create-the-dlp-policy
[ss-dke]: https://documentation.stormshield.eu/SEP/en/Content/Administration_Guide/dke_getting_started.htm
[ss-opa]: https://documentation.stormshield.eu/SEP/en/Content/Administration_Guide/define_opa_policy.htm
[ss-ztdf]: https://documentation.stormshield.eu/SEP/en/Content/SDK_doc/ztdf.html
[virtru-va]: https://www.virtru.com/case-studies/virtru-and-virginia-building-a-whole-of-state-security-posture
