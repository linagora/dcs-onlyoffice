# NATO confidentiality labelling standards: ADatP-4774, ADatP-4778 / 4778.2 (OOXML) and Open XML SPIF

Research notes compiled on 2026-09-26 from primary sources: the standards themselves, the Open XML SPIF
schemas, ECMA-376, and the source code of three open source reference implementations. Every claim cites
a URL; for PDFs the printed page label (for example `p. 5-3`) and the section are given.

Conventions used below:

- **Mandated**: normative text of a standard (SHALL / MUST / REQUIRED) or a constraint of its XML schema.
- **Guidance**: informative Standards Related Documents. ADatP-4774.1 and ADatP-4778.1 state that their
  guidance "is optional" ([ADatP-4774.1][4774.1] §2.1 p. 2-1; [ADatP-4778.1][4778.1] §2.1 p. 2-3).
- **Implementation**: what the open source code does, which is not necessarily what the standard says.
- **UNVERIFIED**: could not be confirmed from a primary source.
- **Tested**: checked with `xmllint` (libxml2 2.9.13) against the schemas, or by running spiffing-java. The
  method is described in the [appendix](#appendix-a-how-the-examples-were-validated).

## Key findings

1. **Label**: namespace `urn:nato:stanag:4774:confidentialitymetadatalabel:1:0`, XSD `version="1.3"`, printed
   in ADatP-4774 Appendix 1 Annex A. Standard root elements: `originatorConfidentialityLabel`,
   `alternativeConfidentialityLabel`, `metadataConfidentialityLabel` (`ConfidentialityLabel` is kept "for
   backwards compatibility only"). The schema requires `PolicyIdentifier`, `Classification` and
   `CreationDateTime`, plus `Type` and `TagName` on every `Category`. The prose also requires
   `ReviewDateTime` whenever there is no `SuccessionHandling`, forbids `Classification/@URI`, and forbids
   `IntegerValue` and `BitStringValue`.
2. **Binding**: namespace `urn:nato:stanag:4778:bindinginformation:1:0`, XSD `version="1.4"`. The structure is
   `BindingInformation` → `ds:Signature`* (first) → `MetadataBindingContainer`+ → `MetadataBinding`+ →
   (`Metadata` | `MetadataReference`)+ then (`Data` | `DataReference`)+. **The signature is optional** in
   ADatP-4778.
3. **OOXML profile** (`urn:nato:stanag:4778:profile:ooxml:1:2`, ADatP-4778.2 chapter 5). The package keeps a
   *single* custom XML part whose root is `mb:BindingInformation`. `DataReference` elements use `pack:///…`
   URIs (empty authority) and `Data` is forbidden. A whole-document binding SHALL reference every present
   part listed in Tables 5-2 and 5-3. Cryptography is required only "for the use cases that cryptographic
   bindings are required", so **an unsigned binding is conformant**. The profile does **not** name the
   relationship type, content type or item-properties part: those come from ECMA-376.
4. **Part-level labelling**: the OOXML profile only anticipates bindings "to elements within a package part
   (e.g. binding metadata to paragraphs within a document)" as future work. Paragraph-level addressing
   inside `document.xml` is **not standardized**. The base standards do provide granularity rules, top-down
   labelling guidance and dominant-label rules.
5. **SPIF**: namespace `http://www.xmlspif.org/spif`. The NATO documents use **schema 2.1**. The canonical URL
   `http://www.xmlspif.org/schema/xmlspif.xsd` now serves **schema 3.0** (document version 3.07, 2026),
   which changes the marking model and which spiffing-java cannot load.
6. **Mapping** (ADatP-4774.1 Table 10; spiffing and spiffing-java follow it; sparrow also uses names, but
   neither the `Type` mapping nor the `URI`):
   - `PolicyIdentifier` = `securityPolicyId/@name`, with `URI="urn:oid:"+@id`;
   - `Classification` = `securityClassification/@name`;
   - `TagName` = `securityCategoryTagSet/@name`;
   - `Type` from `tagType`: `restrictive` and `enumerated`+`restrictive` → RESTRICTIVE; `permissive` and
     `enumerated`+`permissive` → PERMISSIVE; `tagType7` → INFORMATIVE;
   - `GenericValue` = `tagCategory/@name` (**not** the `lacv`, which is only for binary labels).
7. **Implementations**:
   - spiffing (C++) and spiffing-java emit namespace-correct "NATO XML" labels, but without
     `CreationDateTime`, so their output is **not XSD-valid** (tested for spiffing-java).
   - sparrow emits labels whose elements are in **no namespace**, with lowercase or raw SPIF `Type` values.
   - The published examples in the standards contain many schema errors (see [section 9](#9-pitfalls-and-errata-found-in-the-published-examples)).

---

## 1. Sources

| Short name | Document | Where obtained | Notes |
|---|---|---|---|
| ADatP-4774 | *Confidentiality Metadata Label Syntax*, Ed. A V1, 20 Dec 2017 | [PDF mirror][4774]; byte-identical copy in the [sparrow repo][4774-gh]; cover page [NISP][nisp4774] | States it "is authorized for public disclosure" (p. 1-1), but the letter of promulgation §3 forbids reproduction without permission, except for member and partner nations and NATO bodies. |
| ADatP-4774.1 | *Implementation Guidance*, Ed. A V1, Nov 2021 (cover date) | [PDF mirror][4774.1]; byte-identical copy in the [sparrow repo][4774.1-gh] | Guidance: SPIF, mapping, dominant label. |
| ADatP-4778 | *Metadata Binding Mechanism*, Ed. A V1, 26 Oct 2018 | [PDF mirror][4778]; cover page [NISP][nisp4778] | Same public-disclosure statement (p. 1-1) and reproduction clause (letter §3). |
| ADatP-4778.1 | *Metadata Binding Mechanism – Implementation Guidance*, Ed. A V1, Nov 2021 (cover date) | [PDF mirror][4778.1] | Guidance: granular labelling, canonicalization. |
| ADatP-4778.2 | *Profiles for Binding Metadata to a Data Object*, Ed. A V1, Dec 2020 | [NISP storage][4778.2]; [NISP page][nisp47782] | Contains the OOXML profile (chapter 5). |
| TN-1491 Ed. 2 | Predecessor of ADatP-4778.2 (2017) | [NISP storage][tn1491] | Same OOXML text, with profile version `1:1`. |
| SPIF 2.1 | Open XML SPIF schema v2.1 | [xmlspif.org 2017/12][spif21]; also at [2026/08][spif21b] (identical); reproduced in ADatP-4774.1 Annex A | The version the NATO documents use. |
| SPIF 3.0 | Open XML SPIF schema v3.0 (`version="3.07"`) | [xmlspif.org/schema/xmlspif.xsd][spif30]; [ACME 3.0 example][spif30acme] | Current version according to the [xmlspif.org schema page][xmlspifschema]. |
| ECMA-376 | Office Open XML, 5th ed.: Part 1 (2016), Part 2 OPC (2021), Part 4 Transitional (2016) | [Ecma download page][ecma376] | Source of the custom XML part plumbing. |
| spiffing | C++ library, MIT, commit `170af8c` (2024-01-02) | [github.com/surevine/spiffing][spiffing] | |
| spiffing-java | Java 17 port, MIT, commit `38a916b` (2026-09-09) | [github.com/dwd/spiffing-java][spiffing-java] | |
| sparrow | Go web service, Apache-2.0, commit `e4959b8` (2026-02-08) | [github.com/FireFlans/sparrow][sparrow] | |

Provenance and access notes:

- The official NATO Standardization Office site (`nso.nato.int`), linked from the NISP pages, returned
  HTTP 403 during this research. The copies of ADatP-4774, 4774.1, 4778 and 4778.1 come from a third-party
  mirror. The 4774 and 4774.1 files are byte-identical to the copies in the sparrow repository. Their
  authenticity against the NSO originals is **UNVERIFIED**. SHA-256 checksums are in
  [appendix B](#appendix-b-sha-256-of-the-documents-used).
- The NATO Metadata Registry and Repository (NMRR), where the official XSDs, the NATO SPIF, the
  normalization XSLT and the SPIF-derived stylesheets are held ([ADatP-4774.1][4774.1] §3.8 p. 3-12 and
  §3.11), is described as "account required" and was **unreachable**.
- No evidence was found of an edition newer than Ed. A of ADatP-4774 or ADatP-4778. The NISP pages were
  last updated on 12 Apr 2024 and list Ed. A ([NISP 4774][nisp4774], [NISP 4778][nisp4778]); anything
  newer is **UNVERIFIED**.
- The Federated Mission Networking Spiral 5 "Metadata Labelling Profile" lists ADatP-4774, ADatP-4778 and
  ADatP-4778.2 as mandatory, and adds that "the labelling values shall be based on the security policy
  defined for the mission" ([NISP][nispfmn]).

---

## 2. ADatP-4774 confidentiality label (question 1)

### 2.1 Namespaces and versions

- **Label namespace**: `urn:nato:stanag:4774:confidentialitymetadatalabel:1:0`. The XSD declares
  `version="1.3"` and `elementFormDefault="qualified"`, `attributeFormDefault="unqualified"`
  ([ADatP-4774][4774] App. 1 Annex A, p. App 1-A1). All elements are therefore namespace-qualified and all
  attributes (`Type`, `TagName`, `URI`, `Id`, `ReviewDateTime`, `IDType`) are unqualified.
- **Clearance namespace**: `urn:nato:stanag:4774:confidentialityclearance:1:0` (XSD `version="1.2"`), used for
  `ConfidentialityClearance` ([ADatP-4774][4774] App. 2 Annex A, p. App 2-A1). It is not needed for labelling.
- The syntax "is based upon the label description from IETF RFC 2634" ([ADatP-4774][4774] §4.4 p. 4-3).
- ADatP-4778.2 Figure 12-6 also shows an extension namespace
  `urn:nato:stanag:4774:confidentialitymetadatalabel:1:0:ext` carrying a `slab-ext:Marking` element inside
  `ConfidentialityInformation` ([ADatP-4778.2][4778.2] p. 12-12). It is not defined in any public document
  (**UNVERIFIED**). It is legal because `ConfidentialityInformationType` allows `##other` elements.

### 2.2 Element structure (from the XSD)

```text
slab:originatorConfidentialityLabel | slab:alternativeConfidentialityLabel | slab:metadataConfidentialityLabel
   (type ConfidentialityLabelType; slab:ConfidentialityLabel = same type, "for backwards compatibility only")
  @Id               xs:ID         optional
  @ReviewDateTime   xs:dateTime   optional in the XSD, but see 2.3
  @*                any attribute (lax)
  slab:ConfidentialityInformation                      1
    slab:PolicyIdentifier   xs:token, min length 1       1    @URI optional
    slab:Classification     xs:token, min length 1       1    @URI (prohibited by the prose)
    slab:PrivacyMark        xs:string                    0..1
    slab:Category                                        0..n @Type (RESTRICTIVE|PERMISSIVE|INFORMATIVE) required
                                                              @TagName (xs:string) required, @URI optional
      slab:GenericValue     xs:string                    0..n (substitution group of abstract CategoryValue;
                                                              IntegerValue / BitStringValue also exist)
    (any ##other element)                                0..n
  slab:OriginatorID   @IDType required                   0..1
  slab:CreationDateTime   xs:dateTime                    1
  slab:SuccessionHandling                                0..1
    slab:SuccessionDateTime   xs:dateTime                1
    slab:SuccessorConfidentialityLabel  (ConfidentialityLabelBaseType)  1
  (any ##other element)                                  0..n
```

Sources: [ADatP-4774][4774] App. 1 pp. App 1-1 to App 1-11 (prose and tables) and pp. App 1-A2 to App 1-A8
(XSD). `IDType` values: `rfc822Name`, `dNSName`, `directoryName`, `uniformResourceIdentifier`, `iPAddress`,
`x400Address`, `userPrincipalName`, `jID` (Table 9, p. App 1-9 to App 1-10).

Semantics of the three standard roots ([ADatP-4774][4774] p. App 1-1):

- `originatorConfidentialityLabel`: the label the originator associated with the data object.
- `alternativeConfidentialityLabel`: an equivalent label in another policy.
- `metadataConfidentialityLabel`: the label of the metadata set itself.

ADatP-4774.1 recommends that "the originator confidentiality label must never be overwritten" when an
equivalence mapping is applied. The equivalent label is recorded as an alternative label, and a consumer
uses the originator label if its own policy matches, otherwise the matching alternative
([ADatP-4774.1][4774.1] §4.2 Rules 1 to 5, p. 4-3).

### 2.3 What is mandatory

| Item | XSD | Prose (mandated) |
|---|---|---|
| `ConfidentialityInformation`, `PolicyIdentifier`, `Classification` | required | same (p. App 1-3, App 1-4) |
| `CreationDateTime` | required | same (p. App 1-3; also required for the NATO policy, p. 5-2) |
| `Category/@Type`, `Category/@TagName` | required | same (Table 8, p. App 1-8) |
| `ReviewDateTime` | optional | "SHALL be present when no SuccessionHandling element is present" (p. App 1-2; also §4.3 p. 4-3 and p. 5-2). A past date does not invalidate the label (p. App 1-2). |
| `PolicyIdentifier/@URI` | optional | if present it "SHALL use the urn scheme with an oid namespace identifier", for example `urn:oid:1.3.26.1.3.1` (Table 5, p. App 1-5 to App 1-6) |
| `Classification/@URI` | allowed | "The optional URI attribute SHALL NOT be used" (Table 6, p. App 1-6) |
| `Category/@URI` | optional | `urn:oid:` of the category tag set (Table 8, p. App 1-8) |
| Category values | `GenericValue`, `IntegerValue`, `BitStringValue` | "The GenericValue element SHALL be used"; the other two "SHALL NOT be used" (p. App 1-9) |
| Case | case-sensitive XSD enumerations | for the NATO and PUBLIC policies, "All values within the ConfidentialityInformation element are treated as case insensitive during processing" (p. 5-2, p. App 2-C2) |
| `OriginatorID` | optional | "SHOULD contain information about the originator of the confidentiality metadata label" (p. App 1-3) |

Tested (cases in [appendix A](#appendix-a-how-the-examples-were-validated)):

- a label without `CreationDateTime` fails XSD validation;
- `Type="permissive"` (lowercase) fails XSD validation;
- `IntegerValue` passes the XSD even though the prose forbids it.

Other points:

- The text says `CategoryType` "contains one optional CategoryValue element" (p. App 1-7), but the XSD allows
  `0..unbounded`. All examples group several `GenericValue` elements under one `Category` per tag name (pp.
  App 1-B1, App 2-5 to App 2-9).
- Metadata using this syntax "SHALL be appropriately bound to the information to which it relates"
  (p. App 1-1), that is, through ADatP-4778.
- Labels may be bound to portions: "Confidentiality Metadata Labels may be bound to portions of the
  information, including paragraphs, sections, figures and tables" (§4.2 p. 4-2).

### 2.4 NATO policy specifics (for orientation only)

For the NATO policy ([ADatP-4774][4774] App. 2):

- `PolicyIdentifier` is `NATO`, URI `urn:oid:1.3.26.1.3.1` (p. App 2-1).
- Category tag names are `Context` (PERMISSIVE, `urn:oid:1.3.26.1.4.4`, and "MUST be present"), `Only`
  (PERMISSIVE), `Releasable To` (PERMISSIVE), `Additional Sensitivity` (RESTRICTIVE) and `Administrative`
  (INFORMATIVE) (pp. App 2-2 to App 2-8).
- A marking for TOP SECRET shows `COSMIC` instead of `NATO` (p. App 2-1).

### 2.5 Complete example label (national-style policy; fictitious)

The example uses the fictitious policy `EXAMPLE` defined by the SPIF in [section 5.7](#57-complete-example-spif-tested).
The OID is under the `2.25` UUID arc, so it cannot collide with a real policy. It carries a classification,
a restrictive category and a permissive release category. **Tested**: valid against the ADatP-4774 XSD, and
valid against the SPIF in spiffing-java.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<slab:originatorConfidentialityLabel
    xmlns:slab="urn:nato:stanag:4774:confidentialitymetadatalabel:1:0"
    ReviewDateTime="2031-09-26T00:00:00Z">
  <slab:ConfidentialityInformation>
    <slab:PolicyIdentifier
        URI="urn:oid:2.25.283505922519774543341581604402970826256">EXAMPLE</slab:PolicyIdentifier>
    <slab:Classification>RESTRICTED</slab:Classification>
    <slab:Category Type="RESTRICTIVE" TagName="Special Handling"
        URI="urn:oid:2.25.283505922519774543341581604402970826256.1">
      <slab:GenericValue>ALPHA</slab:GenericValue>
    </slab:Category>
    <slab:Category Type="PERMISSIVE" TagName="Releasable To"
        URI="urn:oid:2.25.283505922519774543341581604402970826256.2">
      <slab:GenericValue>XAA</slab:GenericValue>
      <slab:GenericValue>XBB</slab:GenericValue>
    </slab:Category>
  </slab:ConfidentialityInformation>
  <slab:OriginatorID IDType="rfc822Name">author@example.org</slab:OriginatorID>
  <slab:CreationDateTime>2026-09-26T12:00:00Z</slab:CreationDateTime>
</slab:originatorConfidentialityLabel>
```

`XAA` and `XBB` are taken from the ISO 3166-1 alpha-3 user-assigned range, so they cannot be confused with
real countries. For a label that should also be understood under another policy, add an
`alternativeConfidentialityLabel` in a **separate** `mb:Metadata` element of the binding (see
[section 3](#3-adatp-4778-binding-mechanism-question-2)).

### 2.6 Is an official XSD publicly available?

- The complete XSD text is printed in the publicly disclosed ADatP-4774 (App. 1 Annex A, pp. App 1-A1 to
  App 1-A8). The document says the schema "is registered in the NATO Metadata Registry and Repository (NMRR)
  and also the U.S. Metadata Repository (US MDR)" (p. App 1-A1). No publicly downloadable `.xsd` file from
  a NATO host was found.
- The NMRR requires an account ([ADatP-4774.1][4774.1] §3.8 p. 3-12) and was unreachable.
- ADatP-4778 §4.8 prints the binding XSD (pp. 4-20 to 4-23). **Its `xs:appinfo` example is not well-formed
  XML** (curly quotes, and `<slab:PolicyIdentifier>` closed by `</PolicyIdentifier>`), so it has to be
  repaired before use (tested).
- Redistributing the XSD text in an AGPL repository is a licensing question: see [section 10](#10-open-questions).

---

## 3. ADatP-4778 binding mechanism (question 2)

### 3.1 Namespace and schema

- Namespace `urn:nato:stanag:4778:bindinginformation:1:0`. XSD `version="1.4"`, `elementFormDefault="qualified"`,
  `attributeFormDefault="unqualified"`. It imports XML Signature (`ds`) and `xmime`
  (`http://www.w3.org/2005/05/xmlmime`) ([ADatP-4778][4778] Table 1 p. 4-2; §4.8 pp. 4-20 to 4-23).
- "the standard name BindingInformation … SHALL be used as the parent element that holds the Metadata
  Binding and the Cryptographic Artefact (if present)", qualified with that namespace (§4.5.1 p. 4-15).

### 3.2 Structure

```text
mb:BindingInformation                              root of every binding data object (BDO); @* lax
  ds:Signature                                   0..n  XML Signature; comes BEFORE the container
  mb:MetadataBindingContainer                    1..n  @Id (xs:ID) optional
    mb:MetadataBinding                           1..n  @Id (xs:ID) optional
      (mb:Metadata | mb:MetadataReference)       1..n  first group
      (mb:Data     | mb:DataReference)           1..n  second group
    (any ##other)                                0..n
  (any ##other)                                  0..n

mb:Metadata, mb:Data     mixed content, exactly ONE child element (xs:any ##any, lax),
                         @xmime:contentType (default "text/xml; charset=utf-8"), @encoding
mb:MetadataReference,    @URI (xs:anyURI) REQUIRED, @xmime:contentType, @encoding,
mb:DataReference         child ds:Transforms 0..1 (exactly one XPath 1.0 Transform)
```

Sources: [ADatP-4778][4778] §4.3.2 to §4.3.7 pp. 4-2 to 4-14; §4.5 pp. 4-14 to 4-16; XSD pp. 4-21 to 4-23.

- `MetadataBindingContainer` "SHALL be present" (p. 4-2).
- A `MetadataBinding` "SHALL contain at least one or more Metadata components" and "at least one Data Object
  component". "All of the Metadata … is bound to all of the Data Objects" in that binding (p. 4-3).
- "it is RECOMMENDED that Metadata is embedded within a BDO and not referenced" (§4.6 p. 4-17).
- A `DataReference` may carry a `ds:Transforms` with an XPath selecting a subset of an XML data object. It
  must hold exactly one `Transform` with algorithm `http://www.w3.org/TR/1999/REC-xpath-19991116`, and using
  `local-name()` and `namespace-uri()` is RECOMMENDED (§4.3.5 pp. 4-9 to 4-10; §4.3.7 p. 4-14).
- `URI=""` dereferences to the root node. The meaning of a `#fragment` depends on the media type in
  `xmime:contentType` (§4.7 pp. 4-18 to 4-19).
- **Tested**:
  - two label elements inside one `mb:Metadata` **fail** XSD validation, so use one `mb:Metadata` per label;
  - `Id="#id-…"` fails (not an `xs:ID`);
  - the qualified `mb:Id` / `mb:URI` used in ADatP-4778.2 examples are not the schema's `Id` / `URI`.

### 3.3 Binding approaches and granularity

- **Approaches** ([ADatP-4778][4778] §3.2 pp. 3-2 to 3-5; §4.6 pp. 4-17 to 4-18):
  - encapsulating: the data object is inside `mb:Data`, and `BindingInformation` is the document root;
  - embedded: the BDO sits inside the XML data object;
  - detached: the BDO is external and points with `DataReference`.

  Choosing the approach and the location of the BDO is the job of binding profiles, whose normative text
  is kept outside the STANAG (§3.6 pp. 3-11 to 3-12).
- **Granularity rules** (§3.5 pp. 3-8 to 3-10):
  - children inherit the parent's metadata unless they have metadata "of the same type";
  - parents do not inherit from children;
  - metadata of a different type is retained;
  - metadata of the same type supersedes.

  Footnote 4 gives `originatorConfidentialityLabel` and `alternativeConfidentialityLabel` as different types.
  Figure 13 (p. 3-11) shows a single BDO with several `MetadataBinding` elements whose `DataReference`
  URIs point at `#chap2`, `#chap3`, and so on.

### 3.4 Signature: optional; what is signed

- **ADatP-4778 itself**: `ds:Signature` is **Optional**, with "zero or more" allowed, and "represents the
  digital signature of the Metadata Binding" (Table 9, p. 4-16). Cryptographic protection is for policies
  that need integrity of the metadata, the data object "and hence the Binding" (§3.1 p. 3-1).
- **ADatP-4778.2 chapter 2** profiles XML Signature (Annexes A, B, C) and CMS (Annex E, used for SMTP). It
  does "not mandate cryptographic techniques or mechanisms" (§2.1 p. 2-1).

Annex A of [ADatP-4778.2][4778.2]:

- **When a signature is present**:
  - "In the case where a cryptographic binding is required the bindingInformation element … MUST contain
    at least one Signature element" (p. A-5).
  - Originators perform XMLDSIG Core Generation and recipients Core Validation (p. A-2).
  - Enveloping, enveloped and detached signatures are all allowed (p. A-2).
- **What must be referenced** (pp. A-6 to A-7):
  - one `Reference` per `DataReference` / `MetadataReference`, with the same `URI` (the data objects);
  - one `Reference` per `MetadataBinding`, whose `URI` is a shorthand XPointer (`#Id`). This signs the
    embedded label together with the list of references;
  - when a `Manifest` is used, a `Reference` to the `Manifest`.

  It is RECOMMENDED to also reference the timestamp `SignatureProperties` (p. A-10). The Annex D examples
  also reference `KeyInfo` (pp. D-1 to D-3).
- **Manifest**: for `DataReference` URI schemes that XMLDSIG libraries may not dereference (such as `pack:`),
  and for non-XML same-document references, the originator MUST put `Reference` elements into a
  `ds:Manifest` inside a `ds:Object`, with the same URIs. The recipient re-digests each one (pp. A-3, A-5,
  A-9).
- **Enveloped-BDO transform**: for BDOs embedded in an XML data object, the XPath
  `not(ancestor-or-self::*[local-name()='BindingInformation' and namespace-uri()='urn:nato:stanag:4778:bindinginformation:1:0'])`
  is applied first (p. A-7). This does not apply when the BDO is in its own OOXML part.
- **Algorithms**:

| Item | Allowed / mandated | Source |
|---|---|---|
| `CanonicalizationMethod` | one of: C14N 1.0 (with or without comments), C14N 1.1 (with or without comments), Exclusive C14N (with or without comments), C14N 2.0. The Annex D examples use `http://www.w3.org/2001/10/xml-exc-c14n#` | p. A-6; pp. D-1 to D-8 |
| `DigestMethod` | SHA-384 **Mandatory**; SHA-256, SHA-512, RIPEMD-160 Optional; MD5, SHA-1, SHA-224 Prohibited | Table 2-3, p. A-8 |
| `SignatureMethod` (PKI) | RSA-SHA256 and ECDSA-SHA256 **Mandatory**; other SHA-2 variants Optional; SHA-1 and MD5 Prohibited | Table 2-4, p. B-1 |
| `SignatureMethod` (HMAC) | HMAC-SHA256 **Mandatory**; HMAC-SHA1 Prohibited | Table 2-5, p. C-1 |
| `KeyInfo` | REQUIRED. PKI: `X509Data` REQUIRED, `KeyName` SHALL NOT be present. HMAC: `KeyName` MAY be present, `X509Data` SHALL NOT | pp. A-9, B-1 to B-2, C-1 to C-2 |
| `Object` | REQUIRED | p. A-9 |
| Timestamp | "The TimeStamp element MUST be present", as the `Created` time, with reference to WS-Security §10 | p. A-10 |
| XML normalization | RECOMMENDED before signing and verifying: strip prefixes, sort attributes, `n0`/`n1` prefixes, and so on. An XSLT exists, but only in the NMRR | p. A-4; [ADatP-4778.1][4778.1] §5.4 pp. 5-5 to 5-6 |

---

## 4. ADatP-4778.2 OOXML binding profile (question 3)

### 4.1 Identification

- Canonical identifier `urn:nato:stanag:4778:profile:ooxml`; version identifier
  `urn:nato:stanag:4778:profile:ooxml:1:2`. It deprecates `…:ooxml:1:1` ([ADatP-4778.2][4778.2] Table 5-1,
  pp. 5-1 to 5-2). TN-1491 Ed. 2 carries the same text as version `1:1` ([TN-1491][tn1491] Annex D).
- Its references are ISO/IEC 29500-2:2012 (OPC), STANAG 4774 and STANAG 4778 (§5.3 p. 5-2).

### 4.2 What the profile mandates (full list; chapter 5 is short)

1. "a single CustomXML file SHALL be maintained within the OPC package with the Metadata Binding Container
   namespace, 'urn:nato:stanag:4778:bindinginformation:1:0'" (§5.6 p. 5-3). The example part is
   `/customXml/item1.xml` (p. 5-5), and its root element is `mb:BindingInformation` (Figure 5-2).
2. "DataReference elements SHALL be used to reference the files within the OPC package." "Data elements SHALL
   NOT be used." (p. 5-3) In ADatP-4778 terms this is a detached BDO stored inside the package; the profile
   does not name the approach.
3. DataReference URIs use the `pack` scheme. "The authority component … SHALL be empty that denotes the
   package root". "When referring to files, or portions of files, within the OPC package, absolute URIs from
   the package root SHALL be used", for example `pack:///word/document.xml` (p. 5-3).
4. When binding metadata to a **complete document**, all files of Table 5-2 that are present "SHALL be
   referenced", and the common document-properties parts of Table 5-3 "SHALL also be referenced".
   Additional parts "MAY be referenced" (pp. 5-3 to 5-5).
5. Cryptography: the Chapter 2 XML Signature profile (Annexes A, B, C) "SHALL be adhered to for the use cases
   that cryptographic bindings are required". Applying the Annex A "URI Schemes" (Manifest) requirements is
   RECOMMENDED (§5.7 pp. 5-5 to 5-6).
6. Annex A (general): `xmime:contentType` is required on a `DataReference` to non-XML data (p. A-3), for
   example `xmime:contentType="image/jpeg"` on the media reference in Figure 5-2.

The profile also warns that for Word, `/word/document.xml` does not contain headers or footers, which live
in `/word/header1.xml` and `/word/footer1.xml` (§5.5 p. 5-3).

Word parts of Table 5-2 (p. 5-4):

- `/word/document.xml`, `/word/styles.xml`;
- `/word/header<N>.xml`, `/word/footer<N>.xml`;
- `/word/media/*`;
- `/word/footnotes.xml`, `/word/endnotes.xml`;
- `/word/comments.xml`, `/word/commentsExtended.xml`.

Table 5-3 (p. 5-5): `/docProps/core.xml`, `/docProps/app.xml`, `/docProps/custom.xml`. Excel and PowerPoint
lists are in the same table.

### 4.3 What the profile does not specify: ECMA-376 plumbing

The profile gives no relationship type, content type or item-properties part. Figure 5-1 is a screenshot of
a `.docx` with `customXml/item1.xml`, `customXml/itemProps1.xml` and `customXml/_rels` (p. 5-2). Figure 8-1
(generic OPC profile, which "uses the same customXml files and relationships … as those defined in the OOXML
Binding Profile") shows the Transitional relationship type
`http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml` (pp. 8-2 to 8-3). The rest
comes from ECMA-376:

| Item | Value | Source |
|---|---|---|
| Part type | Custom XML Data Storage part; root "any XML allowed" | [ECMA-376-1][ecma1] §15.2.5 pp. 145–146 |
| Content type | `application/xml` (through a `Default` for `.xml`, or an `Override`) | ECMA-376-1 §15.2.5; [ECMA-376-2][ecma2] §7.2.3 p. 27 |
| Relationship | from the main document part (WordprocessingML: `word/document.xml`, in `word/_rels/document.xml.rels`). Transitional: `http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml`; Strict: `http://purl.oclc.org/ooxml/officeDocument/relationships/customXml` | ECMA-376-1 §15.2.5 p. 146; [ECMA-376-4][ecma4] §13.2.5 p. 27 |
| Item properties part | **optional** ("permitted"); target of the relationship `…/relationships/customXmlProps` from the custom XML part; content type `application/vnd.openxmlformats-officedocument.customXmlProperties+xml`; root `ds:datastoreItem` with required `ds:itemID` (GUID) and optional `ds:schemaRefs/ds:schemaRef/@ds:uri` | ECMA-376-1 §15.2.6 pp. 146–147, §22.5.2 pp. 3745–3747; ECMA-376-4 §13.2.6 p. 27 |
| `datastoreItem` namespace | Transitional XSD: `http://schemas.openxmlformats.org/officeDocument/2006/customXml` (Strict: `http://purl.oclc.org/ooxml/officeDocument/customXml`) | Transitional XSD `shared-customXmlDataProperties.xsd` in ECMA-376-4; ECMA-376-1 §A.6.5 p. 4126 |

Note that the part tables (ECMA-376-1 §15.2.6 and ECMA-376-4 §13.2.6) give the root namespace as
`…/customXmlDataProps`, while the normative XSDs use `…/customXml`. Follow the XSD.

### 4.4 The example exactly as the profile shows it (Figure 5-2)

Short excerpt of [ADatP-4778.2][4778.2] Figure 5-2, p. 5-5, described there as the contents of
`/customXml/item1.xml` for a simple Word document with one image. **Tested**: valid against the ADatP-4778
and ADatP-4774 XSDs, even though it has no `ReviewDateTime`, which the ADatP-4774 prose requires.

```xml
<mb:BindingInformation
  xmlns:mb="urn:nato:stanag:4778:bindinginformation:1:0"
  xmlns:xmime="http://www.w3.org/2005/05/xmlmime">
  <mb:MetadataBindingContainer>
   <mb:MetadataBinding>
    <mb:Metadata>
     <slab:originatorConfidentialityLabel
      xmlns:slab="urn:nato:stanag:4774:confidentialitymetadatalabel:1:0">
      <slab:ConfidentialityInformation>
       <slab:PolicyIdentifier>TEST Amoco</slab:PolicyIdentifier>
       <slab:Classification>GENERAL</slab:Classification>
      </slab:ConfidentialityInformation>
      <slab:CreationDateTime>2016-11-10T12:30:00Z</slab:CreationDateTime>
     </slab:originatorConfidentialityLabel>
    </mb:Metadata>
    <mb:DataReference URI="pack:///word/document.xml"/>
    <mb:DataReference URI="pack:///word/styles.xml"/>
    <mb:DataReference URI="pack:///word/header1.xml"/>
    <mb:DataReference URI="pack:///word/footer1.xml"/>
    <mb:DataReference URI="pack:///word/media/image.jpeg"
xmime:contentType="image/jpeg"/>
    <mb:DataReference URI="pack:///word/footnotes.xml"/>
    <mb:DataReference URI="pack:///word/endnotes.xml"/>
    <mb:DataReference URI="pack:///docProps/app.xml"/>
    <mb:DataReference URI="pack:///docProps/core.xml"/>
    <mb:DataReference URI="pack:///docProps/custom.xml"/>
   </mb:MetadataBinding>
  </mb:MetadataBindingContainer>
</mb:BindingInformation>
```

### 4.5 Recommended complete part and package plumbing (tested)

This follows the profile, adds what the ADatP-4774 prose requires (`ReviewDateTime`), and uses the
`EXAMPLE` policy. **Tested**:

- `item1.xml` is valid against the ADatP-4778 and ADatP-4774 XSDs;
- `itemProps1.xml` is valid against the ECMA-376 Transitional XSD.

`/customXml/item1.xml`:

```xml
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<mb:BindingInformation
    xmlns:mb="urn:nato:stanag:4778:bindinginformation:1:0"
    xmlns:xmime="http://www.w3.org/2005/05/xmlmime">
  <mb:MetadataBindingContainer>
    <mb:MetadataBinding Id="mb-document">
      <mb:Metadata>
        <slab:originatorConfidentialityLabel
            xmlns:slab="urn:nato:stanag:4774:confidentialitymetadatalabel:1:0"
            ReviewDateTime="2031-09-26T00:00:00Z">
          <slab:ConfidentialityInformation>
            <slab:PolicyIdentifier
                URI="urn:oid:2.25.283505922519774543341581604402970826256">EXAMPLE</slab:PolicyIdentifier>
            <slab:Classification>RESTRICTED</slab:Classification>
            <slab:Category Type="RESTRICTIVE" TagName="Special Handling">
              <slab:GenericValue>ALPHA</slab:GenericValue>
            </slab:Category>
            <slab:Category Type="PERMISSIVE" TagName="Releasable To">
              <slab:GenericValue>XAA</slab:GenericValue>
              <slab:GenericValue>XBB</slab:GenericValue>
            </slab:Category>
            <slab:Category Type="INFORMATIVE" TagName="Administrative">
              <slab:GenericValue>STAFF</slab:GenericValue>
            </slab:Category>
          </slab:ConfidentialityInformation>
          <slab:CreationDateTime>2026-09-26T12:00:00Z</slab:CreationDateTime>
        </slab:originatorConfidentialityLabel>
      </mb:Metadata>
      <!-- an alternativeConfidentialityLabel would go in a second, separate mb:Metadata -->
      <mb:DataReference URI="pack:///word/document.xml"/>
      <mb:DataReference URI="pack:///word/styles.xml"/>
      <mb:DataReference URI="pack:///word/header1.xml"/>
      <mb:DataReference URI="pack:///word/footer1.xml"/>
      <mb:DataReference URI="pack:///word/footnotes.xml"/>
      <mb:DataReference URI="pack:///word/endnotes.xml"/>
      <mb:DataReference URI="pack:///word/comments.xml"/>
      <mb:DataReference URI="pack:///word/media/image1.png" xmime:contentType="image/png"/>
      <mb:DataReference URI="pack:///docProps/core.xml"/>
      <mb:DataReference URI="pack:///docProps/app.xml"/>
      <mb:DataReference URI="pack:///docProps/custom.xml"/>
    </mb:MetadataBinding>
  </mb:MetadataBindingContainer>
</mb:BindingInformation>
```

Plumbing (ECMA-376, not the profile). The `schemaRef` is optional and is a suggestion, not a requirement.

```xml
<!-- [Content_Types].xml : item1.xml is covered by <Default Extension="xml" ContentType="application/xml"/> -->
<Override PartName="/customXml/itemProps1.xml"
          ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>

<!-- word/_rels/document.xml.rels -->
<Relationship Id="rId100" Target="../customXml/item1.xml"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml"/>

<!-- customXml/_rels/item1.xml.rels -->
<Relationship Id="rId1" Target="itemProps1.xml"
  Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps"/>

<!-- customXml/itemProps1.xml -->
<ds:datastoreItem ds:itemID="{D549412A-CA9E-4F5C-9947-17244A751610}"
    xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">
  <ds:schemaRefs><ds:schemaRef ds:uri="urn:nato:stanag:4778:bindinginformation:1:0"/></ds:schemaRefs>
</ds:datastoreItem>
```

Practical inferences (not stated by the standards):

- Office applications renumber custom XML parts. Locate the BDO part by its root element's namespace, not
  by the name `item1.xml`.
- OPC part names are not fixed. Resolve headers, footers and media through relationships rather than by
  file-name patterns.
- About `pack:///`: OPC 5th edition moved the pack IRI definition from the former Annex B to §6.3.2, whose
  grammar `"pack://" iauthority [ "/" | ipath ]` with `iauthority = *( … )` allows an empty authority.
  "If present, this fragment applies to whatever resource the pack IRI identifies" ([ECMA-376-2][ecma2]
  Foreword p. vii; §6.3.2 pp. 13–14). ADatP-4778.2 cites the 2012 edition, "Annex B".

### 4.6 Signing a DOCX binding

- A signed binding keeps the same part. `ds:Signature` is inserted as the first child of
  `mb:BindingInformation`, as the XSD sequence and the Annex D examples require.
- The `pack:` references are listed in a `ds:Manifest` inside `ds:Object`. This is RECOMMENDED by §5.7, and
  it matters because generic XMLDSIG libraries cannot dereference `pack:`.
- A skeleton follows. **Tested structurally** against the XMLDSIG and ADatP-4778 schemas; the digest values
  are placeholders.

```xml
<mb:BindingInformation xmlns:mb="urn:nato:stanag:4778:bindinginformation:1:0"
                       xmlns:xmime="http://www.w3.org/2005/05/xmlmime">
  <Signature xmlns="http://www.w3.org/2000/09/xmldsig#" Id="sig-1">
    <SignedInfo>
      <CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/>
      <SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
      <Reference URI="#mb-document">                 <!-- the MetadataBinding (label + references) -->
        <Transforms><Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></Transforms>
        <DigestMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#sha384"/><DigestValue>…</DigestValue>
      </Reference>
      <Reference URI="#manifest-1" Type="http://www.w3.org/2000/09/xmldsig#Manifest"> … </Reference>
      <Reference URI="#sigprops-1" Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties"> … </Reference>
    </SignedInfo>
    <SignatureValue>…</SignatureValue>
    <KeyInfo><X509Data><X509Certificate>…</X509Certificate></X509Data></KeyInfo>
    <Object>
      <Manifest Id="manifest-1">                     <!-- one Reference per mb:DataReference, same URI -->
        <Reference URI="pack:///word/document.xml">
          <DigestMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#sha384"/><DigestValue>…</DigestValue>
        </Reference>
        …
      </Manifest>
      <SignatureProperties Id="sigprops-1">
        <SignatureProperty Target="#sig-1">          <!-- Target is REQUIRED by the XMLDSIG schema -->
          <wsu:Timestamp xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
            <wsu:Created>2026-09-26T12:00:00Z</wsu:Created>
          </wsu:Timestamp>
        </SignatureProperty>
      </SignatureProperties>
    </Object>
  </Signature>
  <mb:MetadataBindingContainer> … (as in 4.5, MetadataBinding Id="mb-document") … </mb:MetadataBindingContainer>
</mb:BindingInformation>
```

Caveats:

- **What is digested for XML parts is not fixed by the profile.** Without `Transforms`, XMLDSIG digests the
  octets. ADatP-4778.1 says each data object "is required to be converted to a canonical form" and points to
  the Annex A normalization ([ADatP-4778.1][4778.1] §2.5 p. 2-5, §5.4 pp. 5-5 to 5-6). That guidance is
  optional, and the XSLT is not public.
- The profile text says "TimeStamp". WS-Security defines `wsu:Timestamp` ([OASIS wsu XSD][wsu-xsd]). The
  Annex D examples write `wsu:TimeStamp` and omit `SignatureProperty/@Target`, which the
  [XMLDSIG schema][xmldsig-xsd] requires (tested).
- Any save that rewrites a referenced part (at least `docProps/core.xml` and `docProps/app.xml`) invalidates
  the signature.
- This `ds:Signature` is unrelated to OPC package signatures ([ECMA-376-2][ecma2] clause 10).

### 4.7 Is an unsigned binding conformant?

**Yes.**

- ADatP-4778 makes `ds:Signature` optional (Table 9, p. 4-16).
- ADatP-4778.2 does not mandate cryptographic mechanisms (§2.1 p. 2-1).
- The OOXML profile applies Annexes A, B and C only "for the use cases that cryptographic bindings are
  required" (§5.7 p. 5-5).
- Annex A's MUST (at least one signature) is conditional on "the case where a cryptographic binding is
  required" (p. A-5).

Whether a signature is required is a policy decision outside the standards.

### 4.8 Labelling parts of a document: what the standards say

The OOXML profile is **not silent** on this, but it is **not normative for sub-part granularity**:

- Its list of possible future profiles includes "bindings to elements within a package part (e.g. binding
  metadata to paragraphs within a document)" ([ADatP-4778.2][4778.2] §5.2 p. 5-1).
- It notes that splitting a document over several parts "does not present a problem when applying granular
  metadata to different parts of the document" (§5.5 p. 5-3).
- It allows references to "files, or portions of files" (§5.6 p. 5-3).
- Table 5-2 applies only "when binding metadata to a complete document (as opposed to a specific part of a
  document)" (p. 5-3).
- It defines **no syntax** for addressing a paragraph inside `document.xml`. Because there must be "a single
  CustomXML file", all document-level and part-level `MetadataBinding` elements would live in the same
  `BindingInformation`.

The other documents provide the building blocks:

| Topic | Source |
|---|---|
| Labels may be bound to paragraphs, sections, figures and tables | [ADatP-4774][4774] §4.2 p. 4-2 |
| Requirement to bind metadata "to distinct elements of Composite Data Objects" | [ADatP-4778][4778] §2.2 p. 2-1 |
| Inheritance and supersession rules; example BDO with several `MetadataBinding` elements and fragment `DataReference`s | ADatP-4778 §3.5 pp. 3-8 to 3-11 (Figure 13) |
| XPath `ds:Transforms` on `DataReference` for XML subsets; fragment meaning depends on media type | ADatP-4778 §4.3.7 p. 4-14, §4.7 pp. 4-18 to 4-19 |
| "top-down labelling" recommended: most relaxed label on the root, stricter labels on subsets; the application determines the overall marking | [ADatP-4778.1][4778.1] §3.2 pp. 3-1 to 3-2 |
| Fragment identifiers and XPath-data-model rules | ADatP-4778.1 §3.3 to §3.4 pp. 3-3 to 3-8 |
| Dominant-label rules: classification by `hierarchy`; permissive categories intersected (dropped if empty or absent from any label); restrictive categories united; informative categories may be united; result re-validated against the SPIF | [ADatP-4774.1][4774.1] §4.4 Rules 1 to 9, pp. 4-4 to 4-6 |
| SPIF marking code `portionMarking` ("Apply to a specific portion of a document") | [ADatP-4774.1][4774.1] Table 6 p. 3-9; [SPIF 2.1 schema][spif21] |

Analysis (inference): WordprocessingML declares no `xsd:ID`-typed attributes. No `xsd:ID` appears in the
ECMA-376 Transitional schemas, and the markup `w:id` values are `ST_DecimalNumber` (`wml.xsd`,
`CT_Markup`). So `#fragment` shorthand pointers into `document.xml` would not resolve. Portion bindings in
a DOCX would need a project convention, for example a `DataReference` to `pack:///word/document.xml` with
an XPath `ds:Transforms` selecting a content control. That is **not standardized**; see
[section 10](#10-open-questions).

---

## 5. Open XML SPIF (question 4)

### 5.1 Namespace, versions, where

- Namespace `http://www.xmlspif.org/spif`. The schema uses `elementFormDefault="unqualified"`, but every
  element is declared globally, so **all elements are namespace-qualified** and attributes are unqualified
  ([SPIF 2.1][spif21]). The xmlspif.org schema page misspells the namespace as `www.xmslpif.org`
  ([xmlspif.org][xmlspifschema]).
- Versions ([SPIF 3.0 schema][spif30] version history; [schema page][xmlspifschema]):
  - 1.0 is derived from SDN.801;
  - 2.0 adds validity periods, more marking hooks, selection limits and equivalency;
  - 2.1 adds a marking code and schema constraints;
  - **3.0** removes the `code` elements, adds `simplePhrase`, `shortPhrase` and `inputPhrase`, adds
    `fgcolor` and `bgcolor`, adds a `finalSeparator` qualifier, removes `updateInfo`, and makes
    `markingData` mandatory on classifications and categories.

  The site says "The current version of the schema is 3.0", and that 2.1 is at `/schema/2026/08/xmlspif.xsd`
  (byte-identical to `/schema/2017/12/xmlspif.xsd`).
- The NATO documents use **2.1**:
  - ADatP-4774.1 reproduces it as "XML SPIF schema (Version 2.1)" (§3.8 p. 3-12; Annex A p. A-1);
  - the NATO SPIF example in ADatP-4774 declares `schemaVersion="2.1"` (p. App 2-B1);
  - ADatP-4778.2 uses the `spif` prefix for this namespace (Table 12-2 p. 12-3).
- ADatP-4774.1 and ADatP-4778.2 point to `http://www.xmlspif.org/schema/xmlspif.xsd`, which **now serves
  3.0**. Pin 2.1 explicitly.

### 5.2 Structure (schema 2.1)

```text
spif:SPIF   @schemaVersion (1.0|2.0|2.1) req, @version (int), @creationDate (GeneralizedTime) req,
            @originatorDN req, @keyIdentifier req, @privilegeId (OID) req, @rbacId (OID) req,
            @userRefURI, @docRefURI, @notBefore/@notAfter
  defaultSecurityPolicyId  @name @id                                       0..1
  securityPolicyId         @name (<=256) @id (OID)                          1
  updateInfo                                                                0..1  (removed in 3.0)
  securityClassifications                                                   1
    securityClassification  @name req @lacv (int) req @hierarchy (int) req @color @obsolete   1..n
      equivalentClassification*  markingData*  markingQualifier*  requiredCategory*
    markingData*  markingQualifier*
  securityCategoryTagSets                                                   0..1
    securityCategoryTagSet  @name req @id (OID) req                        1..n
      securityCategoryTag   @name @tagType req @enumType @tag7Encoding
                            @singleSelection (default false) @maxSelection @minSelection        1..n
        tagCategory  @name req @lacv req @requiredClass @obsolete @userInput @dateFormat
                     @notBefore/@notAfter                                  0..n
          equivalentSecCategoryTag*  markingData*  markingQualifier*
          excludedClass* (text = classification name)  requiredCategory*  excludedCategory*
        markingQualifier*
      equivalentSecurityCategoryTagSet*
  privacyMarks  (privacyMark @name …)                                      0..1
  equivalentPolicies  (equivalentPolicy @name @id … requiredCategory*)     0..1
  markingData*  markingQualifier*                                          (SPIF-level)
  extensions  (any)                                                         0..1
```

Source: [SPIF 2.1 schema][spif21]. The prose is in [ADatP-4774.1][4774.1] §3.2 to §3.6, pp. 3-2 to 3-11.

Schema identity constraints include:

- unique classification `lacv`;
- unique classification `color` ("all security classifications have a unique colour",
  [ADatP-4774.1][4774.1] §3.4 p. 3-7);
- unique tag-set `id`;
- keys on classification and tag-set names, used by `excludedClass`, `requiredClass` and `tagSetRef`.

ADatP-4774.1 says `privilegeId` and `rbacId` "MUST be 1.3.26.0.4774.5.24.1" (Table 1 p. 3-2). The NATO SPIF
printed in ADatP-4774 uses `2.16.840.1.101.2.1.8.3` instead (p. App 2-B1).

### 5.3 `tagType` values

The schema enumeration is `notApplicable | restrictive | enumerated | permissive | tagType7`. There is **no
`informative` value**: "tagType7 - (or informative) tag categories; informative tag categories are not used
in the access control decision function" ([SPIF 2.1 schema][spif21], `tagType` documentation).

- `enumerated` needs `enumType` (`restrictive` | `permissive`).
- `tagType7` uses `tag7Encoding` (`bitSetAttributes` | `securityAttributes`).
- The same classification appears in [ADatP-4774.1][4774.1] §3.3.4 p. 3-5.

### 5.4 Rule elements

| Element / attribute | Where | Meaning | Source |
|---|---|---|---|
| `excludedClass` | `tagCategory` | classification that must not be used with the category | [ADatP-4774.1][4774.1] Table 3 p. 3-6 |
| `requiredClass` | `tagCategory` | classification that must be used with the category | same |
| `requiredCategory @operation` (`onlyOne`, `oneOrMore`, `all`) containing `categoryGroup` (`tagSetRef`, `tagType`, `enumType`, `lacv` or `all`) | `securityClassification`, `tagCategory`, `equivalentPolicy`, `equivalentClassification`, `equivalentSecurityCategoryTagSet` | categories that must accompany the classification or category | §3.3.3 p. 3-4 to 3-5; [SPIF 2.1][spif21] `optionalCategoryData` and `operation` docs ("One, and only one, of lacv or all should be present") |
| `excludedCategory` (`tagSetRef`, `tagType`, `enumType`, `lacv` or `all`) | `tagCategory` | categories that must not accompany it | Table 3 p. 3-6 |
| `singleSelection` / `maxSelection` / `minSelection` | `securityCategoryTag` | selection limits | §3.3.4 p. 3-5 |
| `obsolete` | classification, category, privacy mark | valid for old labels, not for new ones | Table 3 p. 3-6; schema docs |
| validity (`notBefore`, `notAfter`) | SPIF, `tagCategory` | time window | Table 3 p. 3-6 |

### 5.5 Marking elements (2.1)

- `markingData` has `@phrase` (optional in the schema; if absent the name is used), `@xml:lang`, and one or
  more `code` children giving the location.
- `markingQualifier` has `@markingCode` and `qualifier` elements (`@markingQualifier` text,
  `@qualifierCode` = `prefix` | `suffix` | `separator`, optional `@xml:lang`).
- `markingData` can be attached to the SPIF, `securityClassifications`, `securityClassification`,
  `tagCategory`, `privacyMark(s)` and policy ids. `markingQualifier` can go in the same places and also on
  `securityCategoryTag`, which is where the list prefix and separator of a tag normally live (schema 3.0
  also allows `markingData` there).
- Classification colour is `@color`: a W3C colour name (the enumeration misspells "fuschia") or `#RRGGBB`.

([ADatP-4774.1][4774.1] §3.5 Tables 4 to 6 pp. 3-7 to 3-9; [SPIF 2.1][spif21].)

The marking codes are `pageTop`, `pageBottom`, `pageTopBottom`, `documentStart`, `documentEnd`,
`noNameDisplay`, `noMarkingDisplay`, `suppressClassName`, `firstLineOfText`, `lastLineOfText`, `subject`,
`xHeader`, `portionMarking`, `inputTitle`, `waterMark` and `replacePolicy`. Use the schema spellings:
ADatP-4774.1 Table 6 writes `supressClassName` and `firstLineofText`.

### 5.6 Equivalent policies

- `equivalentPolicies/equivalentPolicy` has `@name`, `@id`, `@docRefURI` and optional `requiredCategory`.
- `equivalentClassification` has `@policyRef`, `@lacv` and `@applied` (`encrypt` at origination, `decrypt`
  at reception, or `both`).
- `equivalentSecCategoryTag` has `@policyRef`, `@tagSetId`, `@tagType`, `@enumType`, `@lacv`, `@applied` and
  an optional `@action="discard"`.

([ADatP-4774.1][4774.1] §3.6 Tables 7 to 9 pp. 3-10 to 3-11.) These are used to generate the
`alternativeConfidentialityLabel`.

### 5.7 Complete example SPIF (tested)

The fictitious `EXAMPLE` policy has:

- 2 classifications;
- 1 restrictive tag set;
- 1 permissive "Releasable To" tag set;
- 1 informative tag set;
- one rule of each kind: `excludedClass`, `excludedCategory` (whole tag set) and `requiredCategory`.

**Tested**: valid against [SPIF 2.1][spif21], and loaded by spiffing-java.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<spif:SPIF xmlns:spif="http://www.xmlspif.org/spif"
    schemaVersion="2.1" version="1" creationDate="20260926120000Z"
    originatorDN="CN=Example Policy Authority,O=Example,C=XX"
    keyIdentifier="00"
    privilegeId="1.3.26.0.4774.5.24.1" rbacId="1.3.26.0.4774.5.24.1">
  <spif:securityPolicyId name="EXAMPLE" id="2.25.283505922519774543341581604402970826256"/>
  <spif:securityClassifications>
    <spif:securityClassification name="UNCLASSIFIED" lacv="1" hierarchy="1" color="green">
      <spif:markingData xml:lang="fr" phrase="NON CLASSIFIE">
        <spif:code>pageTopBottom</spif:code>
      </spif:markingData>
    </spif:securityClassification>
    <spif:securityClassification name="RESTRICTED" lacv="2" hierarchy="2" color="#FF8C00">
      <spif:markingData xml:lang="fr" phrase="RESTREINT">
        <spif:code>pageTopBottom</spif:code>
      </spif:markingData>
    </spif:securityClassification>
  </spif:securityClassifications>
  <spif:securityCategoryTagSets>
    <spif:securityCategoryTagSet name="Special Handling"
        id="2.25.283505922519774543341581604402970826256.1">
      <spif:securityCategoryTag name="Special Handling" tagType="restrictive">
        <spif:tagCategory name="ALPHA" lacv="1">
          <spif:excludedClass>UNCLASSIFIED</spif:excludedClass>
        </spif:tagCategory>
        <spif:tagCategory name="BRAVO" lacv="2">
          <spif:excludedClass>UNCLASSIFIED</spif:excludedClass>
          <spif:excludedCategory tagSetRef="Releasable To" tagType="enumerated"
              enumType="permissive" all="true"/>
        </spif:tagCategory>
        <spif:markingQualifier markingCode="pageTopBottom">
          <spif:qualifier markingQualifier=" " qualifierCode="separator"/>
        </spif:markingQualifier>
      </spif:securityCategoryTag>
    </spif:securityCategoryTagSet>
    <spif:securityCategoryTagSet name="Releasable To"
        id="2.25.283505922519774543341581604402970826256.2">
      <spif:securityCategoryTag name="Releasable To" tagType="enumerated"
          enumType="permissive">
        <spif:tagCategory name="XAA" lacv="1"/>
        <spif:tagCategory name="XBB" lacv="2">
          <spif:requiredCategory operation="all">
            <spif:categoryGroup tagSetRef="Releasable To" tagType="enumerated"
                enumType="permissive" lacv="1"/>
          </spif:requiredCategory>
        </spif:tagCategory>
        <spif:markingQualifier markingCode="pageTopBottom">
          <spif:qualifier markingQualifier="REL TO " qualifierCode="prefix"/>
          <spif:qualifier markingQualifier=", " qualifierCode="separator"/>
        </spif:markingQualifier>
      </spif:securityCategoryTag>
    </spif:securityCategoryTagSet>
    <spif:securityCategoryTagSet name="Administrative"
        id="2.25.283505922519774543341581604402970826256.3">
      <spif:securityCategoryTag name="Administrative" tagType="tagType7"
          tag7Encoding="bitSetAttributes">
        <spif:tagCategory name="STAFF" lacv="1"/>
        <spif:tagCategory name="MEDICAL" lacv="2"/>
        <spif:markingQualifier markingCode="pageTopBottom">
          <spif:qualifier markingQualifier=" " qualifierCode="separator"/>
        </spif:markingQualifier>
      </spif:securityCategoryTag>
    </spif:securityCategoryTagSet>
  </spif:securityCategoryTagSets>
</spif:SPIF>
```

The rules express the following:

- ALPHA and BRAVO are forbidden at UNCLASSIFIED;
- BRAVO cannot carry any release value;
- releasing to XBB requires XAA as well, so XAA plays the role of the policy owner.

---

## 6. SPIF to ADatP-4774 mapping (question 5)

### 6.1 What the guidance says

[ADatP-4774.1][4774.1] §3.10.2, Table 10 and text, pp. 3-15 to 3-17 (guidance):

| Label item | SPIF source |
|---|---|
| `PolicyIdentifier` (text) | `securityPolicyId/@name` |
| `PolicyIdentifier/@URI` | `"urn:oid:"` + `securityPolicyId/@id` ("must be prefixed with 'urn:oid:'") |
| `Classification` (text) | `securityClassification/@name`; `@URI` not used |
| `PrivacyMark` | `privacyMark/@name` |
| `Category/@TagName` | `securityCategoryTagSet/@name` |
| `Category/@URI` | `"urn:oid:"` + `securityCategoryTagSet[@name=TagName]/@id` |
| `Category/@Type` | from `securityCategoryTag/@tagType` of that tag set. The text says "SPIF tagType must be transformed to uppercase", which is only literally right for `restrictive` and `permissive`. Apply the §3.3.4 classification (p. 3-5): `enumerated`+`enumType` gives RESTRICTIVE or PERMISSIVE, and `tagType7` gives INFORMATIVE |
| `GenericValue` | `tagCategory/@name` in that tag set and tag type (**name, not lacv**) |

The `lacv` values are only for binary labels, such as ESS security labels with ACP-145 categories
(Table 11, pp. 3-17 to 3-20). All examples in ADatP-4774 and ADatP-4778.2 use names:
`<Classification>RESTRICTED</Classification>`, `<GenericValue>SWE</GenericValue>`.

### 6.2 What the reference implementations do (NATO XML labels)

| | spiffing (C++) | spiffing-java | sparrow (Go) |
|---|---|---|---|
| Read | root must be `originatorConfidentialityLabel` in the 4774 namespace; policy looked up **by name**; `URI` (if `urn:oid:`) must match the SPIF OID; classification by name; `Type` RESTRICTIVE, PERMISSIVE or INFORMATIVE; `TagName` → tag set **by name**; `GenericValue` → category **by name** ([label.cc L207-267][sp-parse]); `enumerated*` types are folded into permissive or restrictive for name lookup ([tagset.cc L42-48][sp-tagset]) | same logic ([Wire.java L66-91][spj-read]); also accepts the misspelt `URL` attribute found in spiffing's test data | parses into a namespace-less struct ([structures/label.go L7-22][spa-struct]) |
| Write | `originatorConfidentialityLabel` with default namespace; `PolicyIdentifier` = SPIF name plus `URI="urn:oid:"+OID`; `Classification` = name; one `Category` per tag set and type, with `Type` uppercase and `TagName` = tag-set name; `GenericValue` = category name. **Category `URI` is commented out; no `CreationDateTime`** ([label.cc L328-384][sp-write]) | same, with `Type` = normalized tag type uppercased ([Wire.java L108-124][spj-write], [TagType.java L16-32][spj-tagtype]); **no `CreationDateTime`** (its README says "NATO timestamps … are not retained", [README][spiffing-java]) | declares `xmlns:s4774` but emits **unprefixed elements, so they are in no namespace**; `Type` is whatever the client passes. The playground passes the SPIF `tagType`, or `enumType` for enumerated tags ("permissive", "tagType7"…); no `CreationDateTime`; category order follows Go map iteration ([utils/labels.go L27-52][spa-gen], [utils/categories.go L25-41][spa-type], [App.js L152-171][spa-app]) |
| SPIF `tagType` parse | `permissive`, `restrictive`, `enumerated`+`enumType`; **anything else becomes informative** ([spif.cc L225-247][sp-tagtype]) | explicit; also accepts non-schema `informative` ([TagType.java L20-32][spj-tagtype]) | stores the raw string; one `securityCategoryTag` per tag set only ([structures/SPIF.go L58-81][spa-spif]) |
| Output XSD-valid? | no (missing `CreationDateTime`) | no, **tested** | no, **tested**: not in the 4774 namespace |

- spiffing's README lists "NATO XML Labelling format (if this can be released)" as a TODO, although the code
  exists ([README][spiffing]).
- The NATO test labels in spiffing's data also lack `CreationDateTime` and **fail** XSD validation (tested:
  [nato-4774-17-1.nato][sp-nato-test]).
- sparrow's own sample label uses the invalid prefix `xmlns:4774`, which is not namespace-well-formed
  ([test/labels/label1.xml][spa-label]).

### 6.3 Verified behaviour on the example

spiffing-java at commit `38a916b` was run on the SPIF of [5.7](#57-complete-example-spif-tested) and the label
of [2.5](#25-complete-example-label-national-style-policy-fictitious). Results:

- `valid()` = true.
- `pageBottom` marking = `EXAMPLE RESTRICTED ALPHA REL TO XAA, XBB`; in `fr`: `EXAMPLE RESTREINT ALPHA REL TO XAA, XBB`.
- Adding `Administrative/STAFF` gives `… REL TO XAA, XBB STAFF`, still valid.
- Invalid, as expected: `XBB` without `XAA` (`requiredCategory`), `BRAVO` with a release value
  (`excludedCategory`), `ALPHA` at UNCLASSIFIED (`excludedClass`).
- A lowercase `restricted` throws "Unknown classification". This lookup is **case-sensitive**, whereas
  ADatP-4774 says values are case-insensitive for the NATO and PUBLIC policies.
- `write(Format.NATO)` produces a namespace-correct label **without `CreationDateTime`** that fails the XSD.
- Loading the xmlspif.org **SPIF 3.0** ACME example **fails** with "Unknown qualifierCode"
  (`finalSeparator`).

---

## 7. Label validity rules (question 6)

### 7.1 What a SPIF can express

| Rule | Semantics |
|---|---|
| Classification exists | name (label) / lacv (binary) must be one of `securityClassification` |
| Category exists and has the right type | `TagName` must be a tag set; `GenericValue` must be a `tagCategory` of the matching tag type |
| `excludedClass` | category not allowed with this classification |
| `requiredClass` | category only allowed with this classification |
| `requiredCategory` on a classification | e.g. the ACME policy requires "Releasable To" MOCK and/or PHONY at CONFIDENTIAL (`operation="oneOrMore"`, [ADatP-4774.1][4774.1] Figure 11 pp. 3-28 to 3-29) |
| `requiredCategory` on a category | the category requires others (`onlyOne` = exactly one, `oneOrMore`, `all`) |
| `excludedCategory` on a category | mutually exclusive categories, one value (`lacv`) or a whole tag set |
| Selection limits | `singleSelection`, `maxSelection`, `minSelection` per `securityCategoryTag` |
| `obsolete` | not usable in new labels, still valid when reading old ones |
| Validity windows | `notBefore` / `notAfter` on the SPIF and on categories |

ADatP-4774.1 §3.11.2 shows these rules compiled into Schematron with an NMRR stylesheet (not public),
including the case-insensitive comparison of values (pp. 3-21 to 3-29). "The Schematron rules do not verify
that the confidentiality label is syntactically correct"; that is the XSD's job (p. 3-30).

Rules from ADatP-4774 itself, independent of the SPIF (see [2.3](#23-what-is-mandatory)):

- `CreationDateTime` present;
- `ReviewDateTime` present unless there is `SuccessionHandling`;
- no `Classification/@URI`;
- only `GenericValue`;
- for the NATO policy, a mandatory `Context` category.

### 7.2 How spiffing checks them

| Check | spiffing C++ | spiffing-java |
|---|---|---|
| Entry point | `Spif::valid()`: classification rules, then each category's rules ([spif.cc L693-699][sp-valid]) | `Spif.valid()` ([Spif.java L209-216][spj-valid]) |
| Classification `requiredCategory` | every group must match ([classification.cc L48-53][sp-class]) | [Spif.java L136-151][spj-rules] |
| Category `excludedClass`, `excludedCategory`, `requiredCategory` | [category.cc L54-63][sp-cat] | same method |
| `onlyOne` / `oneOrMore` / `all` | [categorygroup.cc L34-53][sp-group] (onlyOne = exactly one) | count-based, same semantics |
| `categoryGroup` without `lacv` means the whole tag set | [categorydata.cc L44-60][sp-catdata] (the `all` attribute is not read) | [Spif.java L126-134][spj-rules] |
| Not checked | `requiredClass`, `obsolete`, selection limits, validity windows, case-insensitive matching, structural 4774 rules | same; its README says `obsolete` and `singleSelection` add no validation ([README][spiffing-java]) |
| Access decision (not validity) | classification must be in the clearance; every restrictive category must be held; at least one value per permissive tag; informative ignored ([spif.cc L646-679][sp-acdf]) | [Spif.java L221-231][spj-valid] |

sparrow only filters proposed values by `excludedClass` ([utils/mentions.go L10-30][spa-mentions]). Its
dominant-label code, based on ADatP-4774.1 §4.4 and described as "work in progress" in its README, groups
categories by `Type` rather than by tag name ([utils/dominant.go][spa-dominant]).

---

## 8. Marking rendering from a SPIF (question 7)

- **Standard model** ([ADatP-4774.1][4774.1] §3.5 pp. 3-7 to 3-9; [SPIF 2.1][spif21]):
  - each value's `markingData` gives a phrase per language (`xml:lang`) and per location (`code`: page top
    or bottom, document start or end, `portionMarking`, `waterMark`, email subject, …);
  - `noNameDisplay` hides a value's name;
  - `replacePolicy` substitutes the policy phrase;
  - `suppressClassName` hides the classification;
  - `markingQualifier` on a tag gives the prefix, separator and suffix around the list of values (for
    example `REL TO ` and `, `);
  - `color` gives the classification colour.

  ADatP-4774.1 generates a marking stylesheet from the SPIF (NMRR `spif2marking.xsl`, not public), with
  `lang` and `markingCode` parameters (§3.11.3.1 pp. 3-30 to 3-31).
- **NATO examples**:
  - TOP SECRET carries `markingData phrase="COSMIC"` with `replacePolicy`;
  - `Context` values use `noNameDisplay` plus `replacePolicy` so that `EAPC` renders as `NATO/EAPC`;
  - `Releasable` is hidden;
  - "Releasable To" has the prefix `Releasable To ` (in French: `Communicable a `)

  ([ADatP-4774][4774] pp. App 2-B2, App 2-B14 to App 2-B15, App 2-B27 to App 2-B28).
- **spiffing's algorithm** ([spif.cc L544-601][sp-marking], [L497-541][sp-catmarking],
  [marking.cc L36-49][sp-phrase]):
  1. the policy name, or a `replacePolicy` phrase;
  2. a separator (default `" "`);
  3. the classification phrase, unless suppressed;
  4. for each tag: prefix + values joined by the tag separator (default `/`) + suffix.

  Only 9 codes are accepted: page top/bottom/both, document start/end, `noNameDisplay`,
  `noMarkingDisplay`, `suppressClassName`, `replacePolicy`. **Any other code, such as `portionMarking` or
  `waterMark`, makes the SPIF load fail** ([spif.cc L177-205][sp-codes]; spiffing-java
  [Markings.java L55-77][spj-markings]).

---

## 9. Pitfalls and errata found in the published examples

Follow the XSDs, not the examples. Each item below was tested where marked.

1. `slab:alternateConfidentialityLabel` ([ADatP-4778][4778] §4.9.6 and §4.9.7 pp. 4-30 to 4-32;
   [ADatP-4778.2][4778.2] Figure 2-4 p. D-6) does not exist. The element is `alternativeConfidentialityLabel`.
2. Two labels in one `mb:Metadata` (same places; [ADatP-4774.1][4774.1] Figure 19 p. 4-2) are schema-invalid:
   the element allows exactly one child. **Tested.**
3. `mb:Id="#id-…"` and `mb:URI=""` (ADatP-4778.2 Annex D pp. D-2 to D-9) are not the schema's unqualified
   `Id` (`xs:ID`, no `#`) and `URI`. A `DataReference` with only `mb:URI` fails (`URI` required). **Tested.**
4. The enveloped-transform XPath in Figure 2-4 uses the obsolete namespace `http://www.nato.int/2014/06/nl/mb`
   (p. D-5), while the text uses the URN (p. A-7).
5. `ds:SignatureProperty` without `Target`, and `wsu:TimeStamp` instead of `wsu:Timestamp` (Annex D).
   **Tested**: `Target` is required by XMLDSIG.
6. `pack://files/image1.jpeg` (ADatP-4778.2 Figure 8-2 p. 8-3) contradicts the profile's own empty-authority
   rule. It should be `pack:///files/image1.jpeg`.
7. ADatP-4774 Appendix 2 examples use `tagName=` and `type=`, and even `Type="Permissive"` (pp. App 2-5 to
   App 2-10). The schema requires `TagName`, `Type` and uppercase values.
8. ADatP-4774.1 examples use `CreationDataTime` and `successorConfidentialityLabel` (pp. 3-26, 4-1, 4-4).
   The schema has `CreationDateTime` and `SuccessorConfidentialityLabel`.
9. The ACME SPIF of ADatP-4774.1 Annex B has unqualified `equivalentSecCategoryTag` elements (p. B-2). They
   are invalid against SPIF 2.1, and the copy in sparrow fails the same way. **Tested.**
10. The ADatP-4778 XSD as printed is not well-formed: see [2.6](#26-is-an-official-xsd-publicly-available).
11. Nearly every example omits `ReviewDateTime`, although the ADatP-4774 prose makes it mandatory without
    `SuccessionHandling`.
12. ADatP-4778.2 §12.11 cites `http://ww.xmlspif.org/schema/xmlspif.xsd` (p. 12-11), and the xmlspif.org page
    gives the namespace as `www.xmslpif.org`. The real namespace is `http://www.xmlspif.org/spif`.

---

## 10. Open questions

1. **Paragraph and portion labels inside a DOCX** are not standardized
   ([ADatP-4778.2][4778.2] §5.2 lists them as future work). Candidate project conventions:
   - XPath `ds:Transforms` on a `DataReference` to `pack:///word/document.xml`, selecting content controls
     (`w:sdt`) by tag;
   - separate `MetadataBinding` elements in the same single BDO part.

   Interoperability with third-party labelling guards is unknown. Shorthand `#fragment` pointers will not
   work (see [4.8](#48-labelling-parts-of-a-document-what-the-standards-say)).
2. **Which label goes at the whole-document level** when portions differ?
   - ADatP-4778.1 recommends top-down labelling: relaxed root label, stricter portion labels (§3.2).
   - A consumer that only understands the whole-document binding of the OOXML profile would then see the
     relaxed label.
   - The alternative is to put the dominant label (ADatP-4774.1 §4.4) at the top. This needs a decision.
3. **Default `ReviewDateTime`**: its value is a policy decision that the standards do not supply.
4. **Signing**:
   - whose key, and when (every save rewrites `docProps/*`);
   - digest raw part octets, or the Annex A normalization, whose XSLT is not public;
   - `wsu:Timestamp` versus the examples' `wsu:TimeStamp`;
   - SHA-384 is the mandatory digest.

   Verification interoperability with other ADatP-4778.2 implementations is **UNVERIFIED**.
5. **SPIF version**: the NATO documents use 2.1, while xmlspif.org publishes 3.0 (2026) with a different
   marking model. Both reference implementations fail on 3.0 features. Decide whether to accept 3.0 as well.
6. **Marking codes** such as `portionMarking` and `waterMark` are needed for document rendering, but both
   spiffing libraries reject SPIFs that use them. How markings map to ONLYOFFICE headers, footers and
   watermarks is a project decision. Content-control data binding to a custom XML part ([ECMA-376-1][ecma1]
   §17.5.2.6 p. 505) could render marking text, but the BDO carries no marking string, apart from the
   undocumented `slab-ext:Marking` extension.
7. **ONLYOFFICE round-trip of custom XML parts**:
   - the Office API added `ApiCustomXmlParts` (including `GetByNamespace`) and `ApiDocument/GetCustomXmlParts`
     to the Document API in version 9.0 ([ONLYOFFICE API changelog][oo-changelog]);
   - whether a saved DOCX keeps an externally added `customXml` part, its `itemProps` and its relationships
     unchanged is **UNVERIFIED**; it needs a test.
8. **Licensing**:
   - the ADatP-4774 and ADatP-4778 letters of promulgation (§3) forbid reproduction without permission,
     except for member and partner nations and NATO bodies, even though the documents are "authorized for
     public disclosure";
   - bundling their XSD text in an AGPL repository may need permission;
   - the SPIF schemas carry no licence statement.

   **UNVERIFIED**: no legal conclusion is drawn here.
9. **Official artefacts in the NMRR** are not publicly accessible: the XSDs, the full NATO SPIF ("The complete,
   up to date SPIF for the NATO Security Policy is held in the NMRR", [ADatP-4774][4774] p. App 2-B1),
   ADatP-4774.2 value domains, the normalization XSLT, and `spif2conflabel-schematron.xsl`.
10. **`TagName` source when a tag set holds several `securityCategoryTag` elements**: ADatP-4774.1 says the
    tag-set name. sparrow uses the tag name. In all SPIFs seen, the two are equal.
11. **`privilegeId` and `rbacId`**: ADatP-4774.1 requires `1.3.26.0.4774.5.24.1`, while the NATO SPIF uses
    `2.16.840.1.101.2.1.8.3`.
12. **Case-insensitive matching** is required by ADatP-4774 for NATO and PUBLIC values, but the
    implementations are case-sensitive. Suggested approach: match case-insensitively on read, and emit the
    SPIF's spelling on write.
13. **Parts beyond Tables 5-2 and 5-3** (`numbering.xml`, `settings.xml`, charts, embedded objects, glossary)
    are optional in the profile ("MAY"), yet they can hold content. Decide whether to reference every
    content-bearing part.

---

## 11. Recommended minimal subset for a first implementation

Target: read a small SPIF (2 classifications, 1 restrictive, 1 permissive release and 1 informative
category), and emit valid ADatP-4774 labels and an ADatP-4778.2 OOXML part.

**A. Read the SPIF (schema 2.1, namespace `http://www.xmlspif.org/spif`)**

1. Parse namespace-aware; disallow DTDs and external entities. Check `schemaVersion`: accept `2.1` (and `2.0`),
   and reject `3.0` with a clear message until it is supported.
2. Read:
   - `securityPolicyId` `@name` and `@id`;
   - each `securityClassification`: `@name`, `@lacv`, `@hierarchy`, optional `@color` and `@obsolete`,
     `markingData` (`@phrase`, `@xml:lang`, `code`), and `requiredCategory`;
   - each `securityCategoryTagSet`: `@name` and `@id`;
   - each `securityCategoryTag`: `@name`, `@tagType`, `@enumType`, `@tag7Encoding`, `@singleSelection`,
     `@maxSelection`;
   - each `tagCategory`: `@name`, `@lacv`, `@obsolete`, `@requiredClass`, `excludedClass`,
     `requiredCategory`, `excludedCategory`, `markingData`, `markingQualifier`;
   - `markingQualifier` / `qualifier` (prefix, separator, suffix).
3. Map types:
   - `restrictive`, or `enumerated` + `restrictive` → `RESTRICTIVE`;
   - `permissive`, or `enumerated` + `permissive` → `PERMISSIVE`;
   - `tagType7` → `INFORMATIVE`;
   - anything else is an error.
4. Run the ADatP-4774.1 §3.4 consistency checks: unique names, lacv and hierarchy values, and references
   that resolve.
5. Ignore with a warning in v1: equivalences, privacy marks, `defaultSecurityPolicyId`, `extensions`,
   validity windows, `userInput`.

**B. Validate a label**

1. The policy name matches (case-insensitive); if `URI` is present it equals `urn:oid:` + id.
2. The classification exists.
3. Each `Category`: `TagName` resolves, `Type` matches the mapped `tagType`, and each `GenericValue` resolves
   by name.
4. Apply `excludedClass`, `requiredClass`, `excludedCategory` (a `lacv` or a whole tag set) and
   `requiredCategory` at classification and category level (`onlyOne` means exactly one); optionally
   `singleSelection` / `maxSelection`. Reject `obsolete` values for new labels.
5. Apply the ADatP-4774 structural rules from [2.3](#23-what-is-mandatory).
6. Test vectors: the SPIF and label in this document, plus the three invalid variants of
   [6.3](#63-verified-behaviour-on-the-example).

**C. Emit an ADatP-4774 label**

1. Use `originatorConfidentialityLabel` in `urn:nato:stanag:4774:confidentialitymetadatalabel:1:0`, with
   element order as in the XSD.
2. `PolicyIdentifier`: text = SPIF name, `URI="urn:oid:<id>"`.
3. `Classification` = name.
4. One `Category` per tag set (values in SPIF document order, for deterministic output), with
   `Type` / `TagName`, optional `URI="urn:oid:<tagset id>"`, and one `GenericValue` per name.
5. `CreationDateTime` in UTC.
6. **Always** a `ReviewDateTime` attribute (or a `SuccessionHandling`); optional `OriginatorID`.
7. Never emit `Classification/@URI`, `IntegerValue` or `BitStringValue`.
8. Check the output against the ADatP-4774 XSD in tests. The XSD has to be obtained legitimately; see open
   question 8.

**D. Emit the ADatP-4778.2 OOXML part (unsigned in v1, which is conformant)**

1. Keep **one** custom XML part whose root is `mb:BindingInformation`. Find an existing one by namespace, and
   update it rather than adding a second.
2. Inside it, put `MetadataBindingContainer` / `MetadataBinding Id="…"`, with **one `mb:Metadata` per label**
   (the originator label first, then any alternative labels).
3. Add a `DataReference URI="pack:///…"` for every present Table 5-2 and 5-3 part. Add
   `xmime:contentType` on binary parts such as media. Never use `mb:Data`.
4. Regenerate the reference list at every save.
5. ECMA-376 plumbing:
   - `customXml` relationship from `word/document.xml`;
   - optional `itemProps` part (`datastoreItem` with a GUID) and its `customXmlProps` relationship;
   - content-type override for the `itemProps` part;
   - `application/xml` for the BDO part.
6. Render the page-top and page-bottom marking from the SPIF (phrase, qualifiers, colour) into headers and
   footers. This is a UI concern, not part of the binding.
7. Out of scope for v1, but design for them: signatures (Annex A/B: Manifest of `pack:` references, SHA-384,
   RSA-SHA256 or ECDSA-SHA256, `wsu:Timestamp`), alternative labels from SPIF equivalences, portion labels
   (project convention, clearly documented as non-standard), and the dominant-label computation
   (ADatP-4774.1 §4.4).

---

## Appendix A. How the examples were validated

- The ADatP-4774 XSD (App. 1 Annex A) and the ADatP-4778 XSD (§4.8) were transcribed from the PDFs with
  `pdftotext`. The ADatP-4778 one was repaired **only** by removing its malformed `xs:appinfo` example
  label, and its imports were pointed at local copies of the W3C schemas ([XMLDSIG][xmldsig-xsd] and
  [xmlmime][xmlmime-xsd]).
- A driver schema imported both XSDs. All checks were done with `xmllint --schema`.
- Results:
  - the ADatP-4778.2 Figure 5-2 example is valid;
  - the example label, SPIF, `item1.xml` and signed skeleton in this document are valid;
  - `itemProps1.xml` is valid against the ECMA-376 Transitional `shared-customXmlDataProperties.xsd`;
  - the negative cases are invalid: two labels in one `mb:Metadata`, `Id="#…"`, missing
    `CreationDateTime`, lowercase `Type`, `DataReference` with only `mb:URI`, `SignatureProperty` without
    `Target`;
  - SPIFs checked against [SPIF 2.1][spif21] (with the W3C `xml.xsd`): spiffing's NATO test SPIF is valid,
    sparrow's ACME SPIF is invalid (unqualified `equivalentSecCategoryTag`), and the xmlspif.org ACME 3.0
    example is valid against [SPIF 3.0][spif30].
- spiffing-java was built with Maven (Java 24) at commit `38a916b` and driven from a small Java program
  against the example files. Results are in [6.3](#63-verified-behaviour-on-the-example).
- sparrow's label structs were compiled in a scratch Go program to observe `encoding/xml` output: the
  elements come out in no namespace, and the result fails validation.
- These scratch files were not added to the repository.

## Appendix B. SHA-256 of the documents used

```text
592a0da5d0786848743ab024417626f5c8cdcc015c0bfa9c18c0995e8cdafbf9  ADatP-4774 EDA V1 E.pdf
c3d43da53aeb211aee06753882b0d83f32577b825de5f251b562e77dc86671eb  ADatP-4774.1 EDA V1 E.pdf
45dd56e33eb67ffcd486bb42755a283f2fe8596bb660887bf9cbdb574060863e  ADatP-4778 EDA V1 E.pdf
1000a7594133d951ca8f3739a5b55cdfe4fd6be8525f1911cbda31dcf6d48067  ADatP-4778.1 EDA V1 E.pdf
778376bdeecbc63b8612508876fbefa7c53ebbe558debe1bd5b48dbb2e669033  ADatP-4778.2_EDA_V1_E.pdf
14b50994a981990b98ac5f6340fac6db5f48990b44e825b6b7cd851d6e9db262  TN-1491_Edition2-Binding_Profiles_v1.0-Signed.pdf
bd710416630bb559db66813dc1bb48cedd10a9f181666afd36488a9908e7a4d5  xmlspif.org/schema/2017/12/xmlspif.xsd (SPIF 2.1)
e372c16e656dfa8571d4d8b834f32dc55f881d3c9a12daacf57ce1490da4a434  xmlspif.org/schema/xmlspif.xsd (SPIF 3.0, 3.07, fetched 2026-09-26)
```

[4774]: https://www.jedi-sec.us/downloads/MISC_PDF/ADatP-4774%20EDA%20V1%20E.pdf
[4774-gh]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/documentation/ADatP-4774%20EDA%20V1%20E.pdf
[4774.1]: https://www.jedi-sec.us/downloads/MISC_PDF/ADatP-4774.1%20EDA%20V1%20E.pdf
[4774.1-gh]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/documentation/ADatP-4774.1%20EDA%20V1%20E.pdf
[4778]: https://www.jedi-sec.us/downloads/MISC_PDF/ADatP-4778%20EDA%20V1%20E.pdf
[4778.1]: https://jedi-sec.us/downloads/MISC_PDF/ADatP-4778.1%20EDA%20V1%20E.pdf
[4778.2]: https://storage.nisp.nw3.dk/ADatP-4778.2_EDA_V1_E.pdf
[tn1491]: https://storage.nisp.nw3.dk/TN-1491_Edition2-Binding_Profiles_v1.0-Signed.pdf
[nisp4774]: https://nisp.nw3.dk/coverdoc/nato-stanag4774.html
[nisp4778]: https://nisp.nw3.dk/coverdoc/nato-stanag4778.html
[nisp47782]: https://nisp.nw3.dk/standard/nato-adatp-4778.2-ed.a-v1.html
[nispfmn]: https://nisp.nw3.dk/serviceprofile/fmn5-20231123-prf-8.html
[xmlspif]: http://www.xmlspif.org/
[xmlspifschema]: http://www.xmlspif.org/?page_id=51
[spif21]: http://www.xmlspif.org/schema/2017/12/xmlspif.xsd
[spif21b]: http://www.xmlspif.org/schema/2026/08/xmlspif.xsd
[spif30]: http://www.xmlspif.org/schema/xmlspif.xsd
[spif30acme]: http://www.xmlspif.org/schema/2026/03/ACMESecurityPolicy-spif30.spif
[ecma376]: https://ecma-international.org/publications-and-standards/standards/ecma-376/
[ecma1]: https://ecma-international.org/wp-content/uploads/ECMA-376-1_5th_edition_december_2016.zip
[ecma2]: https://ecma-international.org/wp-content/uploads/ECMA-376-2_5th_edition_december_2021.zip
[ecma4]: https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip
[xmldsig-xsd]: https://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd
[xmlmime-xsd]: https://www.w3.org/2005/05/xmlmime
[wsu-xsd]: http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd
[oo-changelog]: https://api.onlyoffice.com/docs/office-api/more-information/changelog/
[spiffing]: https://github.com/surevine/spiffing/tree/170af8c6009c9acd456f9093df445fd582ba7dba
[spiffing-java]: https://github.com/dwd/spiffing-java/tree/38a916ba0e7dd01a505da42ef8c6bb13f183fcdc
[sparrow]: https://github.com/FireFlans/sparrow/tree/e4959b8933a32f2059bca1fae1901a2ac5a73958
[sp-parse]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/label.cc#L207-L267
[sp-write]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/label.cc#L328-L384
[sp-tagset]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/tagset.cc#L42-L48
[sp-tagtype]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/spif.cc#L225-L247
[sp-codes]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/spif.cc#L177-L205
[sp-valid]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/spif.cc#L693-L699
[sp-acdf]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/spif.cc#L646-L679
[sp-marking]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/spif.cc#L544-L601
[sp-catmarking]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/spif.cc#L497-L541
[sp-phrase]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/marking.cc#L36-L49
[sp-class]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/classification.cc#L48-L53
[sp-cat]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/category.cc#L54-L63
[sp-group]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/categorygroup.cc#L34-L53
[sp-catdata]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/src/categorydata.cc#L44-L60
[sp-nato-test]: https://github.com/surevine/spiffing/blob/170af8c6009c9acd456f9093df445fd582ba7dba/test-data/nato-4774-17-1.nato
[spj-read]: https://github.com/dwd/spiffing-java/blob/38a916ba0e7dd01a505da42ef8c6bb13f183fcdc/src/main/java/io/cridland/spiffing/Wire.java#L66-L91
[spj-write]: https://github.com/dwd/spiffing-java/blob/38a916ba0e7dd01a505da42ef8c6bb13f183fcdc/src/main/java/io/cridland/spiffing/Wire.java#L108-L124
[spj-tagtype]: https://github.com/dwd/spiffing-java/blob/38a916ba0e7dd01a505da42ef8c6bb13f183fcdc/src/main/java/io/cridland/spiffing/TagType.java#L16-L32
[spj-rules]: https://github.com/dwd/spiffing-java/blob/38a916ba0e7dd01a505da42ef8c6bb13f183fcdc/src/main/java/io/cridland/spiffing/Spif.java#L126-L151
[spj-valid]: https://github.com/dwd/spiffing-java/blob/38a916ba0e7dd01a505da42ef8c6bb13f183fcdc/src/main/java/io/cridland/spiffing/Spif.java#L209-L231
[spj-markings]: https://github.com/dwd/spiffing-java/blob/38a916ba0e7dd01a505da42ef8c6bb13f183fcdc/src/main/java/io/cridland/spiffing/Markings.java#L55-L77
[spa-struct]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/structures/label.go#L7-L22
[spa-gen]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/utils/labels.go#L27-L52
[spa-type]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/utils/categories.go#L25-L41
[spa-app]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/playground/src/App.js#L152-L171
[spa-spif]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/structures/SPIF.go#L58-L81
[spa-mentions]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/utils/mentions.go#L10-L30
[spa-dominant]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/utils/dominant.go#L8-L136
[spa-label]: https://github.com/FireFlans/sparrow/blob/e4959b8933a32f2059bca1fae1901a2ac5a73958/test/labels/label1.xml
