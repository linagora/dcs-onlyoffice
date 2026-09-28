# Contributing to DCS ONLYOFFICE

Thank you for your interest in DCS ONLYOFFICE. Bug reports, ideas, documentation and code are all welcome. This guide explains how to set up the project, the checks to run and the conventions we follow.

Issues and pull requests are public, and written in English. Never include internal information, credentials, personal data or real protected content: use fictional data only.

## Ways to contribute

- **Report a bug or suggest a feature** by opening an [issue](https://github.com/linagora/dcs-onlyoffice/issues/new/choose). Please search the existing issues first.
- **Report a vulnerability privately**, never in a public issue: see [SECURITY.md](SECURITY.md).
- **Improve the documentation**, or the labelling panel's texts, in English and French.
- **Submit a pull request.** For anything beyond a small fix, open an issue first so that we agree on the change before you invest time in it.

## Development environment

The `standalone` stack runs entirely on your machine, with fictional accounts, a fictional security policy and fictional documents.

Requirements: Docker with Compose v2, Node.js 22.18 or later, pnpm 10 (`corepack enable` provides it), OpenSSL, and xmlsec1, the independent verifier of the document label binding's signature that the tests run (`brew install libxmlsec1` on macOS, `apt-get install xmlsec1` on Debian and Ubuntu).

```sh
pnpm install
deploy/scripts/init-env.sh                                # writes deploy/.env
(cd deploy && docker compose up -d --build --wait)        # the standalone stack on dcs.test
pnpm --filter @dcs/e2e exec playwright install chromium firefox
```

- **Sign in.** Point the stack's host names to your machine, as the [README](README.md#run-the-stack-locally) shows, then open https://portail.dcs.test and sign in with a fictional account: `alice`, `bob`, `chloe`, `dan` or `erin`, whose password is the login. `alice` is an administrator. The end-to-end tests need no hosts file: their browsers resolve the host names on their own.
- **Rebuild after a change.** The portal and the policy service run their TypeScript sources directly with Node.js type stripping, and the portal's image also builds the plugin: after a change to any of the three, rebuild their images with `docker compose up -d --build`.
- **Configuration upgrades.** Running `deploy/scripts/init-env.sh` again on an existing `deploy/.env` sets the secrets that are missing or empty, such as those a new version introduces, and changes nothing else; other new settings have defaults in the Compose file. The signed binding brought three: the demo key that signs bindings, its certificate and the secret the portal and the policy service share. A `deploy/.env` created before portion locks existed lacks `PORTION_LOCK_LEASE_SECONDS=20`, which the test of an abandoned lock needs: add it, then restart the stack.

## Checks

Run them before asking for a review. The end-to-end tests and the two scripts after them need the running `standalone` stack.

```sh
pnpm typecheck    # every package
pnpm test         # policy service API tests, no stack needed
pnpm e2e          # end-to-end tests against the running stack
pnpm --filter @dcs/e2e search-document-server   # then: no portion text among ONLYOFFICE's working files
pnpm --filter @dcs/e2e check-internal-route     # the Document Server's route serves a document to its own token only
```

The CI runs the type checks, the API tests and the end-to-end tests on Chromium and Firefox, then searches the Document Server's working files for portion texts; it must pass.

- **Browsers.** The end-to-end suite runs on Chromium. Tests of browser-specific behaviour carry the `@cross-browser` tag, and also run on Firefox.
- **Screenshots.** When a page shown in the README changes, refresh the screenshots with `pnpm --filter @dcs/e2e captures`; the header of [`e2e/captures/captures.spec.ts`](e2e/captures/captures.spec.ts) says which stack it expects.

## Conventions

### Language

- **English everywhere.** Everything in the repository is written in English: code, comments, documentation, commit messages, issues and pull requests.
- **Markings** shown to users come from the SPIF, in the language it provides.
- **The plugin's own texts are the one exception.** They exist in English and French, in `plugin/src/messages.ts` and in the `nameLocale` and `descriptionLocale` of `plugin/public/config.json`, and the tests quote them in the language they check. A new text needs both languages; technical error details stay in English.
- **Domain vocabulary.** Name domain concepts with the terms of the glossary, [CONTEXT.md](CONTEXT.md), and avoid the words it lists as ones to avoid. [docs/adr](docs/adr) records the architecture decisions.

### Code

TypeScript is strict. Node.js strips types without transforming code, so only erasable syntax is allowed: no `enum`, `namespace` or constructor parameter properties. On top of that:

- named exports only, never `export default` (build tool configuration files excepted);
- explicit types on exported functions and values;
- no `any`: external data is `unknown` until a type guard checks it;
- `null` rather than `undefined` for a value that is absent on purpose;
- `#` for private members;
- no `console.log`: the servers use the Fastify logger, the plugin its `logProblem` helper;
- every type assertion (`as`) carries a `// SAFETY:` comment saying why it holds;
- `async`/`await` rather than promise chains, and a fire-and-forget promise gets a `.catch()` that reports the failure;
- comments explain why, not what.

### Tests

- **Two public seams.** Tests check behaviour through the policy service's HTTP API, in process with `node:test`, and through the whole stack in the browser, with Playwright. Internals are not tested directly.
- **The stack itself.** Besides these seams, end-to-end tests may act on the stack through `docker compose` in `deploy`: to make the clearance directory unreadable to OpenTDF, as an outage would, then restart the policy service, which restores its grants; to store a file in the portal's storage, as someone with access to it could; and to read the portal's log, which is the journal of label changes.
- **Portion texts.** One check looks further, because keeping portion texts out of ONLYOFFICE is what the project guarantees first: every portion text a test writes carries a marker (`e2e/tests/support/marker.ts`), and after the end-to-end suite a script searches the Document Server's working files for it.
- **Independent expected values.** Expected values come from the standards, the SPIF or a reference implementation, never recomputed the way the code computes them.

### Commits

We follow [Conventional Commits](https://www.conventionalcommits.org), with a capitalised subject in the imperative mood:

```text
feat(plugin): Insert portions from the context menu
test(e2e): Write to a document bypassing the panel
fix(deploy): Load ONLYOFFICE's analytics module under a name ad blockers allow
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test` and `chore`. Scopes in use: `plugin`, `portal`, `policy`, `deploy`, `e2e`, `ci`, `demo` and `research`.
- One subject per commit. When the reason for a change is not obvious from the diff, the body explains it, wrapped at 72 columns. Reference issues with `Refs #12` or `Closes #12`.
- Files, commits, pull requests and issues carry no attribution to tools: no co-author trailer for a tool, no "generated with" line.
- **Commits must be signed with SSH.** The `main` branch only accepts commits whose signature GitHub verifies:

  ```sh
  git config gpg.format ssh
  git config user.signingkey ~/.ssh/id_ed25519.pub
  git config commit.gpgsign true
  ```

  Then add the same key to your GitHub account as a **signing key** (Settings, SSH and GPG keys, New SSH key, key type "Signing Key"), with the email address of your commits verified on the account.

### Pull requests

- Branch from `main`: `feat/…`, `fix/…` or `chore/…`.
- Keep one concern per pull request. Its title is lowercase and under 70 characters, for example `feat: insert portions from the context menu`.
- The description has a single `## Summary` section with short bullets about what the diff changes, as the pull request template sets out.
- Run the checks above before asking for a review: the CI must pass.
- An automated review comments on every pull request: address its comments or answer them.
- A maintainer reviews the pull request and merges it with a merge commit, which keeps the history of its commits.

## License

By contributing, you agree that your contributions are licensed under the [GNU Affero General Public License v3.0](LICENSE), the license of the project.
