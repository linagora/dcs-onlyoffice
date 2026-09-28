# A document's sensitivity label follows its document label, written before signing

Each document the portal stores gets the sensitivity label that the label mapping pairs with its document label, leaving out informative categories: a DIFFUSION RESTREINTE document that holds SPECIAL FRANCE portions stays shareable with the allies it is written for, as the document label rule intends. At each save, the policy service writes that label as the `MSIP_Label_*` custom document properties, which Office always reads, before it signs the binding, so that the ADatP-4778.2 signature covers them. It writes no Sensitivity Label Information part (`docMetadata/LabelInfo.xml`).

## Considered Options

- **The most restrictive portion label**: a document with a SPECIAL FRANCE portion would carry the SPECIAL FRANCE sensitivity label, and the tenant's rules would keep it from the allies who may read everything else in it.
- **The Sensitivity Label Information part as well**: Office reads it only in tenants that enable co-authoring of encrypted files, ONLYOFFICE drops it at every save, and the binding signature does not cover it, so a part written after signing could change the label Word shows without breaking the signature.

## Consequences

- A stored file that holds a Sensitivity Label Information part was changed outside the platform, and the portal reports it.
- A document without a document label gets no sensitivity label.
- Properties that someone deletes in the editor come back at the next save.
