# OpenTDF platform v0.27.0 with an external OIDC provider (not Keycloak)

Research notes for step 1 of the Docker Compose stack: the OpenTDF platform (service release
`service/v0.27.0`) starts with PostgreSQL, is reachable through a reverse proxy on its own host
name, accepts API calls authenticated with an access token issued by an external OIDC provider
(LemonLDAP::NG), rejects anonymous calls, and runs with DPoP disabled. Nothing is encrypted yet.

- Date of research: 2026-09-26.
- Primary source: [opentdf/platform at tag `service/v0.27.0`][tag] (commit
  `229b8e8d7d81e8b15f461ac95ced620c1083c11f`, released 2026-09-22, see the
  [release][release] and [changelog][changelog]). Unless stated otherwise, every file link below
  is pinned to that tag.
- Secondary primary sources: the published container image, the OpenTDF documentation
  repository (pinned to commits), the Go standard library and the JWT library at the exact
  versions compiled into the image, the Connect protocol specification, and the LemonLDAP::NG
  documentation and source (only for IdP-side settings).

## How this was researched

1. The source tree of the tag was downloaded and read (docs, example configs, `service/`,
   `lib/ocrypto`).
2. The published image was inspected read-only: manifest list, image config, layer contents,
   the Go build info of the binary, and `opentdf version` / `opentdf --help` in throwaway
   `docker run --rm --entrypoint /usr/bin/opentdf` containers.
