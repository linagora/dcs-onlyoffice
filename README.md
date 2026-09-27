<div align="center">

# DCS ONLYOFFICE

**Data-centric security for ONLYOFFICE Docs: portion-level confidentiality labels following NATO STANAG 4774 and 4778.**

[![CI](https://github.com/linagora/dcs-onlyoffice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/linagora/dcs-onlyoffice/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
![Status: demonstrator](https://img.shields.io/badge/status-demonstrator-orange.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

[Overview](#overview) · [Quick start](#quick-start) · [Architecture](#architecture) · [Configuration](#configuration) · [Development](#development) · [Roadmap](#roadmap) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

</div>

## Overview

A document often mixes information of different sensitivity: a report releasable to partner nations may hold a few paragraphs restricted to one nation. Office suites label and handle such a document as a whole, so the restrictive parts are either removed or the whole document inherits the strictest marking and can no longer be shared.

DCS ONLYOFFICE lets authors insert **protected portions** into a document edited in ONLYOFFICE Docs:

- each portion carries its own **ADatP-4774 confidentiality label**, chosen from the labels the security policy allows;
- the protected text is typed in a side panel and **never reaches the document body**, which only shows a locked, coloured placeholder;
- the document carries a **label computed from its content**, stored as the standard **ADatP-4778.2 OOXML binding**, so that other labelling tools can read it;
- the security policy is never hard-coded: it is read from an **Open XML SPIF** file.

A later iteration encrypts each portion with [OpenTDF](https://opentdf.io), using hybrid post-quantum key encapsulation, so that only readers with the need to know can read it.

> [!IMPORTANT]
> This is a **demonstrator**, not a product. It uses fictional data and a fictional policy only, and is not hardened for production or for real classified information.

## Features

- **Single sign-on** with OpenID Connect (authorization code with PKCE); tokens stay on the server, the browser only holds a session cookie.
- **Document portal**: document list, new documents from templates, editing and read-only sessions, saving through the Document Server callbacks.
- **Labelling panel** in the editor: shows the signed-in user, lists the valid labels, inserts protected portions and highlights the portion under the cursor. Entry points are also in the editor's context menu and **Insert** tab.
- **Document label** computed from a base label and the portions' labels, with two rules: `clear-parts` (the base label plus an indicator when a portion is more restrictive) or `high-water-mark` (the ADatP-4774.1 dominant label).
- **Co-editing**: portions and the document label reach co-authors in real time; concurrent insertions converge to the right label.
- **Policy service**: Open XML SPIF 2.1 reader, valid labels and their rules, markings in several languages, ADatP-4774 serialization and the ADatP-4778.2 binding part.
- **OpenTDF platform** already running and trusting the identity provider, ready for the encryption iteration.
- **End-to-end tests** against the whole stack in CI, which keeps a trace, a screenshot and the saved DOCX files of every test.

## Quick start

Requirements: Docker with Compose v2. The tests also need Node.js 22.18 or later and pnpm 10.

```sh
git clone https://github.com/linagora/dcs-onlyoffice.git
cd dcs-onlyoffice
deploy/scripts/init-env.sh    # writes deploy/.env with fresh secrets
cd deploy
docker compose up -d --build --wait
```

The generated configuration enables the `standalone` profile: a local reverse proxy with its own certificate authority and a local LemonLDAP::NG identity provider with fictional accounts. Point the host names to your machine, for example in `/etc/hosts`:

```text
127.0.0.1 portail.dcs.test docs.dcs.test idp.dcs.test tdf.dcs.test
```

Then open <https://portail.dcs.test> and sign in as `alice`, `bob` or `chloe` (the password is the login). Your browser warns about the local certificate authority the first time.

To stop the stack and delete its data: `docker compose down -v`.

To run behind an existing reverse proxy with your own OpenID Connect provider, see [docs/hosting.md](docs/hosting.md).

## Architecture

```mermaid
flowchart LR
  user([Browser]) -->|HTTPS| proxy[Reverse proxy]
  proxy --> portal[Portal<br/>sign-in, documents, plugin]
  proxy --> docs[ONLYOFFICE Docs]
  proxy --> tdf[OpenTDF platform]
  portal --> policy[Policy service<br/>Open XML SPIF]
  docs -->|load and save| portal
  portal -->|OpenID Connect| idp[Identity provider]
  tdf -->|token keys| idp
  tdf --> db[(PostgreSQL)]
```

| Component | Role | Technology |
| --- | --- | --- |
| `portal` | Sign-in, document list and storage, editor configuration, relay to the policy service, serves the plugin | Node.js, Fastify, `openid-client` |
| `plugin` | Labelling panel inside the editor | Preact, Vite, ONLYOFFICE plugin API |
| `policy` | Reads SPIF files, validates labels, renders markings, computes the document label and its ADatP-4778.2 part | Node.js, Fastify |
| ONLYOFFICE Docs | Document editing and co-editing | ONLYOFFICE Docs 9.4 Community Edition |
| OpenTDF | Key access and attribute-based access control, for the encryption iteration | OpenTDF platform 0.27 |
| Reverse proxy and IdP | Local TLS and fictional accounts in the `standalone` profile | Caddy, LemonLDAP::NG |

### What the document holds

- **Each portion** is a locked content control whose tag names the portion and its label, and whose content is a placeholder with the portion's marking. Its text and its ADatP-4774 label sit in **one Custom XML part per portion** (`urn:linagora:dcs:portion:1`).
- **The document label** is stored as an ADatP-4778.2 `BindingInformation` part that references the package parts it covers, alongside a small part (`urn:linagora:dcs:document:1`) that keeps the base label.
- Custom XML parts survive saving to DOCX and reopening, and propagate to co-authors; the end-to-end tests prove both.

## Configuration

The stack reads `deploy/.env`, created from [`deploy/.env.example`](deploy/.env.example), which documents every setting.

| Setting | Purpose |
| --- | --- |
| `DOMAIN` | Public domain: host names are `portail.`, `docs.` and `tdf.` under it |
| `COMPOSE_PROFILES` | `standalone` for the local proxy and IdP, empty for the hosted mode |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SCOPES` | OpenID Connect provider and client |
| `OIDC_AUDIENCE` | Audience OpenTDF expects in access tokens (default `https://tdf.<DOMAIN>`) |
| `MARKING_LANGUAGE` | Language of the rendered markings (default `fr`, from the demo SPIF) |
| `ROLLUP_RULE` | Document label rule: `clear-parts` (default) or `high-water-mark` |
| `BIND_ADDRESS`, `PORTAL_PORT`, `DOCS_PORT`, `TDF_PORT` | Published ports in the hosted mode |

The demo policy is [`deploy/spif/demo-fr.spif.xml`](deploy/spif/demo-fr.spif.xml): a fictional French policy with four labels, NON PROTÉGÉ, DIFFUSION RESTREINTE, DIFFUSION RESTREINTE – SPÉCIAL FRANCE and DIFFUSION RESTREINTE – DIFFUSION OTAN. Drop other SPIF files in `deploy/spif` to use other policies.

## Development

```sh
pnpm install
pnpm typecheck                                            # every package
pnpm test                                                 # policy service API tests, no stack needed
pnpm --filter @dcs/e2e exec playwright install chromium firefox
pnpm e2e                                                  # end-to-end tests, against the running stack
```

The end-to-end suite runs on Chromium, and the browser-specific checks also run on Firefox. It needs the `standalone` stack running on `dcs.test`; the browsers resolve its host names on their own, no hosts file needed.

| Folder | Content |
| --- | --- |
| [`portal`](portal) | Host portal |
| [`plugin`](plugin) | ONLYOFFICE labelling plugin |
| [`policy`](policy) | Policy service and its API tests |
| [`e2e`](e2e) | Playwright end-to-end tests |
| [`deploy`](deploy) | Docker Compose stack, proxies, local IdP, OpenTDF configuration, demo SPIF and documents |
| [`docs`](docs) | Hosting guide and research notes on the standards, ONLYOFFICE, LemonLDAP::NG and OpenTDF |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions, commit rules and the pull request workflow.

## Roadmap

| Iteration | Scope | Status |
| --- | --- | --- |
| 1 | Stack, single sign-on, portal, labelling panel, policy service | Done |
| 2 | Protected portions without encryption, document label and ADatP-4778.2 binding, co-editing | Done |
| 3 | Encryption of portions with OpenTDF and hybrid post-quantum key encapsulation, clearance directory, access decisions | Planned |
| 4 | Editing existing portions, portion versions, header and footer markings, signed ADatP-4778 binding | Planned |
| 5 | Microsoft Purview label mapping, standalone packaging, demo script | Planned |
| 6 | Spreadsheet editor | Planned |

## Standards

- **STANAG 4774 / ADatP-4774**: confidentiality metadata label syntax.
- **STANAG 4778 / ADatP-4778**: metadata binding, with its OOXML profile ADatP-4778.2.
- **Open XML SPIF 2.1**: security policy information files ([xmlspif.org](http://www.xmlspif.org/)).
- **OpenTDF / ZTDF**: trusted data format and key access ([opentdf.io](https://opentdf.io)).

The tests compare the label and binding outputs with reference documents validated against the standards' schemas, and label verdicts with the spiffing reference implementation. The notes in [docs/research](docs/research) cite the sections they rely on.

## Security

Please do not report vulnerabilities in public issues: see [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 LINAGORA.

This program is free software, released under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version on a server, you must offer its source code to the users of that server.

## Acknowledgements

Built on [ONLYOFFICE Docs](https://github.com/ONLYOFFICE/DocumentServer), [OpenTDF](https://github.com/opentdf/platform), [LemonLDAP::NG](https://lemonldap-ng.org) and [Caddy](https://caddyserver.com). Label verdicts in the tests were checked against [spiffing](https://github.com/surevine/spiffing).
