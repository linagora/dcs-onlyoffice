# DCS ONLYOFFICE

Portion-level confidentiality labelling and encryption for documents edited in ONLYOFFICE Docs, following NATO STANAG 4774 and 4778, with every rule read from a security policy.

## Language

### Policy and labels

**Security policy**:
The machine-readable rules of one organisation: classifications, categories, markings and access rules, read from an Open XML SPIF file.
_Avoid_: SPIF (for the concept), policy file

**Label**:
An ADatP-4774 confidentiality label: one security policy, one classification and a set of categories.
_Avoid_: tag, classification (for the whole label)

**Classification**:
The hierarchical level of a label, such as DIFFUSION RESTREINTE.
_Avoid_: level, grade

**Category**:
A value of a label beside its classification: restrictive (every one must be held to read, such as SPECIAL FRANCE), permissive (holding one is enough, such as Releasable To NATO) or informative (no access rule reads it).
_Avoid_: caveat, mention

**Marking**:
The human-readable rendering of a label, in the language the security policy provides.
_Avoid_: label text, banner

### Documents

**Protected portion**:
A part of a document whose text is typed in the labelling panel, never in the document body, and which carries its own label; the body only shows a locked placeholder.
_Avoid_: secret paragraph, encrypted block

**Portion label**:
The label of one protected portion. The file holds it in clear, for everyone and for other labelling tools, and bound in the portion's envelope.

**Bound label**:
The portion label as the envelope carries it, bound to the envelope. For a reader who can open the envelope, it prevails over the label in clear, which anyone able to edit the file could change.
_Avoid_: assertion label, inner label

**Base label**:
The label an author gives to the document's unprotected content.

**Document label**:
The label of the whole document, computed from its base label and its portion labels, and bound to the file as ADatP-4778.2 prescribes.
_Avoid_: global label, rollup

**Envelope**:
The encrypted form of a protected portion's text: a ZTDF object that also carries the portion label, bound to it.
_Avoid_: ciphertext, blob, TDF (for the concept)

**Unencrypted portion**:
A protected portion created before encryption existed, whose text sits in clear in the file; it can still be read, but no longer created.
_Avoid_: legacy portion, clear portion

### People and access

**Clearance**:
What one person may read under one security policy: the highest classification, the categories held and a validity period.
_Avoid_: habilitation (in English text), entitlement, permissions

**Clearance directory**:
The record of every person's clearances, kept apart from the identity provider.
_Avoid_: attribute store, référentiel (in English text)

**Access decision**:
Whether a clearance lets its holder read a label, by the rules of the label's security policy.
_Avoid_: authorization, entitlement check
