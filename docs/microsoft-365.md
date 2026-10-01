# Interoperability with Microsoft 365

The platform and Microsoft 365 exchange the classification of a Word document or an Excel workbook, both ways, through Microsoft Purview sensitivity labels. A label mapping pairs each label of the security policy with a sensitivity label of one Microsoft 365 tenant: a document the platform stores carries the matching sensitivity label, which Office shows, and a file labelled in Office gets the matching base label when it is uploaded to the portal.

What Office shows and reads stops at the document. The protected portions stay encrypted inside the file, and only the platform opens them, for the people whose clearance allows their labels: a reader in Word or Excel sees their placeholders, never their text.

## What crosses over

- **From the platform to Office.** At each save it stores, and at each upload, the policy service writes into the file the sensitivity label that the label mapping pairs with the document label, as the seven `MSIP_Label_*` custom document properties that Office reads ([ADR 0005](adr/0005-a-document-sensitivity-label-follows-its-document-label.md)). A document downloaded from the portal, then opened from OneDrive, SharePoint or a local folder, shows that label in Office's **Sensitivity** control, and Microsoft 365 treats it as a file that carries the label.
- **From Office to the platform.** A file labelled in Office, uploaded to the portal with **The label the file carries**, gets as its base label the label that the mapping pairs with its sensitivity label. The person uploading it may still raise it, and lower it only as an administrator whose clearance allows it.
- **Back and forth.** A document the platform stored keeps its label through Word for Mac: when it saves a change, Word keeps the platform's Custom XML parts, the binding and the base label part among them, and the label's custom properties. Uploaded again, the document keeps its base label. Word rewrites the other parts, among them those that the binding signature covers: the platform records in the journal that the signature no longer matches, and signs the file afresh.

## What stays in the platform: the protected portions

A protected portion is a paragraph, or cells, whose label may be more restrictive than the document's. The labelling panel encrypts its text with OpenTDF before it reaches ONLYOFFICE, into an envelope that the file keeps in a Custom XML part. In the document's body, a locked placeholder takes its place, which shows only the portion's marking. The end-to-end tests check that the Document Server never sees a portion's text, in the co-editing exchanges or in the saved file, and the CI searches the Document Server's working files for it.

In Word or Excel, the reader of such a file sees the document's sensitivity label, its content in clear, the page marking the platform wrote, and the placeholder of each portion, never the portion's text. No Office application opens the envelope, and OpenTDF gives its key only through the platform, to someone whose clearance allows the portion's label. The same holds for anyone who gets the file by other means.

Each placeholder links to its portion's page on the portal: the text of a text document's placeholder, and the cells of a workbook's. A reader in Word or Excel who follows the link signs in to the platform if needed, and the page shows the portion's text, decrypted in the reader's browser, to someone who may open the document and whose clearance allows the portion's label, and "Access denied" to anyone else. Nothing is installed on the Microsoft side, and the file still holds no portion's text. The page shows the portion as the platform stores it now, which the copy at hand may no longer match.

For instance, a DIFFUSION RESTREINTE document that holds one paragraph labelled DIFFUSION RESTREINTE – SPÉCIAL FRANCE:

| | In the platform, cleared for SPÉCIAL FRANCE | In the platform, cleared for DIFFUSION RESTREINTE only | In Word or Excel |
| --- | --- | --- | --- |
| Label shown | DIFFUSION RESTREINTE – CONTIENT DES PORTIONS PLUS RESTRICTIVES, the document label | The same | DIFFUSION RESTREINTE, the sensitivity label |
| Content in clear | Read | Read | Read |
| The SPÉCIAL FRANCE paragraph | Read in the labelling panel | Access denied | Its placeholder only: DIFFUSION RESTREINTE – SPÉCIAL FRANCE – protected portion, whose link opens the portion's page, with the platform's answer |

The sensitivity label follows the document label without its informative category: Office shows DIFFUSION RESTREINTE, the classification of the content it can read, while the more restrictive paragraph stays encrypted. The file of this example that the platform stored for the tests with a Microsoft 365 tenant holds the paragraph's text encrypted in its envelope, and in clear in none of its parts.

## Conditions

### In the Microsoft 365 tenant

