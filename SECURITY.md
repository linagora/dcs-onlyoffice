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
- Portions encrypted before access by clearance carry no attribute value, and OpenTDF hands their key to anyone signed in.
- OpenTDF answers a decision it could not make, for instance when the clearance directory cannot be read, the same way as a refusal: the panel shows both as "Access denied" until it is reopened.
- The `standalone` profile is for development and isolated demos: it uses a local certificate authority, fictional accounts whose password is their login, and it allows the OAuth password grant for the tests.
- Portal sessions live in memory, and ONLYOFFICE Docs Community Edition keeps editing sessions in memory: a restart signs users out and closes open sessions.

Secrets belong in `deploy/.env`, which Git ignores. Never commit credentials, even revoked ones, or real protected content.