3. Small throwaway Go tests were run against the tag's own code in a scratch copy of the source
   (outside this repository) to observe behaviour that is easy to get wrong: configuration and
   environment variable loading, token validation and the HTTP responses of the real Connect
   authentication/authorization interceptors in front of a stub `NamespaceService`, CORS
   preflights, and KAS key loading. See [Appendix A](#appendix-a-verification-log).
4. The full `opentdf start` against a real PostgreSQL and a real LemonLDAP::NG was **not** run.

Legend used below: **[verified]** means observed by executing the tag's code or by inspecting the
image; **[source]** means read in the tag's source or documentation; **UNVERIFIED** means not
confirmed.

## Summary

- Image: `registry.opentdf.io/platform:v0.27.0` (also `v0.27`), multi-arch `linux/amd64` and
  `linux/arm64`, `ENTRYPOINT ["/usr/bin/opentdf"]`, no `CMD`: pass
  `start --config-file <path>`. Runs as uid 65532, has no shell. `ghcr.io/opentdf/platform`
  refuses anonymous pulls and is not where releases are published. [verified]
- A YAML config file is mandatory. `OPENTDF_*` environment variables override a key **only if
  that key exists in the YAML file**. [verified]
- Startup is fail-fast: the platform fetches `<issuer>/.well-known/openid-configuration` and the
  JWKS, and connects to PostgreSQL; any failure (including an untrusted TLS certificate) aborts
  the process, with no retry. A private CA is trusted with `SSL_CERT_FILE` / `SSL_CERT_DIR`.
  [verified for the IdP part; source for the database part]
- Per request: JWT signature from the JWKS with a **mandatory `kid` header**, `iss` equal to the
  issuer **published in the discovery document**, `aud` containing `server.auth.audience`,
  `exp`/`nbf`/`iat` if present. No introspection, no userinfo: access tokens must be JWTs that
  carry the role claims. [verified] LemonLDAP::NG only emits `kid` when its signing key has a key
  ID, and only puts user claims in JWT access tokens when asked to (section 8.1). [source]
- Keycloak-flavoured defaults to replace: `groups_claim: realm_access.roles`,
  `client_id_claim: azp`, ERS `mode: keycloak`, and the built-in groupings of the Keycloak roles
  `opentdf-admin` / `opentdf-standard`. [source]
- Authorization: Casbin model v1 by default with roles `admin`, `standard`, `unknown`; a caller
  whose token maps to no role gets `role:unknown`, which can only call `kas.AccessService/Rewrap`
  plus the public endpoints. [verified]
- Proof of trust: `POST /policy.namespaces.NamespaceService/ListNamespaces` returns 200 for a
  mapped role, 403 `permission_denied` for a valid token without role, 401 `unauthenticated`
  without a token. [verified]
- CORS allows no origin by default; the browser app origin must be listed. [verified]
- KAS keys: RSA needs `cert` (a public key PEM is enough), EC private keys must be PKCS#8; KAS
  enabled without any key configuration crashes at startup. Hybrid `hpqt:secp384r1-mlkem1024`
  keys come from the platform's own `keygen` tool. [verified]
- Several documented keys are wrong at v0.27.0 (`server.port` default, `db.runMigration`,
  `auth.cache_refresh`, `grpc.reflection`). [verified for the first two; source for the others]

## 1. Container image

| Item | Value | Evidence |
| --- | --- | --- |
| Image name | `registry.opentdf.io/platform` | release workflow pushes to a registry secret; the official docs compose and Helm chart use `registry.opentdf.io/platform` ([docs compose][docs-compose-platform], [chart values][charts-values]) |
| Tags for this release | `v0.27.0`, `v0.27`, `sha-229b8e8d7d81e8b15f461ac95ced620c1083c11f` | tag rules in [release-build.yaml][release-build]; all three present in the [registry tag list][registry-tags] [verified] |
| Index digest | `sha256:4f35e6a10af23a2aaeb53133afc28ed8c3a3f23407701e002358231775c5318a` | [manifest][registry-manifest] [verified] |
| Architectures | `linux/amd64` (`sha256:6c2587e4...`), `linux/arm64` (`sha256:57fa00b0...`), plus two BuildKit SLSA provenance attestation manifests | `platforms: linux/amd64,linux/arm64` in [release-build.yaml][release-build]; [manifest][registry-manifest] [verified] |
| Base image | `cgr.dev/chainguard/glibc-dynamic` (no shell, no curl/wget) | [Dockerfile][dockerfile]; layer listing [verified] |
| Entrypoint / command | `ENTRYPOINT ["/usr/bin/opentdf"]`, no `CMD`; the server is the `start` subcommand | [Dockerfile][dockerfile], [start.go][start-cmd]; image config [verified] |
| Subcommands | `start`, `migrate`, `policy`, `provision`, `version`, `completion` | `opentdf --help` [verified]; [root.go][root-go] |
| Version / toolchain | `opentdf version` prints `0.27.0`; binary built with go1.27.1 (jwx v2.1.7, casbin v2.108.0, viper v1.21.0, connect v1.20.0, go-chi/cors v1.2.1) | [verified] (`go version -m`) |
| User | `65532` (`nonroot`, home `/home/nonroot`) | image config and `/etc/passwd` [verified] |
| Working directory | unset (`/`) | image config [verified] |
| Environment | `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` (public CA bundle) | image config, identical on both architectures [verified] |
| Signature | Sigstore bundles attached as OCI referrers; signing certificate identity `https://github.com/opentdf/platform/.github/workflows/release-build.yaml@refs/tags/service/v0.27.0`, issuer `https://token.actions.githubusercontent.com` | [signing step][release-sign], [referrers][registry-referrers] (certificate decoded) [verified]; cryptographic verification with `cosign verify` **UNVERIFIED** (cosign not run) |

`ghcr.io/opentdf/platform:v0.27.0` answered `denied` to an anonymous manifest request, so it is
not usable for this stack (whether it exists privately is UNVERIFIED).

Suggested (not executed) signature check:

```sh
cosign verify registry.opentdf.io/platform@sha256:4f35e6a10af23a2aaeb53133afc28ed8c3a3f23407701e002358231775c5318a \
  --certificate-identity https://github.com/opentdf/platform/.github/workflows/release-build.yaml@refs/tags/service/v0.27.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### 1.1 Where the configuration file is read from

- `opentdf start --config-file <path>` loads exactly that file ([root.go][root-go],
  [start.go][start-cmd], [legacy_loader.go][legacy-loader]). [source]
- Without the flag, viper searches `$HOME/.opentdf/opentdf.yaml`, `./.opentdf/opentdf.yaml`,
  then `./opentdf.yaml` ([legacy_loader.go][legacy-loader]). In the image `$HOME` is
  `/home/nonroot` and the working directory is `/`. [source, verified for image values]
- The file is mandatory: `ReadInConfig` errors abort startup ([legacy_loader.go][legacy-loader],
  [config.go][config-reload]). [source]
- `--config-key` (default `opentdf`) changes both the file base name and the environment
  variable prefix ([root.go][root-go], [legacy_loader.go][legacy-loader]). [source]
- The loader watches the file and re-applies service-level settings on change
  ([legacy_loader.go][legacy-loader]). [source]
- The upstream docs compose runs `["start", "--config-file", "/configs/opentdf.yaml"]`
  ([docs compose][docs-compose-platform]). [source]

### 1.2 Environment variable overrides

- The default loader chain used by `opentdf start` is "legacy" (YAML file + environment) then
  "default settings" ([start.go][loader-order]). [source]
- Naming: prefix `OPENTDF_`, then the dotted key path upper-cased with `.` replaced by `_`,
  through viper `AutomaticEnv` ([legacy_loader.go][legacy-loader]). Snake-case key names keep
  their underscores: `server.auth.policy.groups_claim` is
  `OPENTDF_SERVER_AUTH_POLICY_GROUPS_CLAIM`. [verified]
- **An environment variable only overrides a key that exists in the YAML file** (any
  placeholder value works). The only exceptions are the four keys the loader pre-registers:
  `server.auth.cache_refresh_interval`, `logger.trace_correlation`, `logger.audit_timeout`,
  `server.http.trustedProxies` ([legacy_loader.go][legacy-loader]). Upstream tests assert this
  behaviour ([config_test.go][config-test-env]). With `OPENTDF_DB_PASSWORD=from-env` and no
  `db.password` in the file, the effective password stayed `changeme`; with a placeholder in the
  file, it became `from-env`. [verified]
- List values can be given comma-separated, e.g.
  `OPENTDF_SERVER_CORS_ALLOWEDORIGINS=https://a.example,https://b.example`. [verified]
- Keys are case-insensitive (viper limitation, open issue [#745][issue-745]). [source]
- The documented `OPENTDF_SERVER_CRYPTOPROVIDER_STANDARD='[...]'` form
  ([Configuring.md][cfg-crypto]) does not match the struct shape (`standard.keys`,
  [standard_crypto.go][standard-crypto]); it is likely stale. UNVERIFIED, prefer the YAML file.

## 2. Configuration for step 1

The complete file is in [section 9](#9-complete-minimal-configuration-file-step-1). This section
explains each part.

### 2.1 Database (PostgreSQL) and migrations

- Keys and defaults: `host` (`localhost`), `port` (`5432`), `database` (`opentdf`), `user`
  (`postgres`), `password` (`changeme`), `sslmode` (`prefer`), `schema` (`opentdf`),
  `connect_timeout_seconds` (`15`), `pool.*`, **`runMigrations`** (`true`), `verifyConnection`
  (`true`) ([db.go][db-config]). [source; the `password` and `runMigrations` defaults verified]
- Migrations (goose) run at startup, once per namespace, when `runMigrations` is true
  ([serviceregistry.go][svcreg-start], [db_migration.go][db-migration]). `opentdf migrate`
  exists for out-of-band runs ([migrate.go][migrate-cmd]). [source]
- The documented key `runMigration` ([Configuring.md][cfg-db]) is ignored: a file with
  `runMigration: false` still produced `runMigrations=true`. [verified]
- Each service namespace uses schema `<schema>_<namespace>`, i.e. `opentdf_policy`
  ([optFunc.go][db-optfunc]), created with `CREATE SCHEMA IF NOT EXISTS`
  ([db_migration.go][db-migration]). The DB user therefore needs `CREATE` on the database; the
  owner created by the official `postgres` image has it. [source]
- The connection is pinged at client creation; an unreachable database aborts startup with
  `failed to connect to database` ([db.go][db-connect]). [source]
- PostgreSQL 13 or later is required because migrations use the built-in `gen_random_uuid()`
  ([migration][migration-uuid], [PostgreSQL 13 docs][pg13-uuid]); the upstream compose uses
  `postgres:15-alpine` ([docker-compose.yaml][compose-upstream]). [source]
- The password is `url.QueryEscape`d into a `postgres://` URL and the user name is not escaped
  ([db.go][db-connect]); a space in the password would become `+`. Use a URL-safe random
  password and a plain user name. Derived from source, UNVERIFIED by execution.

### 2.2 Server, port and reverse proxy

- `server.port` defaults to **8080** ([server.go][server-config]); the documentation says 9000
  ([Configuring.md][cfg-server]). [verified]
- `server.host` defaults to all interfaces ([server.go][server-config],
  [server.go][server-http]). [source]
- With `tls.enabled: false` (default) the listener speaks HTTP/1.1 and cleartext HTTP/2 (h2c),
  so TLS terminates at the reverse proxy ([server.go][server-http]). The upstream docs proxy
  (Caddy) forwards with `to h2c://platform:8080` and `versions h2c 2 1.1` so that gRPC also works
  ([docs compose][docs-compose-caddy]). Connect JSON calls from a browser work over HTTP/1.1.
  [source]
- Routing: `POST`/`GET`/`OPTIONS` requests whose path looks like `/<package>.<Service>/<Method>`
  go to the Connect handlers (Connect, gRPC, gRPC-Web); everything else (for example `/healthz`,
  `/.well-known/opentdf-configuration`) goes to plain HTTP handlers
  ([server.go][server-http]). [source]
- Default HTTP read and write timeouts are 10 s ([server.go][server-timeouts],
  [server.go][server-http]). [source]
- `server.http.trustedProxies` (CIDR list) makes audit logs use `X-Forwarded-For` from those
  peers; an invalid CIDR aborts startup ([Configuring.md][cfg-server]). [source]
- `server.grpc.reflectionEnabled` (documented as `grpc.reflection`) defaults to `true`, and the
  reflection handlers are mounted without the auth interceptors
  ([server.go][server-config], [server.go][server-reflection]); disable it on a public host.
  [source]
- `server.public_hostname` is only used to compute the KAS URL when `key_management` is enabled
  ([kas.go][kas-register]). Not needed for step 1. [source]

### 2.3 `server.auth`

| Key | Default | Notes | Evidence |
| --- | --- | --- | --- |
| `enabled` | `true` | disabling is deprecated and logged as such at startup | [config.go][auth-config], [server.go][server-auth-init] |
| `issuer` | none, required | discovery URL base; the discovery document's `issuer` becomes the effective value | [config.go][auth-config], [token_verifier.go][token-verifier] |
| `audience` | none, required | single string, must appear in the token `aud` | [config.go][auth-config], [token_verifier.go][token-verifier] |
| `dpop.enforce` | `false` | deprecated `enforceDPoP` still honoured; a warning `DPoP is not enforced` is logged at startup | [config.go][auth-config] |
| `cache_refresh_interval` | `15m` | minimum JWKS refresh interval; documented as `auth.cache_refresh` | [config.go][auth-config], [legacy_loader.go][legacy-loader], [Configuring.md][cfg-server] |
| `skew` | `1m` | tolerated clock skew for `exp`/`nbf`/`iat` | [config.go][auth-config], [token_verifier.go][token-verifier] |
| `dpopskew` | `1h` | DPoP proof age, irrelevant with DPoP off | [config.go][auth-config] |
| `policy.*` | see section 4 | claims and Casbin policy | [policy.go][policy-go] |

All defaults above were confirmed by loading a config through the tag's loaders. [verified]

### 2.4 CORS for a browser app on another origin

- `server.cors.enabled` defaults to `true`, but `allowedorigins` defaults to `[]`, which allows
  **no** cross-origin request: a preflight from any origin gets no
  `Access-Control-Allow-Origin` ([server.go][server-config], [server.go][server-http]).
  [verified]
- Origins are compared case-insensitively and must match exactly (`scheme://host[:port]`), or
  `"*"` allows any origin ([server.go][server-http]). [verified]
- Default allowed headers: `Accept, Accept-Encoding, Authorization, Connect-Protocol-Version,
  Content-Length, Content-Type, Dpop, X-CSRF-Token, X-Requested-With,
  X-Rewrap-Additional-Context`; default methods `GET, POST, PATCH, DELETE, OPTIONS`;
  `allowcredentials: true`; `maxage: 3600` ([server.go][server-config],
  [Configuring.md][cfg-cors]). [verified]
- The Connect CORS guide also lists `Connect-Timeout-Ms` and `X-User-Agent` for browser clients
  ([Connect CORS][connect-cors]); they are not in the defaults, and a preflight that asks for an
  unlisted header is refused. Adding them with `additionalheaders` keeps the defaults
  ([server.go][server-config], [Configuring.md][cfg-cors]). [verified] Whether web SDK 0.21.0
  actually sends them is UNVERIFIED.
- CORS also wraps the plain HTTP handlers, so `GET /.well-known/opentdf-configuration` is
  readable cross-origin ([server.go][server-http]). [source]
- Let the platform answer preflights (the reverse proxy should pass `OPTIONS` through and not
  add its own CORS headers). Recommendation, not a platform fact.

### 2.5 Which services to enable

- `mode` defaults to `all`, which runs `policy`, `authorization`, `kas`, `wellknown` and
  `entityresolution`; `health` is always registered ([services.go][services-go],
  [Configuring.md][cfg-modes]). [verified default]
- `core` is `policy` + `authorization` + `wellknown`, so `all` is equivalent to
  `core,kas,entityresolution` for this stack. Neither needs `sdk_config`: the in-process SDK is
  used ([start.go][start-modes]). Negations such as `all,-kas` are supported
  ([Configuring.md][cfg-modes]). Parsing of `all`, `all,-kas` and `core,kas,entityresolution`
  was checked. [verified]
- Recommendation: `mode: all`.

### 2.6 KAS keys (shape in 0.27)

With `services.kas.key_management: false` (the default), KAS keys come from
`server.cryptoProvider` and the `services.kas.keyring` list
([kas.go][kas-register], [provider.go][kas-config], [Configuring.md][cfg-kas]). [source]

```yaml
server:
  cryptoProvider:
    type: standard
    standard:
      keys:
        - kid: r1                  # short, unique, stable identifier
          alg: rsa:2048
          private: /etc/opentdf/keys/kas-private.pem   # PKCS#8 or PKCS#1 PEM
          cert: /etc/opentdf/keys/kas-cert.pem         # REQUIRED for RSA: PUBLIC KEY or CERTIFICATE PEM
        - kid: e1
          alg: ec:secp256r1
          private: /etc/opentdf/keys/kas-ec-private.pem # must be PKCS#8 ("BEGIN PRIVATE KEY")
          cert: /etc/opentdf/keys/kas-ec-cert.pem       # X.509 cert, served by LegacyPublicKey
services:
  kas:
    keyring:                        # default (non-legacy) key per algorithm
      - kid: r1
        alg: rsa:2048
      - kid: e1
        alg: ec:secp256r1
```

- Field names `kid`, `alg`, `private`, `cert` ([standard_crypto.go][standard-crypto]); accepted
  `alg` values include `rsa:2048`, `rsa:4096`, `ec:secp256r1`, `hpqt:xwing`,
  `hpqt:secp256r1-mlkem768`, `hpqt:secp384r1-mlkem1024`, `mlkem:768`, `mlkem:1024`
  ([crypto_provider.go][crypto-consts]); the in-process key service serves EC only for P-256
  ([in_process_provider.go][in-process]). [source]
- RSA without `cert` aborts startup (`ocrypto.FromPublicPEM failed`), although the docs call
  `cert` optional ([standard_crypto.go][standard-crypto], [Configuring.md][cfg-crypto]).
  [verified]
- EC private keys are parsed with `x509.ParsePKCS8PrivateKey` only
  ([ec_key_pair.go][ocrypto-ec]). A SEC1 `BEGIN EC PRIVATE KEY` file loads at startup but fails
  later when the public key is requested. [verified]
- `keyring` lists which `kid` is the default per algorithm; legacy copies are inferred when none
  is marked `legacy` ([provider.go][kas-keyring]). Without `keyring`, the deprecated `eccertid` /
  `rsacertid` (used by `opentdf-example.yaml`) or the first key per algorithm is used; `keyring`
  and `eccertid` together panic ([provider.go][kas-keyring], [example yaml][example-yaml]).
  [verified]
- `PublicKey` only serves a key that is the default for the requested algorithm, i.e. a
  non-legacy `keyring` entry (without `keyring`, only the EC P-256 and RSA 2048 keys selected by
  `eccertid` / `rsacertid` or picked first); a loaded key that is not a default can still be used
  by rewrap through its `kid` ([publicKey.go][kas-publickey],
  [in_process_provider.go][in-process], [kas.go][kas-adapter]). [source]
- **KAS enabled with no `cryptoProvider` and no keyring crashes at startup**:
  `UpgradeMapToKeyring(nil)` dereferences a nil provider ([kas.go][kas-register],
  [provider.go][kas-keyring]). The panic was reproduced at function level; there is no recover in
  service startup ([serviceregistry.go][svcreg-start]). [verified at function level] Either
  configure keys (recommended, they are needed later) or run `mode: all,-kas` for step 1.

Hybrid key for later (same shape as the upstream example, which declares
`hpqt:secp384r1-mlkem1024` as `h2` ([example yaml][example-yaml])):

```yaml
server:
  cryptoProvider:
    standard:
      keys:
        # ... r1 and e1 as above
        - kid: h2
          alg: hpqt:secp384r1-mlkem1024
          private: /etc/opentdf/keys/kas-p384mlkem1024-private.pem  # PKCS#8, composite OID
          cert: /etc/opentdf/keys/kas-p384mlkem1024-public.pem      # bare SPKI "PUBLIC KEY" (certificates rejected)
services:
  kas:
    preview:
      hybrid_tdf_enabled: true      # required to rewrap "hybrid-wrapped" KAOs; also enables ML-KEM
    keyring:
      - kid: r1
        alg: rsa:2048
      - kid: e1
        alg: ec:secp256r1
      - kid: h2
        alg: hpqt:secp384r1-mlkem1024   # needed so that PublicKey serves it
```

- `hybrid-wrapped` KAOs are rejected with 400 unless `preview.hybrid_tdf_enabled` is true
  ([rewrap.go][kas-rewrap-hybrid]); enabling it also enables ML-KEM
  ([provider.go][kas-preview]). [verified for the flag normalisation]
- A mislabeled hybrid key (PEM of one scheme declared as another) fails at load time; a
  certificate-wrapped hybrid public key is rejected ([standard_crypto.go][standard-crypto],
  [asym_encryption.go][ocrypto-asym]). [verified for the mislabel case]

### 2.7 Entity resolution: `claims` versus the default `keycloak`

- ERS mode defaults to `keycloak` in code and in [Configuring.md][cfg-ers]
  ([entityresolution.go][ers-v1], [v2][ers-v2]); the ERS README claims `claims` is the default
  ([README][ers-readme]), which is wrong for v0.27.0. [source]
- `keycloak` mode calls the Keycloak Admin API with `url`, `clientid`, `clientsecret`, `realm`,
  `legacykeycloak`, `inferid` ([Configuring.md][cfg-ers]). It connects lazily on the first
  request, so startup succeeds without Keycloak but every decision would fail
  ([keycloak ERS][ers-keycloak]). [source]
- `claims` mode builds the entity from the JWT's own claims (with `sub`, `iss`, `aud`, `jti`
  added back) without calling the IdP, and classifies every entity as a subject
  ([claims ERS][ers-claims], [OpenTDF docs][docs-ers]). [source]
- Step 1 makes no access decisions, but set `services.entityresolution.mode: claims` now and drop
  all Keycloak-only ERS keys.

### 2.8 Keycloak-flavoured defaults that must be replaced

| Setting | Default (Keycloak assumption) | For a non-Keycloak IdP | Evidence |
| --- | --- | --- | --- |
| `server.auth.policy.groups_claim` | `realm_access.roles` | the IdP's groups claim, e.g. `groups` | [policy.go][policy-go] |
| `server.auth.policy.client_id_claim` | `azp` | the claim the IdP puts in access tokens; `client_id` for LemonLDAP::NG JWT access tokens (section 8.1) | [policy.go][policy-go], [LL::NG source][llng-src-at] |
| `server.auth.policy.username_claim` | `preferred_username` | keep if released by the IdP, else `sub` | [policy.go][policy-go] |
| Built-in groupings | `g, opentdf-admin, role:admin` and `g, opentdf-standard, role:standard` (Keycloak realm roles created by `provision keycloak`) | your own `g, <group>, role:...` lines in `extension` | [enforcer.go][casbin-v1-enforcer], [keycloak_data.yaml][keycloak-data] |
| `server.auth.audience` sample | `http://localhost:8080` (added by a Keycloak audience mapper) | a value present in the IdP token `aud` | [example yaml][example-yaml], [keycloak_data.yaml][keycloak-data] |
| `services.entityresolution.mode` | `keycloak` (Admin API; selectors `azp`, `preferred_username`) | `claims` | [entityresolution.go][ers-v1], [keycloak ERS][ers-keycloak] |
| `services.entityresolution.{url,clientid,clientsecret,realm,legacykeycloak,inferid}` | Keycloak endpoint and credentials | remove | [Configuring.md][cfg-ers] |
| `audit.jwt_claim_mappings` example | `realm_access.roles` | optional, adapt or omit | [example yaml][example-yaml] |
| `server.auth.policy.roles_provider` | unset | leave unset: it needs factories registered in Go code, and setting it with the stock binary aborts startup | [authn.go][authn-roleprovider] |

The OpenTDF docs describe the default roles as tied to the Keycloak `realmsRole` claim
([authz docs][docs-authz]).

### 2.9 Documentation versus code at v0.27.0

| Topic | Documentation | Code at the tag | Evidence |
| --- | --- | --- | --- |
| Default port | `9000` | `8080` [verified] | [Configuring.md][cfg-server], [server.go][server-config] |
| Migrations flag | `db.runMigration` | `db.runMigrations` [verified] | [Configuring.md][cfg-db], [db.go][db-config] |
| JWKS refresh | `auth.cache_refresh` | `auth.cache_refresh_interval` | [Configuring.md][cfg-server], [config.go][auth-config] |
| Reflection | `grpc.reflection` | `grpc.reflectionEnabled` | [Configuring.md][cfg-server], [server.go][server-config] |
| RSA `cert` | optional | required [verified] | [Configuring.md][cfg-crypto], [standard_crypto.go][standard-crypto] |
| ERS default | README: `claims` | `keycloak` | [README][ers-readme], [entityresolution.go][ers-v1] |
| Env overrides | listed for every key | only for keys present in the YAML [verified] | [Configuring.md][cfg-db], [legacy_loader.go][legacy-loader] |
| `role:unknown` | "can only perform public functions" | also allowed `kas.AccessService/Rewrap` | [authz docs][docs-authz], [casbin_policy.csv][casbin-v1-csv] |

## 3. Token validation

### 3.1 At startup: discovery and JWKS (fail-fast)

- `NewAuthenticator` validates that `issuer` and `audience` are set, then GETs
  `<issuer>/.well-known/openid-configuration` (must return 200), registers the discovered
  `jwks_uri` in a JWKS cache and fetches it once; any error is returned
  ([token_verifier.go][token-verifier], [discovery.go][discovery]). [source]
- The error aborts server creation (`failed to create authentication interceptor`, then
  `issue creating opentdf server`) and the process exits; there is no retry
  ([server.go][server-auth-init], [start.go][start-server-create]). An unreachable issuer gave
  `dial tcp ...: connect: connection refused`; an issuer behind an untrusted CA gave
  `x509: certificate signed by unknown authority`. [verified] Consequence for Compose: start the
  IdP first and keep `restart: unless-stopped`.
- If the configured `issuer` differs from the discovery document's `issuer`, the latter is used
  for token validation and published as `platform_issuer` ([token_verifier.go][token-verifier],
  [Configuring.md][cfg-server], [OIDC.md][oidc-md]). With a configured issuer without trailing
  slash and a discovery `issuer` with one, validation used the slashed value. [verified]
- The JWKS is cached and refreshed with a minimum interval of `cache_refresh_interval`
  ([token_verifier.go][token-verifier], [OIDC.md][oidc-md]). After an IdP key rotation, tokens
  signed with a new `kid` may be rejected until the next refresh. Derived, UNVERIFIED.
- Discovery metadata is republished under `idp` in the platform well-known document, but only
  the fields of the internal struct (`issuer`, `authorization_endpoint`, `token_endpoint`,
  `userinfo_endpoint`, `jwks_uri`, `response_types_supported`, `subject_types_supported`,
  `id_token_signing_alg_values_supported`, `require_request_uri_registration`)
  ([discovery.go][discovery], [authn.go][authn-new]). [source]

### 3.2 Trusting a private CA for the issuer's HTTPS

- Discovery uses Go's `http.DefaultClient` ([discovery.go][discovery]) and the JWKS cache uses
  the library's default client; both rely on the system certificate pool. The JWKS fetch over
  TLS succeeded with only `SSL_CERT_FILE` trust configured. [verified]
- On Linux, Go loads `SSL_CERT_FILE` (or the first default bundle) **and** every file of
  `SSL_CERT_DIR` (or of `/etc/ssl/certs` and `/etc/pki/tls/certs`)
  ([root.go][go-root], [root_linux.go][go-root-linux]). [source]
- The image already sets `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` (public roots).
  [verified] Three equivalent options:
  1. mount the CA PEM in a dedicated directory and set `SSL_CERT_DIR` to it (public roots stay
     loaded from `SSL_CERT_FILE`); used in section 10;
  2. mount the CA PEM as an extra file under `/etc/ssl/certs/`;
  3. mount a combined bundle and point `SSL_CERT_FILE` at it. The upstream docs compose replaces
     `/etc/ssl/certs` with a volume holding a regenerated bundle
     ([docs compose][docs-compose-ca]).
- The trust test ran on macOS, where Go 1.27 keeps using the platform verifier for modules that
  declare an older `go` version unless `GODEBUG=x509sslcertoverrideplatform=1`
  ([godebug table][go-godebug], [root.go][go-root]); the platform module declares `go 1.25.0`
  ([go.mod][service-gomod]). On Linux the on-disk path is always used ([root.go][go-root]), so
  no GODEBUG is needed in the container. Container behaviour derived from source, UNVERIFIED by a
  container run.

### 3.3 Per-request checks

| Check | Behaviour | Evidence |
| --- | --- | --- |
| Authorization scheme | `Bearer <jwt>` or `DPoP <jwt>` (case-sensitive prefix); anything else, including `bearer <jwt>` and `Basic`, is 401 | [authn.go][authn-checktoken] [verified] |
| Signature | key taken from the cached JWKS; the JWT header **must contain a `kid`** present in the JWKS (library default `requireKid=true`); algorithm from the JWK `alg` or inferred from the key type | [token_verifier.go][token-verifier], [jwx WithKeySet][jwx-keyset], [jwx key provider][jwx-keyprovider]; token without `kid` got 401, JWKS key without `alg` accepted [verified] |
| `iss` | exact string match with the effective issuer (trailing slash matters) | [token_verifier.go][token-verifier]; `iss` without slash got 401 [verified] |
| `aud` | required, must contain `server.auth.audience` (string or array) | [token_verifier.go][token-verifier], [jwx validate][jwx-validate]; wrong `aud` 401, array containing it 200 [verified] |
| `exp`, `nbf`, `iat` | validated only when present, with `server.auth.skew` | [jwx validate][jwx-validate]; expired 401, token without `exp` accepted [verified] |
| `typ` header | not checked (`at+jwt` accepted) | no `typ` option in [token_verifier.go][token-verifier]; [verified] |
| `cnf` claim | if present, a valid DPoP proof is required even with `dpop.enforce: false` | [authn.go][authn-checktoken]; `cnf` without proof got 401 [verified] |
| Introspection / userinfo | none; the token must be a JWT carrying the claims | [OIDC.md][oidc-md], open issue [#2227][issue-2227] |

### 3.4 Claims that are used

| Claim | Config key (default) | Used for | Evidence |
| --- | --- | --- | --- |
| username | `username_claim` (`preferred_username`) | Casbin subject; **top-level claim only** (no dot notation) | [subject_extractor.go][subject-extractor] |
| groups | `groups_claim` (`realm_access.roles`) | Casbin subjects; dot notation allowed; value must be a JSON array of strings or a single string; a delimited string such as `"a; b"` is one value | [role_provider.go][role-provider]; delimited string got 403, single string 200 [verified] |
| client ID | `client_id_claim` (`azp`) | logs and request context; missing claim is only a warning for normal calls, but authorization v2 decisions (used by KAS rewrap later) fail without it | [authn.go][authn-connect], [authorization v2][authzv2-clientid], [accessPdp.go][kas-pdp], [authn.go][authn-ipc] |
| `sub`, `iss`, `aud`, `jti`, all others | ERS `claims` mode | entity attributes for subject mappings (later) | [claims ERS][ers-claims] |
| `cnf` | none | DPoP binding | [authn.go][authn-checktoken] |

### 3.5 DPoP disabled: consequences

- Tokens without `cnf` are accepted with either scheme, without a proof. [verified]
- The well-known document always advertises `supports_dpop: true`
  ([authn.go][authn-new]). How web SDK 0.21.0 reacts to it is UNVERIFIED.
- Later, for rewraps: without a DPoP key bound to the token, KAS does not verify the signature of
  the signed request token ([rewrap.go][kas-rewrap-srt]). [source]
- The OpenTDF docs say the JavaScript SDK has DPoP off by default with `authTokenInterceptor()`
  and recommend `disableDPoP: true` when the IdP has no DPoP support
  ([SDK auth docs][docs-sdkauth], [auth guide][docs-authguide]). [source]

## 4. Authorization (Casbin) in v0.27

### 4.1 Model and default policy

- Engine `casbin`, model version `v1` by default ([policy.go][policy-go]). [verified]
- v1 model: request `(sub, res, act)`, matcher `g(r.sub, p.sub) && keyMatch(r.res, p.res) &&
  keyMatch(r.act, p.act)`, effect "allowed if a rule allows and no rule denies"
  ([casbin_model.conf][casbin-v1-model]). [source]
- For Connect calls the resource is the procedure path without the leading slash (for example
  `policy.namespaces.NamespaceService/ListNamespaces`) and the action comes from the method name:
  `Get*`/`List*` read, `Create*`/`Update*`/`Assign*` write, `Delete*`/`Remove*`/`Deactivate*`
  delete, `Unsafe*` unsafe, anything else `other` ([authn.go][authn-action],
  [authorizer.go][casbin-v1-authorizer]). Plain HTTP routes use the URL path and the HTTP method
  ([authn.go][authn-mux]). [source]
- Default policy ([casbin_policy.csv][casbin-v1-csv]): [source]
  - `role:admin`: `*` on everything;
  - `role:standard`: read on `policy.*` and `kasregistry.*`, any action on
    `kas.AccessService/Rewrap`, read on authorization v1 `GetDecisions`, `GetDecisionsByToken`
    and v2 `GetDecision`, `GetDecisionMultiResource`, `GetDecisionBulk`;
  - `role:unknown`: any action on `kas.AccessService/Rewrap`.
- Authz v2 (`policy.version: v2`) switches to an RPC + dimensions model with a different default
  policy (roles become `role:<group>`, client IDs `client:<id>`) ([auth README][auth-readme],
  [v2 policy.csv][casbin-v2-csv]). Not needed for step 1.

### 4.2 How the caller's role is derived

- v1 subjects are: every value of the groups claim (as-is), the value of the username claim, and
  an implicit `role:unknown`; the request is allowed as soon as one subject is allowed
  ([subject_extractor.go][subject-extractor], [enforcer.go][casbin-v1-enforcer]). [source]
- Roles are attached with Casbin grouping lines `g, <group or username>, role:<role>` in
  `server.auth.policy.extension` (appended to the built-in policy) or in `csv` (replaces it)
  ([enforcer.go][casbin-v1-enforcer], [Configuring.md][cfg-casbin]). [source]
- **The built-in groupings of `opentdf-admin` and `opentdf-standard` are only added when neither
  `extension` nor the deprecated `map` is set**; once `extension` is set, only your lines apply
  ([enforcer.go][casbin-v1-enforcer]). [source]
- With `groups_claim: groups` and
  `extension: "g, opentdf-admin, role:admin\ng, opentdf-standard, role:standard"`, a token with
  `groups: ["opentdf-standard", "staff"]` was allowed to list namespaces and a token without
  `groups` was denied. [verified]

### 4.3 Who can call what (v1 default policy)

| Caller | Allowed | Evidence |
| --- | --- | --- |
| No token | `wellknownconfiguration.WellKnownService/GetWellKnownConfiguration`, `GET /.well-known/opentdf-configuration`, `kas.AccessService/PublicKey`, `kas.AccessService/LegacyPublicKey`, `GET /healthz`, `grpc.health.v1.Health/Check`; gRPC reflection too when enabled | [authn.go][authn-public], [server.go][server-reflection] |
| Valid token, no mapped role (`role:unknown`) | the public endpoints plus `kas.AccessService/Rewrap`; everything else (all `policy.*`, authorization, entity resolution RPCs) is 403 | [casbin_policy.csv][casbin-v1-csv], upstream tests [enforcer_test.go][casbin-v1-tests]; `ListNamespaces` 403 [verified] |
| `role:standard` | the above plus read-only policy RPCs and the listed decision RPCs; no writes, no `GetEntitlements` | [casbin_policy.csv][casbin-v1-csv]; `ListNamespaces` 200 [verified] |
| `role:admin` | everything | [casbin_policy.csv][casbin-v1-csv]; `ListNamespaces` 200 [verified] |

## 5. Health and readiness

- `GET /healthz`: liveness, always `200 {"status":"SERVING"}` once the server runs; public
  ([health.go][health-go], [authn.go][authn-public]). [source]
- `GET /healthz?service=all`: runs the registered readiness checks; `503 {"status":"NOT_SERVING"}`
  if one fails, and an unknown service name gives `503 {"status":"UNKNOWN"}`
  ([health.go][health-go]). In v0.27.0 only `kas` and `authorization` register checks and both
  return nil, so the database is not checked ([provider.go][kas-ready], [kas.go][kas-register],
  [authorization.go][authz-ready-reg], [authorization.go][authz-ready]). [source]
- gRPC health: `grpc.health.v1.Health/Check` (public); `Watch` is unimplemented
  ([health.go][health-go]). [source]
- `/healthz` is advertised as `health.endpoint` in the well-known document
  ([health.go][health-go]). [source]
- Because startup is fail-fast (section 3.1 and 2.1), a running process means the IdP discovery,
  the JWKS and PostgreSQL were reachable at startup.
- The image has no shell or HTTP client, so a Compose `healthcheck` cannot run inside it
  [verified]; probe `/healthz` from the reverse proxy. Unknown plain HTTP paths such as `/`
  require a token (401), so do not use them as probes ([authn.go][authn-mux]). [source]

## 6. Proving that the platform trusts the IdP

Connect unary calls: `POST /<package>.<Service>/<Method>`, `Content-Type: application/json`,
`Connect-Protocol-Version: 1`, JSON body; errors are JSON `{"code": ..., "message": ...}` with
`unauthenticated` mapped to 401 and `permission_denied` to 403
([Connect protocol][connect-protocol]). [source]

### 6.1 Public calls (no token)

```sh
PLATFORM=https://<PLATFORM_HOST>

curl -s "$PLATFORM/healthz"                     # {"status":"SERVING"}
curl -s "$PLATFORM/.well-known/opentdf-configuration" | jq .
curl -s -X POST "$PLATFORM/wellknownconfiguration.WellKnownService/GetWellKnownConfiguration" \
  -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' -d '{}' | jq .
curl -s -X POST "$PLATFORM/kas.AccessService/PublicKey" \
  -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' \
  -d '{"algorithm":"ec:secp256r1"}' | jq .
```

- `GET /.well-known/opentdf-configuration` returns the configuration map directly; the Connect
  RPC returns the same map wrapped in `{"configuration": {...}}`
  ([wellknown_configuration.go][wellknown-go]). [source]
- Expected keys: `platform_issuer` (the discovery `issuer`), `idp` (discovery subset),
  `supports_dpop: true`, `dpop_signing_alg_values_supported` (`ES256` ... `RS512`),
  `dpop_nonce_required: false` ([authn.go][authn-new]); `health: {"endpoint": "/healthz"}`
  ([health.go][health-go]); `key_managers`, empty without external key managers
  ([key_management.go][keymgmt-wk]); possibly `base_key`, empty until a base key is set in the
  KAS registry ([kasregistry][basekey-start], [policy DB][basekey-wk]). Exact rendering
  UNVERIFIED (derived from source).
- `PublicKey` returns `{"publicKey": "-----BEGIN PUBLIC KEY-----...", "kid": "e1"}` for a
  configured default key ([publicKey.go][kas-publickey]). Derived from source, UNVERIFIED by
  execution.

### 6.2 A token-protected call

```sh
TOKEN=<access token (JWT) issued by the IdP for a test user>

curl -s -i -X POST "$PLATFORM/policy.namespaces.NamespaceService/ListNamespaces" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H 'Connect-Protocol-Version: 1' \
  -d '{}'
```

Obtain the token with the authorization code flow (or, if enabled on a test client, the password
grant) against the `token_endpoint` published at `<issuer>/.well-known/openid-configuration`.

| Case | Expected response | Evidence |
| --- | --- | --- |
| (a) valid token, groups mapped to `role:standard` or `role:admin` | `HTTP 200`, body `{"pagination":{}}` on an empty database | status [verified] with a stub service (which returned `{}`); body derived from the [namespaces DB code][ns-db] (empty list, zero-valued pagination object), UNVERIFIED |
| (b) valid token, no mapped role | `HTTP 403` `{"code":"permission_denied","message":"permission denied"}` | [authn.go][authn-finalize] [verified] |
| (c) no `Authorization` header | `HTTP 401` `{"code":"unauthenticated","message":"missing authorization header"}` | [authn.go][authn-connect] [verified] |
| malformed token, missing `kid`, wrong `iss` or `aud`, expired, wrong scheme | `HTTP 401` `{"code":"unauthenticated","message":"unauthenticated"}` | [authn.go][authn-connect] [verified]; a bad signature or an unknown `kid` takes the same code path (not tested) |

Plain HTTP handlers (not Connect) answer with text bodies instead: `missing authorization
header` / `unauthenticated` (401) and `permission denied` (403) ([authn.go][authn-mux]).
[source]

The (a)/(b)/(c) triple is the proof asked for step 1: 200 means the token is trusted and mapped,
403 means the token is trusted but carries no mapped role, 401 means no or untrusted token.

## 7. KAS key files

### 7.1 RSA 2048 and EC P-256 with OpenSSL

Upstream generates them with ([init-temp-keys.sh][init-keys], same commands in the
[docs compose][docs-compose-keys]):

```sh
openssl genpkey -algorithm RSA -out kas-private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in kas-private.pem -pubout -out kas-cert.pem          # a public key, used as "cert"
openssl ecparam -name prime256v1 > ecparams.tmp
openssl req -x509 -nodes -newkey ec:ecparams.tmp -subj "/CN=kas" \
  -keyout kas-ec-private.pem -out kas-ec-cert.pem -days 365
```

Equivalent commands used for verification (OpenSSL 3.6):

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out kas-private.pem
openssl pkey -in kas-private.pem -pubout -out kas-cert.pem
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out kas-ec-private.pem
openssl req -x509 -new -key kas-ec-private.pem -subj "/CN=kas" -days 3650 -out kas-ec-cert.pem
```

Both sets produce PKCS#8 private keys (`BEGIN PRIVATE KEY`); the second set was loaded through the
tag's `StandardCrypto` and both public keys were exported. [verified] Do not use
`openssl ecparam -genkey` (SEC1 output, see section 2.6).

- File names are free; upstream uses `kas-private.pem`, `kas-cert.pem`, `kas-ec-private.pem`,
  `kas-ec-cert.pem` ([init-temp-keys.sh][init-keys]). [source]
- Key IDs are free short stable strings, conventionally `r1` (RSA) and `e1` (EC)
  ([Configuring.md][cfg-crypto], [example yaml][example-yaml]). Keep them stable: KAOs reference
  them. [source]
- The container runs as uid 65532, so mounted key files must be readable by that uid; the upstream
  docs compose simply makes them world-readable in a `fix-keys-permissions` job
  ([docs compose][docs-compose-perms]). Prefer `chown 65532:65532` and mode `0400` on the private
  keys.

### 7.2 Hybrid post-quantum keys (later)

- OpenSSL cannot produce them: the P-384 + ML-KEM-1024 key is a composite KEM from
  draft-ietf-lamps-pq-composite-kem-14 with OID `1.3.6.1.5.5.7.6.63`, in SPKI / PKCS#8 PEM
  ([pq_oids.go][ocrypto-oids], [HYBRID_NIST_KEY_WRAPPING.md][ocrypto-hybrid-doc]). OpenSSL 3.6
  printed the OID numerically. [verified]
- Generate with the platform's tool from the tagged source (Go 1.25 or later,
  [go.mod][service-gomod]):
  `go run ./service/cmd/keygen -output <dir>`; it writes `kas-xwing-*`, `kas-p256mlkem768-*`,
  `kas-p384mlkem1024-*`, `kas-mlkem768-*`, `kas-mlkem1024-*` (`-private.pem` / `-public.pem`)
  ([keygen][keygen]). The docs compose builds it with `GOWORK=off go run ./cmd/keygen` from a
  sparse checkout ([docs compose][docs-compose-pqc]). The tool is not in the container image.
  [verified: generated and loaded as `hpqt:secp384r1-mlkem1024`]
- Declaration: see the hybrid block in section 2.6. Web SDK 0.21.0 support for this algorithm is
  UNVERIFIED.

## 8. Known issues and gotchas with non-Keycloak IdPs

1. **Fail-fast startup** on discovery, JWKS, TLS trust or database errors, no retry (sections 2.1
   and 3.1). [verified for the IdP part; source for the database part]
2. **`iss` must equal the discovery `issuer` byte for byte.** The platform adopts the discovery
   value, so a trailing-slash mismatch in the config is harmless, but tokens must carry the same
   string. [verified] Related SDK bug with trailing-slash issuers, fixed before v0.27.0:
   [#3260][issue-3260].
3. **`kid` is mandatory** in the access token header. [verified] LemonLDAP::NG emits it only when
   the signing key has a key ID (section 8.1).
4. **Access tokens must be JWTs with the role claims inside**: no introspection and no userinfo
   enrichment ([OIDC.md][oidc-md], open issue [#2227][issue-2227]).
5. **`aud` must contain `server.auth.audience`**; the docs list a wrong audience as the first
   cause of 401 ([auth guide][docs-authguide]). [verified]
6. **Groups must be a JSON array** (or a single string); delimited strings are not split.
   [verified]
7. `username_claim` has no dot notation; `groups_claim` has ([subject_extractor.go][subject-extractor],
   [role_provider.go][role-provider]).
8. `client_id_claim` must name a claim the IdP really emits, otherwise decisions (and so rewraps)
   fail later ([authorization v2][authzv2-clientid]).
9. Setting `extension` removes the built-in `opentdf-admin` / `opentdf-standard` groupings
   ([enforcer.go][casbin-v1-enforcer]).
10. **Env overrides need the key in the YAML** (section 1.2). [verified]
11. A token that carries `cnf` needs a DPoP proof even with DPoP off. [verified]
12. `supports_dpop: true` is always advertised ([authn.go][authn-new]).
13. The Authorization scheme prefix is case-sensitive (`Bearer `) ([authn.go][authn-checktoken]).
    [verified]
14. CORS: no origin allowed by default; extra Connect headers must be added (section 2.4).
    [verified]
15. gRPC reflection is on by default and unauthenticated ([server.go][server-reflection]).
16. No in-container healthcheck possible; readiness ignores the database (section 5).
17. KAS without keys crashes; RSA needs `cert`; EC keys must be PKCS#8 (section 2.6).
    [verified]
18. Documentation drift listed in section 2.9. [verified]
19. Other issues seen: subject mappings on `.sub` did not match in `claims` mode
    ([#3188][issue-3188], fixed: the tag's claims ERS re-adds `sub` ([claims ERS][ers-claims]));
    duplicate subject mappings can block working ones (open [#3190][issue-3190]); SDK client
    credentials with Okta ([#3076][issue-3076], SDK side, closed); the OIDC boundary was
    documented in [#3824][issue-3824].

### 8.1 IdP-side checklist for LemonLDAP::NG

Sources: the LemonLDAP::NG documentation ("latest" pages) and the LemonLDAP::NG source at tag
`v2.23.4` (read, not executed). The platform-side consequences are the verified behaviours of
section 3.3. Decode one real access token before finalising the platform config.

- Enable **"Use JWT format for Access Token"** (`oidcRPMetaDataOptionsAccessTokenJWT`) on the
  relying party used by the browser plugin ([LL::NG OIDC IdP doc][llng-idp],
  [LL::NG source][llng-src-at]). The platform cannot use opaque tokens.
- **Give the signing key a key ID.** LL::NG only writes `kid` in the JWT header, and in the JWKS,
  when the key has one (`oidcServiceKeyIdSig` for the default signing key)
  ([Key.pm][llng-src-key], [OpenIDConnect.pm][llng-src-kid], [OpenIDConnect.pm][llng-src-jwk]).
  Without it the platform rejects every token with 401 (section 3.3). The documentation says a
  `kid` is derived when keys are generated from the manager ([LL::NG OIDC service doc][llng-service]).
- A JWT access token contains `iss`, `exp`, `aud`, `jti`, `sid`, `scope`, `client_id`, `iat` and
  `sub`, and no `azp`; the user claims (for example groups, `preferred_username`) are added only
  with **"Release claims in Access Token"** (`oidcRPMetaDataOptionsAccessTokenClaims`)
  ([LL::NG source][llng-src-at], [LL::NG OIDC IdP doc][llng-idp]). Hence
  `client_id_claim: client_id` in section 9.
- `aud` is the RP client ID followed by the RP's **"Additional audiences"**
  ([LL::NG source][llng-src-aud], [LL::NG OIDC IdP doc][llng-idp]): `server.auth.audience` can be
  the RP client ID or one of the additional audiences.
- Publish groups with the **Array** column set to "Always" so that a single group is still an array
  ([LL::NG OIDC IdP doc][llng-idp]); which scope releases the groups claim is an IdP configuration
  choice (UNVERIFIED here).
- JWKS signing keys are published without `alg` ([OpenIDConnect.pm][llng-src-jwk]); the platform
  infers the algorithm from the key type (a JWKS without `alg` was accepted). [verified]
- Access tokens carry `typ: at+JWT` ([LL::NG source][llng-src-at], [LL::NG upgrade notes][llng-typ]);
  the platform ignores `typ`. [verified for `at+jwt`]
- Issuer: "If this value is left empty, the portal URL is used"
  ([LL::NG OIDC service doc][llng-service]); a portal URL usually ends with `/`, which is fine as
  long as tokens and discovery agree (section 3.1).
- DPoP is not mentioned in the LL::NG pages consulted, so tokens should not carry `cnf`; keep
  platform DPoP off.

## 9. Complete minimal configuration file (step 1)

Placeholders: `<ISSUER_URL>`, `<AUDIENCE>`, `<DB_PASSWORD>`, `<BROWSER_APP_ORIGIN>`,
`<IDP_ADMIN_GROUP>`, `<IDP_USER_GROUP>`. The same structure with concrete values was loaded
through the tag's configuration loaders, including the environment overrides of section 10.
[verified]

```yaml
# opentdf.yaml: OpenTDF platform service v0.27.0, step 1
# (platform up, token-protected API, DPoP off, no encryption yet).
# Keep every key that is overridden by an OPENTDF_* environment variable in this file:
# environment variables cannot create keys.

logger:
  level: info                 # use debug while wiring the IdP
  type: json
  output: stdout

db:
  host: opentdf-db
  port: 5432
  database: opentdf
  user: opentdf
  password: "<DB_PASSWORD>"   # or keep any placeholder and set OPENTDF_DB_PASSWORD
  sslmode: disable            # same Docker network; use verify-full for a remote server
  schema: opentdf             # the policy service uses schema "opentdf_policy"
  runMigrations: true         # default; note the spelling ("runMigration" is ignored)

mode: all                     # policy, authorization, kas, wellknown, entityresolution (+ health)

services:
  entityresolution:
    mode: claims              # default is "keycloak"
  kas:
    keyring:                  # default (non-legacy) key per algorithm
      - kid: r1
        alg: rsa:2048
      - kid: e1
        alg: ec:secp256r1

server:
  port: 8080                  # default 8080 (not 9000 as documented)
  auth:
    enabled: true
    issuer: "<ISSUER_URL>"    # e.g. https://auth.example.org/ ; the discovery "issuer" wins
    audience: "<AUDIENCE>"    # must be one of the access token "aud" values
    dpop:
      enforce: false
    cache_refresh_interval: 15m
    skew: 1m
    policy:
      username_claim: preferred_username   # top-level claim only; use sub if not released
      groups_claim: groups                 # JSON array of strings (or single string)
      client_id_claim: client_id           # LemonLDAP::NG JWT access tokens carry client_id, not azp
      extension: |
        g, <IDP_ADMIN_GROUP>, role:admin
        g, <IDP_USER_GROUP>, role:standard
  cors:
    enabled: true
    allowedorigins:
      - "<BROWSER_APP_ORIGIN>"             # exact scheme://host[:port]
    additionalheaders:                     # appended to the default list
      - Connect-Timeout-Ms
      - X-User-Agent
  # http:
  #   trustedProxies:
  #     - <REVERSE_PROXY_SUBNET_CIDR>      # an invalid CIDR aborts startup
  grpc:
    reflectionEnabled: false
  cryptoProvider:
    type: standard
    standard:
      keys:
        - kid: r1
          alg: rsa:2048
          private: /etc/opentdf/keys/kas-private.pem
          cert: /etc/opentdf/keys/kas-cert.pem
        - kid: e1
          alg: ec:secp256r1
          private: /etc/opentdf/keys/kas-ec-private.pem
          cert: /etc/opentdf/keys/kas-ec-cert.pem
```

## 10. Docker Compose service definition

Assumptions: the reverse proxy runs in another service attached to an external network named
`proxy` and routes `<PLATFORM_HOST>` to `opentdf:8080`; the IdP's public host name resolves from
inside the platform container. Values come from an `.env` file.

```yaml
services:
  opentdf-db:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: opentdf
      POSTGRES_PASSWORD: ${OPENTDF_DB_PASSWORD:?set OPENTDF_DB_PASSWORD}
      POSTGRES_DB: opentdf
    volumes:
      - opentdf-db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opentdf -d opentdf"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks:
      - opentdf-internal

  opentdf:
    image: registry.opentdf.io/platform:v0.27.0@sha256:4f35e6a10af23a2aaeb53133afc28ed8c3a3f23407701e002358231775c5318a
    restart: unless-stopped            # the process exits if the IdP or the DB is not reachable yet
    command: ["start", "--config-file", "/etc/opentdf/opentdf.yaml"]
    environment:
      # Work only because these keys exist in opentdf.yaml (section 1.2)
      OPENTDF_DB_PASSWORD: ${OPENTDF_DB_PASSWORD:?set OPENTDF_DB_PASSWORD}
      OPENTDF_SERVER_AUTH_ISSUER: ${OIDC_ISSUER:?set OIDC_ISSUER}
      OPENTDF_SERVER_AUTH_AUDIENCE: ${OPENTDF_AUDIENCE:?set OPENTDF_AUDIENCE}
      OPENTDF_SERVER_CORS_ALLOWEDORIGINS: ${BROWSER_APP_ORIGIN:?set BROWSER_APP_ORIGIN}
      # Only if the IdP certificate is issued by a private CA: extra trust anchors,
      # the public bundle from SSL_CERT_FILE (set in the image) stays in use
      SSL_CERT_DIR: /etc/opentdf/ca
    volumes:
      - ./opentdf/opentdf.yaml:/etc/opentdf/opentdf.yaml:ro
      - ./opentdf/keys:/etc/opentdf/keys:ro     # readable by uid 65532
      - ./opentdf/ca:/etc/opentdf/ca:ro         # private CA certificate(s), PEM
    expose:
      - "8080"
    depends_on:
      opentdf-db:
        condition: service_healthy
    # extra_hosts:
    #   - "<IDP_HOST>:host-gateway"   # only if the IdP host name must resolve to the host's proxy
    networks:
      - opentdf-internal
      - proxy
    # No healthcheck: the image has no shell or curl. Probe GET /healthz from the proxy.

networks:
  opentdf-internal: {}
  proxy:
    external: true

volumes:
  opentdf-db-data: {}
```

Notes, each tied to a source:

- `command`, config mount and `extra_hosts` follow the upstream docs compose
  ([docs compose][docs-compose-platform]); `postgres:15-alpine` with `pg_isready` follows the
  platform compose ([docker-compose.yaml][compose-upstream]).
- Reverse proxy: forward to the platform over h2c to support gRPC as well as Connect JSON; the
  upstream Caddy site block is ([docs compose][docs-compose-caddy]):

  ```
  https://<PLATFORM_HOST> {
    reverse_proxy {
      to h2c://opentdf:8080
      transport http {
        versions h2c 2 1.1
      }
    }
  }
  ```

  Other proxies need the equivalent "h2c upstream" setting (not tested here).
- The issuer URL must be reachable from inside the container under the same name as in the tokens'
  `iss` (sections 3.1 and 3.3).
- Key preparation on the host (section 7), for example:

  ```sh
  mkdir -p opentdf/keys opentdf/ca && cd opentdf/keys
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out kas-private.pem
  openssl pkey -in kas-private.pem -pubout -out kas-cert.pem
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out kas-ec-private.pem
  openssl req -x509 -new -key kas-ec-private.pem -subj "/CN=kas" -days 3650 -out kas-ec-cert.pem
  sudo chown 65532:65532 ./*.pem && chmod 0400 kas-private.pem kas-ec-private.pem
  ```

## 11. Open questions

1. A decoded real LemonLDAP::NG access token for the plugin's relying party: presence of `kid`,
   `aud` values, and which user claims (groups as an array, `preferred_username`) are released
   for the requested scopes. The source reading of section 8.1 predicts the shape but was not
   executed here.
2. Which request headers and fetch credentials mode web SDK 0.21.0 uses (CORS list, whether
   `allowcredentials` can be turned off), and whether it reacts to `supports_dpop: true`.
3. Whether web SDK 0.21.0 can wrap with `hpqt:secp384r1-mlkem1024` (`hybrid-wrapped` KAOs).
4. Casbin model v1 (default, group and username subjects) or v2 (adds `client:<id>` subjects and
   per-RPC rules) for the long term.
5. KAS in `key_management: false` mode with static keys, or key management with the KAS registry
   (needs `root_key` and a registered KAS URI) for later steps.
6. Readiness does not check PostgreSQL: is an external database probe needed?
7. Full end-to-end startup of v0.27.0 against the real IdP and database is still to be done
   (UNVERIFIED here).

## Appendix A. Verification log

Image inspection (read-only):

- `docker manifest inspect registry.opentdf.io/platform:v0.27.0`: OCI index with `linux/amd64`,
  `linux/arm64` and two attestation manifests; `ghcr.io/opentdf/platform:v0.27.0`: `denied`.
- `docker pull`, `docker image inspect`: user `65532`, entrypoint `/usr/bin/opentdf`, no `Cmd`,
  no working directory, `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`; same config for amd64
  (read from the registry blob).
- `docker save` and layer listing: glibc, libstdc++, CA bundle, `/usr/bin/opentdf`; no shell.
- `docker run --rm --entrypoint /usr/bin/opentdf <image> version` printed `0.27.0`; `--help`
  listed the subcommands.
- `go version -m` on the extracted binary: go1.27.1 and the module versions quoted in section 1.
- OCI referrers of the index digest: Sigstore bundles; the signing certificate SAN and issuer
  quoted in section 1 were decoded with OpenSSL.

Throwaway Go tests against the tag's code (scratch copy of the tarball, run on a macOS
development machine with `CGO_ENABLED=0`):

| Test | Code exercised | Observation |
| --- | --- | --- |
| Config defaults | legacy + default-settings loaders | port 8080, `runMigrations` true even with `runMigration: false`, mode `[all]`, auth enabled, policy v1, `realm_access.roles`, `preferred_username`, `azp`, CORS enabled with no origin, reflection true, refresh `15m` |
| Env overrides | same | ignored when the key is absent from the YAML; applied when present, including `OPENTDF_SERVER_AUTH_POLICY_GROUPS_CLAIM` and comma-separated `OPENTDF_SERVER_CORS_ALLOWEDORIGINS` |
| Proposed YAML | same | loads with the expected values (section 9 structure) |
| Startup trust | `auth.NewAuthenticator` against an HTTPS fake IdP | untrusted CA: `x509: certificate signed by unknown authority`; with `SSL_CERT_FILE` (plus `GODEBUG=x509sslcertoverrideplatform=1` on macOS): success; unreachable issuer: `connection refused` |
| Connect responses | real `ConnectAuthNInterceptor` + `ConnectAuthZInterceptor` + default Casbin v1 in front of a stub `NamespaceService`, fake IdP JWKS with and without `alg` | results in sections 3.3, 4 and 6.2 |
| CORS | real `newHTTPServer` handler chain | results in section 2.4 |
| KAS keyring | `KASConfig.UpgradeMapToKeyring`, `normalizePreview` | nil provider panics; keyring and legacy inference; hybrid preview implies ML-KEM |
| KAS keys | `security.NewStandardCrypto` + in-process key service | RSA, EC and P-384 + ML-KEM-1024 keys load and export; RSA without `cert` fails; mislabeled hybrid fails; SEC1 EC key fails at use time |

Not executed: `opentdf start` with PostgreSQL and a real IdP, a Linux container run with a private
CA, `cosign verify`, any web SDK call.

## Appendix B. Sources

Links in this document are reference-style; the full list of targets (with line anchors) follows
this section in the Markdown source. Source roots:

- OpenTDF platform, tag `service/v0.27.0`:
  <https://github.com/opentdf/platform/tree/service/v0.27.0> (commit
  `229b8e8d7d81e8b15f461ac95ced620c1083c11f`), release notes
  <https://github.com/opentdf/platform/releases/tag/service%2Fv0.27.0>.
- Published image: `registry.opentdf.io/platform` (manifest
  <https://registry.opentdf.io/v2/platform/manifests/v0.27.0>, tag list
  <https://registry.opentdf.io/v2/platform/tags/list>).
- OpenTDF documentation repository, pinned commits: getting-started compose
  <https://github.com/opentdf/docs/blob/82d13de9efc9fcb63627b39aec4dd2695f11b339/docs/getting-started/docker-compose.yaml>,
  authorization, entity resolution, authentication guide and SDK authentication pages (links in
  the text); Helm chart values
  <https://github.com/opentdf/charts/blob/0ca2f00e11f9a3528acbe03962119e959286fd19/charts/platform/values.yaml>.
- Go standard library go1.27.1 (`crypto/x509`), lestrrat-go/jwx v2.1.7 (the versions compiled
  into the image).
- Connect protocol and CORS guides: <https://connectrpc.com/docs/protocol/>,
  <https://connectrpc.com/docs/cors/>.
- LemonLDAP::NG documentation:
  <https://lemonldap-ng.org/documentation/latest/idpopenidconnect.html>,
  <https://lemonldap-ng.org/documentation/latest/openidconnectservice.html>,
  <https://lemonldap-ng.org/documentation/2.0/upgrade_templates.html>; LemonLDAP::NG source at tag
  `v2.23.4`: <https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/tree/v2.23.4>.
- GitHub issues of opentdf/platform: #745, #2227, #3076, #3188, #3190, #3260, #3824.

[tag]: https://github.com/opentdf/platform/tree/service/v0.27.0
[release]: https://github.com/opentdf/platform/releases/tag/service%2Fv0.27.0
[changelog]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/CHANGELOG.md#L1-L29
[dockerfile]: https://github.com/opentdf/platform/blob/service/v0.27.0/Dockerfile#L1-L24
[release-build]: https://github.com/opentdf/platform/blob/service/v0.27.0/.github/workflows/release-build.yaml#L54-L72
[release-sign]: https://github.com/opentdf/platform/blob/service/v0.27.0/.github/workflows/release-build.yaml#L74-L83
[registry-tags]: https://registry.opentdf.io/v2/platform/tags/list
[registry-manifest]: https://registry.opentdf.io/v2/platform/manifests/v0.27.0
[registry-referrers]: https://registry.opentdf.io/v2/platform/referrers/sha256:4f35e6a10af23a2aaeb53133afc28ed8c3a3f23407701e002358231775c5318a
[docs-compose-platform]: https://github.com/opentdf/docs/blob/82d13de9efc9fcb63627b39aec4dd2695f11b339/docs/getting-started/docker-compose.yaml#L279-L304
[docs-compose-caddy]: https://github.com/opentdf/docs/blob/82d13de9efc9fcb63627b39aec4dd2695f11b339/docs/getting-started/docker-compose.yaml#L14-L26
[docs-compose-ca]: https://github.com/opentdf/docs/blob/82d13de9efc9fcb63627b39aec4dd2695f11b339/docs/getting-started/docker-compose.yaml#L251-L277
[docs-compose-keys]: https://github.com/opentdf/docs/blob/82d13de9efc9fcb63627b39aec4dd2695f11b339/docs/getting-started/docker-compose.yaml#L474-L529
[docs-compose-pqc]: https://github.com/opentdf/docs/blob/82d13de9efc9fcb63627b39aec4dd2695f11b339/docs/getting-started/docker-compose.yaml#L531-L562
[docs-compose-perms]: https://github.com/opentdf/docs/blob/82d13de9efc9fcb63627b39aec4dd2695f11b339/docs/getting-started/docker-compose.yaml#L321-L337
[charts-values]: https://github.com/opentdf/charts/blob/0ca2f00e11f9a3528acbe03962119e959286fd19/charts/platform/values.yaml#L10
[root-go]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/cmd/root.go#L10-L30
[start-cmd]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/cmd/start.go#L8-L27
[migrate-cmd]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/cmd/migrate.go#L19-L40
[legacy-loader]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/config/legacy_loader.go#L22-L96
[loader-order]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/server/start.go#L47-L111
[config-reload]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/config/config.go#L233-L324
[config-test-env]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/config/config_test.go#L537-L650
[cfg-modes]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/Configuring.md#L43-L73
[cfg-server]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/Configuring.md#L119-L204
[cfg-cors]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/Configuring.md#L206-L272
[cfg-crypto]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/Configuring.md#L302-L321
[cfg-db]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/Configuring.md#L384-L432
[cfg-kas]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/Configuring.md#L448-L492
[cfg-ers]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/Configuring.md#L551-L614
[cfg-casbin]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/Configuring.md#L637-L732
[oidc-md]: https://github.com/opentdf/platform/blob/service/v0.27.0/docs/OIDC.md#L1-L103
[example-yaml]: https://github.com/opentdf/platform/blob/service/v0.27.0/opentdf-example.yaml#L5-L149
[compose-upstream]: https://github.com/opentdf/platform/blob/service/v0.27.0/docker-compose.yaml#L81-L95
[keycloak-data]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/cmd/keycloak_data.yaml#L1-L17
[server-config]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/server/server.go#L52-L146
[server-timeouts]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/server/server.go#L38-L44
[server-auth-init]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/server/server.go#L264-L311
[server-http]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/server/server.go#L351-L459
[server-reflection]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/server/server.go#L604-L616
[start-server-create]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/server/start.go#L217-L224
[start-modes]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/server/start.go#L400-L438
[services-go]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/server/services.go#L44-L102
[auth-config]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/config.go#L12-L86
[discovery]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/discovery.go#L19-L62
[token-verifier]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/token_verifier.go#L30-L105
[authn-public]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L39-L67
[authn-new]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L202-L320
[authn-roleprovider]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L322-L353
[authn-mux]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L483-L633
[authn-ipc]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L810-L846
[authn-connect]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L937-L1034
[authn-finalize]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L1036-L1064
[authn-action]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L1198-L1211
[authn-checktoken]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authn.go#L1213-L1275
[policy-go]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/policy.go#L3-L58
[role-provider]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/role_provider.go#L14-L115
[subject-extractor]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/subject_extractor.go#L54-L200
[casbin-v1-csv]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/casbin/v1/casbin_policy.csv
[casbin-v1-model]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/casbin/v1/casbin_model.conf
[casbin-v1-enforcer]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/casbin/v1/enforcer.go#L21-L191
[casbin-v1-authorizer]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/casbin/v1/authorizer.go#L71-L115
[casbin-v1-tests]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/casbin/v1/enforcer_test.go#L102-L187
[casbin-v2-csv]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/authz/casbin/v2/policy.csv
[auth-readme]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/auth/README.md#L20-L115
[health-go]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/health/health.go#L24-L124
[wellknown-go]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/wellknownconfiguration/wellknown_configuration.go#L46-L90
[keymgmt-wk]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/policy/keymanagement/key_management.go#L70-L86
[basekey-start]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/policy/kasregistry/key_access_server_registry.go#L77
[basekey-wk]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/policy/db/key_access_server_registry.go#L937-L967
[ns-db]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/policy/db/namespaces.go#L84-L147
[kas-ready]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/access/provider.go#L92-L96
[authz-ready-reg]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/authorization/authorization.go#L105
[authz-ready]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/authorization/authorization.go#L153-L157
[kas-register]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/kas.go#L39-L193
[kas-adapter]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/kas.go#L242-L264
[kas-config]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/access/provider.go#L38-L90
[kas-keyring]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/access/provider.go#L130-L156
[kas-preview]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/access/provider.go#L197-L225
[kas-publickey]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/access/publicKey.go#L24-L183
[kas-rewrap-srt]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/access/rewrap.go#L373-L406
[kas-rewrap-hybrid]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/access/rewrap.go#L796-L822
[kas-pdp]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/kas/access/accessPdp.go#L123-L175
[authzv2-clientid]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/authorization/v2/authorization.go#L326-L338
[db-config]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/db/db.go#L91-L106
[db-connect]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/db/db.go#L160-L240
[db-migration]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/db/db_migration.go#L57-L80
[db-optfunc]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/db/optFunc.go#L10-L15
[svcreg-start]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/pkg/serviceregistry/serviceregistry.go#L184-L201
[migration-uuid]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/policy/db/migrations/20240131000000_create_new_tables.sql#L10
[pg13-uuid]: https://www.postgresql.org/docs/13/functions-uuid.html
[crypto-consts]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/security/crypto_provider.go#L3-L25
[standard-crypto]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/security/standard_crypto.go#L21-L207
[in-process]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/internal/security/in_process_provider.go#L19-L186
[ocrypto-ec]: https://github.com/opentdf/platform/blob/service/v0.27.0/lib/ocrypto/ec_key_pair.go#L243-L262
[ocrypto-asym]: https://github.com/opentdf/platform/blob/service/v0.27.0/lib/ocrypto/asym_encryption.go#L73-L103
[ocrypto-oids]: https://github.com/opentdf/platform/blob/service/v0.27.0/lib/ocrypto/pq_oids.go#L8-L18
[ocrypto-hybrid-doc]: https://github.com/opentdf/platform/blob/service/v0.27.0/lib/ocrypto/HYBRID_NIST_KEY_WRAPPING.md
[keygen]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/cmd/keygen/main.go#L1-L80
[init-keys]: https://github.com/opentdf/platform/blob/service/v0.27.0/.github/scripts/init-temp-keys.sh#L44-L54
[service-gomod]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/go.mod#L1-L3
[ers-v1]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/entityresolution/entityresolution.go#L18-L76
[ers-v2]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/entityresolution/v2/entity_resolution.go#L19-L85
[ers-claims]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/entityresolution/claims/v2/entity_resolution.go#L243-L285
[ers-keycloak]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/entityresolution/keycloak/v2/entity_resolution.go#L38-L94
[ers-readme]: https://github.com/opentdf/platform/blob/service/v0.27.0/service/entityresolution/README.md#L43-L55
[docs-authz]: https://github.com/opentdf/docs/blob/8c681e0c801c460a8afd2ca5404f5ed9e01fdea0/docs/components/core/authz.md
[docs-ers]: https://github.com/opentdf/docs/blob/0aa167191f71c1416267592a61e864ab87e05679/docs/components/entity_resolution.md
[docs-authguide]: https://github.com/opentdf/docs/blob/2b2b6b5dff332f22336baf764103a37ae11c7f7d/docs/guides/authentication-guide.mdx
[docs-sdkauth]: https://github.com/opentdf/docs/blob/248646b72be27f40a73fcb6a25c1a039b9e7f3f4/docs/sdks/authentication.mdx
[go-root]: https://github.com/golang/go/blob/go1.27.1/src/crypto/x509/root.go#L123-L202
[go-root-linux]: https://github.com/golang/go/blob/go1.27.1/src/crypto/x509/root_linux.go#L9-L23
[go-godebug]: https://github.com/golang/go/blob/go1.27.1/src/internal/godebugs/table.go#L79
[jwx-keyset]: https://github.com/lestrrat-go/jwx/blob/v2.1.7/jws/options.go#L149-L173
[jwx-keyprovider]: https://github.com/lestrrat-go/jwx/blob/v2.1.7/jws/key_provider.go#L104-L175
[jwx-validate]: https://github.com/lestrrat-go/jwx/blob/v2.1.7/jwt/validate.go#L355-L500
[connect-protocol]: https://connectrpc.com/docs/protocol/
[connect-cors]: https://connectrpc.com/docs/cors/
[llng-idp]: https://lemonldap-ng.org/documentation/latest/idpopenidconnect.html
[llng-service]: https://lemonldap-ng.org/documentation/latest/openidconnectservice.html
[llng-typ]: https://lemonldap-ng.org/documentation/2.0/upgrade_templates.html
[llng-src-at]: https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/OpenIDConnect.pm#L1380-1418
[llng-src-kid]: https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/OpenIDConnect.pm#L2598-2627
[llng-src-jwk]: https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/OpenIDConnect.pm#L2766-2786
[llng-src-aud]: https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/OpenIDConnect.pm#L3000-3012
[llng-src-key]: https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/Key.pm#L132-141
[issue-745]: https://github.com/opentdf/platform/issues/745
[issue-2227]: https://github.com/opentdf/platform/issues/2227
[issue-3076]: https://github.com/opentdf/platform/issues/3076
[issue-3188]: https://github.com/opentdf/platform/issues/3188
[issue-3190]: https://github.com/opentdf/platform/issues/3190
[issue-3260]: https://github.com/opentdf/platform/issues/3260
[issue-3824]: https://github.com/opentdf/platform/issues/3824
