# LemonLDAP::NG as a local OpenID Connect provider (research)

Research date: 2026-09-26. Scope: local development and CI only. Nothing in this
note is production guidance, and every secret shown here is a throwaway
development value.

**Artefact studied**: `yadd/lemonldap-ng-full:2.23.4-1`, OCI index
`sha256:cfda28316071983f1bd3ef8de97d2c81edaefefb0bcc2ee7aea5d82ebe0cde11`,
run on macOS arm64 with Docker Desktop 29.8.0 (linuxkit 7.0.12, aarch64).
Inside the image: Debian 13.7, Perl 5.40.1, nginx 1.26.3, OpenSSL 3.5.7, jq 1.7.

**Citation conventions**

- `[D:page]`: official documentation, `https://lemonldap-ng.org/documentation/latest/<page>.html`.
  The live pages are titled "LemonLDAP::NG 2.0 documentation" (the 2.x series)
  and their content matches `doc/sources/admin/<page>.rst` at tag `v2.23.4`.
- `[S:...]`: LemonLDAP::NG (LLNG) source at tag `v2.23.4`, see the link list at the end.
- `[Y:...]`: image build sources, `github.com/guimard/llng-docker` at tag
  `v2.23.4-1` (commit `98d51f6`).
- `image:/path`: a file read inside the image (`docker run --rm --entrypoint cat ...`).
- **VERIFIED**: observed in the throwaway container, see section 8.6.
  **UNVERIFIED**: not observed, inferred from documentation or code reading.

## TL;DR

1. The image is multi-arch (amd64, arm64, arm/v7, s390x), serves plain HTTP on
   port 80 (nginx + FastCGI portal and manager), and uses s6-overlay 3.1.3.0 as
   `/init`. **arm64 caveat**: the arm64 variant ships **x86-64** s6-overlay
   binaries because the Dockerfile always downloads `s6-overlay-x86_64.tar.xz`.
   On Docker Desktop for Mac it works through Rosetta (VERIFIED); on native
   arm64 Linux it is expected to fail. Use the `2.23.4-1-no-s6` tag there
   (UNVERIFIED at runtime).
2. Configuration lives in the File backend (`/var/lib/lemonldap-ng/conf/lmConf-N.json`)
   wrapped by the Overlay backend (`/over`, one file per key). At every start the
   image's `update-llng-conf` script rewrites `portal`, `domain` and `key` from the
   `PORTAL` / `SSODOMAIN` environment variables when they differ.
3. Recommended provisioning (VERIFIED end to end, including restarts): commit
   one `lmConf-1.json` and a 30-line `/etc/cont-init.d/00-dcs-idp-config` script
   that generates the signing key once, injects it with `jq`, copies the file into
   place and drops the local config cache. The `/over` directory works too
   (VERIFIED) and needs no script.
4. The whole target setup works as specified (VERIFIED): discovery document and
   JWKS (`kid`, `x5c`), authorization code + PKCE with `client_secret_basic`, JWT
   access token (RS256, `typ: at+JWT`, `aud: ["dcs-maquette"]`) carrying `sub`,
   `email`, `preferred_username`, `name`, `given_name`, `family_name` and
   `groups` as a JSON array, userinfo, introspection, online refresh token that
   dies at logout, no consent screen, group-based access rule, and RP-initiated
   logout to `https://portail.dcs.test/`.
5. Gotchas found: the server cannot refuse the PKCE `plain` method; a standalone
   config **must** contain `locationRules` (the portal crashes otherwise); after
   editing configuration files, a restart may keep serving the old config from a
   local cache for up to 10 minutes; any save done by `update-llng-conf` writes
   all defaults **and resolved `%SERVERENV:...%` secrets** into the stored file;
   the JsonFile demo backend emits invalid UTF-8 for non-ASCII values; the issuer
   is `https://idp.dcs.test/` **with** a trailing slash; the order of values in
   `groups` is not stable.

---

## 1. The Docker image

### 1.1 Tags, architectures, code version

