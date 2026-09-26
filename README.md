# DCS ONLYOFFICE

Portion-level confidentiality labelling for ONLYOFFICE Docs, following the NATO labelling standards STANAG 4774 and 4778 (ADatP-4774, ADatP-4778.2).

Authors insert protected portions into a document. Each portion carries its own ADatP-4774 confidentiality label, and the document carries a label computed from its content, stored as the standard ADatP-4778.2 OOXML binding so that third-party labelling tools can read it. A later iteration encrypts each portion (OpenTDF, ZTDF) so that only readers with the need to know can read it.

The security policy is never hard-coded: it is described in an Open XML SPIF file.

## Status

Early prototype, work in progress. Only fictional data is used.

## License

[GNU Affero General Public License v3.0](LICENSE).
