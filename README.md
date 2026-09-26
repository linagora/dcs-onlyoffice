# DCS ONLYOFFICE

Portion-level confidentiality labelling for ONLYOFFICE Docs, following the NATO labelling standards STANAG 4774 and 4778 (ADatP-4774, ADatP-4778.2).

Authors insert protected portions into a document. Each portion carries its own ADatP-4774 confidentiality label, and the document carries a label computed from its content, stored as the standard ADatP-4778.2 OOXML binding so that third-party labelling tools can read it. A later iteration encrypts each portion (OpenTDF, ZTDF) so that only readers with the need to know can read it.

The security policy is never hard-coded: it is described in an Open XML SPIF file.

## Status

Early prototype, work in progress. Only fictional data is used.

## Quick start

Requirements: Docker with Compose v2. Running the tests also needs Node.js 22.18 or later and pnpm 10.

```sh
deploy/scripts/init-env.sh    # creates deploy/.env with fresh secrets
cd deploy
docker compose up -d --build --wait
```

The generated configuration enables the `standalone` profile: a local reverse proxy with its own certificate authority and a local IdP. The stack answers on `https://portail.dcs.test`; point the host names to your machine first, for example with this line in `/etc/hosts`:

```
127.0.0.1 portail.dcs.test docs.dcs.test idp.dcs.test tdf.dcs.test
```

Sign in with one of the fictional accounts of the local IdP: `alice`, `bob` or `chloe`, the password being the login.

Your browser will warn about the local certificate authority the first time.

To run the stack behind an existing reverse proxy with your own OpenID Connect provider, see [docs/hosting.md](docs/hosting.md).

## Tests

End-to-end tests drive a real browser against the running stack:

```sh
pnpm install
pnpm --filter @dcs/e2e exec playwright install chromium firefox
pnpm e2e
```

Unit and API tests run without the stack: `pnpm test`.

## Repository layout

| Folder | Content |
| --- | --- |
| `portal` | Host portal: sign-in, document list, ONLYOFFICE editor configuration, relay API |
| `plugin` | ONLYOFFICE plugin: the labelling panel on the right of the editor |
| `policy` | Policy service: reads Open XML SPIF files, lists valid labels, renders markings |
| `deploy` | Docker Compose stack, reverse proxies, local IdP, OpenTDF configuration, initialisation job, demo SPIF and documents |
| `e2e` | Playwright end-to-end tests |

## License

[GNU Affero General Public License v3.0](LICENSE).