- **Sensitivity labels without encryption.** The platform decrypts nothing: at upload, it refuses a file that a label with encryption protected, as it refuses a file protected by a password. Labels with content marking were not tried; according to Microsoft's guidance, Office adds no header, footer or watermark for a label set outside Office.
- **The labels published** to the people who open the documents in Office, in a label policy.
- **The labels turned on for SharePoint and OneDrive**, for Office for the web. In the test, the labels took about two and a half hours to show there after their publication.
- **Office licences** that include sensitivity labels, such as Microsoft 365 E3, E5 or Business Premium, and a subscription edition of the Office apps.
- **Co-authoring of files with sensitivity labels** was off during the tests, as it is by default. A tenant that turns it on, which the Purview portal cannot undo, has Office write the labels of unencrypted files in a Sensitivity Label Information part. The platform reads that part first at upload and never keeps it, and it logs a stored file that holds one. Office should still read the custom properties the platform writes, for a tenant without an element in such a part, as [MS-OFFCRYPTO] §2.6.3 says; this was not tried.

### In the platform

- **A label mapping** for the tenant: a JSON file that names the tenant's id and, for each label of the security policy without informative categories, the id and unique name of its sensitivity label.

  ```json
  {
    "tenant": "<tenant id>",
    "labels": {
      "DEMO-FR:2": { "id": "<sensitivity label id>", "name": "<its unique name>" },
      "DEMO-FR:2/1.1": { "id": "<sensitivity label id>", "name": "<its unique name>" }
    }
  }
  ```

  The tenant id is the Microsoft Entra tenant id. The labels' ids and unique names come from the Purview portal, from Microsoft Graph (`GET /security/dataSecurityAndGovernance/sensitivityLabels`, delegated permission `SensitivityLabel.Read`) or from `Get-Label`. [`deploy/spif/demo-fr.label-mapping.json`](../deploy/spif/demo-fr.label-mapping.json) is the example of the demo policy, for a fictional tenant.
- **One sensitivity label per label, and one label per sensitivity label.** A label without an entry gets no sensitivity label. At upload, a sensitivity label that the mapping does not know counts as none, and so do a label of another tenant, several labels of the tenant, and one that the mapping pairs with several labels: the person uploading the file then chooses its base label.
- **The setting.** Keep the mapping of a real tenant in `deploy/spif`, under a name that starts with `local-`, which Git ignores, and set `LABEL_MAPPING_FILE`, for instance to `/spif/local-label-mapping.json`. Then restart the policy service: it reads the mapping when it starts, and does not start on one that names a label its security policy lacks. The [hosting guide](hosting.md#configuration) describes the setting.
- **The upload.** To keep the label that Office set, choose **The label the file carries** when uploading the file.
- **The portion pages.** A placeholder's link works from a machine that reaches the portal's public address, for a person who has an account on the platform. A portion written before placeholders linked to their pages gets its link at its next change in the panel.

## Trying it

The standalone stack's label mapping names a fictional tenant, which Office does not know: the documents it stores carry sensitivity labels that Office shows as none. To see the import, upload one of the files under [`deploy/demo/uploads`](../deploy/demo/uploads), which that fictional tenant labelled, with **The label the file carries**, as the [walkthrough](walkthrough.md)'s step 10 does. To see both ways with Office, set the label mapping of your own tenant, as above, then open in Word a document the platform stored, and upload a document you labelled in Word.

## What was checked

A Microsoft 365 Business Premium tenant held four sensitivity labels without encryption or content marking, one per label of the demo policy, with co-authoring of labelled files off. The [research notes](research/microsoft-purview-labels.md), sections 8.1 and 8.2, give the details.

| | Word for the web | Excel for the web | Word for Mac |
| --- | --- | --- | --- |
| Shows the label of a file the platform stored | Yes, for the four labels | Yes | Yes, for the one label tried |
| A file it labelled gets the matching base label at upload | Yes, for the four labels | Not tried with the tenant | Yes |
| Keeps the platform's parts and label when it saves a change | The label, yes; the parts, not tried | Not tried | Yes |

Word for Mac was not shown the other three labels. It would show them the same way: the platform writes the same seven properties for every label, which Word for the web showed for the four, and Word for Mac listed the four labels of the policy. Excel for Mac and the Windows applications were not tried. The end-to-end tests check the same export and import, for documents and workbooks, with files that a fictional tenant labelled.

## Limits

- The sensitivity label is metadata: it encrypts nothing. Outside the platform, the content in clear of a document is readable by whoever has the file. The tenant's rules apply to it in Microsoft 365; the platform's clearances and OpenTDF apply in the platform only.
- Office sees one label per document. The platform's finer labels, those of the protected portions and the document label's informative category, stay in the platform.
- The binding signature, which shows that the platform computed the document label, does not survive a change made in Office: the platform detects it, logs it, and signs the file afresh at upload.
- Whether a document's protected portions survive a change made in Office was not tried.
- Whether Word and Excel follow a link inside a locked placeholder, in Protected View too, and what Safe Links makes of it, was not tried.
- A label mapping covers one tenant.

[SECURITY.md](../SECURITY.md) lists these properties with the platform's others.
