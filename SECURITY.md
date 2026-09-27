# Security policy

DCS ONLYOFFICE is a demonstrator. It uses fictional data and a fictional security policy, and it is not hardened for production or for real classified information. Vulnerability reports are still welcome, because its design is meant to carry over to real deployments.

## Supported versions

Only the `main` branch receives fixes. There are no releases yet.

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion about a vulnerability.

Report it privately through GitHub instead: in the repository's **Security** tab, choose **Report a vulnerability**, or go straight to <https://github.com/linagora/dcs-onlyoffice/security/advisories/new>.

Please include:

- the affected component (portal, plugin, policy service or deployment) and the commit;
- the steps to reproduce, and what an attacker gains;
- a suggested fix, if you have one.

We aim to acknowledge reports within five working days and keep you informed until the issue is fixed. With your agreement, the advisory credits you.

Vulnerabilities of ONLYOFFICE Docs, OpenTDF, LemonLDAP::NG or other dependencies belong to their own projects. Tell us as well when they affect this stack.

## Known limitations

These are known properties of the demonstrator, not vulnerabilities:

- Nothing prevents a reader from copying the decrypted text of a portion from the labelling panel into the document body, where it is stored in clear and passes through the Document Server.
- Unencrypted portions, written before encryption existed, keep their text base64-encoded in the DOCX; they can still be read, but no longer created.
- Portions encrypted before the hybrid key, whose key a static RSA key of earlier versions wrapped, can no longer be read: the KAS no longer holds that key.
- The KAS's private keys are wrapped with a root key kept in `deploy/.env`, not in a hardware security module.
- The plugin runs a build of the OpenTDF web SDK from a fork, which adds hybrid key wrapping until a release of the SDK includes it; [`plugin/vendor/README.md`](plugin/vendor/README.md) gives its commit and how to rebuild it.
- Anyone able to edit a document can change a portion's label in clear, which the document label, the placeholder in the body and refused readers rely on. Only readers who open the envelope see the label bound to it, with a warning; someone who holds the envelope's key could even replace that bound label, until the signed ADatP-4778 binding planned for iteration 4.
- The portal checks who opens a document against its saved base label. The panel has the document saved as soon as its base label changes, but someone already in the editing session stays in it, and an editor configuration signed earlier can rejoin that session until it ends.
- Lowering a base label is logged, not prevented: someone able to edit the file outside the panel could still lower it.
- The portal's refusal controls who opens a document; the document's content in clear stays in clear in the portal's storage and on the Document Server. The document list shows how many documents a person may not open, and an address tells whether a document exists.
- OpenTDF answers a decision it could not make, for instance when the clearance directory cannot be read, the same way as a refusal: the panel shows both as "Access denied" until it is reopened.
- The `standalone` profile is for development and isolated demos: it uses a local certificate authority, fictional accounts whose password is their login, and it allows the OAuth password grant for the tests.
- Portal sessions live in memory, and ONLYOFFICE Docs Community Edition keeps editing sessions in memory: a restart signs users out and closes open sessions.

Secrets belong in `deploy/.env`, which Git ignores. Never commit credentials, even revoked ones, or real protected content.
