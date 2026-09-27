# Review instructions

DCS ONLYOFFICE is a demonstrator of portion-level confidentiality labelling for ONLYOFFICE Docs, following NATO STANAG 4774 and 4778 (ADatP-4774, ADatP-4778.2), with policies read from Open XML SPIF files. It is a pnpm monorepo in TypeScript: `portal` (Fastify, OpenID Connect), `plugin` (Preact ONLYOFFICE plugin), `policy` (SPIF, labels, markings, document label), `e2e` (Playwright) and `deploy` (Docker Compose).

When reviewing a pull request, report real problems first, in this order:

1. **Security.** Access tokens must stay on the server: the browser only holds the session cookie. Protected portion text must never be written to the document body. Requests from the Document Server must be verified with its JWT. No secret, credential, internal host name or real protected content may enter the repository; data must be fictional.
2. **Correctness against the standards.** ADatP-4774 labels and the ADatP-4778.2 binding must stay valid against their schemas. Label rules come from the SPIF, never from hard-coded policy names or values. Keep the two document label rules apart: `clear-parts` follows the SPIF access decision, `high-water-mark` follows ADatP-4774.1 section 4.4.
3. **ONLYOFFICE plugin constraints.** Code passed to `callCommand` is serialised and runs in the editor's sandbox: it may only use `Api` and `Asc.scope`. Commands must go through the plugin's command queue, because the SDK keeps a single callback slot.
4. **Conventions** of CONTRIBUTING.md: English only, except the plugin's French texts (`plugin/src/messages.ts`, `plugin/public/config.json`) and the tests that check them; named exports; explicit types on exported symbols; no `any`, external data is `unknown` until checked; `null` rather than `undefined`; `#` private members; no `console.log`; every `as` assertion has a `// SAFETY:` comment; `async`/`await` rather than promise chains; only erasable TypeScript syntax (no `enum`, `namespace` or parameter properties).
5. **Tests.** Behaviour is tested through the policy service's HTTP API and through the browser against the whole stack, not through internals. Expected values must come from an independent source, not be recomputed the way the code does. Every portion text an end-to-end test writes carries the marker of `e2e/tests/support/marker.ts`, which the CI then looks for among the Document Server's working files.

Do not comment on:

- `plugin/public/vendor/`, files copied from ONLYOFFICE as they are;
- `docs/research/`, research notes;
- `pnpm-lock.yaml`;
- formatting that the existing code already follows.

Keep comments short and concrete: say what breaks and when, and suggest a fix.
