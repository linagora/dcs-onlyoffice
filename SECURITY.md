# Security policy

DCS ONLYOFFICE is a demonstrator. It uses fictional data and a fictional security policy, and it is not hardened for production or for real classified information. Vulnerability reports are still welcome, because its design is meant to carry over to real deployments.

## Supported versions

Only the `main` branch receives fixes. There are no releases yet.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues, pull requests or comments.**

Report them privately with GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to [the reporting form](https://github.com/linagora/dcs-onlyoffice/security/advisories/new).

Please include as much of the following as you can:

- the component concerned: portal, labelling plugin, policy service, OpenTDF provisioning job, or deployment files and scripts (`deploy/`);
- the commit where you found it;
- a description of the vulnerability and of what an attacker gains;
- the steps to reproduce it, or a proof of concept;
- a suggested fix or mitigation, if you have one.

Never include real credentials, tokens, personal data or protected content in a report: use the fictional accounts and data of the `standalone` stack, and redact the rest.

## What to expect

- We acknowledge your report and keep you informed until the issue is fixed.
- We may ask you for details, and we agree with you on the date of any public disclosure.
- Once the fix is on `main`, we publish a security advisory which, with your agreement, credits you.

## Guidelines for security research

- Use the local `standalone` stack described in the [README](README.md#run-the-stack-locally): it runs the whole stack on your machine, with fictional accounts, a fictional security policy and fictional documents.
- Only test instances that you run yourself, or that you are explicitly allowed to test. Never access or change other people's data, and do not degrade a service: no load or denial-of-service testing.
- Never put real personal data or real protected content into the stack.
- Stop and report as soon as you have shown that a vulnerability exists.

## Scope

In scope: the code and configuration of this repository: the portal, the labelling plugin, the policy service and its OpenTDF provisioning job, and the deployment files and scripts of `deploy/`.

Out of scope:

- vulnerabilities of ONLYOFFICE Docs, OpenTDF, LemonLDAP::NG, Caddy or other dependencies, which belong to their own projects: report them to their maintainers, and tell us as well when they affect this stack;
- the known limitations below, which are properties of the demonstrator, not vulnerabilities.

## Known limitations

These are known properties of the demonstrator, not vulnerabilities:

- Nothing prevents a reader from copying the decrypted text of a portion from the labelling panel into the document body, where it is stored in clear and passes through the Document Server.
- Portion locks coordinate the authors who change portions through the panel; they are not an access control. Anyone able to edit a document can still write a portion's part outside the panel, and the policy service takes the portion label the panel sends for the lock's check. The portal lets only the people who may open a document see or take its locks. Locks live in the policy service's memory: a restart frees them all, and two authors could then change the same portion, the last one's change prevailing. During an editing session, the editor's undo can bring back a portion's earlier envelope and version; the policy service remembers the version a change wrote for a minute only, so that a co-author's editor that has not received the change yet does not change the version before it, and so that an undone change does not keep the portion from changing.
- The window that shows a portion's text next to the cursor relies on plugin window options that ONLYOFFICE Docs does not document (`ShowWindow` with `isTargeted` and `isCustomWindow`), which an end-to-end test checks. To place and close it, the panel receives the keys pressed and the clicks made in the document, and keeps none of them. The editor sees the window's size, which grows with the text, as the envelope's size in the document already shows.
- Unencrypted portions, written before encryption existed, keep their text base64-encoded in the DOCX; they can still be read, but no longer created.
- Portions encrypted before the hybrid key, whose key a static RSA key of earlier versions wrapped, can no longer be read: the KAS no longer holds that key.
- The KAS's private keys are wrapped with a root key kept in `deploy/.env`, not in a hardware security module.
- The plugin runs a build of the OpenTDF web SDK from a fork, which adds hybrid key wrapping until a release of the SDK includes it; [`plugin/vendor/README.md`](plugin/vendor/README.md) gives its commit and how to rebuild it.
- Anyone able to edit a document can change a portion's label in clear, which the document label, the placeholder in the body and refused readers rely on. Only readers who open the envelope see the label bound to it, with a warning; someone who holds the envelope's key could even replace that bound label.
- The signature of the document label's binding proves that the platform computed the label from the labels in clear, and bound it to the package parts it references, when it stored the file; it proves nothing of who wrote the content. The policy service signs whatever the saved labels in clear give, so a label lowered in the editor is signed too, and logged. The signature covers the parts ADatP-4778.2 lists; not the package's relationships (`_rels`) and content types (`[Content_Types].xml`), nor its other parts, the Custom XML parts among them: the base label's part, and the portions' parts, whose envelopes bind their labels. A verifier must digest again the package parts that the signature's `Manifest` references: `xmlsec1` reports them but still exits with 0 when one of them no longer matches. A file that the policy service could not sign is stored unsigned, and the failure logged. The demo key and its self-signed certificate live in `deploy/.env`, not in a hardware security module; a deployment would use a key and a certificate its PKI issues.
- The portal checks who opens a document against its saved base label, and decides again for whoever joins its editing session as an editor. The Document Server reports no viewer: someone whose clearance is revoked while a session lasts can still view it live with a configuration signed earlier, and an editor who rejoins sees the document as it is before the portal disconnects them. A base label that excludes someone holding a configuration, or whose holders the portal no longer knows after a restart, ends the session for everyone, viewers included: the Document Server then refuses the earlier configurations, and the document opens again once the session's last save is stored.
- Lowering a base label or a portion label is logged, not prevented: someone able to edit the file outside the panel could still lower it. The portal's log is the journal of these changes: every change of a base label or a portion made in the panel, with the person who made it, the labels before and after and, for a portion, its versions; and every save that lowers a label in clear, a portion's in its part or in its placeholder's tag included, with the people who held a configuration for the editing session, since the Document Server only names a save's last editor. It never holds a portion's text. A change the panel reports while the policy service cannot decide who may open the document is refused and not retried: only the comparison of saves then records it, if it lowers a label. The journal lives in the portal container's log, which Docker keeps as long as the container exists.
- The portal's refusal controls who opens a document; the document's content in clear stays in clear in the portal's storage and on the Document Server. The document list shows how many documents a person may not open, and an address tells whether a document exists.
- The panel reads the KAS's "pdp-denied" answer as a decision OpenTDF could not make, shows a technical failure and retries it. OpenTDF 0.27 also gives that answer to evaluation errors it does not classify, which the panel then keeps retrying instead of showing a refusal.
- The Document Server fetches the addresses an editor makes it fetch, private ones included, and signs its requests: the portal's internal route cannot tell a download of the edited document from one an editor provoked.
- The `standalone` profile is for development and isolated demos: it uses a local certificate authority, fictional accounts whose password is their login, and it allows the OAuth password grant for the tests.
- Portal sessions live in memory, and ONLYOFFICE Docs Community Edition keeps editing sessions in memory: a restart signs users out and closes open sessions.

Secrets belong in `deploy/.env`, which Git ignores. Never commit credentials, even revoked ones, or real protected content.