| Item | Value | Source |
|---|---|---|
| Platforms of `2.23.4-1` | `linux/amd64`, `linux/arm64`, `linux/arm/v7`, `linux/s390x` (plus attestation manifests) | `docker buildx imagetools inspect yadd/lemonldap-ng-full:2.23.4-1`; build matrix in [Y:action.yml#L65] |
| Per-arch digests | amd64 `sha256:90b5891a...d188`, arm64 `sha256:29d13e65...9327` | same command |
| s6-free variant | `yadd/lemonldap-ng-full:2.23.4-1-no-s6` (index `sha256:f414ad7a...382a`), same 4 platforms, entrypoint `/start`, CMD nginx | registry inspection (image not pulled); [Y:base-no-s6/Dockerfile#L126-L134], [Y:base-no-s6/start] |
| LLNG packages | Debian backports `2.23.2+ds-1~bpo13+1` | `dpkg -l` in the image |
| Effective LLNG code | 2.23.4: the image applies `2.23.3.patch` and `2.23.4.patch` on top of the packages; module `$VERSION` strings read `2.23.4` | [Y:base/Dockerfile], [Y:full/Dockerfile]; `image:/usr/share/perl5/Lemonldap/NG/Portal/Issuer/OpenIDConnect.pm` |
| Diff with upstream v2.23.4 | Identical: `Portal/Lib/Key.pm`, `Common/OpenIDConnect/{Metadata,Constants}.pm`, `Common/Util.pm`, `Common/Util/Crypto.pm`, `Portal/Main/{Issuer,Init,Process}.pm`, `Portal/Plugins/OIDC/ClientCredentialsGrant.pm`, `Portal/{Auth,UserDB}/Demo.pm`, `Common/Conf/Backends/{Overlay,File}.pm`, `Common/PSGI/Request.pm`, `Handler/Main/Reload.pm`. Small differences: `Issuer/OpenIDConnect.pm` (one extra hook call `oidcGotOfflineRefreshData`, so image line numbers after 1943 are shifted by one), `Lib/OpenIDConnect.pm` (whitespace), `Main/Run.pm` (JSON answer for `PE_REDIRECT`), `Main/Plugins.pm` (always loads the plugin-store `Autoloader`), `Common/Conf.pm` (log wording); `Constants.pm` and `DefaultValues.pm` are regenerated with plugin keys | `diff` of the extracted image tree against the `v2.23.4` tarball |

**arm64 and s6-overlay (important)**. The base Dockerfile always adds
`s6-overlay-x86_64.tar.xz` ([Y:base/Dockerfile#L25-L28]) while the multi-arch
build uses QEMU ([Y:action.yml]). In the arm64 image, `/command/s6-svscan` and
`/command/execlineb` have ELF machine `0x3e` (x86-64) whereas `/usr/bin/perl`
and `/usr/sbin/nginx` are `0xb7` (aarch64) (VERIFIED with
`od -An -tx1 -j18 -N2`). On Docker Desktop for Mac the container runs because
the s6 processes are executed by `/run/rosetta/rosetta` (VERIFIED in `ps`). On
a native arm64 Linux host (Graviton, `ubuntu-24.04-arm` runners, Raspberry Pi)
without an amd64 binfmt handler, `/init` should fail with "exec format error"
(UNVERIFIED). The `-no-s6` variant has no foreign-architecture binaries in its
Dockerfile ([Y:base-no-s6/Dockerfile]) and is the portable choice
(UNVERIFIED at runtime: not pulled, per the research rules). GitHub-hosted
amd64 runners and Docker Desktop on Apple Silicon are both fine with the s6 tag.

### 1.2 Ports, entrypoint, processes, volumes

- `EXPOSE 80`, `CMD ["/usr/sbin/nginx"]` ([Y:full/Dockerfile#L49-L51]);
  `ENTRYPOINT ["/init"]` ([Y:base/Dockerfile#L144]). nginx runs with
  `daemon off;` (`image:/etc/nginx/nginx.conf`). No TLS inside the container
  unless `TLS_CERT_FILE` is set ([Y:full/install/etc/cont-init.d/update-nginx-conf]).
- s6 services: `llng-fastcgi-server` (portal + manager PSGI apps behind a Unix
  socket) and `cron` (`image:/etc/services.d/*/run`).
- nginx sites: `portal-nginx.conf` (`server_name` = host of `PORTAL`) and
  `z_manager-nginx.conf` (`server_name manager.${SSODOMAIN}`)
  (`image:/etc/nginx/sites-enabled/`). The portal block is the first `listen 80`
  server, hence nginx's default server: requests with any `Host` header reach the
  portal (VERIFIED with `Host: localhost:18080`, `Host: llng`, `Host: idp.dcs.test`).
- The manager vhost is reachable with `Host: manager.dcs.test` and redirects to
  the portal for login (`PROTECTION=manager`) (VERIFIED). It is not needed here:
  do not route that host name in the reverse proxy.
- `VOLUME ["/etc/lemonldap-ng", "/var/lib/lemonldap-ng/conf", "/var/lib/lemonldap-ng/sessions", "/var/lib/lemonldap-ng/psessions"]`
  ([Y:base/Dockerfile#L134]): each container gets anonymous volumes for these.
- Startup to a working discovery document: about 2 s on the test machine;
  idle memory about 260 MiB (VERIFIED, `docker stats`).

### 1.3 Environment variables understood by the image

Defaults come from the `ENV` blocks ([Y:base/Dockerfile#L44], [Y:portal/Dockerfile],
[Y:full/Dockerfile#L7]) and the effect from the init scripts
([Y:base/install/etc/cont-init.d/update-llng-conf],
[Y:full/install/etc/cont-init.d/update-nginx-conf]) or
`image:/usr/sbin/llng-fastcgi-server` (lines 20-31).

| Variable | Default | Effect |
|---|---|---|
| `SSODOMAIN` | `example.com` | `updateConf setDomain`: replaces every `.<old domain>` by `.<new domain>` in the whole stored config and sets `domain` (cookie domain). Also builds `manager.${SSODOMAIN}`. |
| `PORTAL` | `http://auth.example.com/` | Normalised by `image:/usr/bin/portalUrl` to `scheme://host/` (scheme kept, `https://` if none, path dropped) and stored as `portal`; its host becomes nginx `server_name`. |
| `LOGLEVEL` | `info` | `logLevel` in `lemonldap-ng.ini` (`debug`, `info`, `notice`, `warn`, `error`). |
| `LOGGER`, `USERLOGGER` | `stderr` (the README says `syslog`, the Dockerfile sets `stderr`) | `stderr` selects `Lemonldap::NG::Common::Logger::Std`; `loki` also possible (`LOKIURL`, `LOKITENANT`, `LOKIAUTHORIZATION`). |
| `AUDITLOGGER`, `LLNG_AUDITLOGGER` | empty, `...::UserLoggerJSON` | Audit log class (JSON audit lines are visible in `docker logs`). |
| `FORWARDED_BY`, `FORWARDED_HEADER` | empty, `X-Forwarded-For` | Adds `real_ip_recursive on; real_ip_header ...; set_real_ip_from <cidr>;` to both nginx vhosts (`image:/usr/bin/setXforwardedForIfNeeded`). Comma or space separated CIDRs. |
| `STRICT_SERVER_NAME` | empty | Any value enables the Debian default nginx site as catch-all, so requests without the right `Host` no longer reach the portal. Leave empty for the healthcheck below. |
| `SERVERNAME` | empty | Overrides the portal `server_name`. |
| `PROTECTION`, `AUTHBASIC` | `manager`, empty | Manager protection mode (`manager` or `none`) and optional basic auth. |
| `REDIS_SERVER`, `REDIS_INDEXES` | empty | Switches `globalStorage` to `Apache::Session::Browseable::Redis` and sets `forceGlobalStorageIssuerOTT`, `tokenUseGlobalStorage`, `forceGlobalStorageUpgradeOTT`. |
| `PG_SERVER`, `PG_*`, `DBI_CHAIN`, `DBI_USER`, `DBI_PASSWORD`, `LDAP_URL`, `LDAP_CONF_*` | empty | Move the configuration (and sessions) to PostgreSQL/DBI or LDAP; first start uploads the local config. Not needed here. |
| `HANDLER_CRON`, `PORTAL_CRON` | `yes` | Keep or replace the purge cron jobs (`image:/etc/cron.d/liblemonldap-ng-*-perl`). |
| `FORCE_KEY_REGENERATION` | `no` | `yes` regenerates the LLNG `key` at every start (forces a config save, see 1.5). Keep `no`. |
| `OVERRIDE_<key>[_<subkey>]` | none | Sets any config key at start (`{...}`/`[...]` values parsed as JSON); each one triggers a config save when the stored value differs ([Y:base/README.md#L99]). |
| `LANGUAGES` | LLNG list | Portal languages, e.g. `en,fr`. |
| `FIXED_LOGOUT_REDIRECTION`, `CROWDSEC_*`, `NGINX_LOG_JSON`, `DEFAULT_WEBSITE`, `TLS_CERT_FILE`/`TLS_KEY_FILE`, `RELAY` | empty | Optional features (fixed logout URL, CrowdSec, JSON access logs, drop default site, TLS inside the container, extra relay vhosts). |
| `NPROC`, `ENGINE`, `LISTEN` | 7, `FCGI`, none | Read by `llng-fastcgi-server` (number of workers, engine, TCP listen). |
| `LLNG_JSONUSERS` | none | Path of the JsonFile users file (plugin, section 5.2), alternative to the `jsonFileUserPath` config key. |
| `S6_BEHAVIOUR_IF_STAGE2_FAILS` | unset | s6-overlay: with `2`, a failing `/etc/cont-init.d` script stops the container (`image:/package/admin/s6-overlay-3.1.3.0/etc/s6-rc/scripts/cont-init`, `.../s6-linux-init/skel/rc.init`). UNVERIFIED (read, not exercised). |

`MANAGER` and `HANDLER` are **not** understood by this image. They look like the
`MANAGER_HOSTNAME` / `HANDLER_HOSTNAME` variables of the other, official
`lemonldapng/lemonldap-ng` image ([D:docker]).

### 1.4 Where the configuration lives

- `image:/etc/lemonldap-ng/lemonldap-ng.ini` (local config, from
  [Y:portal/install/etc/lemonldap-ng/lemonldap-ng.ini]):
  `[configuration] type = Overlay`, `overlayRealtype = File`,
  `overlayDirectory = /over`, `dirName = /var/lib/lemonldap-ng/conf`,
  local cache `Cache::FileCache` in `/var/cache/lemonldap-ng` with
  `default_expires_in => 600`, `[all] checkTime = 1`. At start the image adds
  `useServerEnv = 1`, which enables `%SERVERENV:VAR%` placeholders in the
  configuration ([Y:update-llng-conf#L18-L26], [D:customconfigplaceholder], new in 2.23.0).
- File backend: `lmConf-<N>.json`, the highest `N` is the current config; saves
  write the file in place (`open '>'`) after taking `lmConf.lock` in the same
  directory ([S:File.pm]).
- Overlay backend: every file in `/over` (dotfiles ignored) overrides the key
  of the same name at load time. Keys matching `$hashParameters` (for example
  `oidcRPMetaDataOptions`, `oidcRPMetaDataExportedVars`,
  `oidcRPMetaDataOptionsExtraClaims`, `oidcRPMetaDataMacros`,
  `oidcRPMetaDataScopeRules`, `groups`, `macros`, `locationRules`, `keys`) must
  contain JSON; other keys are raw strings (leading/trailing whitespace trimmed
  for single-line values). Overlay keys are removed before a save and never
  written back unless `overlayWrite = 1` ([S:Overlay.pm], [D:overlayconfbackend]).
  VERIFIED: after start, the stored `lmConf-1.json` contained none of the overlay keys.
- Default image config `image:/var/lib/lemonldap-ng/conf/lmConf-1.json`: Demo
  authentication, sample vhosts and menu, `oidcServiceIgnoreScopeForClaims: 1`,
  `securedCookie: 0`, `timeout: 72000`.

### 1.5 What happens at every start

`/etc/cont-init.d/*` run in lexical order before the services
(`image:/package/admin/s6-overlay-3.1.3.0/etc/s6-rc/scripts/cont-init`;
`/start` does the same with `sh` in the no-s6 variant): `sync-templates`,
`update-llng-conf`, `update-nginx-conf`, `update-nginx-portal-conf`.

`update-llng-conf` ([Y:update-llng-conf]) runs `image:/usr/share/docker-llng/updateConf`:
`setDomain "$SSODOMAIN"`, `set portal "$(portalUrl "$PORTAL")"`, generates
`key` when empty (or when `FORCE_KEY_REGENERATION=yes`), then applies
`OVERRIDE_*`. Each `set` saves only when the value differs, with
`saveConf(force => 1, cfgNumFixed => 1)`, i.e. it overwrites the current
`lmConf-N.json` ([Y:base/install/usr/share/docker-llng/updateConf]).

Two consequences, both VERIFIED:

- `updateConf` loads the config with `getConf()`, which fills **all** default
  values and resolves placeholders ([S:Conf.pm#L194], [S:Conf.pm#L606]). When it
  saves, the stored file grows to about 450 keys and
  `%SERVERENV:DCS_OIDC_CLIENT_SECRET%` is replaced by the secret value.
  If `portal`, `domain` and `key` already match, nothing is written and the
  placeholder stays as is.
- The image prints the generated `key` in clear in the start log (its masking
  regex hides only the first occurrence). Development only, but worth knowing.

### 1.6 Providing a pre-built configuration

| Option | How | Status | Notes |
|---|---|---|---|
| **A. Seed script (recommended)** | Mount `lmConf-1.json` read-only at `/seed/`, and an executable script at `/etc/cont-init.d/00-dcs-idp-config` that copies it into `/var/lib/lemonldap-ng/conf/` (section 8.3). | VERIFIED (script installed with `docker cp` + `chmod 755`; a read-only bind mount of the same file is expected to behave the same, UNVERIFIED) | One reviewable JSON file. Re-seeded at every start, so runtime changes (manager, CLI) are discarded by design. The script clears the config cache and can generate secrets. |
| B. Overlay directory | Mount a directory at `/over:ro`; one file per top-level key. | VERIFIED | No script. The image default `lmConf-1.json` stays underneath (demo menu and vhosts, harmless). Files must be readable by `www-data` (uid 33). See the cache pitfall below. |
| C. `lemonldap-ng-cli` | `docker exec <c> /usr/share/lemonldap-ng/bin/lemonldap-ng-cli -yes 1 merge FILE` (or `restore FILE`, `set KEY VALUE`, `addKey ...`) | VERIFIED (`info`, `get`, `restore`, `merge`) | Every call creates `lmConf-<N+1>.json`. `restore FILE` stores the file "raw"; `merge FILE` goes through the manager checks (`Manager::Conf::Parser`, `image:/usr/share/perl5/Lemonldap/NG/Manager/Cli.pm`), which reported no error and no warning for the section 8 config. The CLI switches to `www-data`, so input files must be world-readable. Not idempotent: keep it for one-off changes. Syntax: [D:cli_examples]. |
| D. Bind-mount `lmConf-1.json` directly | `-v ./lmConf-1.json:/var/lib/lemonldap-ng/conf/lmConf-1.json` | UNVERIFIED | Works only if `portal`, `domain` and `key` in the file already match the environment. Otherwise `update-llng-conf` rewrites your file (read-write mount: defaults and resolved secrets land in the repository) or fails to save (read-only mount). Not recommended. |
| E. `OVERRIDE_<key>` variables | `environment: OVERRIDE_securedCookie: "1"` | not tested | Fine for a few scalars. Each one triggers a save, see 1.5. |

**Pitfalls (VERIFIED):**

- **Stale config cache.** The portal keeps the parsed config in
  `/var/cache/lemonldap-ng/lemonldap-ng-config` (container layer, not a volume)
  and reuses it while `cfgNum` is unchanged, up to `default_expires_in = 600` s
  ([S:Conf.pm#L194]). After editing an overlay file, `docker restart` still
  served the old `kid`. Fixes: recreate the container, or run
  `docker exec <c> /usr/share/lemonldap-ng/bin/lemonldap-ng-cli update-cache`
  (new value served within 2 s; a changed `users.json` was also reloaded).
  The option A script deletes the cache at every start.
- **`locationRules` is mandatory in a standalone config.** Without it the
  default value `{"default": "deny"}` is applied and every portal request fails
  with `Can't use string ("deny") as a HASH ref ... Handler/Main/Reload.pm line 348`.
  `"locationRules": {}` fixes it (default checked in the image with
  `Lemonldap::NG::Common::Conf::DefaultValues->defaultValues()`).

### 1.7 Session storage

- Default `globalStorage` is `Apache::Session::File` in
  `/var/lib/lemonldap-ng/sessions`, persistent sessions in
  `/var/lib/lemonldap-ng/psessions` (both anonymous volumes).
- OIDC authorization codes, access-token and refresh-token sessions go to the
  global storage unless `oidcStorage` is set ([S:Lib/OpenIDConnect.pm#L3038],
  [D:openidconnectservice] "Sessions").
- Purge: cron at minute 7 (`purgeCentralCache`) and minute 1
  (`purgeLocalCache`) every hour (`image:/etc/cron.d/`).
- `REDIS_SERVER` moves sessions to Redis (1.3). For one IdP container in dev
  and CI, the file storage is enough. Sessions and the generated signing key
  survive `docker restart`, not a container recreated without its volumes.

### 1.8 Healthcheck

`curl` is in the image (not `wget`). The discovery document proves that nginx,
the FastCGI server, the configuration and the OIDC issuer are all up:

```yaml
healthcheck:
  test: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://localhost/.well-known/openid-configuration"]
  interval: 5s
  timeout: 3s
  retries: 12
  start_period: 10s
```

VERIFIED inside the container: HTTP 200 in about 12 ms; the portal default
server answers `Host: localhost` (do not set `STRICT_SERVER_NAME`). `/ping`
also answers (`{"status":0}`) but does not test the OIDC module.

---

## 2. Enabling the OIDC issuer

### 2.1 Configuration keys

| Key | Default | Meaning | Source |
|---|---|---|---|
| `issuerDBOpenIDConnectActivation` | `0` | Turn the OP on. | [S:Attributes.pm#L1961], [D:idpopenidconnect] |
| `issuerDBOpenIDConnectPath` | `^/oauth2/` | Endpoint prefix (`oauth2`). | same |
| `issuerDBOpenIDConnectRule` | `1` | Rule allowing a user to use the OP at all. | same |
| `oidcServiceMetaDataIssuer` | empty: the `portal` URL | Issuer, also base URL of all endpoints. With `PORTAL=https://idp.dcs.test` the issuer is `https://idp.dcs.test/` (trailing slash, VERIFIED). Setting it to `https://idp.dcs.test` would give the same endpoint URLs because `/` is inserted when missing (UNVERIFIED, code reading). | [S:Issuer#L50], [S:Metadata.pm#L10], [D:openidconnectservice] |
| `oidcServicePrivateKeySig` | none | PEM private key. PKCS#8 (`BEGIN PRIVATE KEY`) works (VERIFIED). | [S:Attributes.pm#L5084], [S:Key.pm#L132] |
| `oidcServicePublicKeySig` | none | PEM public key **or X.509 certificate**; a certificate adds `x5c` and `x5t` to the JWKS and `x5t` to JWT headers (VERIFIED). The key type is detected from this value. | [S:Lib/OpenIDConnect.pm#L2766], [D:openidconnectservice] |
| `oidcServiceKeyIdSig` | none | `kid` of the key. When empty, no `kid` is published nor put in JWT headers. | [S:Lib/OpenIDConnect.pm#L2569], [S:Lib/OpenIDConnect.pm#L2766] |
| `oidcServiceKeyTypeSig` | `RSA` | `RSA` or `EC`; drives the advertised algorithms (RS/PS vs ES/EdDSA) and the default access-token algorithm. | [S:Metadata.pm], [S:Lib/OpenIDConnect.pm#L1636] |
| `oidcServiceSignatureKey` | `default-oidc-sig, old-oidc-sig, new-oidc-sig` | Key names: the first signs, all are published. `default-oidc-sig` maps to the three keys above; named keys can live in the `keys` container (2.22+). | [S:Attributes.pm#L5146], [S:Key.pm], [D:keys] |
| `oidcServiceOld*Sig`, `oidcServiceNew*Sig` | none | Rotation slots used by `rotateOidcKeys`. | `image:/usr/share/lemonldap-ng/bin/rotateOidcKeys` |
| `oidcServiceMetaDataDisallowNoneAlg` | off | Removes `none` from advertised algorithms (VERIFIED). | [S:Attributes.pm#L5240], [S:Metadata.pm] |
| `oidcServiceAllowAuthorizationCodeFlow` / `...ImplicitFlow` / `...HybridFlow` | `1` / `0` / `0` | Allowed flows. | [D:openidconnectservice] |
| `oidcServiceIgnoreScopeForClaims` | `0` (the image demo config sets `1`) | `1`: release every exported claim whatever the scopes. `0`: only claims attached to granted scopes. | [S:Attributes.pm#L5172], [S:Lib/OpenIDConnect.pm#L2407] |
| `oidcServiceAllowOnlyDeclaredScopes` | `0` | Drop unknown scopes. | [D:openidconnectservice] |
| `oidcServiceAccessTokenExpiration`, `oidcServiceIDTokenExpiration`, `oidcServiceAuthorizationCodeExpiration`, `oidcServiceOfflineSessionExpiration` | 3600, 3600, 60, 2592000 s | Global lifetimes (per-RP overrides in section 3). | [S:Attributes.pm] |
| `oidcServiceMetadataTtl` | none | `Cache-Control: public, max-age=N` on the discovery document (VERIFIED with 60). | [D:openidconnectservice] |
| `oidcStorage`, `oidcStorageOptions` | none | Separate storage for OIDC sessions. | [D:openidconnectservice] |

### 2.2 Generating the signing key

Plain OpenSSL (on the host or in the image):

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
  -subj "/CN=idp.dcs.test" -keyout oidc-sig.key -out oidc-sig.crt
```

LLNG's own generator (same code as the manager "new key" button and
`rotateOidcKeys`), 20-year self-signed certificate:

```sh
docker run --rm --entrypoint perl yadd/lemonldap-ng-full:2.23.4-1 \
  -MLemonldap::NG::Common::Util::Crypto -e \
  'my $k = Lemonldap::NG::Common::Util::Crypto::genCertKey(2048, undef, "idp.dcs.test");
   print $k->{private}, $k->{public}, "kid: $k->{hash}\n"'
```

(VERIFIED; source [S:Util/Crypto.pm].) Import with the CLI as documented in
[D:cli_examples] (`lemonldap-ng-cli -yes 1 set oidcServicePrivateKeySig "$(cat oidc.key)" ...`)
or put the PEMs in the JSON (section 8). `rotateOidcKeys` only fills the "new"
slot on its first run and prints "Rotation will be done next time", so it is not
a bootstrap tool (`image:/usr/share/lemonldap-ng/bin/rotateOidcKeys`).

### 2.3 Where the metadata and keys are served

| What | URL with the target setup | Source |
|---|---|---|
| Discovery | `https://idp.dcs.test/.well-known/openid-configuration` (hidden from anonymous users if `oidcServiceHideMetadata`) | [S:Issuer#L89] |
| JWKS | `https://idp.dcs.test/oauth2/jwks` (`?client_id=<id>` for per-RP signing keys) | [S:Lib/OpenIDConnect.pm#L2790], [D:keys] |
| Authorization | `https://idp.dcs.test/oauth2/authorize` | [S:Metadata.pm] |
| Token | `https://idp.dcs.test/oauth2/token` | same |
| Userinfo | `https://idp.dcs.test/oauth2/userinfo` | same |
| Introspection / revocation | `.../oauth2/introspect`, `.../oauth2/revoke` | same |
| End session | `https://idp.dcs.test/oauth2/logout` | same |
| Registration | only when dynamic registration is enabled | same |

Discovery document observed (VERIFIED, abridged):

```json
{
  "issuer": "https://idp.dcs.test/",
  "authorization_endpoint": "https://idp.dcs.test/oauth2/authorize",
  "token_endpoint": "https://idp.dcs.test/oauth2/token",
  "userinfo_endpoint": "https://idp.dcs.test/oauth2/userinfo",
  "jwks_uri": "https://idp.dcs.test/oauth2/jwks",
  "end_session_endpoint": "https://idp.dcs.test/oauth2/logout",
  "introspection_endpoint": "https://idp.dcs.test/oauth2/introspect",
  "revocation_endpoint": "https://idp.dcs.test/oauth2/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
  "code_challenge_methods_supported": ["plain", "S256"],
  "id_token_signing_alg_values_supported": ["HS256", "HS384", "HS512", "RS256", "RS384", "RS512", "PS256", "PS384", "PS512"],
  "scopes_supported": ["openid", "profile", "email", "address", "phone"],
  "subject_types_supported": ["public"],
  "response_modes_supported": ["query", "fragment", "form_post"],
  "backchannel_logout_supported": true,
  "frontchannel_logout_supported": true
}
```

JWKS observed: one key `{"kty": "RSA", "use": "sig", "kid": "<oidcServiceKeyIdSig>", "n": ..., "e": "AQAB", "x5c": [...], "x5t": ...}`,
no `alg` member (VERIFIED). Custom scopes such as `groups` are not listed in
`scopes_supported`. Authorization responses carry an `iss` parameter (RFC 9207,
[S:Lib/OpenIDConnect.pm#L639], VERIFIED).

---

## 3. Relying party definition

### 3.1 JSON structure

Per-RP data is spread over several top-level keys, each a hash keyed by the RP
configuration key (here `dcs-maquette`) ([S:Lib/OpenIDConnect.pm#L167] `load_rp`, [D:cli_examples]):

```json
{
  "oidcRPMetaDataOptions":            { "dcs-maquette": { "oidcRPMetaDataOptionsClientID": "dcs-maquette", "...": "..." } },
  "oidcRPMetaDataExportedVars":       { "dcs-maquette": { "<claim>": "<session attribute or RP macro>[;<type>[;<array>]]" } },
  "oidcRPMetaDataOptionsExtraClaims": { "dcs-maquette": { "<scope>": "<space separated claim names>" } },
  "oidcRPMetaDataMacros":             { "dcs-maquette": { "<macro>": "<Perl expression>" } },
  "oidcRPMetaDataScopeRules":         { "dcs-maquette": { "<scope>": "<rule>" } }
}
```

### 3.2 Options for each requirement

All keys below live in `oidcRPMetaDataOptions.dcs-maquette`. Types and defaults:
[S:Attributes.pm#L5377-L5670]; behaviour: [D:idpopenidconnect] "Options".

| Requirement | Key(s) and value | Behaviour | Status |
|---|---|---|---|
| Client id / secret | `oidcRPMetaDataOptionsClientID: "dcs-maquette"`, `oidcRPMetaDataOptionsClientSecret: "%SERVERENV:DCS_OIDC_CLIENT_SECRET%"` | The placeholder resolves from the container environment at load time. For `client_secret_basic`, id and secret are URL-decoded after base64 decoding (RFC 6749), so keep the secret URL-safe. | VERIFIED; [S:Lib/OpenIDConnect.pm#L2108] |
| Confidential client | `oidcRPMetaDataOptionsPublic: 0` | A token request carrying only `client_id` (method `none`) is rejected with `invalid_client`. | VERIFIED |
| Client auth method | `oidcRPMetaDataOptionsAuthMethod: "client_secret_basic"` (`""` = any; also `client_secret_post`, `client_secret_jwt`, `private_key_jwt`) | Another method is rejected with `invalid_client` (400); a wrong secret gives 401 `invalid_client` + `WWW-Authenticate: Basic`. | VERIFIED; [S:Lib/OpenIDConnect.pm#L2011] |
| Redirect URI | `oidcRPMetaDataOptionsRedirectUris: "https://portail.dcs.test/auth/callback"` (space separated list) | Exact string match; the token request must repeat the same `redirect_uri`. | VERIFIED; [S:Issuer#L1468], [S:Issuer#L1594] |
| Post-logout redirect URI | `oidcRPMetaDataOptionsPostLogoutRedirectUris: "https://portail.dcs.test/"` | Exact match (section 7). | VERIFIED |
| PKCE required | `oidcRPMetaDataOptionsRequirePKCE: 1` (0 disabled, 1 required, 2 PKCE or secret for public clients) | No `code_challenge` gives a redirect `error=invalid_request&error_description=Code challenge is required`; a missing or wrong `code_verifier` gives `invalid_grant`. **`code_challenge_method=plain` is accepted and cannot be refused server-side**: the RP must send S256. | VERIFIED; [S:Issuer#L873], [S:Issuer#L1612], [S:Lib/OpenIDConnect.pm#L2934] |
| Access token as JWT | `oidcRPMetaDataOptionsAccessTokenJWT: 1` | Header `typ: at+JWT`, `kid`, `x5t`; payload `iss`, `sub`, `aud`, `exp`, `iat`, `jti`, `sid`, `scope`, `client_id` (no `nbf`). The token is still recorded server-side (introspection works). | VERIFIED; [S:Lib/OpenIDConnect.pm#L1322], [S:Lib/OpenIDConnect.pm#L1385] |
| Access token algorithm | `oidcRPMetaDataOptionsAccessTokenSignAlg: "RS256"` (empty: RS256 or ES256 from the key type) | | VERIFIED; [S:Lib/OpenIDConnect.pm#L1636] |
| ID token algorithm | `oidcRPMetaDataOptionsIDTokenSignAlg: "RS256"` (default) | | VERIFIED |
| Claims in the access token | `oidcRPMetaDataOptionsAccessTokenClaims: 1` | Copies the **userinfo claim set** into the JWT (not only the "extra claims", despite the doc wording), without overriding the registered claims above. | VERIFIED; [S:Lib/OpenIDConnect.pm#L1385] |
| Claims in the ID token too | `oidcRPMetaDataOptionsIDTokenForceClaims: 1` | Without it the code-flow ID token only has `iss sub aud exp iat auth_time acr azp amr sid nonce at_hash`. | VERIFIED; [S:Issuer#L2827] |
| `sub` | `oidcRPMetaDataOptionsUserIDAttr: "uid"` (default: `whatToTrace`) | May also name an RP macro. | VERIFIED; [S:Lib/OpenIDConnect.pm#L3016] |
| Audience | always `[client_id]` + `oidcRPMetaDataOptionsAdditionalAudiences` (space separated) | `aud` is always an array. With `"dcs-api onlyoffice"`: `["dcs-maquette","dcs-api","onlyoffice"]` in both tokens. | VERIFIED; [S:Lib/OpenIDConnect.pm#L3000] |
| Online refresh token | `oidcRPMetaDataOptionsRefreshToken: 1` | Refresh token tied to the SSO session: lifetime = SSO `timeout` (default 72000 s), rejected (`invalid_grant`) once the session is gone. The refresh response has a new access token and ID token, no new refresh token unless `oidcRPMetaDataOptionsRefreshTokenRotation: 1`. `oidcRPMetaDataOptionsRtActivity` adds an inactivity timeout. | VERIFIED; [S:Issuer#L1741], [S:Issuer#L1894], [S:Lib/OpenIDConnect.pm#L1489] |
| No offline access | `oidcRPMetaDataOptionsAllowOffline: 0` | A requested `offline_access` scope is silently removed; an online token is issued and the token response carries the reduced `scope`. Offline tokens (when enabled) survive logout and last `...OfflineSessionExpiration` (default 30 days). | VERIFIED; [S:Issuer#L891], [D:idpopenidconnect] |
| No consent screen | `oidcRPMetaDataOptionsBypassConsent: 1` | Not compliant with the OIDC spec, per the documentation. | VERIFIED; [S:Issuer#L700] |
| Access restricted to a group | `oidcRPMetaDataOptionsRule: "inGroup('dcs-maquette')"` | Refused users stay on an LLNG error page (code 84, `PE_UNAUTHORIZEDPARTNER`); nothing is sent back to the RP. `$_oidc_grant_type` is available in the rule. | VERIFIED; [S:Issuer#L467], [S:Constants.pm#L94] |
| Token lifetimes | `oidcRPMetaDataOptionsAccessTokenExpiration`, `...IDTokenExpiration`, `...AuthorizationCodeExpiration`, `...OfflineSessionExpiration` (empty = global value) | 300 s gave `expires_in: 300` and `exp - iat = 300` for both tokens. | VERIFIED |
| Logout without confirmation | `oidcRPMetaDataOptionsLogoutBypassConfirm: 1` | Only with a valid `id_token_hint` (section 7). | VERIFIED |
| client_credentials | `oidcRPMetaDataOptionsAllowClientCredentialsGrant: 1` | Loads `Plugins::OIDC::ClientCredentialsGrant` and adds `client_credentials` to `grant_types_supported`. The RP access rule is evaluated without a user: `inGroup('dcs-maquette')` makes the grant fail with `invalid_grant`, so use for example `$_oidc_grant_type eq 'clientcredentials' or inGroup('dcs-maquette')`, or a separate RP. `sub` is the client id. Public clients are refused. When disabled: `unsupported_grant_type`. | VERIFIED; [S:Plugins.pm#L64], [S:ClientCredentialsGrant.pm] |

Other RP options that exist but are not needed here: `...DisplayName`, `...Icon`,
`...AuthnLevel`, `...AuthnRequireState`, `...AuthnRequireNonce`,
`...UserinfoRequireHeaderToken`, `...LogoutUrl`/`...LogoutType` (front/back
channel), `...Jwks`/`...JwksUri`, encryption options, `...NoJwtHeader`,
`...TokenXAuthorizedRP` ([S:Attributes.pm#L5377-L5670]).

---

## 4. Releasing `groups` as a JSON array

1. The session attribute `groups` is a string joined with `multiValuesSeparator`
   (default `"; "`), filled by the user backend and by the `groups` rules
   ([S:UserDB/Demo.pm#L154], [S:Process.pm#L652], [D:exportedvars]).
2. Map it with the "Always" array mode: `"groups": "groups;string;always"` in
   `oidcRPMetaDataExportedVars.dcs-maquette`. The value format is
   `session_key;type;array`, `type` in `string|int|bool`, `array` in
   `auto|always|never`; `always` splits on the separator even for a single group
   ([S:Lib/OpenIDConnect.pm#L2357], [S:Lib/OpenIDConnect.pm#L2480],
   [D:idpopenidconnect] "Exported attributes (claims)").
3. Attach it to a scope: `"oidcRPMetaDataOptionsExtraClaims": {"dcs-maquette": {"groups": "groups"}}`
   creates scope `groups` releasing claim `groups` ([S:Lib/OpenIDConnect.pm#L167],
   [D:idpopenidconnect] "Scope values content"). Standard scopes are predefined:
   `profile` gives `name given_name family_name preferred_username ...`, `email`
   gives `email email_verified` ([S:OIDC/Constants.pm#L23]).
4. With `oidcServiceIgnoreScopeForClaims: 0` (section 8), the RP must request
   `openid profile email groups`. VERIFIED: without `groups` in the request the
   claim is absent. With `1`, every exported claim is always released. To force
   the scope without asking the RP, a scope rule does it:
   `"oidcRPMetaDataScopeRules": {"dcs-maquette": {"groups": "1"}}` ([D:idpopenidconnect] "Scope rules").

Observed: `"groups": ["dcs-maquette", "dcs-maquette-admin"]` for the admin user
and `["dcs-maquette"]` for the others (VERIFIED). The order changes between
runs (hash ordering in the demo backends): compare as a set.

To publish only some groups (for example hide the built-in demo groups), use an
RP macro and map the claim to it (VERIFIED):

```json
{
  "oidcRPMetaDataMacros": {"dcs-maquette": {"dcsGroups": "join('; ', grep { /^dcs-maquette/ } split(/; /, $groups))"}},
  "oidcRPMetaDataExportedVars": {"dcs-maquette": {"groups": "dcsGroups;string;always"}}
}
```

(fragment: merge these keys into the full configuration)

---

## 5. Demo accounts

### 5.1 Built-in `Demo` backend

`authentication: Demo`, `userDB: Same`, `passwordDB: Demo` (the image default).
Accounts are hard-coded; the password is the login ([S:UserDB/Demo.pm#L21],
[S:Auth/Demo.pm#L32], [D:authdemo]):

| Login / password | `uid` | `cn` | `mail` | Built-in demo groups |
|---|---|---|---|---|
| `dwho` / `dwho` | dwho | Doctor Who | dwho@badwolf.org | `timelords`, `users` |
| `rtyler` / `rtyler` | rtyler | Rose Tyler | rtyler@badwolf.org | `earthlings`, `users` |
| `msmith` / `msmith` | msmith | Mickey Smith | msmith@badwolf.org | `earthlings`, `users` |

Only `uid`, `cn` and `mail` exist; users cannot be defined in the configuration
(package variables `%demoAccounts` and `%demoGroups`). Workable for the target
if needed (VERIFIED): groups rules `{"dcs-maquette": "1", "dcs-maquette-admin": "$uid eq 'dwho'"}`,
RP macros `givenNameFromCn: (split(/ /, $cn, 2))[0]` and `snFromCn: (split(/ /, $cn, 2))[1]`
mapped to `given_name` / `family_name`, and the `dcsGroups` macro of section 4
to hide `timelords`, `earthlings` and `users`.

### 5.2 Recommended: the JsonFile backend shipped in the image

The image includes the Debian package `linagora-lemonldap-ng-plugin-json-file`
0.5.1, "JSON file-based authentication and user backend for development and
testing" (`dpkg -l`; [Y:portal/Dockerfile]; code in
`image:/usr/share/perl5/Lemonldap/NG/Portal/Auth/JsonFile.pm` and
`image:/usr/share/perl5/Lemonldap/NG/Portal/UserDB/JsonFile.pm`; upstream
[P:json-file]).

- Configuration: `authentication: "JsonFile"`, `userDB: "Same"` (or
  `"JsonFile"`), `passwordDB: "Null"`, and `jsonFileUserPath: "/idp/users.json"`
  (or the `LLNG_JSONUSERS` environment variable).
- File format: `{"users": {"<login>": {"password": ..., "uid": ..., <any attribute>}}, "groups": {"<group>": ["<login>", ...]}}`.
  `password` defaults to the login, `uid` to the key. Every attribute is copied
  into the session; groups fill `groups` and `hGroups` (the `Demo` logic reused).
- The file is read at portal start and on config reload
  (`lemonldap-ng-cli update-cache` after an edit, VERIFIED).
- **Keep values ASCII.** With `"cn": "Chloé Bernard"`, the access token, ID
  token and userinfo contained the Latin-1 byte `0xE9` instead of UTF-8
  (invalid JSON for strict parsers) (VERIFIED). Likely cause: the plugin decodes
  the file into Perl character strings while LLNG handles UTF-8 byte strings
  (UNVERIFIED analysis).

Other file-based options (DBI with SQLite, a REST backend, an OpenLDAP
container) exist but need more moving parts; not evaluated.

### 5.3 Groups from configuration rules

The `groups` key maps a group name to a rule evaluated after login; matching
groups are appended to `groups` and `hGroups` after those of the user backend,
in alphabetical order of their names ([S:Process.pm#L652], [D:exportedvars]):

```json
{
  "groups": {
    "dcs-maquette": "1",
    "dcs-maquette-admin": "$uid eq 'alice'"
  }
}
```

Rules may use `inGroup('name')` (since 2.0.8) and any session attribute
([D:exportedvars]). With JsonFile, groups are simpler to declare in
`users.json`, as in section 8.

---

## 6. Running behind the TLS reverse proxy

- **Portal URL and issuer** come only from configuration: the request portal is
  `HANDLER->tsv->{portal}` ([S:Run.pm#L59]) and the issuer is
  `oidcServiceMetaDataIssuer` or the portal URL ([S:Issuer#L50]). Set
  `PORTAL=https://idp.dcs.test` (stored as `https://idp.dcs.test/`) while the
  container serves HTTP on port 80. The portal code does not read
  `X-Forwarded-Proto` or `X-Forwarded-Host` (only the Traefik handler mode reads
  `X-Forwarded-Host`/`-Uri`: [S:Handler/Server/Traefik.pm]). VERIFIED: the same
  `https://idp.dcs.test/...` URLs are returned whatever `Host` is sent.
- **Client IP**: LLNG stores the request address (`REMOTE_ADDR`) as `ipAddr`
  ([S:Process.pm] L589). Let nginx trust the proxy with
  `FORWARDED_BY=<proxy CIDR>` ([D:behindproxyminihowto]; section 1.3). VERIFIED:
  with `FORWARDED_BY=172.16.0.0/12,192.168.0.0/16,10.0.0.0/8`, the audit log
  showed the `X-Forwarded-For` address. Restrict it to the proxy network if you
  can: `real_ip_header` trusts the header from those sources.
- **Cookies**: `domain` = `SSODOMAIN` gives `domain=.dcs.test` (the special
  values `#PORTAL#` and `#PORTALDOMAIN#` exist but `update-llng-conf` sets
  `domain` back to `SSODOMAIN` at start whenever they differ)
  ([S:Process.pm#L806], [D:ssocookie]). `securedCookie: 1` adds `secure`,
  purely from configuration, so it works behind a TLS terminator
  ([S:Process.pm#L731]). Per the code, an empty `sameSite` means `Lax` unless
  SAML is enabled (the documentation also mentions OIDC, the code does not)
  ([S:Util.pm#L69]; code reading, the validated config sets `sameSite: "Lax"`
  explicitly). `Lax` suits the top-level GET redirects to `/oauth2/authorize`
  and `/oauth2/logout`. Observed SSO cookie (VERIFIED):
  `lemonldap=<id>; domain=.dcs.test; path=/; HttpOnly=1; SameSite=Lax; secure`.
  Consequence: browsers must use `https://idp.dcs.test`; plain-HTTP access to the
  container breaks the login (secure cookies are not sent back).
- The `https` config key ("Use HTTPS for redirection from portal") concerns
  handler-protected vhosts, not the OP ([S:Attributes.pm]).
- Proxy side, sketch only (Caddy not run in this research):

  ```caddyfile
  idp.dcs.test {
      tls internal
      reverse_proxy idp:80
  }
  ```

---

## 7. RP-initiated logout

Endpoint `end_session_endpoint` = `https://idp.dcs.test/oauth2/logout`
(`GET` or `POST`; parameters `id_token_hint`, `post_logout_redirect_uri`,
`state`, `client_id`) ([S:Issuer#L1268]):

- `post_logout_redirect_uri` must equal one of the RP's
  `oidcRPMetaDataOptionsPostLogoutRedirectUris`. The RP is found from the
  `id_token_hint` `azp` claim (payload decoded, signature **not** checked) or
  from `client_id`; without either, any RP's list is accepted
  ([S:Issuer#L1437]). Otherwise the portal shows error 108
  (`PE_UNAUTHORIZEDURL`) (VERIFIED with `https://evil.example/`).
- With `oidcRPMetaDataOptionsLogoutBypassConfirm: 1` **and** an `id_token_hint`
  whose `sub` and `sid` match the current session, the session is destroyed
  immediately and the browser gets `302 https://portail.dcs.test/?state=<state>`
  ([S:Issuer#L1387]; VERIFIED).
- Without `id_token_hint`, a confirmation page is shown; posting `confirm=1`
  logs out and redirects the same way (VERIFIED).
- Without an SSO session, a valid `post_logout_redirect_uri` is honoured at once
  (`302`) ([S:Issuer#L2444]; VERIFIED).
- After logout, the online refresh token of that session fails with
  `invalid_grant` (VERIFIED).
- Front- or back-channel logout to the RP (`oidcRPMetaDataOptionsLogoutUrl`,
  `...LogoutType`) is optional and not configured here ([D:idpopenidconnect] "Logout").

---

## 8. Complete minimal configuration

### 8.1 Layout (proposed)

```
infra/idp/
├── lmConf-1.json          # full LLNG configuration, no secret inside
├── users.json             # fictional accounts (JsonFile backend)
└── 00-dcs-idp-config      # executable seed script (chmod 755)
```

### 8.2 `lmConf-1.json`

This is the exact file validated in section 8.6. Keys not listed take LLNG
defaults. The signing key, its `kid` and `key` are injected by the script.

```json
{
  "authentication": "JsonFile",
  "cfgAuthor": "dcs-onlyoffice (local dev IdP)",
  "cfgDate": "1790380800",
  "cfgLog": "Local development OpenID Connect provider - NOT FOR PRODUCTION",
  "cfgNum": 1,
  "demoExportedVars": {
    "cn": "cn",
    "mail": "mail",
    "uid": "uid"
  },
  "domain": "dcs.test",
  "exportedHeaders": {},
  "exportedVars": {},
  "globalStorage": "Apache::Session::File",
  "globalStorageOptions": {
    "Directory": "/var/lib/lemonldap-ng/sessions",
    "LockDirectory": "/var/lib/lemonldap-ng/sessions/lock",
    "generateModule": "Lemonldap::NG::Common::Apache::Session::Generate::SHA256"
  },
  "groups": {},
  "issuerDBOpenIDConnectActivation": 1,
  "jsonFileUserPath": "/idp/users.json",
  "locationRules": {},
  "macros": {},
  "oidcRPMetaDataExportedVars": {
    "dcs-maquette": {
      "email": "mail",
      "family_name": "sn",
      "given_name": "givenName",
      "groups": "groups;string;always",
      "name": "cn",
      "preferred_username": "uid"
    }
  },
  "oidcRPMetaDataMacros": {
    "dcs-maquette": {}
  },
  "oidcRPMetaDataOptions": {
    "dcs-maquette": {
      "oidcRPMetaDataOptionsAccessTokenClaims": 1,
      "oidcRPMetaDataOptionsAccessTokenExpiration": 300,
      "oidcRPMetaDataOptionsAccessTokenJWT": 1,
      "oidcRPMetaDataOptionsAccessTokenSignAlg": "RS256",
      "oidcRPMetaDataOptionsActivation": 1,
      "oidcRPMetaDataOptionsAllowClientCredentialsGrant": 0,
      "oidcRPMetaDataOptionsAllowOffline": 0,
      "oidcRPMetaDataOptionsAllowPasswordGrant": 0,
      "oidcRPMetaDataOptionsAuthMethod": "client_secret_basic",
      "oidcRPMetaDataOptionsAuthorizationCodeExpiration": 60,
      "oidcRPMetaDataOptionsBypassConsent": 1,
      "oidcRPMetaDataOptionsClientID": "dcs-maquette",
      "oidcRPMetaDataOptionsClientSecret": "%SERVERENV:DCS_OIDC_CLIENT_SECRET%",
      "oidcRPMetaDataOptionsDisplayName": "DCS maquette",
      "oidcRPMetaDataOptionsIDTokenExpiration": 300,
      "oidcRPMetaDataOptionsIDTokenForceClaims": 1,
      "oidcRPMetaDataOptionsIDTokenSignAlg": "RS256",
      "oidcRPMetaDataOptionsLogoutBypassConfirm": 1,
      "oidcRPMetaDataOptionsPostLogoutRedirectUris": "https://portail.dcs.test/",
      "oidcRPMetaDataOptionsPublic": 0,
      "oidcRPMetaDataOptionsRedirectUris": "https://portail.dcs.test/auth/callback",
      "oidcRPMetaDataOptionsRefreshToken": 1,
      "oidcRPMetaDataOptionsRefreshTokenRotation": 0,
      "oidcRPMetaDataOptionsRequirePKCE": 1,
      "oidcRPMetaDataOptionsRule": "inGroup('dcs-maquette')",
      "oidcRPMetaDataOptionsUserIDAttr": "uid"
    }
  },
  "oidcRPMetaDataOptionsExtraClaims": {
    "dcs-maquette": {
      "groups": "groups"
    }
  },
  "oidcRPMetaDataScopeRules": {
    "dcs-maquette": {}
  },
  "oidcServiceAllowAuthorizationCodeFlow": 1,
  "oidcServiceAllowHybridFlow": 0,
  "oidcServiceAllowImplicitFlow": 0,
  "oidcServiceIgnoreScopeForClaims": 0,
  "oidcServiceKeyTypeSig": "RSA",
  "oidcServiceMetaDataDisallowNoneAlg": 1,
  "passwordDB": "Null",
  "persistentStorage": "Apache::Session::File",
  "persistentStorageOptions": {
    "Directory": "/var/lib/lemonldap-ng/psessions",
    "LockDirectory": "/var/lib/lemonldap-ng/psessions/lock"
  },
  "portal": "https://idp.dcs.test/",
  "portalSkin": "bootstrap5",
  "registerDB": "Null",
  "sameSite": "Lax",
  "securedCookie": 1,
  "userDB": "Same",
  "whatToTrace": "uid"
}
```

`users.json` (fictional people, `.test` addresses, ASCII only):

```json
{
  "users": {
    "alice": { "password": "alice", "uid": "alice", "cn": "Alice Martin",  "givenName": "Alice", "sn": "Martin",  "mail": "alice.martin@dcs.test" },
    "bob":   { "password": "bob",   "uid": "bob",   "cn": "Bob Durand",    "givenName": "Bob",   "sn": "Durand",  "mail": "bob.durand@dcs.test" },
    "chloe": { "password": "chloe", "uid": "chloe", "cn": "Chloe Bernard", "givenName": "Chloe", "sn": "Bernard", "mail": "chloe.bernard@dcs.test" }
  },
  "groups": {
    "dcs-maquette": ["alice", "bob", "chloe"],
    "dcs-maquette-admin": ["alice"]
  }
}
```

### 8.3 `00-dcs-idp-config` (seed script)

```sh
#!/command/with-contenv sh
# Seed the LemonLDAP::NG File configuration backend from a version-controlled
# lmConf-1.json. Runs before the image's own update-llng-conf script
# (cont-init.d scripts run in lexical order), at every container start.
set -eu
SEED=/seed/lmConf-1.json
CONF_DIR=/var/lib/lemonldap-ng/conf
[ -f "$SEED" ] || exit 0

# Dev-only secrets, generated once per configuration volume (never in git)
if [ ! -s "$CONF_DIR/oidc-sig.key" ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -subj "/CN=$(echo "${PORTAL:-idp}" | sed 's#^https*://##; s#/.*##')" \
    -keyout "$CONF_DIR/oidc-sig.key" -out "$CONF_DIR/oidc-sig.crt" 2>/dev/null
  openssl rand -hex 16 > "$CONF_DIR/llng.key"
  chmod 600 "$CONF_DIR/oidc-sig.key" "$CONF_DIR/llng.key"
fi
KID="dcs-$(openssl x509 -in "$CONF_DIR/oidc-sig.crt" -noout -fingerprint -sha256 \
  | sed 's/.*=//; s/://g' | cut -c1-16 | tr 'A-F' 'a-f')"

rm -f "$CONF_DIR"/lmConf-*.json "$CONF_DIR/lmConf.lock"
jq --rawfile key "$CONF_DIR/oidc-sig.key" --rawfile crt "$CONF_DIR/oidc-sig.crt" \
   --arg kid "$KID" --arg llngkey "$(cat "$CONF_DIR/llng.key")" \
   '.oidcServicePrivateKeySig = $key | .oidcServicePublicKeySig = $crt
    | .oidcServiceKeyIdSig = $kid | .key = $llngkey' \
   "$SEED" > "$CONF_DIR/lmConf-1.json"
chown www-data:www-data "$CONF_DIR/lmConf-1.json"
chmod 0640 "$CONF_DIR/lmConf-1.json"

# Drop the local configuration cache: same cfgNum would otherwise be served
# from cache (up to 10 minutes) after an edit + restart
rm -rf /var/cache/lemonldap-ng/lemonldap-ng-config
echo "dcs: LLNG configuration seeded from $SEED (signing key id $KID)"
```

Why it is shaped this way:

- `#!/command/with-contenv sh` gives the script the container environment, as
  the image's own scripts do; the no-s6 `/start` runs it with `sh` anyway
  ([Y:base-no-s6/start]).
- The injected `portal`, `domain` and `key` already match the environment, so
  `update-llng-conf` writes nothing and the `%SERVERENV:...%` placeholder stays
  in the stored file (VERIFIED: log shows no update line, stored file still has
  the placeholder).
- The key pair lives in the conf volume: same `kid` across restarts (VERIFIED),
  new key when the volume is recreated. RP libraries usually refetch the JWKS
  on an unknown `kid`. To keep a fixed key instead, commit a dev-only PEM pair
  and drop the generation block (secret scanners may flag it).
- The `openssl req` subject uses `PORTAL`; the resulting certificate had
  `CN=idp.dcs.test` (VERIFIED).

### 8.4 Docker Compose service (transcription of the validated setup)

```yaml
services:
  idp:
    image: yadd/lemonldap-ng-full:2.23.4-1   # 2.23.4-1-no-s6 on native arm64 Linux (see 1.1)
    environment:
      SSODOMAIN: dcs.test
      PORTAL: https://idp.dcs.test
      LOGLEVEL: info                          # debug when troubleshooting
      LOGGER: stderr
      USERLOGGER: stderr
      FORWARDED_BY: 172.16.0.0/12             # networks allowed to send X-Forwarded-For
      DCS_OIDC_CLIENT_SECRET: ${DCS_OIDC_CLIENT_SECRET:-dev-secret-change-me}
      # S6_BEHAVIOUR_IF_STAGE2_FAILS: "2"     # stop if the seed script fails (UNVERIFIED)
    volumes:
      - ./infra/idp/lmConf-1.json:/seed/lmConf-1.json:ro
      - ./infra/idp/users.json:/idp/users.json:ro
      - ./infra/idp/00-dcs-idp-config:/etc/cont-init.d/00-dcs-idp-config:ro
    healthcheck:
      test: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://localhost/.well-known/openid-configuration"]
      interval: 5s
      timeout: 3s
      retries: 12
      start_period: 10s
    # no published port: the reverse proxy reaches idp:80
```

The RP must be configured with issuer `https://idp.dcs.test/` (trailing slash),
client `dcs-maquette`, the secret, `client_secret_basic`, PKCE S256 and scopes
`openid profile email groups`.

### 8.5 Zero-script alternative: the same content as `/over` files

Mount a directory at `/over:ro` and create one file per top-level key; this
exact set was VERIFIED on top of the image default configuration:

| File in `/over` | Content |
|---|---|
| `issuerDBOpenIDConnectActivation` | `1` |
| `oidcServicePrivateKeySig` | PEM private key (file readable by uid 33) |
| `oidcServicePublicKeySig` | PEM certificate |
| `oidcServiceKeyIdSig` | e.g. `dcs-dev-sig-1` |
| `oidcServiceKeyTypeSig` | `RSA` |
| `oidcServiceMetaDataDisallowNoneAlg` | `1` |
| `oidcServiceIgnoreScopeForClaims` | `0` |
| `authentication` / `userDB` / `passwordDB` | `JsonFile` / `Same` / `Null` |
| `jsonFileUserPath` | `/idp/users.json` |
| `securedCookie` / `sameSite` | `1` / `Lax` |
| `oidcRPMetaDataOptions`, `oidcRPMetaDataExportedVars`, `oidcRPMetaDataOptionsExtraClaims` | the JSON objects of section 8.2 |

`PORTAL`, `SSODOMAIN` and `key` are then handled by `update-llng-conf`. Remember
the cache pitfall (1.6) after editing these files.

### 8.6 What was validated, and how

One throwaway container, `research-llng`, on `127.0.0.1:18080`, removed at the
end. It was first started with the overlay files (8.5), then switched to the
seed approach (8.2 and 8.3 copied in with `docker cp`, `/over` emptied) and
restarted several times:

```sh
docker run -d --name research-llng -p 127.0.0.1:18080:80 \
  -e SSODOMAIN=dcs.test -e PORTAL=https://idp.dcs.test -e LOGLEVEL=debug \
  -e DCS_OIDC_CLIENT_SECRET=dev-secret-change-me \
  -e FORWARDED_BY=172.16.0.0/12,192.168.0.0/16,10.0.0.0/8 \
  -v "$PWD/over:/over:ro" -v "$PWD/idp:/idp:ro" \
  yadd/lemonldap-ng-full:2.23.4-1

curl -s -H 'Host: idp.dcs.test' http://127.0.0.1:18080/.well-known/openid-configuration \
  | jq '{issuer, token_endpoint, jwks_uri, end_session_endpoint, grant_types_supported,
         token_endpoint_auth_methods_supported, code_challenge_methods_supported}'
curl -s http://127.0.0.1:18080/oauth2/jwks | jq '.keys[] | {kid, kty, use, x5t, x5c: (.x5c != null)}'
```

The browser flow was driven by the stdlib-only Python script of the appendix
(it talks HTTP to the container with `Host: idp.dcs.test` and
`X-Forwarded-Proto: https`, and handles the `secure` cookies by hand).

| Check | Result |
|---|---|
| Discovery document | issuer `https://idp.dcs.test/`, endpoints under `/oauth2/`, `response_types_supported ["code"]`, grants `authorization_code refresh_token`, auth methods `client_secret_post client_secret_basic`, PKCE `plain S256`, no `none` algorithm |
| JWKS | 1 RSA key, `use: sig`, `kid` as configured, `x5c` + `x5t`, no `alg` |
| Login + authorize (PKCE S256) | `GET /oauth2/authorize` returns the login form (hidden `token`, `url`, `skin`, `inProgress`); `POST` of the same URL returns `302 https://portail.dcs.test/auth/callback?code=...&state=...&session_state=...&iss=https%3A%2F%2Fidp.dcs.test%2F`; no consent page |
| Token endpoint (`client_secret_basic` + `code_verifier`) | 200 with `access_token`, `id_token`, `refresh_token`, `token_type: Bearer`, `expires_in: 300` |
| Access token | RS256, `typ: at+JWT`, signature valid against the JWKS certificate; `iss`, `sub=alice`, `aud=["dcs-maquette"]`, `client_id`, `scope`, `jti`, `sid`, `iat`, `exp`, and `email`, `preferred_username`, `name`, `given_name`, `family_name`, `groups` (array) |
| ID token | RS256, same user claims (forced), `acr: loa-2`, `amr: ["pwd"]`, `azp`, `nonce`, `at_hash`, `auth_time` |
| Userinfo / introspection | 200 with the same claims / `active: true` |
| Refresh grant | 200, new access token and ID token |
| RP-initiated logout with `id_token_hint` | `302 https://portail.dcs.test/?state=bye`; refresh token then `400 invalid_grant` |
| Negative cases | no `code_challenge`: error redirect; no `code_verifier`: `invalid_grant`; code reuse: `invalid_grant`; `client_secret_post`: `invalid_client`; wrong secret: 401; user outside `dcs-maquette` (temporary 4th test account): error page 84; unregistered `post_logout_redirect_uri`: error page 108 |
| Other | `groups` absent when the scope is not requested; `offline_access` stripped; additional audiences; `client_credentials` on a dedicated RP; Demo backend with groups rules and RP macros; config survives restarts with the same `kid`; `lemonldap-ng-cli merge` accepted the configuration |

Not verified in this research (UNVERIFIED): the s6 tag on native arm64 Linux
and the `-no-s6` tag at runtime; bind-mounting the seed script (it was copied
in); the Compose file and the Caddy snippet as such (no Caddy, no TLS in the
test: the proxy was simulated with `Host` and `X-Forwarded-*` headers); option D
(direct mount of `lmConf-1.json`); `S6_BEHAVIOUR_IF_STAGE2_FAILS=2`; an issuer
without trailing slash; a real browser (the login was scripted).

---

## 9. Open questions

1. **Back-channel reachability**: the RP server calls the token, userinfo and
   JWKS endpoints at `https://idp.dcs.test/...` (from discovery). Inside the
   Compose network that name must resolve to the TLS proxy (network alias) and
   the RP must trust the proxy's local CA, or the RP library must support a
   separate internal base URL. Not covered by LLNG sources.
2. **arm64 Linux**: confirm on a native arm64 Linux runner that the s6 tag
   fails and that `2.23.4-1-no-s6` works; decide which tag the repository pins.
3. **Signing key**: generated per volume (current proposal) or a committed
   dev-only key for a stable JWKS across `down`/`up`?
4. **Scope-driven release** (`oidcServiceIgnoreScopeForClaims: 0`) mirrors a
   typical production OP but requires the RP to ask for `groups`. Keep it, or
   switch to `1`, or force the scope with a scope rule?
5. **PKCE `plain`** cannot be refused by LLNG 2.23.4. Enforce S256 in the RP
   and tests only?
6. **Non-ASCII names** with JsonFile: report upstream, or stay ASCII-only?
7. **Issuer with trailing slash**: keep `https://idp.dcs.test/` or set
   `oidcServiceMetaDataIssuer` without it (UNVERIFIED variant)?
8. **Portal-only image**: `yadd/lemonldap-ng-portal` would drop the unused
   manager; not evaluated because the brief fixes the `-full` image.
9. **Fail fast**: set `S6_BEHAVIOUR_IF_STAGE2_FAILS=2` (s6 tag only) so that a
   broken seed does not leave a half-configured IdP running (UNVERIFIED).

---

## Appendix: validation script

Condensed, stdlib-only version of the Python harness used for section 8.6
(`python3 oidc_flow.py alice alice`). This exact code was re-run against the
final configuration: both signatures valid, refresh 200, logout 302, refresh
after logout `invalid_grant` (VERIFIED).

<details>
<summary>oidc_flow.py</summary>

```python
#!/usr/bin/env python3
"""Browser-less OIDC authorization code + PKCE smoke test against the LLNG
container reached over plain HTTP, as the TLS reverse proxy would reach it.
Cookies are handled by hand: the portal marks them Secure and scopes the SSO
cookie to .dcs.test, which stdlib cookie jars would not send to 127.0.0.1."""
import base64, hashlib, http.client, json, os, re, secrets, subprocess, sys, tempfile, urllib.parse

BACKEND = urllib.parse.urlparse(os.environ.get("LLNG_BACKEND", "http://127.0.0.1:18080"))
HOST, CLIENT_ID = "idp.dcs.test", "dcs-maquette"
SECRET = os.environ.get("CLIENT_SECRET", "dev-secret-change-me")
REDIRECT_URI, POST_LOGOUT = "https://portail.dcs.test/auth/callback", "https://portail.dcs.test/"
cookies = {}

def b64url(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def unb64url(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def request(method, path, body=None, headers=None, auth=None):
    h = {"Host": HOST, "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.10"}
    if cookies: h["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
    if auth: h["Authorization"] = "Basic " + base64.b64encode(auth.encode()).decode()
    if isinstance(body, dict):
        body = urllib.parse.urlencode(body); h["Content-Type"] = "application/x-www-form-urlencoded"
    h.update(headers or {})
    conn = http.client.HTTPConnection(BACKEND.hostname, BACKEND.port)
    conn.request(method, path, body=body, headers=h)
    r = conn.getresponse(); data = r.read()
    for k, v in r.getheaders():
        if k.lower() == "set-cookie":
            name, _, rest = v.partition("=")
            if "expires=Wed, 21 Oct 2015" in v: cookies.pop(name, None)
            else: cookies[name] = rest.split(";", 1)[0]
    return r.status, {k.lower(): v for k, v in r.getheaders()}, data

def jwt(token):
    h, p, s = token.split(".")
    return json.loads(unb64url(h)), json.loads(unb64url(p)), (h, p, s)

def rs256_ok(token, jwks):
    header, _, (h, p, s) = jwt(token)
    key = next(k for k in jwks["keys"] if k.get("kid") == header.get("kid"))
    with tempfile.TemporaryDirectory() as d:
        open(f"{d}/c.pem", "w").write("-----BEGIN CERTIFICATE-----\n" + key["x5c"][0] + "\n-----END CERTIFICATE-----\n")
        pub = subprocess.run(["openssl", "x509", "-in", f"{d}/c.pem", "-pubkey", "-noout"], capture_output=True, check=True).stdout
        open(f"{d}/pub.pem", "wb").write(pub); open(f"{d}/data", "wb").write(f"{h}.{p}".encode()); open(f"{d}/sig", "wb").write(unb64url(s))
        return subprocess.run(["openssl", "dgst", "-sha256", "-verify", f"{d}/pub.pem", "-signature", f"{d}/sig", f"{d}/data"], capture_output=True).returncode == 0

def login(user, password, scope):
    verifier = b64url(secrets.token_bytes(32))
    params = {"response_type": "code", "client_id": CLIENT_ID, "redirect_uri": REDIRECT_URI, "scope": scope,
              "state": secrets.token_hex(4), "nonce": secrets.token_hex(4),
              "code_challenge": b64url(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256"}
    path = "/oauth2/authorize?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
    st, h, body = request("GET", path)
    if st != 302:  # login form: replay hidden fields (CSRF token, url, skin...)
        hidden = dict(re.findall(r'<input type="hidden"(?: id="\w+")? name="(\w+)" value="([^"]*)"', body.decode("utf-8", "replace")))
        st, h, body = request("POST", path, body={**hidden, "user": user, "password": password})
    return verifier, h.get("location", f"no redirect, HTTP {st}")

def main():
    user, password = sys.argv[1], sys.argv[2]
    scope = sys.argv[3] if len(sys.argv) > 3 else "openid profile email groups"
    jwks = json.loads(request("GET", "/oauth2/jwks")[2])
    verifier, location = login(user, password, scope)
    print("authorize ->", location)
    if not location.startswith(REDIRECT_URI + "?code=") and "code=" not in location: return
    code = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(location).query))["code"]
    st, _, body = request("POST", "/oauth2/token", auth=f"{CLIENT_ID}:{SECRET}", body={
        "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT_URI, "code_verifier": verifier})
    tok = json.loads(body); print("token", st, sorted(tok))
    for name in ("access_token", "id_token"):
        header, payload, _ = jwt(tok[name]); print(name, header, payload, "signature ok:", rs256_ok(tok[name], jwks))
    print("userinfo", request("GET", "/oauth2/userinfo", headers={"Authorization": "Bearer " + tok["access_token"]})[2].decode())
    print("refresh", request("POST", "/oauth2/token", auth=f"{CLIENT_ID}:{SECRET}",
                             body={"grant_type": "refresh_token", "refresh_token": tok["refresh_token"]})[0])
    st, h, _ = request("GET", "/oauth2/logout?" + urllib.parse.urlencode(
        {"id_token_hint": tok["id_token"], "post_logout_redirect_uri": POST_LOGOUT, "state": "bye"}))
    print("logout", st, h.get("location"))
    print("refresh after logout", request("POST", "/oauth2/token", auth=f"{CLIENT_ID}:{SECRET}",
          body={"grant_type": "refresh_token", "refresh_token": tok["refresh_token"]})[2].decode())

if __name__ == "__main__":
    main()
```

</details>

---

## Sources

Documentation (live 2.x pages; sources under `doc/sources/admin/` at `v2.23.4`):

- [D:idpopenidconnect] https://lemonldap-ng.org/documentation/latest/idpopenidconnect.html
- [D:openidconnectservice] https://lemonldap-ng.org/documentation/latest/openidconnectservice.html
- [D:keys] https://lemonldap-ng.org/documentation/latest/keys.html
- [D:authdemo] https://lemonldap-ng.org/documentation/latest/authdemo.html
- [D:overlayconfbackend] https://lemonldap-ng.org/documentation/latest/overlayconfbackend.html
- [D:behindproxyminihowto] https://lemonldap-ng.org/documentation/latest/behindproxyminihowto.html
- [D:ssocookie] https://lemonldap-ng.org/documentation/latest/ssocookie.html
- [D:cli_examples] https://lemonldap-ng.org/documentation/latest/cli_examples.html
- [D:customconfigplaceholder] https://lemonldap-ng.org/documentation/latest/customconfigplaceholder.html
- [D:exportedvars] https://lemonldap-ng.org/documentation/latest/exportedvars.html
- [D:docker] https://lemonldap-ng.org/documentation/latest/docker.html
- Documentation sources: https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/tree/v2.23.4/doc/sources/admin

LLNG source, tag `v2.23.4` (base `https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/`):

- [S:Issuer] `lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Issuer/OpenIDConnect.pm`: https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Issuer/OpenIDConnect.pm
  (L50 issuer, L89 routes, L467 access rule, L700 consent, L873 PKCE at authorize, L891 offline_access, L1268 RP-initiated logout, L1387 bypass confirm, L1437 post-logout URI check, L1468 URI match, L1594 code grant, L1612 PKCE at token, L1741 online refresh token, L1894 refresh grant, L2444 logout without session, L2641 metadata, L2827 ID token)
- [S:Lib/OpenIDConnect.pm] `lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/OpenIDConnect.pm`: https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/OpenIDConnect.pm
  (L167 load_rp, L639 `iss` response parameter, L1322 access token, L1385 JWT access token, L1489 refresh token TTL, L1636 default algorithm, L2011 client authentication, L2108 credential parsing, L2272 scopes, L2357 claim mapping, L2407 userinfo claims, L2480 array handling, L2569 JWT signing, L2766 JWK, L2790 JWKS, L2934 PKCE check, L3000 audiences, L3016 `sub`, L3038 storage)
- [S:Key.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Lib/Key.pm#L132
- [S:Metadata.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-common/lib/Lemonldap/NG/Common/OpenIDConnect/Metadata.pm
- [S:OIDC/Constants.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-common/lib/Lemonldap/NG/Common/OpenIDConnect/Constants.pm#L23
- [S:Attributes.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-manager/lib/Lemonldap/NG/Manager/Build/Attributes.pm
  (L1286 `key`, L1676 `domain`, L1699 `securedCookie`, L1716 `sameSite`, L1961 issuer activation, L4971-L5245 OIDC service, L5377-L5670 RP options)
- [S:Util.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-common/lib/Lemonldap/NG/Common/Util.pm#L69
- [S:Util/Crypto.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-common/lib/Lemonldap/NG/Common/Util/Crypto.pm
- [S:Process.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Main/Process.pm (L589 `ipAddr`, L652 groups, L731 cookie, L806 cookie domain)
- [S:Run.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Main/Run.pm#L59
- [S:Conf.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-common/lib/Lemonldap/NG/Common/Conf.pm (L194 getConf and cache, L606 placeholders)
- [S:Overlay.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-common/lib/Lemonldap/NG/Common/Conf/Backends/Overlay.pm
- [S:File.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-common/lib/Lemonldap/NG/Common/Conf/Backends/File.pm
- [S:UserDB/Demo.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/UserDB/Demo.pm#L21
- [S:Auth/Demo.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Auth/Demo.pm#L32
- [S:Plugins.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Main/Plugins.pm#L64
- [S:ClientCredentialsGrant.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Plugins/OIDC/ClientCredentialsGrant.pm
- [S:Constants.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-portal/lib/Lemonldap/NG/Portal/Main/Constants.pm#L94
- [S:Handler/Server/Traefik.pm] https://gitlab.ow2.org/lemonldap-ng/lemonldap-ng/-/blob/v2.23.4/lemonldap-ng-handler/lib/Lemonldap/NG/Handler/Server/Traefik.pm

Image build sources, tag `v2.23.4-1` (base `https://github.com/guimard/llng-docker/blob/v2.23.4-1/`):

- [Y:base/Dockerfile] https://github.com/guimard/llng-docker/blob/v2.23.4-1/base/Dockerfile (L25-L28 s6 x86_64, L44 ENV, L134 VOLUME, L144 ENTRYPOINT)
- [Y:base-no-s6/Dockerfile] https://github.com/guimard/llng-docker/blob/v2.23.4-1/base-no-s6/Dockerfile and [Y:base-no-s6/start] https://github.com/guimard/llng-docker/blob/v2.23.4-1/base-no-s6/start
- [Y:portal/Dockerfile] https://github.com/guimard/llng-docker/blob/v2.23.4-1/portal/Dockerfile
- [Y:full/Dockerfile] https://github.com/guimard/llng-docker/blob/v2.23.4-1/full/Dockerfile
- [Y:action.yml] https://github.com/guimard/llng-docker/blob/v2.23.4-1/.github/actions/docker-common/action.yml#L65
- [Y:base/README.md] https://github.com/guimard/llng-docker/blob/v2.23.4-1/base/README.md#L99
- [Y:update-llng-conf] https://github.com/guimard/llng-docker/blob/v2.23.4-1/base/install/etc/cont-init.d/update-llng-conf
- [Y:base/install/usr/share/docker-llng/updateConf] https://github.com/guimard/llng-docker/blob/v2.23.4-1/base/install/usr/share/docker-llng/updateConf
- [Y:full/install/etc/cont-init.d/update-nginx-conf] https://github.com/guimard/llng-docker/blob/v2.23.4-1/full/install/etc/cont-init.d/update-nginx-conf
- [Y:portal/install/etc/lemonldap-ng/lemonldap-ng.ini] https://github.com/guimard/llng-docker/blob/v2.23.4-1/portal/install/etc/lemonldap-ng/lemonldap-ng.ini

JsonFile plugin (installed in the image as `linagora-lemonldap-ng-plugin-json-file` 0.5.1):

- [P:json-file] https://github.com/linagora/lemonldap-ng-plugins/tree/main/plugins/json-file
- In the image: `/usr/share/perl5/Lemonldap/NG/Portal/Auth/JsonFile.pm`,
  `/usr/share/perl5/Lemonldap/NG/Portal/UserDB/JsonFile.pm`,
  `/etc/lemonldap-ng/manager-overrides.d/json-file.json`
