# Hosted mode

In hosted mode, the stack runs on a Docker host behind an existing reverse proxy that terminates TLS, and users sign in with an external OpenID Connect provider. The `standalone` profile (local proxy, local certificate authority, local IdP) is not used.

## Requirements

- **DNS**: `portail.<DOMAIN>`, `docs.<DOMAIN>` and `tdf.<DOMAIN>` point to the reverse proxy. A wildcard record for `*.<DOMAIN>` works.
- **TLS**: the reverse proxy holds a certificate for these three names, for instance a wildcard certificate.
- **Network**: the reverse proxy reaches the Docker host on three ports (6140, 6141 and 6142 by default). Prefer a private network: the stack publishes these ports on one address only.
- **OpenID Connect client**, registered at the provider:
  - confidential client, authorization code flow with PKCE (S256);
  - redirect URI `https://portail.<DOMAIN>/auth/callback`, post-logout redirect URI `https://portail.<DOMAIN>/`;
  - scopes `openid profile email groups`;
  - access tokens as JWT signed RS256 by a key that has a key id, because the OpenTDF platform validates them itself and cannot use opaque tokens;
  - the claims `email`, `preferred_username`, `name` and `groups` (a JSON array) inside the access token, because the platform only reads the access token;
  - the platform's URL, `https://tdf.<DOMAIN>`, as an additional audience of the access token (or set `OIDC_AUDIENCE` to the audience the provider issues, often the client id);
  - online refresh tokens.

With LemonLDAP::NG, these are options of the relying party: JWT format for access tokens, claims released in access tokens, additional audiences, and the `groups` attribute exported as an array.

## Configuration

Create `deploy/.env` with `deploy/scripts/init-env.sh`, which generates the secrets, then set:

| Variable | Hosted value |
| --- | --- |
| `COMPOSE_PROFILES` | empty: no local proxy and no local IdP |
| `DOMAIN` | the public domain |
| `BIND_ADDRESS` | the Docker host's address that the reverse proxy reaches |
| `PORTAL_PORT`, `DOCS_PORT`, `TDF_PORT` | the published ports, if the defaults are taken |
| `OIDC_ISSUER` | the issuer exactly as the provider's discovery document spells it |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | the registered client |
| `OIDC_SCOPES` | `openid profile email groups` |
| `OIDC_AUDIENCE` | only when access tokens do not carry `https://tdf.<DOMAIN>` in their audience |

`deploy/.env` holds secrets: it is ignored by Git and must stay on the host.

## Reverse proxy

`deploy/nginx/dcs.conf.template` is an nginx site for the three host names. Render it with `envsubst`, as its header shows. It:

- redirects HTTP to HTTPS;
- passes websockets to the Document Server, which co-editing needs;
- sends `X-Forwarded-Proto` and `X-Forwarded-Host`;
- refuses `/internal/`, which only the Document Server may call from the Compose network.

No authentication gate may sit in front of these sites: the editor's websockets and the token-authenticated OpenTDF calls would break.

## Start

```sh
cd deploy
docker compose up -d --build --wait
```

The OpenTDF platform stops at startup when it cannot fetch the provider's discovery document or keys; it restarts automatically until the provider is reachable.

## Checks

```sh
curl -fsS https://portail.<DOMAIN>/healthz          # {"status":"ok"}
curl -fsS https://docs.<DOMAIN>/healthcheck         # true
curl -fsS https://tdf.<DOMAIN>/healthz              # {"status":"SERVING"}
curl -sI https://portail.<DOMAIN>/ | grep -i location   # redirects to the sign-in
```

Then sign in with an account of the provider, open a demo document and check that the labelling panel shows your name.
