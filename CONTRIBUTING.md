# Contributing to DCS ONLYOFFICE

Thank you for your interest in the project. This guide covers the setup, the conventions and the way changes get merged.

## Before you start

- For anything beyond a small fix, open an issue first so that we agree on the change.
- Issues and pull requests are public. Never include internal information, credentials, personal data or real protected content: use fictional data only.
- Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) explains, never in a public issue.

## Setup

Requirements: Docker with Compose v2, Node.js 22.18 or later, and pnpm 10 (`corepack enable` provides it).

```sh
pnpm install
deploy/scripts/init-env.sh                                # writes deploy/.env
(cd deploy && docker compose up -d --build --wait)        # the standalone stack on dcs.test
pnpm --filter @dcs/e2e exec playwright install chromium firefox
```

Check your work with:

```sh
pnpm typecheck    # every package
pnpm test         # policy service API tests, no stack needed
pnpm e2e          # end-to-end tests against the running stack
pnpm --filter @dcs/e2e search-document-server   # then: no portion text among ONLYOFFICE's working files
pnpm --filter @dcs/e2e check-internal-route     # the Document Server's route serves a document to its own token only
```

The portal and the policy service run their TypeScript sources directly with Node.js type stripping, so after a change to them, rebuild their images: `docker compose up -d --build`.

## Conventions

Everything in the repository is written in English: code, comments, documentation, commit messages, issues and pull requests. Markings shown to users come from the SPIF, in the language it provides. The plugin's own texts are the exception: they exist in English and French, in `plugin/src/messages.ts` and in the `nameLocale` and `descriptionLocale` of `plugin/public/config.json`, and the tests quote them in the language they check. A new text needs both languages; technical error details stay in English.

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

Tests check behaviour through two public seams: the policy service's HTTP API, in process with `node:test`, and the whole stack through the browser with Playwright. Internals are not tested directly. One check looks further, because keeping portion texts out of ONLYOFFICE is what the project guarantees first: every portion text a test writes carries a marker (`e2e/tests/support/marker.ts`), and after the end-to-end suite a script searches the Document Server's working files for it. Expected values come from the standards, the SPIF or a reference implementation, never recomputed the way the code computes them.

## Commits

- Follow [Conventional Commits](https://www.conventionalcommits.org) with a capitalised subject in the imperative mood, for example `feat(plugin): Insert portions from the context menu`. Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test` and `chore`.
- One subject per commit. When the reason for a change is not obvious from the diff, the body explains it, wrapped at 72 columns. Reference issues with `Refs #12` or `Closes #12`.
- Commits carry no attribution trailer for tools.
- **Commits must be signed with SSH.** The `main` branch only accepts commits whose signature GitHub verifies:

  ```sh
  git config gpg.format ssh
  git config user.signingkey ~/.ssh/id_ed25519.pub
  git config commit.gpgsign true
  ```

  Then add the same key to your GitHub account as a **signing key** (Settings, SSH and GPG keys, New SSH key, key type "Signing Key"), with the email address of your commits verified on the account.

## Pull requests

- Branch from `main`: `feat/…`, `fix/…` or `chore/…`.
- Keep one concern per pull request. Its title is lowercase and under 70 characters, for example `feat: insert portions from the context menu`.
- The description has a single `## Summary` section with short bullets about what the diff changes.
- Run the checks above before asking for a review. The CI runs the type checks, the API tests and the end-to-end tests on Chromium and Firefox, then searches the Document Server's working files for portion texts; it must pass.
- GitHub Copilot reviews every pull request automatically. Address its comments or answer them.
- A maintainer reviews the pull request and merges it with a merge commit, which keeps the history of its commits.

## License

By contributing, you agree that your contributions are licensed under the [GNU Affero General Public License v3.0](LICENSE), the license of the project.
