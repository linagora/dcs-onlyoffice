# ONLYOFFICE Docs Community Edition 9.4.0.1: integration research

Research notes for running `onlyoffice/documentserver:9.4.0.1` behind a TLS reverse proxy on a
private Docker network, opening documents from a small host portal through the Docs API with JWT,
handling callbacks and force-save, and writing a right-panel document-labelling plugin that works
with content controls and custom XML parts.

- Date of research: 2026-09-26.
- Primary sources: the image itself, the ONLYOFFICE source code at the git tag that matches the
  image (`v9.4.0.129`, see [section 0](#0-version-pinning)), and api.onlyoffice.com. Every claim
  below carries a link; image-only facts give the path inside the image.
- Nothing was run against a live editor. Everything that needs a browser or a running container is
  collected in [Open questions](#15-open-questions-need-a-live-test).

Legend: **[image]** read from the `onlyoffice/documentserver:9.4.0.1` image (most authoritative);
**[code]** read in ONLYOFFICE source at tag `v9.4.0.129`; **[doc]** api.onlyoffice.com (the site
documents the latest release, currently 9.4.1, not 9.4.0); *inference* = my reading of the code,
not an explicit statement; **UNVERIFIED** = not confirmed; **CONTRADICTION** = docs and 9.4.0 code
disagree (the code wins for this image).

## Summary

- **CE 9.4 is a single-process, in-memory server.** The Community image no longer bundles
  PostgreSQL, RabbitMQ or Redis, and the public server source aliases the SQL, queue and pub/sub
  modules to in-memory implementations ("no persistence across restarts"). A new, non-configurable
  memory admission guard silently turns *new* editing sessions into **view mode** when the heap
  budget is exhausted. The old 20-connection CE limit is gone from the code
  ([1.1](#11-ce-94-runtime-model-in-memory-single-process)).
- **Docker env:** `JWT_ENABLED` defaults to `true` and `JWT_SECRET` to a *new random value at every
  start*, so always set it. `JWT_IN_BODY` has no effect in 9.4.0 (the config keys it writes are
  never read). `ALLOW_PRIVATE_IP_ADDRESS` is not needed for `document.url`/`callbackUrl` when JWT is
  on, because URLs taken from a verified token bypass the SSRF filter (code; needs a live check).
  `PLUGINS_ENABLED=true` downloads plugins from `https://onlyoffice.github.io` at each start.
  `/healthcheck` answers HTTP 200 with the body `true` or `false`
  ([1.2](#12-environment-variables-read-by-the-entrypoint), [1.3](#13-ports-volumes-healthcheck)).
- **Reverse proxy:** the internal nginx derives scheme/host/prefix from `X-Forwarded-Proto`
  (or `CloudFront-Forwarded-Proto`), the first value of `X-Forwarded-Host` (else `Host`) and
  `X-Forwarded-Prefix`; WebSockets must pass through ([1.4](#14-behind-a-tls-reverse-proxy)).
- **Docs API:** required client fields are `document.url`, `document.key` (string), and
  `document.fileType` or `documentType`. The server-side token must contain `document.key`,
  `document.url`, identical `document.permissions`, `editorConfig.callbackUrl` and
  `editorConfig.mode` (unless the client asks for `view`). `pluginsData` is still supported: the
  **browser** fetches each `config.json` with `fetch()` from the editor iframe, so a cross-origin
  plugin host needs CORS ([2](#2-docs-api-editor-configuration)).
- **Callbacks** carry the JWT twice: `Authorization: Bearer` (payload `{"payload": body}`) and a
  `token` field in the body (payload = body). The handler must answer HTTP 200 with `{"error":0}`.
  The saved-file `url` is signed for 15 minutes and uses the browser-facing host
  ([3](#3-callback-handler), [5](#5-jwt-on-requests-sent-by-the-document-server)).
- **Command service:** `POST /command` with `{"token": jwt({c:"forcesave", key})}`. Error `4`
  means there is nothing new to save; code also returns `7` (expired token), which the docs omit
  ([4](#4-command-service-force-save)).
- **Plugin runtime:** `Asc.plugin.info` exposes `userId`, `userName`, `isViewMode`, `editorType`,
  `lang`, `documentId` (the key), `documentCallbackUrl`, `options` and `jwt` (the DS session token).
  Most of these are undocumented but present in the code. `callCommand` code runs in a sandbox
  (`window`/`document` shadowed, XHR needs a user confirmation dialog), gets data only through
  JSON-serialised `Asc.scope`, and runs as **one undo step** that is **rolled back in view mode**
  ([7](#7-plugin-runtime-api)).
- **Events:** declare events in `config.json` `events` even though the docs call it deprecated.
  Only that path replays `onDocumentContentReady` to a late-started plugin. Using
  `attachEditorEvent("onContextMenuClick")` silently breaks `attachContextMenuClickEvent`. The
  `onContextMenuShow` payload key is `type`, not `Type` as documented ([7.6](#76-events)).
- **Content controls:** `Push`/`AddElement`/`AddText` refuse to edit `contentLocked` and
  `sdtContentLocked` controls, and `Delete` refuses `sdtLocked` and `sdtContentLocked` ones. But
  `GetContent()` and `RemoveAllElements()` are not guarded, and `SetLock` always works. Unlock,
  modify and relock inside one `callCommand` ([8](#8-office-javascript-api-text-document-inside-callcommand)).
- **Custom XML parts (critical):** the 9.0 API is present. Parts are written to the DOCX as
  `customXml/itemN.xml` + `itemPropsN.xml` and read back on open. Every mutation is recorded as
  history changes that are serialised into the co-editing stream and are **undoable by the user**.
  The code also shows limits. Data binding to content controls is disabled in the CE build (the
  `ooxml` add-on flag is never set). The serialiser mishandles `&` and `"` (a live test is needed).
  Mixed content is not preserved ([9](#9-custom-xml-parts-api-90-critical)).
- **Plugin SDK files:** use the copies shipped in the image under
  `/var/www/onlyoffice/documentserver/sdkjs-plugins/v1/` (served at `/sdkjs-plugins/v1/`). The
  `https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js` URL used in the docs now serves a newer
  version. The files are licensed AGPL-3.0 ([11](#11-pluginsjs-plugins-uijs-pluginscss)).
- **DOM:** the editor is `<iframe name="frameEditor">` with no id (it replaces the placeholder).
  A `panelRight` plugin runs in `<iframe id="iframe_<guid>" name="pluginFrameEditor">` whose `src`
  is `baseUrl + variation.url + "?lang=…&theme-type=…"`, so its origin is the plugin host
  ([12](#12-dom-structure-for-browser-automation)).

## How this was researched

1. The image was pulled and inspected read-only with short `docker run --rm --entrypoint …`
   commands: image config, `dpkg -l`, `/app/ds/run-document-server.sh`,
   `/etc/onlyoffice/documentserver/*`, nginx includes, `/usr/bin/documentserver-*.sh`,
   `sdkjs-plugins/`, `web-apps/apps/api/documents/api.js.tpl`, and greps inside the
   `sdkjs/*/sdk-all*.js` bundles. 9.4.0 "removed code minification"
   ([changelog][ds-changelog-backend]), so the bundles are readable. No long-running container was
   started.
2. Source tarballs of `server`, `sdkjs`, `web-apps`, `Docker-DocumentServer` at `v9.4.0.131`
   (identical to `.129` for everything cited, see section 0) were read. Files from `core` and
   `document-server-package` were fetched at `v9.4.0.129`.
3. The api.onlyoffice.com pages were read from their Markdown sources (repository
   `ONLYOFFICE/api.onlyoffice.com`, commit `32b84cf`), and every cited public URL was checked to
   return HTTP 200.

## 0. Version pinning

- The Docker tag `9.4.0.1` is a multi-arch index (`sha256:3ab6ebc7c605…`) with `linux/amd64`
  (`sha256:e231bc62…`) and `linux/arm64` (`sha256:4cf3b554…`) variants. Both image configs record
  `PACKAGE_VERSION=9.4.0-129` in their build history, and both were built on 2026-07-22 **[image]**.
- Inside the arm64 image, `dpkg -l` shows `onlyoffice-documentserver 9.4.0-129`. The generated
  `api.js.tpl` returns `9.4.0` from `DocEditor.version()` and sends `_dc=9.4.0-129` **[image]**.
- The matching tags are `v9.4.0.129` in [sdkjs][sdkjs-tag], [web-apps][webapps-tag],
  [server][server-tag], [core][core-tag], [Docker-DocumentServer][docker-tag] and
  [document-server-package][dsp-tag]. The meta-repository tag [`DocumentServer v9.4.0`][ds-meta]
  points at `v9.4.0.131` plus a merge commit. For web-apps, server and Docker-DocumentServer, `.129`
  and `.131` are the same commit. For sdkjs, only `cell/apiBuilder.js` and tests differ, so all
  line numbers cited below are valid for `.129` (checked with the GitHub compare API).
- The image's `/app/ds/run-document-server.sh` is byte-identical to
  [`run-document-server.sh`][d-run]. `/etc/onlyoffice/documentserver/default.json` and
  `production-linux.json` are identical to [`default.json`][v-default] and
  [`production-linux.json`][v-prodlinux] **[image]**.

## 1. Docker image

### 1.1 CE 9.4 runtime model: in-memory, single process

- The official 9.4.0 changelog lists, under "Back-end" ([CHANGELOG.md L47-L54][ds-changelog-backend]):
  - "Consolidated components into a single process";
  - "Removed dependency on RabbitMQ";
  - "Removed dependency on databases";
  - "Removed the limitation of 20 simultaneously opened documents".

  The code below shows what this means for CE.
- The Dockerfile installs `postgresql`, `rabbitmq-server`, `redis-server` (and Oracle/MSSQL clients)
  **only when `PRODUCT_EDITION` is non-empty**, that is for EE/DE ([Dockerfile L86-L116][d-dockerfile-editions]).
  The CE image has `PRODUCT_EDITION=` **[image]**.
- The entrypoint sets `REDIS_AVAILABLE`, `RABBITMQ_AVAILABLE`, `DB_AVAILABLE` and
  `ADMINPANEL_AVAILABLE` to `false` for CE ([L131-L132][d-run-available]). As a result `DB_*`,
  `AMQP_*` and `REDIS_*` variables are never read in CE ([L164-L214][d-run-readsetting]), even though
  the README lists them as "the complete list of parameters" ([README L194-L245][d-readme-env]).
- In the server, `isMemoryRuntime()` is always `true` when `license.packageType` is the open-source
  type ([profile.js L37-L64][v-profile]). The CE license module returns that type
  ([license.js L44-L70][v-license]), and `production-linux.json` sets `"packageType": 0`
  ([production-linux.json][v-prodlinux]).
- The public source hard-wires the backends: `baseConnector.js` is
  `module.exports = require('./memoryConnector')` ([L37][v-baseconn]), `pubsubRabbitMQ.js` is
  `require('./pubsubMemory')` ([L37][v-pubsub]) and `taskqueueRabbitMQ.js` is
  `require('./taskqueueMemory')` ([L37][v-taskq]). The memory connector says: "No SQL pool, no
  driver dependencies, no persistence across restarts" ([memoryConnector.js L36-L44][v-memconn]).
- *Inference:* open editing sessions and unsaved changes live in the `docservice` process. They are
  lost on crash or restart, and you cannot run two instances behind a load balancer. On `SIGTERM`
  the entrypoint runs `documentserver-prepare4shutdown.sh` ([L10-L19][d-run-exit]), which sends
  `PUT http://localhost:8000/internal/cluster/inactive` **[image]**
  (`/usr/bin/documentserver-prepare4shutdown.sh`). That starts the shutdown flow
  ([shutdown.js][v-shutdown], route in [server.js L287][v-serverjs-routes]), which publishes a
  shutdown message and waits up to 30 s plus the conversion timeout for saves to finish. Give the
  container a generous stop timeout (the ONLYOFFICE compose file uses `stop_grace_period: 60s`,
  [docker-compose.yml L25][d-compose]).
- **Memory admission guard (new in 9.4):** see [memoryGuard.js L36-L67 and L109-L125][v-guard]. It
  is applied during `auth` ([DocsCoServer.js L634-L671, L3037][v-guard-apply]). It blocks a session
  only when that session would open a document that no one is editing yet, and only if one of two
  conditions is true:
  - the number of open editable documents is at least
    `floor((heap_size_limit − 256 MiB) / budget)`;
  - or `used_heap + budget` exceeds 90 % of the heap limit.

  The budget is `max(maxChangesSize / 4, 20 MiB)`. With the default `maxChangesSize` of `150MB`
  ([default.json L520][v-default-maxchanges], parsed with `bytes.parse`) it is 37.5 MiB. Viewers,
  live viewers and users joining an already-open document are always admitted.
  **A refused session is not rejected: the server switches it to view mode**
  (`modifyConnectionEditorToView`, `licenseType = ConnectionsOS`) and logs the warning
  `auth: forced view mode by community memory guard …`. The policy is "intentionally NOT
  configurable"; `maxChangesSize` is its only input. The heap limit of the packaged `docservice`
  binary inside a container is **UNVERIFIED**.
- The CE license returns `connections` and `connectionsView` equal to `0x7fffffff`
  ([license.js L54-L55][v-license], [constants.js L95][v-const-lic]), which matches the changelog.
  **CONTRADICTION:** the Viewing page still says "The open source version limit is 20" for the live
  viewer ([doc][a-viewing]).
- The CE license also returns `advancedApi: false` ([license.js L57][v-license]). The editor drops
  host-page `onExternalPluginMessage` messages when this flag is false
  ([editorscommon.js L2189-L2203][s-edcommon-ext]). So the host page cannot push messages into
  plugins in CE, and the Automation API connector needs `advancedApi` too (same check).

### 1.2 Environment variables read by the entrypoint

All rows are from [`run-document-server.sh`][d-run] (identical in the image) unless noted.

| Variable | Default | Effect | Evidence |
|---|---|---|---|
| `JWT_ENABLED` | `true` | Sets `token.enable.browser`, `token.enable.request.inbox` and `token.enable.request.outbox` | [L110-L117, L386-L388][d-run-jwt] |
| `JWT_SECRET` | random `pwgen -s 32` **at every start** | Written to `secret.browser`, `secret.inbox`, `secret.outbox` and `secret.session`. Set it, otherwise all signed configs break after a restart. The startup log prints a hint when it is random. `documentserver-jwt-status.sh` prints the active value. | [L119-L121, L390-L393][d-run-jwt], [L843][d-run-tail], image `/usr/bin/documentserver-jwt-status.sh` |
| `JWT_HEADER` | `Authorization` | `token.inbox.header` and `token.outbox.header`. The prefix stays `Bearer ` ([default.json L473-L504][v-default-token]). | [L122, L395-L396][d-run-jwt] |
| `JWT_IN_BODY` | `false` | Writes `token.inbox.inBody` and `token.outbox.inBody`. **No effect in 9.4.0:** neither key is referenced anywhere in the server source (grep of `server@v9.4.0.129`), see [5](#5-jwt-on-requests-sent-by-the-document-server). **CONTRADICTION** with the [token-in-body doc][a-tokenbody]. | [L123, L398-L399][d-run-jwt] |
| `WOPI_ENABLED` | `false` | `wopi.enable`, and generates RSA keys in `/var/www/onlyoffice/Data`. Not needed for the Docs API. | [L412-L429][d-run-wopi] |
| `ALLOW_PRIVATE_IP_ADDRESS` | `false` | `services.CoAuthoring['request-filtering-agent'].allowPrivateIPAddress` | [L431-L435][d-run-wopi] |
| `ALLOW_META_IP_ADDRESS` | `false` | `…allowMetaIPAddress` (a "meta" address is `0.0.0.0` or `::`, [doc][a-servercfg-rfa]) | [L431-L435][d-run-wopi] |
| `USE_UNAUTHORIZED_STORAGE` | `false` | `requestDefaults.rejectUnauthorized=false`, which accepts self-signed TLS on the storage side | [L407-L410][d-run-wopi] |
| `NODE_EXTRA_CA_CERTS` | `/var/www/onlyoffice/Data/certs/extra-ca-certs.pem` | Added to the supervisor environment of the Node services when the file exists. Better than the previous row for an internal CA. | [L72-L88][d-run-ca] |
| `PLUGINS_ENABLED` | `true` | Runs `documentserver-pluginsmanager.sh --update=…/plugin-list-default.json` in the background at every start. Default marketplace: `https://onlyoffice.github.io` (`pluginsmanager --help`). List: `ai, highlightcode, mendeley, ocr, photoeditor, speech, speechrecognition, thesaurus, translator, youtube, zotero`. Does not affect `editorConfig.plugins`. | [L807-L809][d-run-plugins], image `/var/www/onlyoffice/documentserver/sdkjs-plugins/plugin-list-default.json` |
| `GENERATE_FONTS` | `true` | Runs `documentserver-generate-allfonts.sh` at every start (`allfontsgen` over core fonts, `/var/www/onlyoffice/Data/custom-fonts` and system fonts, plus theme thumbnails and the x2t JS cache). This slows startup. | [L836-L839][d-run-tail], image `/usr/bin/documentserver-generate-allfonts.sh` |
| `SECURE_LINK_SECRET` | random at every start | nginx `secure_link` secret and `storage.fs.secretString`. It signs `/cache/files/...` URLs, including the callback `url`. | [L672][d-run-nginx], image `/usr/bin/documentserver-update-securelink.sh`, [storage-base.js L161-L200][v-storage] |
| `EXAMPLE_ENABLED` | `false` | Autostarts the test example app on port 3000 | [L812][d-run-plugins] |
| `DS_LOG_LEVEL` | from `log4js/production.json` (`WARN`) | Log level (not in the README) | [L216, L675-L677][d-run-readsetting], image `/etc/onlyoffice/documentserver/log4js/production.json` |
| `NGINX_WORKER_PROCESSES`, `NGINX_WORKER_CONNECTIONS`, `NGINX_ACCESS_LOG` | `1`, `ulimit -n`, `false` | nginx tuning | [L103-L107, L618-L628][d-run-nginx] |
| `SSL_CERTIFICATE_PATH`, `SSL_KEY_PATH`, `SSL_DHPARAM_PATH`, `SSL_VERIFY_CLIENT`, `CA_CERTIFICATES_PATH`, `ONLYOFFICE_HTTPS_HSTS_*`, `LETS_ENCRYPT_*` | see script | TLS inside the container; irrelevant when a proxy terminates TLS | [L61-L70, L90-L95, L152-L156, L630-L661][d-run-nginx] |
| `METRICS_*` | disabled | StatsD | [L159-L162][d-run-readsetting] |

### 1.3 Ports, volumes, healthcheck

- `EXPOSE 80 443` ([Dockerfile L71][d-dockerfile-expose]). nginx listens on `0.0.0.0:80` (and
  `[::]:80`) over plain HTTP. HTTPS on 443 is configured only if a certificate and key exist
  (`ds-ssl.conf.tmpl`) ([L630-L661][d-run-nginx], [ds-ssl.conf.tmpl.m4][p-ssl]). The docservice
  itself listens on `localhost:8000` ([http-common.conf.m4 upstream][p-http], `server.port: 8000`
  in [default.json L322][v-default-server]).
- CE volumes: `/var/log/onlyoffice`, `/var/lib/onlyoffice` (cache, including forgotten files),
  `/var/www/onlyoffice/Data` (certificates, WOPI keys, `custom-fonts`) and
  `/usr/share/fonts/truetype/custom` ([Dockerfile L140][d-dockerfile-volume], image config,
  [README L71-L110][d-readme-volumes]).
- The image defines no `HEALTHCHECK` (`docker image inspect`) **[image]**. The ONLYOFFICE compose
  file uses `curl -f http://localhost:8000/info/info.json` ([docker-compose.yml L17-L22][d-compose]).
- The documented health endpoint is `GET /healthcheck`, whose response "must be **true**"
  ([doc][a-selfhosted]). The code always answers **HTTP 200** with `text/plain` body `true` or
  `false` ([DocsCoServer.js L4483-L4535][v-healthcheck], route [server.js L263][v-serverjs-routes]),
  so check the body. Example:
  `curl -fsS http://localhost/healthcheck | grep -qx true`.
- nginx restricts `/internal/*` and `/info/*` to `127.0.0.1` ([ds-docservice.conf.m4 L63-L76][p-docsvc]).

### 1.4 Behind a TLS reverse proxy

- The internal nginx computes three values ([http-common.conf.m4 L18-L45][p-http]):
  - `$the_scheme` comes from `CloudFront-Forwarded-Proto` or `X-Forwarded-Proto`; only `http` and
    `https` are accepted, and `wss` maps to `https`;
  - `$the_host` is the first value of `X-Forwarded-Host`, falling back to `Host`;
  - `$the_prefix` comes from `X-Forwarded-Prefix`.

  It then forwards `Host`, `Upgrade`/`Connection`, `X-Forwarded-Host`, `X-Forwarded-Proto` and
  `X-Forwarded-For` to the docservice.
- The docservice builds absolute URLs from the first value of the forwarded proto (only if it
  matches `^https?$`), the first value of `X-Forwarded-Host` (else `Host`) and
  `X-Forwarded-Prefix` ([utils.js L826-L895][v-utils-baseurl], [constants.js L55][v-const-proto]).
  These base URLs are stored per session and used for the callback `url` and `changesurl`
  ([canvasservice.js L1170-L1181][v-canvas-url]).
- What the outer proxy must do:
  - preserve `Host`, or set `X-Forwarded-Host` to the public host, and send
    `X-Forwarded-Proto: https`;
  - allow WebSocket upgrades. The socket.io path is `<editor path>/../../../../doc/<key>/c`
    ([docscoapi.js L1677][s-docscoapi-path]), in practice `/9.4.0-<hash>/doc/<key>/c/...`, which
    nginx proxies with HTTP/1.1 ([ds-docservice.conf.m4 L108-L110][p-docsvc]);
  - use long timeouts (the internal nginx uses 300 s, [L86-L97][p-docsvc]);
  - not add `X-Frame-Options`, because the editor runs in an iframe of the portal (*inference*);
  - `X-Forwarded-Prefix` enables hosting under a sub-path.
- *Inference:* the forwarded headers are trusted without an allowlist
  ([http-common.conf.m4][p-http]), so do not expose the container port to untrusted clients.

### 1.5 arm64

The index contains `linux/amd64` and `linux/arm64`, both built from the same `9.4.0-129` package
**[image]**, as configured in [docker-bake.hcl L113][d-bake]. No arm64-specific caveat was found in
the ONLYOFFICE README or docs. Functional parity is **UNVERIFIED**.

### 1.6 Minimal service definition (illustrative)

```yaml
services:
  onlyoffice:
    image: onlyoffice/documentserver:9.4.0.1
    environment:
      JWT_ENABLED: "true"
      JWT_SECRET: "${ONLYOFFICE_JWT_SECRET}"   # fixed, >= 32 random chars
      PLUGINS_ENABLED: "false"                # no outbound download of marketplace plugins
      GENERATE_FONTS: "false"                 # optional: faster start without custom fonts
      # ALLOW_PRIVATE_IP_ADDRESS: "true"      # only needed for non-JWT requests, see section 5
    volumes:
      - oo-logs:/var/log/onlyoffice
      - oo-lib:/var/lib/onlyoffice
      - oo-data:/var/www/onlyoffice/Data
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost/healthcheck | grep -qx true"]
      interval: 30s
      start_period: 90s
    stop_grace_period: 60s
    expose: ["80"]      # published only through the TLS reverse proxy
```

## 2. Docs API editor configuration

### 2.1 api.js and constructor

- Load `https://<ds-public-host>/web-apps/apps/api/documents/api.js` ([doc][a-doceditor]). nginx
  serves it with `Cache-Control: no-store` ([ds-docservice.conf.m4 L9-L15][p-docsvc]). An optional
  `?shardkey=<key>` query is copied into the config ([api.js L1041-L1050][w-api-shard]).
- `new DocsAPI.DocEditor(placeholderId, config)` replaces the placeholder element with an iframe
  ([api.js L402][w-api-ctor], [L621][w-api-replace], [doc][a-doceditor]).

### 2.2 Required fields

- **Client side**, api.js calls `window.alert("One or more required parameter …")` unless
  `document.url` is set, `document.key` is a non-empty string, and `document.fileType` or
  `documentType` is set ([api.js L506-L515][w-api-check]).
- **Server side**, with JWT, `validateAuthToken` requires the following in the token
  ([DocsCoServer.js L2696-L2712][v-validate]):
  - `document.key`;
  - `document.permissions` whenever the client sent permissions;
  - `document.url`;
  - `editorConfig.callbackUrl` whenever the client sent a callback URL;
  - `editorConfig.mode` unless the client mode is `view`.

  `server.tokenRequiredParams` is `true` by default ([default.json L349][v-default-server]), so a
  missing field disconnects the editor with a JWT error ([L2877-L2884][v-validate-use]). Other
  rules:
  - the token's `document.permissions` must be **deep-equal** to the client's, otherwise the result
    is access denied ([L2724-L2733][v-filljwt]);
  - the token must not have top-level `url`, `payload` or `key` claims ([L2815-L2818][v-filljwt]).

### 2.3 `document.key`

- Allowed characters are `0-9 a-z A-Z - . _ =`, with a maximum of 128 characters. The key must be
  unique across all integrators sharing the server, and it "must be generated anew" every time the
  document is edited and saved ([doc][a-document]).
- The code uses the same character class, `DOC_ID_PATTERN = '0-9-.a-zA-Z_='`. A socket connection
  whose key does not match is dropped with "access denied" ([constants.js L38-L41][v-const-docid],
  [DocsCoServer.js L1916-L1920][v-docid-reject]). The constant `DOC_ID_MAX_LENGTH = 240` is only
  used for WOPI ([constants.js L42][v-const-docid]).
- The key lifecycle is described in [section 3](#34-when-the-document-key-must-change).

### 2.4 `document.url`

- It is the absolute URL of the file, fetched **server-side** by the Document Server
  ([doc][a-document]). The converter downloads it with 3 attempts, a 2-minute timeout and a
  100 MB limit ([converter.js L510-L552][v-conv-download],
  [default.json FileConverter.converter][v-default-conv]).
- The URL must be reachable from the container, for example `http://portal:8080/...` on the Docker
  network. With JWT, the request carries a signed header ([section 5](#5-jwt-on-requests-sent-by-the-document-server)).

### 2.5 `editorConfig.callbackUrl`

It is required when editing, and it is the absolute URL of your storage service ([doc][a-editor]).
The server resolves its host and applies the IP filter when the session starts
([DocsCoServer.js L2944-L2953][v-auth-callback]).

### 2.6 `editorConfig.user`

- Fields ([doc][a-editor]):
  - `id`: string, at most 128 characters, preferably an anonymised hash;
  - `name`: at most 128 characters;
  - `group`: comma-separated;
  - `image`;
  - `roles`: PDF forms only.
- api.js converts a numeric `id` to a string and logs a warning ([api.js L566-L570][w-api-check]).
- When the token contains `editorConfig.user`, the server takes `id` and `name` from it, and a
  signed `name` forbids renaming (`denyChangeName`) ([DocsCoServer.js L2781-L2811][v-filljwt]).
- Without an `id`, web-apps generates an anonymous `uid-<timestamp>` ([Main.js L440-L443][w-main-user]).
  `fullname` becomes `group + NBSP + name` when a group is set ([utils.js L1015-L1023][w-utils-user]).

### 2.7 Read-only opening

- There are two documented switches ([doc mode][a-editor], [doc permissions.edit][a-perms]):
  - `editorConfig.mode: "view"`;
  - `document.permissions.edit: false`, which opens a viewer that cannot be switched to editing
    even if `mode` is `edit`.
- api.js appends `&mode=view` to the editor URL when `mode == 'view'`, **or** when
  `permissions.edit === false && !permissions.review` (non-PDF) ([api.js L1229-L1232][w-api-view]).
  *Inference:* `edit:false` with `review:true` opens review mode, not a viewer.
- On the server, a client that asks for `view` cannot be escalated by the token
  (`if (null != edit.mode && 'view' !== data.mode)`, [DocsCoServer.js L2759-L2760][v-filljwt]), and
  the token's `mode` is not required in that case. **Recommendation:** sign `mode: "view"` together
  with `permissions.edit: false` and `review: false`.
- The viewer can be a live viewer or a static "common viewer", selected with `coEditing`
  ([doc][a-viewing]).

### 2.8 `editorConfig.coEditing`

- The object is `{ "mode": "fast" | "strict", "change": true|false }`, with defaults
  `mode: "fast"` and `change: true`. `fast` forces autosave ([doc][a-editor]).
- The server copies `coEditing` from the token ([DocsCoServer.js L2762-L2771][v-filljwt]).
- *Inference:* use `fast` so that plugin changes such as labels and custom XML reach the server and
  co-authors immediately.

### 2.9 `editorConfig.plugins`

- Documented keys: `autostart` (GUID list, run sequentially), `disable` (GUIDs, new in 9.4 per the
  [changelog][ds-changelog-disable]), `options` (`{ all: {...}, "<guid>": {...} }`) and
  `pluginsData` ("absolute URLs to the plugin config.json files") ([doc][a-pluginscfg]).
  **`pluginsData` is still supported in 9.4.**
- web-apps reads `data.config.plugins` on `init` ([Plugins.js L132-L135][w-plugins-load]). It passes
  `options` to `api.setPluginsOptions` and `disable` to `setPluginsDisabled` ([L139-L162][w-plugins-load]).
- **The browser fetches `pluginsData`**, not the server: `fetch(url)` runs inside the editor iframe
  (origin = the DS public origin), and `json.baseUrl = url.substring(0, url.lastIndexOf("config.json"))`
  ([Plugins.js L1063-L1100][w-plugins-fetch]). The URL must therefore end with `config.json`.
  *Inference:* when `config.json` is on another origin than the DS, that host must answer with
  `Access-Control-Allow-Origin` for the DS origin (a plain GET without credentials). The docs do not
  mention CORS.
- Server-installed plugins (any folder under `/var/www/onlyoffice/documentserver/sdkjs-plugins/`
  that contains a `config.json`) are listed by `GET /plugins.json`, cached for 5 min, and merged
  with the config plugins ([Plugins.js L165-L182][w-plugins-load],
  [server.js L373-L416, L120][v-serverjs-plugins]). This lets the plugin be same-origin with the
  editor, so no CORS is needed. Server-wide autostart is configured with
  `services.CoAuthoring.plugins.autostart` in `local.json` ([default.json L505-L508][v-default-plugins]).
- Autostart calls `asc_pluginRun(guid, 0, '')` one plugin after another; the legacy `autoStartGuid`
  key triggers a deprecation warning ([Plugins.js L859-L863, L1102-L1131][w-plugins-autostart]).
- `options` reaches the plugin as `Asc.plugin.info.options = {...options.all, ...options[guid]}`
  ([plugins.js L727-L743][s-plugins-options]). It is a clean way to pass the portal API base URL or
  a short-lived token to the plugin.
- *Inference:* `editorConfig.plugins` is not validated against the JWT, because
  `fillDataFromJwt` only reads the fields listed in 2.2 and 2.6-2.8 ([L2713-L2819][v-filljwt]).
- `customization.plugins: false` disables all plugins, including yours
  ([Plugins.js L200][w-plugins-setapi], [api.js comment L279][w-api-pluginsflag]).

### 2.10 Signing the configuration

- The payload has "the same structure as the config". Since 7.1, the parameters listed in 2.2 must
  be included ([doc][a-sigbrowser]). The `token` field sits at the top level of the config
  ([doc][a-config]). The ONLYOFFICE samples use HS256 and warn that signing must happen server-side
  ([doc][a-sig]).
- api.js copies `config.token` to `document.token` ([api.js L571][w-api-check]), and the editor sends
  it as `jwtOpen` ([docscoapi.js L1659, L1721][s-docscoapi-jwt]).
- The server verifies the token with `jwt.verify(token, key, { clockTolerance: 60 })` against the
  browser secret, and enforces `exp` if present ([DocsCoServer.js L1656-L1680][v-checkjwt],
  [default.json L501-L503][v-default-token]). There is no `algorithms` list, so *inference* from
  `jsonwebtoken` 9.0.2 ([package.json][v-pkg]): HS256, HS384 and HS512 are accepted for a secret key.
- In Docker all four secrets are equal to `JWT_SECRET` ([L390-L393][d-run-jwt]).

### 2.11 Readiness events

- `onAppReady` fires when the application is loaded; api.js then sends `init` and `openDocument`
  ([doc][a-events], [api.js L458-L468][w-api-appready]). `onDocumentReady` fires when the document
  is loaded ([doc][a-events]).
- In code, `onInfo` (`{mode: "edit"|"view"}`) is posted just before `onDocumentReady`
  ([Main.js L1562-L1565][w-main-ready], [Gateway.js L225-L227, L348-L350][w-gateway]).
  *Inference:* use `onInfo` to detect a session that the memory guard forced into view mode
  (**UNVERIFIED**).

### 2.12 Minimal example

```js
// Portal backend (Node, jsonwebtoken): build and sign; never sign in the browser.
import jwt from "jsonwebtoken";
const PLUGIN_GUID = "asc.{A1B2C3D4-0000-4000-8000-000000000001}"; // generate your own UUID
const config = {
  documentType: "word",
  document: {
    fileType: "docx",
    key: "doc123-v7",                                  // [0-9A-Za-z._=-], <= 128
    title: "Example.docx",
    url: "http://portal:8080/internal/files/123",      // fetched by the DS container
    permissions: { edit: true, review: false, comment: true, download: true, print: true,
                   modifyContentControl: true },       // must be sent unchanged to the browser
  },
  editorConfig: {
    mode: "edit",
    lang: "en",
    callbackUrl: "http://portal:8080/onlyoffice/callback?doc=123",
    user: { id: "u-42", name: "Jane Doe" },
    coEditing: { mode: "fast", change: false },
    plugins: {
      pluginsData: ["https://portal.example.org/plugins/labels/config.json"],
      autostart: [PLUGIN_GUID],
      options: { [PLUGIN_GUID]: { apiBase: "https://portal.example.org/api" } },
    },
  },
};
config.token = jwt.sign(config, process.env.ONLYOFFICE_JWT_SECRET, { algorithm: "HS256" });
```

```html
<!-- Portal page -->
<div id="editor"></div>
<script src="https://docs.example.org/web-apps/apps/api/documents/api.js"></script>
<script>
  const docEditor = new DocsAPI.DocEditor("editor", Object.assign({}, CONFIG_FROM_BACKEND, {
    events: {
      onAppReady: () => {},
      onDocumentReady: () => {},
      onInfo: (e) => console.log("mode", e.data.mode),
      onError: (e) => console.error(e.data.errorCode, e.data.errorDescription),
    },
  }));
</script>
```

## 3. Callback handler

### 3.1 Statuses

| status | Meaning (doc) | Code name |
|---|---|---|
| 1 | Document is being edited. Sent on every connect or disconnect, and again after a reconnect within about 100 s. | `Editing` |
| 2 | Ready for saving, about 10 s after the last editor leaves (`savetimeoutdelay` 5000 ms plus conversion) | `MustSave` |
| 3 | Saving error | `Corrupted` |
| 4 | Closed with no changes | `Closed` |
| 6 | Edited, current state saved (force-save) | `MustSaveForce` |
| 7 | Error during force-save | `CorruptedForce` |

Sources: [callback doc][a-callback], [saving doc][a-saving], enum at
[DocsCoServer.js L241-L250][v-status] (`0 NotFound` and `5 MailMerge` also exist),
[default.json L336][v-default-server].

### 3.2 Body fields

- Documented fields: `key` (required), `status` (required), `url` (statuses 2, 3, 6 and 7),
  `changesurl`, `history`, `filetype`, `users`, `actions[] {type, userid}`, `forcesavetype`,
  `userdata` and `formsdataurl` ([doc][a-callback]).
- The object the code serialises also has `lastsave`, `notmodified`, `mailMerge`, `encrypted` and
  `token` ([commondefines.js L832-L872][v-defs-sfc]).
- `actions[].type` is `0` = disconnected, `1` = connected, `2` = force-save button
  ([L1175-L1179][v-defs-enums]).
- `forcesavetype` is `0` = command service, `1` = Save button (requires `customization.forcesave`),
  `2` = auto-assembly timer, `3` = form submit ([doc][a-callback]). The code value `4` (internal) is
  never sent to the callback ([commondefines.js L1190-L1196][v-defs-enums],
  [canvasservice.js L1205-L1207][v-canvas-reply]).

### 3.3 Expected response and failure handling

- Answer `{"error":0}`, otherwise the editor shows an error ([doc][a-callback]).
- In code, success means an HTTP **200** response whose JSON body has `error == 0`. `postRequestPromise`
  treats any status other than 200 or 204 as an error, and a 204 has no body, so the result is not
  "success" ([utils.js L435-L520][v-utils-post], [canvasservice.js L1226-L1231, L1284-L1303][v-canvas-reply]).
- Status 1: a failure publishes an editor warning, "Error on save server subscription!"
  ([DocsCoServer.js L1481-L1487][v-reply1]).
- Status 2: HTTP 429, 5xx or network errors are retried up to 3 times with backoff
  ([default.json L536][v-default-backoff], [canvasservice.js L1263-L1275][v-canvas-reply]). A
  non-zero reply, or retries that run out, stores the file as a **forgotten file** in
  `/var/lib/onlyoffice/...` (retrieve it with `getForgotten`)
  ([canvasservice.js L1302-L1330][v-canvas-forgotten]).
- The `url` is a signed `/cache/files/...` URL of type Temporary. It **expires after 900 s** and is
  built on the session's **browser-facing** base URL ([canvasservice.js L1180][v-canvas-url],
  [storage-base.js L161-L200][v-storage], [default.json L109][v-default-urlexp]).
  - A backend on the private network may need to replace scheme and host with the internal DS
    address while keeping path and query. The nginx `secure_link_md5` covers
    `$secure_link_expires$uri$secure_link_secret`, so the host is not signed
    ([ds-docservice.conf.m4 L45-L59][p-docsvc]).
  - The alternative `storage.externalHost` in `local.json` overrides the base of *all* signed URLs,
    including those the browser uses ([utils.js L1305-L1309][v-utils-exthost], [doc][a-servercfg]).
    It is not exposed as an environment variable.

### 3.4 When the document key must change

- Once a status-2 request has been answered with `{"error":0}`, the key "can no longer be used to
  open the document for editing"; it only opens the cached copy for viewing. Generate a new key for
  the next editing session ([doc][a-coedit]).
- After a force-save (status 6) the key **must not change** while the session is running, and new
  users join with the same key ([doc][a-coedit]).
- If the file changes outside the editor, the key must change too ("Every time the document is
  edited and saved, the key must be generated anew", [doc][a-document]).
- *Inference:* in CE 9.4, a container restart forgets every session, so a key that was mid-session
  starts a fresh session from `document.url` (see 1.1).

### 3.5 Handler skeleton

```js
app.post("/onlyoffice/callback", express.json({ limit: "5mb" }), (req, res) => {
  let data;
  try {
    const bearer = (req.get("Authorization") || "").replace(/^Bearer /, "");
    const decoded = jwt.verify(req.body?.token || bearer, process.env.ONLYOFFICE_JWT_SECRET,
                               { algorithms: ["HS256"], clockTolerance: 60 });
    data = decoded.payload ?? decoded;   // header token wraps fields in {payload}; body token is flat
  } catch {
    return res.status(401).json({ error: 1 });   // not 2xx: DS treats it as a failure
  }
  if (data.status === 2 || data.status === 6) {
    // download data.url within 15 min (rewrite host if needed), store it;
    // on status 2 rotate document.key for the next session
  }
  res.status(200).json({ error: 0 });
});
```

## 4. Command service (force save)

- **Endpoint:** `POST https://<ds>/command`. Before 8.2 the path was
  `/coauthoring/CommandService.ashx`, which is still routed in 9.4 ([doc][a-cmd],
  [server.js L234-L236][v-serverjs-routes]). The optional `?shardkey=<key>` query is recommended
  for load balancing ([doc][a-cmd]).
- **Request:** `{"c":"forcesave","key":"<key>","userdata":"<optional>"}` ([doc][a-forcesave]).
  With JWT, send `{"token": <jwt>}`, where the payload holds these fields; this is the recommended
  form ([doc][a-cmd], [doc][a-tokenbody]). Alternatively send
  `Authorization: Bearer <jwt({payload:{...}})>`, which the docs "do not recommend"
  ([doc][a-tokenheader]).
- **What the code does:** it checks the body `token` first and the header otherwise, with the inbox
  secret. Decoded claims are merged whether flat, under `.payload` or under `.query`. With
  `tokenRequiredParams` on, the unsigned body fields are discarded ([DocsCoServer.js L1697-L1742][v-reqparams]).
- **Response:** `{"error":0,"key":"..."}` ([doc][a-forcesave]).

  | Code | Meaning (doc, [command service][a-cmd]) |
  |---|---|
  | 0 | No error |
  | 1 | Missing key, or no document with that key |
  | 2 | Callback URL not correct |
  | 3 | Internal server error |
  | 4 | No changes were applied to the document before the forcesave command |
  | 5 | Command not correct |
  | 6 | Invalid token |

  **CONTRADICTION/omission:** the code also returns **7 = token expired**
  ([commondefines.js L1180-L1189][v-defs-enums], [DocsCoServer.js L4538-L4553][v-validateinput]).
- In `forcesave`, `4` (`NotModified`) is returned when the server has no change newer than the last
  save for a known key, `1` for an unknown key, and `3` for other failures
  ([DocsCoServer.js L4670-L4686][v-cmd-forcesave], `startForceSave` at [L1069][v-startforcesave]).
  A success is followed, asynchronously, by a status-6 callback with `forcesavetype: 0`
  ([doc][a-saving]).

```js
const body = { c: "forcesave", key: "doc123-v7", userdata: "manual" };
const r = await fetch("http://onlyoffice/command", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: jwt.sign(body, process.env.ONLYOFFICE_JWT_SECRET, { algorithm: "HS256" }) }),
});
const { error } = await r.json();   // 0 ok, 1 unknown key, 4 nothing new to save, 6 bad token, 7 expired
```

## 5. JWT on requests sent by the Document Server

`JWT_ENABLED=true` turns on `token.enable.request.outbox` ([L386-L388][d-run-jwt]). The outbox
algorithm is HS256, tokens expire after 5 minutes, and the header prefix is `Bearer `
([default.json L489-L496][v-default-token]).

- **Download of `document.url`:** the request carries `<JWT_HEADER>: Bearer <jwt>` with the payload
  `{"payload":{"url":"<document.url>"}}` ([converter.js L510-L531][v-conv-download],
  [utils.js L1135-L1149][v-utils-filljwt]). Two conditions apply:
  - the open must have been authorised by a verified browser token (`withAuthorization`,
    [DocsCoServer.js L2918-L2923][v-auth-withauth]);
  - the URL must not match `token.outbox.urlExclusionRegex`
    ([utils.js L1191-L1203][v-utils-canoutbox]).

  The docs describe the same behaviour ([doc: File download][a-tokenheader]).
- **Callback POST:** when outbox is enabled, the DS always sends **both** of these
  ([DocsCoServer.js L796-L829][v-sendserverreq]):
  - the header `<JWT_HEADER>: Bearer jwt({"payload": <body>})`;
  - a body field `token` = `jwt(<body fields>)`.

  The plain fields stay in the body, and `JWT_IN_BODY` is ignored.
  **CONTRADICTION:** the [token-in-body doc][a-tokenbody] shows callback bodies that contain only
  `{"token": …}` and gates the behaviour behind `outbox.inBody`.
  If the header token reaches 7168 characters, `changesurl` and `history` are removed from the plain
  body and from the header token, but the body `token` still contains them
  ([canvasservice.js L1033-L1042][v-canvas-fixlen]). Always trust the decoded token.
- **`JWT_ENABLED=false`:** no header and no body token.
- **Private addresses:** `addExternalRequestOptions` makes a direct request, with **no**
  request-filtering agent, when the URL is "in the JWT token" and
  `externalRequest.directIfIn.jwtToken` is `true` (the default). Otherwise
  `externalRequest.action.blockPrivateIP=true` applies the agent configured by
  `ALLOW_PRIVATE_IP_ADDRESS` and `ALLOW_META_IP_ADDRESS` ([utils.js L268-L330][v-utils-direct],
  [default.json L303-L318][v-default-extreq], [doc][a-servercfg-rfa]).
  - `document.url` downloads pass `isInJwtToken = withAuthorization`
    ([converter.js L1205-L1226][v-conv-task]).
  - Callbacks pass `isInJwtToken = token.enable.request.inbox` ([DocsCoServer.js L815-L826][v-sendserverreq]).
  - *Inference:* with JWT on, a private-network `document.url` or `callbackUrl` works without
    `ALLOW_PRIVATE_IP_ADDRESS`. Without JWT it is required. **UNVERIFIED** live.
  - The docs only warn that "A token does not bypass network restrictions … the document server must
    still be able to reach it" ([doc][a-coedit]).
  - The DS also resolves the host and applies the allow-all `ipfilter`
    ([utils.js L1035-L1049][v-utils-hostfilter]).

## 6. Plugin `config.json` schema (9.x)

Top-level and variation fields, merged from the docs ([configuration][a-p-config],
[types][a-p-types]), the sdkjs parsers ([`CPlugin.deserialize`][s-apicommon-cplugin],
[`CPluginVariation.deserialize`][s-apicommon-variation]) and web-apps `parsePlugins`
([Plugins.js L886-L1047][w-plugins-parse]).

| Field | Notes |
|---|---|
| `name`, `nameLocale` | Display name, with translations keyed by 2-letter language code |
| `guid` | **Must** be `asc.{UUID}` ([doc][a-p-config], [doc: errors][a-p-errors]) |
| `version`, `minVersion` | `minVersion` hides the plugin when the editor is older ([Plugins.js checkPluginVersion][w-plugins-parse]) |
| `baseUrl` | `""` means the plugin lives in the DS `sdkjs-plugins` folder. For `pluginsData` plugins, web-apps **overwrites** it with the URL minus `config.json` ([Plugins.js L1073][w-plugins-fetch]). |
| `group {name, rank}`, `help`, `offered`, `onlyofficeScheme` | UI, marketplace and branding metadata ([doc][a-p-config]) |
| `tab {id, text, separator}` | Read by web-apps (*code only*, [Plugins.js L996][w-plugins-parse]) |
| `isConnector`, `loader`, `isUICustomizer` | Internal and advanced (*code*) |
| `variations[]` | One or more sub-plugins; web-apps uses `variations[0]` by default |
| `variations[].url` | Entry HTML, relative to `baseUrl` |
| `variations[].description`, `descriptionLocale` | Marketplace text |
| `variations[].icons` (string pattern or array), `icons2` (deprecated) | Icons ([doc][a-p-config]) |
| `variations[].EditorsSupport` | `word`, `cell`, `slide`, `pdf` (code default `["word","cell","slide"]`). A plugin is neither visible nor runnable in an editor that is not listed ([Plugins.js L925][w-plugins-visible], [plugins.js L504-L531][s-plugins-editorsupport]). |
| `variations[].isViewer`, `isDisplayedInViewer` | In view mode a variation is visible only if `isViewer && isDisplayedInViewer !== false` ([Plugins.js L925][w-plugins-visible]) |
| `variations[].type` | `system`, `background`, `window`, `panel`, `panelRight`, and doc `unvisible`. **CONTRADICTION:** the code parser accepts `"invisible"`; any unknown string, including `"unvisible"`, falls back to `background` ([apiCommon.js L7278-L7312][s-apicommon-type], [doc][a-p-types]). |
| `isSystem`, `isVisual`, `isInsideMode`, `isModal`, `menu`, `screens` | Deprecated. Used only when `type` is absent: `isSystem` gives `system`, `isVisual` gives `panel` or `window` depending on `isInsideMode`, anything else gives the invisible type ([apiCommon.js L7450-L7498][s-apicommon-variation]). |
| `isCustomWindow`, `isCanDocked`, `size [w,h]` | Window plugins; `isCanDocked` lets the user dock or undock |
| `initDataType`, `initData` | `none`, `text`, `html`, `ole`, `desktop`, `desktop-external`, `sign` ([doc][a-p-config]) |
| `initOnSelectionChanged` | Re-runs `init` on each selection change ([doc][a-p-config]) |
| `isUpdateOleOnResize` | OLE only |
| `buttons[] {text, primary, isViewer, textLocale}` | Window and panel buttons. `[]` means none. The code default is Ok/Cancel ([apiCommon.js L7339][s-apicommon-variation]). |
| `events[]` | Marked "deprecated since 8.2, use `attachEditorEvent`" ([doc][a-p-config]), **but still functional and needed** (see [7.6](#76-events)) |
| `store`, `crypto*` | Marketplace and encryption plugins only |

Minimal right-panel plugin for the text editor, subscribing to the requested events:

```json
{
  "name": "Document labels",
  "guid": "asc.{A1B2C3D4-0000-4000-8000-000000000001}",
  "version": "0.1.0",
  "minVersion": "9.0.0",
  "variations": [
    {
      "description": "Document labelling panel",
      "url": "index.html",
      "icons": ["resources/light/icon.png", "resources/light/icon@2x.png"],
      "type": "panelRight",
      "EditorsSupport": ["word"],
      "isViewer": true,
      "isDisplayedInViewer": true,
      "initDataType": "none",
      "initData": "",
      "buttons": [],
      "events": [
        "onDocumentContentReady",
        "onChangeContentControl",
        "onFocusContentControl",
        "onBlurContentControl",
        "onContextMenuShow",
        "onContextMenuClick",
        "onToolbarMenuClick"
      ]
    }
  ]
}
```

`onBlurContentControl` exists ([doc][a-p-blur], emitted at [word/api.js L11699-L11707][s-wordapi-ccevents]).
Replace the GUID with your own UUID.

```html
<!-- index.html, next to config.json (plugins.js loads "./config.json" relative to this page) -->
<!DOCTYPE html>
<html><head><meta charset="UTF-8">
  <script src="vendor/onlyoffice/plugins.js"></script>     <!-- pinned 9.4 copy, see section 11 -->
  <script src="vendor/onlyoffice/plugins-ui.js"></script>
  <link rel="stylesheet" href="vendor/onlyoffice/plugins.css">
  <script src="code.js"></script>
</head><body><div id="app"></div></body></html>
```

```js
// code.js
(function () {
  const plugin = window.Asc.plugin;

  plugin.init = function () {
    const info = plugin.info; // editorType, userId, userName, isViewMode, lang, documentId, options, jwt...
    refreshControls();
    plugin.executeMethod("AddToolbarMenuItem", [{
      guid: plugin.guid,
      tabs: [{ id: "labels_tab", text: "Labels", items: [
        { id: "labels_apply", type: "button", text: "Apply label", hint: "Apply label",
          lockInViewMode: true, items: [] } ] }],
    }]);
  };

  // Editor events: delivered because they are listed in config.json "events".
  plugin.attachEvent("onDocumentContentReady", () => refreshControls());
  plugin.attachEvent("onFocusContentControl", (cc) => { /* cc.Tag, cc.Id, cc.InternalId, cc.Lock ... */ });
  plugin.attachEvent("onBlurContentControl", (cc) => {});
  plugin.attachEvent("onChangeContentControl", (cc) => {});
  plugin.attachEvent("onContextMenuShow", (options) => {
    // options.type: "None" | "Target" | "Selection" | "Image" | "Shape" | "OleObject"
    // MUST always answer, otherwise the editor waits for this plugin before showing the menu.
    plugin.executeMethod("AddContextMenuItem", [{
      guid: plugin.guid,
      items: [{ id: "labels_ctx_apply", text: "Apply label…", data: "ctx" }],
    }]);
  });

  // Click events: dispatched by plugins.js' built-in event_onContextMenuClick/event_onToolbarMenuClick.
  plugin.attachContextMenuClickEvent("labels_ctx_apply", (data) => { /* data === "ctx" */ });
  plugin.attachToolbarMenuClickEvent("labels_apply", () => {});

  // Panel close ("X") arrives as button(-1); defining button() makes you responsible for closing.
  plugin.button = function (id) { if (id === -1) plugin.executeCommand("close", ""); };

  function refreshControls() {
    plugin.executeMethod("GetAllContentControls", [], (controls) => {
      // [{Tag, Id, Lock, InternalId, Alias, Appearance, Color?, Border?, Shd?}]
    });
  }
})();
```

## 7. Plugin runtime API

### 7.1 Loading handshake

- The plugin page loads `plugins.js`. On `window.onload` it XHRs **`./config.json` relative to the
  page**, merges it into `Asc.plugin` (which is how `Asc.plugin.guid` gets set) and posts
  `{type:"initialize", guid}` to the parent **[image]** (`sdkjs-plugins/v1/plugins.js`), same code as
  [onlyoffice.github.io@ebcb847][g-plugins].
- The editor answers `plugin_init`, whose payload is the **full plugin API code compiled into the
  editor build** ([plugins.js L1784-L1793][s-plugins-handshake]). The plugin `eval`s it, then posts
  `initialize_internal`, and the editor sends `init` with the start data
  ([L1748-L1782][s-plugins-handshake]).
- `v1/plugins.js` itself is only a loader plus the menu and button helpers, so the API always matches
  the editor version.
- The editor accepts plugin messages only from its own origin, from `chrome-extension://`, or from
  an origin that prefixes the plugin `baseUrl` ([plugins.js L1457-L1476][s-plugins-origin]).

### 7.2 `Asc.plugin.info` fields

`Asc.plugin.info` is the whole `init` message ([plugin_base.js L641][s-pbase-onmsg]). Its fields are
built by `correctData` ([plugins.js L1359-L1388][s-plugins-correctdata]) and at run time
([L1071-L1076][s-plugins-run]):

| Field | Value (code) |
|---|---|
| `guid`, `type: "init"`, `data` | Plugin GUID and init data (`init(data)` receives `info.data`) |
| `editorType` | `word`, `cell`, `slide` or `visio` ([apiBase.js L474-L492][s-apibase-editorname]); `editorSubType: "pdf"` in the PDF editor |
| `isViewMode` | `api.isViewMode \|\| isPdfEditor()` |
| `isMobileMode`, `isEmbedMode` | Booleans |
| `lang` | Plugin manager language |
| `documentId` | `api.documentId`, which is `document.key` |
| `documentTitle`, `documentCallbackUrl` | Title, and the `callbackUrl` in clear text |
| `userId` | `api.User.id` = `editorConfig.user.id`, or `uid-…` for anonymous users ([apiBase.js L633-L635][s-apibase-user], [Main.js L551-L564][w-main-docinfo]) |
| `userName` | Full name, prefixed by `group` and a NBSP when a group is set ([utils.js L1015-L1023][w-utils-user]) |
| `jwt` | `CoAuthoringApi.get_jwt()` = `jwtSession \|\| jwtOpen` ([docscoapi.js L695-L697][s-docscoapi-getjwt]). The session token is signed with the **session** secret (`JWT_SECRET` in Docker), expires after 30 days, and its payload is `{document:{key, permissions}, editorConfig:{user:{id, name, index}, coEditing, …}}` ([DocsCoServer.js L535-L567][v-filljwtconn], [default.json L497-L500][v-default-token]). *Inference:* the portal can verify it to authenticate plugin calls. Any plugin running in the editor can read it. |
| `options` | `{...editorConfig.plugins.options.all, ...options[guid]}` ([plugins.js L727-L743][s-plugins-options]), updated on `updateOptions` |
| `theme` | Theme object, sent only at start |
| `mmToPx`, `restrictions`, `externalData`, `aiPluginSettings` | Misc |
| `recalculate`, `resize`, `methodName` | Set by the SDK when calling `callCommand` or `executeMethod` |

The docs only list the OLE-related fields plus `editorType`, `guid`, `mmToPx`, `recalculate` and
`resize` ([doc][a-p-asc]). `userId`, `userName`, `isViewMode`, `lang`, `documentId`, `jwt` and
`options` are present in code but undocumented.

### 7.3 `callCommand(func, isClose, isCalc, callback)`

- The SDK builds the string
  `"var Asc = {}; Asc.scope = " + JSON.stringify(window.Asc.scope) + "; var scope = Asc.scope; (" + func.toString() + ")();"`
  and sends it with type `close` (when `isClose === true`) or `command`, with
  `info.recalculate = (isCalc !== false)` ([plugin_base_api.js L529-L541][s-pbaseapi-callcommand]).
  **It returns nothing.** The value returned by `func` goes to `callback`, or to
  `Asc.plugin.onCommandCallback` when no callback is given ([doc][a-p-cmd]).
- `callCommandAsync(func)` and `callMethodAsync(name, args)` Promise helpers exist in 9.4.
  `callCommandAsync` uses `isCalc = true` ([L610-L620][s-pbaseapi-callcommand]).
- In the editor ([plugins.js L1551-L1648][s-plugins-callcommand]):
  - commands are queued one at a time;
  - the code must pass `isValidJs`;
  - it runs only if the editor is not in a long action and `canRunBuilderScript()` succeeds.
- For the text editor, a code comment in `canRunBuilderScript` (written in Russian, translated here)
  says the builder script is always allowed to run, "even if it is a viewer and the script changes
  the content", and that the changes are checked at the end of the action. It opens **one history
  action** (`historydescription_BuilderScript`) with
  `CheckActionLock()`. `_onEndBuilderScript` then runs `Recalculate()` and `FinalizeAction()`, and a
  `false` result from the latter makes the callback receive `undefined`
  ([word/api.js L10265-L10292][s-wordapi-builder]).
- `FinalizeAction` → `private_CheckActionLock` cancels (undoes) the whole action in two cases
  ([Document.js L2214-L2330, L2471-L2490][s-doc-finalize], [L13905-L13915][s-doc-lockcheck]):
  - `!CanEdit()`, that is **view mode**, except in form filling;
  - co-editing locks.

  *Inference:* reads work in view mode, and writes are rolled back.
- **`isCalc`:** documented as "recalculate or not, default `true`" ([doc][a-p-cmd]). In 9.4 code,
  `false` only skips `_afterEvalCommand`, the step that pre-loads fonts and images and unlocks the
  style panel. The text editor still calls `Recalculate()` in `_onEndBuilderScript`
  ([plugins.js L1621-L1645][s-plugins-callcommand], [apiBase.js L4590-L4650][s-apibase-eval]).
  Use `false` only for edits that add no fonts or images (tags, custom XML).
- **Sandbox** (`_safePluginEval`, [macros.js L443-L575][s-macros-safeeval]). 9.4.0 fixed "a
  vulnerability that allowed bypassing macro sandbox restrictions … via sloppy-mode `this` and
  `eval`" ([changelog][ds-changelog-sec]).
  - the code runs in strict mode;
  - `window`, `document`, `self`, `globalThis`, `Function` and `AscDesktopEditor` are shadowed by
    `{}`, and `alert` is a no-op;
  - `import` is rejected;
  - `eval` works once;
  - `setTimeout` and `setInterval` are wrapped;
  - `XMLHttpRequest` is replaced by a wrapper that **asks the user for permission** before each
    request (`asc_getUserPermissionToMakeRequestFromMacros`, a modal "A macro makes a request to
    URL…" dialog, [macros.js L310-L440][s-macros-xhr], [apiBase.js L4743-L4752][s-apibase-perm],
    [Main.js L3279-L3319][w-main-macroperm]);
  - available globals are `Api`, `App`, `ThisApplication` and `ThisDocument`. Other globals such as
    `DOMParser` stay reachable, and the ONLYOFFICE custom-xml example uses `DOMParser` inside
    `callCommand` ([example L151][sp-cx]).
- **Return values:** they must pass `Asc.checkReturnCommand` (primitives, `null`, arrays, plain
  objects up to depth 10, typed arrays). A function anywhere makes the whole result `undefined`
  ([apiCommon.js L9571-L9630][s-apicommon-checkret], [doc][a-p-cmd]: "any objects will be replaced
  with undefined"). Return plain data, never `Api*` objects.

### 7.4 `Asc.scope`

- `callCommand` "is executed in its own context isolated from other JavaScript data. … use
  Asc.scope", and "functions cannot be passed … using the Asc.scope object" ([doc][a-p-cmd],
  [doc: errors][a-p-errors]).
- In code it is serialised with `JSON.stringify` and embedded in the code string
  ([plugin_base_api.js L531][s-pbaseapi-callcommand]). Consequences:
  - it carries JSON data only;
  - `Date` values become strings;
  - `undefined` and functions are dropped;
  - circular references throw in the plugin.
- Inside the command, `Asc` is a local `{scope}`, so no other `Asc.*` exists there.

### 7.5 `executeMethod(name, params, callback)`

- The result goes to `callback`, or to `Asc.plugin.onMethodReturn` ([doc][a-p-methods]).
- Calls are **serialised**: while one call is pending, later calls are queued and return `false`,
  and a sent call returns `true` ([plugin_base_api.js L424-L452][s-pbaseapi-execmethod]).
- Do not use the return value for results.

### 7.6 Events

There are three mechanisms ([doc][a-p-events], [plugin_base.js L844-L852][s-pbase-onmsg],
[image v1/plugins.js][g-plugins]).

1. **`events` in `config.json` plus a handler.** The editor delivers the event to the plugin. The
   handler is either `Asc.plugin.event_<name> = fn` or `Asc.plugin.attachEvent(name, fn)`. A defined
   `event_<name>` wins over `attachEvent`.
2. **`Asc.plugin.attachEditorEvent(name, fn)`** (8.2+). It sets `Asc.plugin["event_"+name]` and
   posts `{type:"attachEvent"}`, which adds the event to the plugin's `eventsMap` at run time
   ([plugins.js L1893-L1903][s-plugins-attach]).
3. `detachEditorEvent` / `detachEvent`.

Pitfalls, all from source:

- `onDocumentContentReady` is the only "main event" stored and **replayed to a plugin started after
  the document loaded**, and only if the event is in `config.json` `events` at start time
  ([plugins.js L165-L168, L655-L661, L1111-L1122][s-plugins-mainevents]). `attachEditorEvent` is
  called in `init`, after the replay point, so it never gets the replay. The docs call `events`
  deprecated ([doc][a-p-config]); **keep it**.
- The v1 `plugins.js` **predefines** `event_onContextMenuClick` and `event_onToolbarMenuClick`. They
  split `id_oo_sep_data` and dispatch to `attachContextMenuClickEvent` and
  `attachToolbarMenuClickEvent` handlers. Calling `attachEditorEvent("onContextMenuClick", fn)`
  **replaces** that dispatcher, so per-id handlers stop firing **[image]**. The docs show both
  styles side by side ([doc][a-p-asc], [doc][a-p-ctx]). ONLYOFFICE's own example puts both events in
  `config.json` and uses `attachEvent` plus `attachContextMenuClickEvent`
  ([config.json L63][sp-ctx-cfg], [context_menu.js L16, L119][sp-ctx]).
- The editor only delivers `onContextMenuClick` and `onToolbarMenuClick` to plugins subscribed to
  them ([apiBase.js L5362-L5371][s-apibase-ctx], [plugins.js L663-L700][s-plugins-event2]).
- The docs example uses `Asc.plugin.onDestroy` ([doc][a-p-events]); that name does not appear in the
  9.4 plugin SDK source (grep of `plugin_base*.js`, `common/plugins.js` and v1 `plugins.js`).
  **UNVERIFIED** as a hook.

### 7.7 Context menu

- **`onContextMenuShow` payload** (code, [editorscommon.js L15118-L15145][s-edcommon-ctxinfo],
  [word/api.js L14313-L14342][s-wordapi-ctxinfo]):
  `{ "type": "None"|"Target"|"Selection"|"Image"|"Shape"|"OleObject", "guid"?: <OLE plugin guid>, "header"?|"footer"?: true, "headerArea"?|"footerArea"?: true }`
  ([commonDefines.js L3861-L3868][s-commondef-ctx]).
  - **CONTRADICTION:** the docs name the key `Type` ([doc][a-p-asc]); ONLYOFFICE's example reads
    `options.type` ([context_menu.js L26, L51][sp-ctx]).
  - There is no content-control type. Call `GetCurrentContentControl` to know whether the cursor is
    inside one.
- **Rule:** a plugin that listens must answer `AddContextMenuItem`, synchronously or not, because
  the editor waits for every listening plugin ([doc][a-p-ctx],
  [plugin_base_api.js L259-L273][s-pbaseapi-ctxdoc], [apiBase.js L5329-L5360, L5395-L5436][s-apibase-ctx]).
- **`AddContextMenuItem` payload** (code, [apiBase_plugins.js L2052-L2092][s-apibaseplug-ctx]): a
  single object in a one-element array.

  ```js
  executeMethod("AddContextMenuItem", [{
    guid: Asc.plugin.guid,
    items: [{ id, text, data?, disabled?, icons?, separator?, items?: [...] }],
  }])
  ```

  - When `data` is set, the id sent back becomes `id + "_oo_sep_" + data`, and the v1 dispatcher
    passes `data` to the handler.
  - Relative `icons` are resolved against `baseUrl`.
  - **CONTRADICTION:** the docs table types the parameter as `ContextMenuItem[]`, while the examples
    pass `{guid, items}` ([doc][a-p-asc]). `UpdateContextMenuItem` has the same shape.
- **Click:** the `onContextMenuClick` event receives the item id (with the `_oo_sep_` suffix). Use
  `Asc.plugin.attachContextMenuClickEvent(id, fn(data))` ([doc][a-p-ctx]).

### 7.8 Toolbar

- **`AddToolbarMenuItem` payload** ([doc][a-p-toolbar],
  [apiBase_plugins.js L2133-L2199][s-apibaseplug-toolbar]):

  ```js
  executeMethod("AddToolbarMenuItem", [{
    guid,
    tabs: [{ id, text, items: [{
      id, type: "button"|"big-button", text, hint, icons?, data?, disabled?, enableToggle?,
      lockInViewMode?, separator?, split?, items?: [...]
    }] }],
  }])
  ```

- A tab id equal to a standard tab (`home`, `ins`, `draw`, `layout`, `links`, `forms`, `review`,
  `protect`, `view`, `plugins`) adds buttons to that tab ([doc][a-p-toolbar]).
- **Click:** the `onToolbarMenuClick(id)` event (8.1+) is handled with
  `attachToolbarMenuClickEvent(id, fn)` ([doc][a-p-toolbar],
  [plugin_base_api.js L286-L294][s-pbaseapi-ctxdoc]).

### 7.9 Content-control methods and event payloads

- `GetAllContentControls()` returns `ContentControl[]` ([api_plugins.js L217-L228][s-wordplug-getall],
  [doc][a-p-getall]).
- `GetCurrentContentControl()` returns the InternalId string ([L260-L263][s-wordplug-getall]).
- `SelectContentControl(internalId)` ([L321-L329][s-wordplug-getall], [doc][a-p-select]).
- `MoveCursorToContentControl(internalId, isBegin)`:
  - **CONTRADICTION:** the docs give a default of `false` and say it means "begin"
    ([doc][a-p-move]);
  - the code treats anything but `false` as `true`, so the default is the **start**, and `false`
    moves to the end ([Document.js L23290-L23315][s-doc-movecursor]).
- `AddContentControl(type, commonPr)`, where `type` is `1` block, `2` inline, `3` row or `4` cell.
  It returns `{Tag, Id, Lock, InternalId}` ([api_plugins.js L634-L643][s-wordplug-addcc],
  [doc][a-p-addcc]).
- **`ContentControl` object:**
  `{ Tag, Id, Lock, InternalId, Alias, Appearance (1 frame | 2 hidden), [FormKey, RadioGroup, FormValue], [Color{R,G,B}], [Border{Color{R,G,B,A}}], [Shd{Color{R,G,B,A}}] }`
  ([SdtPr.js L493-L545][s-sdtpr-event], [doc][a-p-cc]). The `Lock` values are:

  | Value | Meaning | Documented as |
  |---|---|---|
  | 0 | `ContentLocked` | "only deleting" |
  | 1 | `SdtContentLocked` | "disable deleting or editing" |
  | 2 | `SdtLocked` | "only editing" |
  | 3 | `Unlocked` | "full access" |

  Sources: [commonDefines.js L3176-L3181][s-commondef-lock], [doc][a-p-cclock].
- `InternalId` (for example `"1_713"`) is the session-scoped object id. Persist `Tag` and `Id`
  instead; `Id` is serialised as `w:id` ([Serialize2.js L6771][s-ser2-sdtid]).
- **`onFocusContentControl`, `onBlurContentControl` and `onChangeContentControl`** all receive that
  `ContentControl` object ([word/api.js L11679-L11707][s-wordapi-ccevents], [doc][a-p-focus],
  [doc][a-p-change]).
- `onChangeContentControl` fires once per changed control at the end of the action or undo/redo
  that changed it (`private_FinalizeContentControlChange`), and bubbles up to parent controls
  ([Document.js L2691-L2697][s-doc-ccfinalize], [L26676-L26689][s-doc-ccchange]). Whether it fires for co-authors'
  remote changes is **UNVERIFIED**.
- `onShowContentControlTrack` and `onHideContentControlTrack` give id arrays
  ([plugin-events.js][s-plugevents]).

## 8. Office JavaScript API (text document) inside `callCommand`

| Member | Behaviour in 9.4 (code) |
|---|---|
| `Api.CreateBlockLvlSdt()` | No arguments. Returns a new `ApiBlockLvlSdt` containing one empty paragraph ([apiBuilder.js L5580-L5583][s-builder-create], [doc example][a-o-setborder]). |
| `SetTag(tag)` / `GetTag()` | Plain setter and getter ([L24850-L24866][s-builder-sdt]) |
| `SetAlias(alias)` / `GetAlias()` | [L25043-L25071][s-builder-sdt] |
| `SetLock(lock)` / `GetLock()` | Lock is `"unlocked"`, `"contentLocked"` (content cannot be edited), `"sdtContentLocked"` (cannot edit or delete) or `"sdtLocked"` (cannot delete). Any other string returns `false`. There is **no lock check on `SetLock` itself** ([L23146-L23163][s-builder-setlock], [L24826-L24838][s-builder-sdt], [doc][a-o-setlock]). |
| `SetBorderColor(color)` | Since 9.1 takes an `ApiColor` (`Api.RGB(r,g,b)`, `Api.RGBA(...)`, `Api.HexColor('#0000FF')`). The legacy positional `SetBorderColor(r, g, b, a=255)` is still accepted ([L23783-L23806][s-builder-border], [doc][a-o-setborder], [Api.RGB/HexColor L5031-L5072][s-builder-color]). `SetBackgroundColor` is the same; `SetColor` (9.4) sets the tag colour. |
| `SetPlaceholderText(text)` | Returns `false` for an empty or non-string value, and shows the placeholder if the control is empty ([L25484-L25490][s-builder-sdt]) |
| `GetContent()` | Returns an `ApiDocumentContent` **with no lock check** ([L25068-L25071][s-builder-sdt]) |
| `Push(el)` / `AddElement(el, pos)` / `AddText(str)` | Return `false` when the control is `contentLocked` or `sdtContentLocked` (`_canBeEdited`), or when the element is already in the document ([L25290-L25370][s-builder-sdt], [L33168-L33177][s-builder-canbe]) |
| `Delete(keepContent)` | Returns `false` when the control is `sdtLocked` or `sdtContentLocked` (`_canBeDeleted`) ([L25167-L25188][s-builder-sdt]) |
| `RemoveAllElements()` | Replaces the content with the placeholder, **no lock check** ([L25153-L25157][s-builder-sdt]) |
| `GetInternalId()` / `GetId()` / `SetId(n)` | Session object id / `w:id` / set a numeric `w:id` ([L24776-L24803][s-builder-sdt], [L23111-L23120][s-builder-setlock]) |
| `Select()`, `MoveCursorOutside()`, `GetDataBinding()`, `SetDataBinding({prefixMapping, storeItemID, xpath})`, `UpdateFromXmlMapping()` | See [9.5](#95-data-binding-to-content-controls-is-disabled-in-ce) for data binding |

- **Insert at the cursor:** `Api.GetDocument().InsertContent([sdt], isInline?, {KeepTextOnly}?)`
  inserts at the current position ([doc][a-o-insert]). In code, **an existing selection is deleted
  first**, then the elements are inserted at the paragraph's current position; a block element
  splits the paragraph ([apiBuilder.js L7525-L7580][s-builder-insert]).
  - This is also what ONLYOFFICE's custom-xml example does ([example L632][sp-cx]).
  - Alternatives are `ApiDocument.AddElement(pos, el)` for an absolute position, or the plugin
    method `AddContentControl(1, {...})` outside `callCommand`.
- **Enumerate** ([L7881-L7896, L7972-L7990][s-builder-enum], [L6574-L6578][s-builder-current],
  [L4636-L4665][s-builder-byid], [doc][a-o-getallcc]):
  - `ApiDocument.GetAllContentControls()` returns block and inline controls;
  - `GetContentControlsByTag(tag)`;
  - `GetCurrentContentControl()` (9.0, inherited from `ApiDocumentContent`, [L3138][s-builder-inherit]);
  - `Api.GetByInternalId(id)` (9.0.4).
- **Locked controls and `callCommand`:** the per-method checks above are the only protection.
  - The end-of-action lock check only looks at co-editing locks and form filling
    ([ParagraphContentBase.js L5071-L5096][s-pcb-checklock], [History.js L1734-L1790][s-hist-checklock]).
  - *Inference:* content of a `sdtContentLocked` control can be changed through `GetContent()` or
    `RemoveAllElements()`, but `Push`, `AddElement` and `AddText` refuse. **UNVERIFIED** live.
  - The robust pattern is to unlock, modify and relock in a single `callCommand`. That produces one
    undo step, rolled back as a whole if locked.

```js
// Insert a locked, tagged block control at the cursor
Asc.scope.label = { id: "L-42", text: "Internal" };
Asc.plugin.callCommand(function () {
  var sdt = Api.CreateBlockLvlSdt();
  sdt.SetTag("label:" + Asc.scope.label.id);
  sdt.SetAlias("Label");
  sdt.SetBorderColor(Api.RGB(0, 102, 204));
  sdt.GetContent().GetElement(0).AddText(Asc.scope.label.text);
  sdt.SetLock("sdtContentLocked");
  Api.GetDocument().InsertContent([sdt]);
  return sdt.GetInternalId();
}, false, true, function (internalId) { /* string */ });

// Update it later
Asc.scope.target = { id: internalId, text: "Confidential" };
Asc.plugin.callCommand(function () {
  var sdt = Api.GetByInternalId(Asc.scope.target.id);
  if (!sdt || sdt.GetClassType() !== "blockLvlSdt") return false;
  var lock = sdt.GetLock();
  sdt.SetLock("unlocked");
  var content = sdt.GetContent();
  content.RemoveAllElements();
  content.GetElement(0).AddText(Asc.scope.target.text);
  sdt.SetLock(lock);
  return true;
}, false, true, function (ok) {});
```

## 9. Custom XML parts API (9.0), critical

### 9.1 API surface

`ApiDocument.GetCustomXmlParts()` (9.0) returns `new ApiCustomXmlParts(document)`
([apiBuilder.js L10161-L10164][s-builder-getcx], [doc][a-o-getcx]; introduced in 9.0 per the
[changelog][a-o-changelog]).

- **`ApiCustomXmlParts`** ([L6683-L6794][s-builder-cxparts], [doc][a-o-cxparts]):
  - `Add(xml)` returns an `ApiCustomXmlPart` and runs `createCustomXml`;
  - `GetById(id)` matches `itemId`;
  - `GetByNamespace(ns)` returns a part list, matched against the part's xmlns declarations;
  - `GetAll()`, `GetCount()`, `GetClassType()` (`"customXmlParts"`).
- **`ApiCustomXmlPart`** ([L6801-L6993][s-builder-cxpart], [doc][a-o-cxpart]):
  - `GetId()` returns **`itemId`**, a GUID formatted `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`
    (uppercase, braces) ([CreateGUID][s-apicommon-guid]);
  - `GetXml()`, `GetNodes(xpath)`, `Delete()`;
  - `GetAttribute`, `InsertAttribute`, `UpdateAttribute` and `DeleteAttribute`, each taking
    `(xpath, name[, value])`;
  - `InsertElement(xpath, xml, index?)`, `UpdateElement(xpath, xml)`, `DeleteElement(xpath)`;
  - `GetClassType()`.
- **`ApiCustomXmlNode`** ([L6995-L7303][s-builder-cxnode], [doc][a-o-cxnode]):
  - `GetNodes(relXpath)` (the path must start with `/`, for example `"/*"`), `GetXPath()`
    (`/root/child[2]`), `GetNodeName()`, `GetNodeValue()`, `GetXml()`, `GetText()`;
  - `SetNodeValue(xml)`, `SetXml(xml)`, `SetText(str)`, `Delete()`, `GetParent()`, `Add(name)`;
  - `GetAttributes()` returns `[{name, value}]`, plus `GetAttribute`, `SetAttribute` (add only),
    `UpdateAttribute` (existing only) and `DeleteAttribute`.
- **XPath is a small custom subset** ([custom-xml.js L240-L358][s-cx-xpath]):
  - `/a/b` child steps by *local* name, with prefixes ignored;
  - `*`, `[n]` (1-based position) and `//` descendant steps;
  - a trailing `@attr` step returns the owning elements;
  - no other predicates.
- **Namespaces:** every `xmlns`/`xmlns:p` value found while parsing is added both as a schemaRef
  (written to `itemProps`) and to the namespace map used by `GetByNamespace`. A default namespace
  gets a generated prefix `ns…` ([custom-xml.js L751-L810][s-cx-parse], [L164-L176][s-cx-ns]).

### 9.2 Persistence in the DOCX: yes (source)

1. Opening a DOCX: x2t turns every `customXml` part with its `itemProps` (`ds:itemID`,
   schemaRefs) into a `Customs` table (`ItemId`, `Uri`, `ContentA`) of the editor binary
   ([core BinaryWriterD.cpp L9738-L9786, L10092-L10096][c-bwd]). sdkjs `BinaryCustomsTableReader`
   rebuilds a `CustomXml` per part and adds it to the manager
   ([serialize-custom-xml.js L152-L206][s-cxser], called from [Serialize2.js L8095-L8098][s-ser2-read]).
2. In the editor, the model is `CustomXmlManager`, created with each `CDocument`
   ([Document.js L1205][s-doc-cxmgr], [custom-xml-manager.js][s-cxmgr]).
3. Saving: `BinaryCustomsTableWriter` writes every part (itemId, schemaRefs, UTF-8 text) whenever
   `getCount() > 0` ([Serialize2.js L1975-L1978][s-ser2-write], [serialize-custom-xml.js L57-L104][s-cxser]).
   x2t's `Binary_CustomsTableReader` then writes `customXml/itemN.xml`, `customXml/itemPropsN.xml`
   and `customXml/_rels/itemN.xml.rels`, and registers the content type
   ([core BinaryReaderD.cpp L3673-L3740][c-brd], [CustomXmlWriter.cpp L47-L109][c-cxw]).
   - *Inference:* the server-side save re-runs the same `sdkjs` bundles through doctrenderer, whose
     config points at `../../../sdkjs` **[image]**
     (`/var/www/onlyoffice/documentserver/server/FileConverter/bin/DoctRenderer.config`). So the
     change classes below are applied on the server too.
   - An end-to-end check (save, unzip, reopen) is still **UNVERIFIED**.
4. Neither the docs nor the parts API mention persistence explicitly ([doc][a-o-cxparts]).

### 9.3 Undo history and co-editing: yes (source)

- **History changes exist** ([custom-xml-changes.js][s-cxchg]):
  - `CChangesCustomXmlManagerAdd` and `CChangesCustomXmlManagerRemove`, types
    `historyitem_type_CustomXmlManager | 1` and `| 2`, with `Undo`, `Redo`, `WriteToBinary`,
    `ReadFromBinary` and `CreateReverseChange` ([L43-L170][s-cxchg]);
  - `CChangesCustomXmlContentStart`, `…Part` and `…End`, types `historyitem_type_CustomXml | 1`,
    `| 2` and `| 3` ([L176-L281][s-cxchg]).

  The type bases are `72 << 16` and `73 << 16` ([HistoryCommon.js L1513-L1514][s-histcommon-types]).
  `AscDFH.InheritBaseChange` registers each class in `AscDFH.changesFactory`, which is how remote and
  server-side changes are deserialised ([HistoryCommon.js L5930-L5933][s-histcommon-inherit]).
- **Recording:**
  - `CustomXmlManager.add` calls `History.Add(new CChangesCustomXmlManagerAdd(...))`, and
    `deleteExactXml` records a Remove ([custom-xml-manager.js L58-L113][s-cxmgr]);
  - creating a `CustomXml` registers it in `g_oTableId`, which itself records a
    `CChangesTableIdAdd` serialising `Id`, `itemId` and schemaRefs through `Write_ToBinary2`
    ([custom-xml.js L49-L106][s-cx-class], [TableId.js L67-L76][s-tableid-add]). Remote clients
    rebuild the object from the factory entry
    `m_oFactoryClass[historyitem_type_CustomXml] = AscWord.CustomXml` ([TableId.js L359][s-tableid-factory]);
  - content edits (`Add`, `SetXml`, `SetText`, attribute and element methods) go through
    `CustomXml.Change()`: a copy is taken before, and `writeContent(old, new)` after records `Start`,
    one or more `Part` changes carrying **both old and new full text** in 1 MiB slices
    (`BINARY_PART_HISTORY_LIMIT = 1048576`), then `End` ([custom-xml.js L132-L150][s-cx-write],
    [L447-L467][s-cx-change], [apiBuilder.js L7100-L7297][s-builder-cxnode]).
- **Consequences** (*inference* from the above):
  1. A `callCommand` that edits custom XML is part of that command's single undo step, so **the
     user can undo it with Ctrl+Z**. Redo restores it.
  2. The changes travel through the normal co-editing stream (they have binary serialisation) and
     are replayed by co-authors and by the server at save time.
  3. No change class defines `CheckLock`. The base version is a no-op
     ([HistoryCommon.js L4973-L4975][s-histcommon-checklock]), so there are no co-editing locks on
     custom XML: concurrent edits of the same part resolve as last-writer-wins on the whole text.
  4. Every edit resends the whole part twice (old and new text). Keep parts small; the
     interaction with `websocketMaxPayloadSize: "1.5MB"` ([default.json L519][v-default-maxchanges])
     is **UNVERIFIED**.
  5. A document whose only change is custom XML still counts as modified, so status 2 is expected
     (**UNVERIFIED**).

### 9.4 Serialisation quirks (source reading; test before relying on them)

- **Parsing:** the parser (`CustomXmlCreateContent` on the easysax StAX reader) stores text nodes
  and attribute values **raw**, with entities not decoded. `StaxParser.GetValue()` returns the raw
  substring ([custom-xml.js L751-L810][s-cx-parse], [easysax.js L1435-L1437][s-easysax]).
- **Serialising:** `getStringFromBuffer()` writes attributes with XML encoding, writes the **text
  raw and trimmed after all child elements**, then does global `replaceAll("&quot;", "\"")` and
  `replaceAll("&amp;", "&")` ([custom-xml.js L621-L680][s-cx-buffer],
  [Metafile.js L922-L1000, L1236-L1250][s-metafile]). `GetXml()` and the saved part both use this
  path ([custom-xml-manager.js getCustomXMLString][s-cxmgr], [serialize-custom-xml.js L90-L95][s-cxser]).
- *Inference* for the consequences:
  1. A text value containing `&amp;`, or an `&` set with `SetText`, comes out as a bare `&`, which
     is **malformed XML**.
  2. An attribute value set via the API that contains `&` or `"` comes out unescaped.
  3. `<` set raw via `SetText` stays raw, also malformed.
  4. Mixed content (`<a>x<b/>y</a>`) is re-ordered and trimmed.
  5. `GetText()` and `GetAttribute()` return raw, still-encoded strings.

  Practical guidance: keep label values to a safe character set, or encode them (for example
  base64url), and use element-only or attribute-only structures.

### 9.5 Data binding to content controls is disabled in CE

- Both directions are gated by `customXmlManager.isSupported()`, which is
  `window.Asc.Addons.ooxml === true`: XML to control in `checkDataBinding` / `UpdateFromXmlMapping`,
  and control to XML in `updateDataBinding` ([custom-xml-manager.js L178-L197, L463-L466][s-cxmgr],
  [SdtBase.js L1278-L1287][s-sdtbase-bind]).
- In the 9.4.0.1 image, the only add-on registered is `forms` (`window['Asc']['Addons']['forms'] = true`
  in `sdkjs/word/sdk-all-min.js`). No file under `sdkjs/` or `web-apps/` sets `ooxml`; the only
  match is the check itself **[image]** (grep).
- *Inference:* `SetDataBinding` stores the mapping, but nothing is synchronised, and
  `UpdateFromXmlMapping()` returns `false`. ONLYOFFICE's custom-xml example relies on binding
  ([example L606-L644][sp-cx]); it would not work on this image. **UNVERIFIED** live.

### 9.6 Example

```js
Asc.scope.ns = "urn:example:labels:v1";
Asc.scope.xml = '<labels xmlns="urn:example:labels:v1"><label id="L-42" level="internal"/></labels>';
Asc.plugin.callCommand(function () {
  var parts = Api.GetDocument().GetCustomXmlParts();
  var found = parts.GetByNamespace(Asc.scope.ns);
  var part = found.length ? found[0] : parts.Add(Asc.scope.xml);
  part.UpdateAttribute("/labels/label", "level", "confidential"); // existing attribute only
  return { id: part.GetId(), xml: part.GetXml(), count: parts.GetCount() };
}, false, false, function (r) { /* { id: "{XXXXXXXX-…}", xml: "…", count: n } */ });
```

## 10. Custom document properties (9.0)

- `ApiDocument.GetCustomProperties()` returns `ApiCustomProperties` ([apiBuilder.js L10187-L10189][s-builder-getcp],
  [doc][a-o-getcp]). Its only exported methods in 9.4 are `GetClassType()` (`"customProperties"`),
  `Add(name, value)` and `Get(name)` ([L30385-L30446, L31777-L31779][s-builder-cp], [doc][a-o-cp]).
- `Add` maps a string to `vtLpwstr`, a boolean to `vtBool`, an integer to `vtI4`, another number to
  `vtR8` and a valid `Date` to `vtFiletime`. Other types return `false`. An existing name is
  modified in place.
- There is no delete or list method.
- Changes are recorded in history (`historyitem_CustomPropertiesAddProperty`)
  ([Format.js L14930-L14945][s-format-cp]) and serialised in the editor binary
  ([Serialize2.js L1965-L1972][s-ser2-write]). The mapping to `docProps/custom.xml` by x2t is
  **UNVERIFIED**.

## 11. `plugins.js`, `plugins-ui.js`, `plugins.css`

- **In the image:** `/var/www/onlyoffice/documentserver/sdkjs-plugins/v1/{plugins.js,plugins-ui.js,plugins.css}`.
  They are served at `https://<ds>/sdkjs-plugins/v1/...` through the `/sdkjs-plugins` static route
  ([production-linux.json][v-prodlinux], [ds-docservice.conf.m4 L32-L43][p-docsvc]). Bundled
  plugins reference them as `../v1/plugins.js` **[image]** (`sdkjs-plugins/marketplace/index.html`),
  which a plugin installed under `sdkjs-plugins/<name>/` can reuse.
- **Version match:**
  - the image's `v1/plugins.js` (12166 bytes, git blob `24f9be9d…`) is the file at
    onlyoffice.github.io commit [`ebcb847`][g-plugins] (2026-01-15);
  - `plugins-ui.js` and `plugins.css` are byte-identical to onlyoffice.github.io master
    ([v1 folder][g-v1]);
  - the live `https://onlyoffice.github.io/sdkjs-plugins/v1/plugins.js`, which the docs reference
    ([doc][a-p-entry], [doc][a-p-asc]), has since gained window-header and float-button helpers
    (commits of 2026-06 to 2026-08). **Pin a copy** from the image or from `ebcb847`.
  - The plugin API proper is injected by the editor anyway ([7.1](#71-loading-handshake)).
- **ONLYOFFICE/sdkjs-plugins** has no `v1/` folder on master (`v1` gives 404). It holds Apache-2.0
  example plugins ([LICENSE][sp-license]).
- **Licence:** AGPL-3.0. The file headers of `plugins.js` and `plugins-ui.js` carry the Ascensio
  AGPL notice **[image]**, and the [onlyoffice.github.io LICENSE][g-license] is AGPL-3.0.
  `plugins-ui.js` bundles PerfectScrollbar without a licence header in the bundle; that library's
  licence is not stated there (**UNVERIFIED**). The injected SDK (`sdkjs/common/plugins/plugin_base*.js`)
  is AGPL-3.0 ([header][s-pbase]).

## 12. DOM structure for browser automation

- **Host page:** `createIframe` builds `<iframe name="frameEditor" frameborder="0" allowfullscreen allow="autoplay; camera; microphone; display-capture; clipboard-write;">`,
  **with no id**. It replaces the placeholder element, so `#placeholder` disappears
  ([api.js L1279-L1297, L621][w-api-iframe], [doc][a-doceditor]).
  - The `src` is `<DS base>/9.4.0-<hash>/web-apps/apps/documenteditor/main/index.html?_dc=9.4.0-129&lang=…&customer=ONLYOFFICE&type=desktop&frameEditorId=<placeholderId>&parentOrigin=<portal origin>&fileType=docx[&mode=view]`
    ([api.js L1186-L1277, L1325-L1336][w-api-view]; version values **[image]**).
  - api.js only accepts messages whose origin equals the iframe's origin ([L1017][w-api-msg]).
- **Panel plugin (`panel` / `panelRight`) inside the editor iframe:**
  - The sdkjs manager sets `frameId = "iframe_" + guid` ([plugins.js L1078][s-plugins-run]) and
    passes `urlParams = "?lang=<lang>&theme-type=<light|dark>"` ([L1150-L1157][s-plugins-show]).
  - web-apps computes `url = plugin.baseUrl + variation.url + urlParams`
    ([Plugins.js L780-L806][w-plugins-show]) and creates:

    ```
    <div id="panel-plugins-<english name, lower-cased, [^a-z0-9-_:] replaced by '-'>" class="plugin-panel">
      <div class="current-plugin-box"> … <div class="current-plugin-frame">
        <iframe id="iframe_asc.{GUID}" name="pluginFrameEditor" src="<baseUrl><url>?lang=…&theme-type=…"
                allow="camera; microphone; display-capture">
    ```

    The side button is `#slot-btn-plugins<name>` ([Plugins.js L616-L668][w-plugins-sidemenu],
    [PluginPanel.js L130-L157][w-panel]).
  - **The plugin frame's origin is the origin of `baseUrl`**, which is the `pluginsData` host, or
    the DS origin for server-installed plugins.
  - Select the frame by `name="pluginFrameEditor"` or by id, escaping the `.{}` characters.
- **Background and invisible plugins:** a hidden iframe with `id` = `name` = `iframe_<guid>` is
  appended to the editor `body` at `top:-100px`, `z-index:-1000` ([plugins.js L1159-L1172][s-plugins-show]).
- *Inference* for tools like Playwright: use `page.frame({ name: "frameEditor" })`, then its child
  frame named `pluginFrameEditor`. For readiness, wait for the host's `onDocumentReady` callback.

## 13. Known pitfalls

Documented by ONLYOFFICE:

- Pass data into `callCommand` through `Asc.scope`, and never functions ([doc][a-p-cmd],
  [doc: errors][a-p-errors]).
- `isCalc = false` "only when your edits surely will not require document recalculation"
  ([doc][a-p-cmd]).
- Callback return values contain "only the js standard types", and objects become `undefined`
  ([doc][a-p-cmd]).
- A plugin listening to `onContextMenuShow` must answer `AddContextMenuItem` ([doc][a-p-ctx]).
- The JWT must be generated server-side ([doc][a-sig]). The document `url` must be reachable from
  the DS even with a token ([doc][a-coedit]). The key must change after a successful save
  ([doc][a-coedit]).
- An avatar sent in base64 inside a signed config makes the token too long ([doc][a-editor]).
- **Network calls inside `callCommand` freezing the editor:** no statement found in the ONLYOFFICE
  docs (search of the docs repository), so it is **UNVERIFIED** as a documented pitfall. The
  source behaviour is in the next list.

Derived from the 9.4 source (see the sections above):

- Do not do network I/O in `callCommand`. XHR triggers a modal permission dialog. The builder
  action is finalised synchronously, so an asynchronous continuation would edit the document outside
  any history action. *Inference:* changes may be unrecorded, not undoable or not sent to co-authors.
  Fetch data in the plugin page, then pass it through `Asc.scope`.
- `window` and `document` are `{}` inside `callCommand` ([7.3](#73-callcommandfunc-isclose-iscalc-callback)).
- `executeMethod` calls are serialised and a queued call returns `false` ([7.5](#75-executemethodname-params-callback)).
- Keep `events` in `config.json`, and do not mix `attachEditorEvent("onContextMenuClick")` with
  `attachContextMenuClickEvent` ([7.6](#76-events)).
- Writes from `callCommand` are rolled back in view mode, and the whole command is one undo step
  ([7.3](#73-callcommandfunc-isclose-iscalc-callback)).
- Custom XML: user-undoable, last-writer-wins, escaping bugs, no data binding in CE ([9](#9-custom-xml-parts-api-90-critical)).
- `InternalId` is not persistent ([7.9](#79-content-control-methods-and-event-payloads)).
- `JWT_SECRET` and `SECURE_LINK_SECRET` are random per start unless set. `/healthcheck` answers 200
  even when the body is `false`. The forwarded headers are trusted blindly ([1](#1-docker-image)).
- CE 9.4 loses in-memory sessions on restart, and the memory guard silently forces view mode
  ([1.1](#11-ce-94-runtime-model-in-memory-single-process)).

## 14. Docs versus code at 9.4.0.129

| Topic | Docs | Code (9.4.0.129) |
|---|---|---|
| CE connection limit | "open source version limit is 20" (live viewer) ([doc][a-viewing]) | `0x7fffffff`, replaced by the memory guard ([license.js][v-license], [memoryGuard.js][v-guard]) |
| `token.*.inBody` / `JWT_IN_BODY` | Enables body tokens ([doc][a-tokenbody]) | Never read. Callbacks always carry header and body tokens ([DocsCoServer.js L796-L829][v-sendserverreq]); inbox accepts either ([L1697-L1742][v-reqparams]) |
| Callback body with JWT | Only `{"token": …}` ([doc][a-tokenbody]) | Full body plus `token` ([L796-L829][v-sendserverreq]) |
| Command error codes | 0-6 ([doc][a-cmd]) | Also `7` = token expired ([commondefines.js L1180-L1189][v-defs-enums]) |
| Plugin `type` | `unvisible` ([doc][a-p-types]) | `invisible`; unknown strings fall back to `background` ([apiCommon.js L7294-L7312][s-apicommon-type]) |
| `variations.events` | Deprecated since 8.2 ([doc][a-p-config]) | Still required to replay `onDocumentContentReady` and to use the built-in click dispatchers ([plugins.js][s-plugins-mainevents]) |
| `onContextMenuShow` payload | Key `Type` ([doc][a-p-asc]) | Key `type` ([editorscommon.js L15118-L15126][s-edcommon-ctxinfo]) |
| `AddContextMenuItem` parameter | `ContextMenuItem[]` ([doc][a-p-asc]) | One `{guid, items}` object in an array ([apiBase_plugins.js L2087-L2092][s-apibaseplug-ctx]) |
| `MoveCursorToContentControl` default | `isBegin = false`, "begin" ([doc][a-p-move]) | Anything but `false` means begin ([Document.js L23305-L23306][s-doc-movecursor]) |
| `Asc.plugin.info` | OLE fields only ([doc][a-p-asc]) | Also `userId`, `userName`, `isViewMode`, `lang`, `documentId`, `documentCallbackUrl`, `jwt`, `options` ([plugins.js L1359-L1388][s-plugins-correctdata]) |
| `Asc.plugin.onDestroy` | Used in an example ([doc][a-p-events]) | Not found in the 9.4 SDK source |
| Docker README env list | "complete list" includes `DB_*`, `AMQP_*`, `REDIS_*` ([README][d-readme-env]) | Ignored by the CE entrypoint ([run-document-server.sh L131-L214][d-run-available]) |

## 15. Open questions (need a live test)

1. **Memory guard:** the actual `heap_size_limit` of `docservice` in the container, and therefore
   the number of simultaneous editable documents. How does the client present a forced-view session
   (does `onInfo` report `view`)? Check the log line `forced view mode by community memory guard`.
2. **Private network:** with `JWT_ENABLED=true` and `ALLOW_PRIVATE_IP_ADDRESS=false`, do the
   `document.url` download and the callback to a private IP succeed, as the code suggests? With JWT
   off, do they fail?
3. **Callback `url`:** which host does it contain behind the proxy? Does rewriting it to the
   internal service name download correctly (nginx `secure_link`)? Is the 900 s expiry enough?
4. **Restart behaviour:** what happens to an open session on `docker restart`? Does the SIGTERM
   shutdown flow send status 2 in the memory runtime? Are forgotten files kept on the
   `/var/lib/onlyoffice` volume?
5. **Custom XML round trip:** does the saved DOCX contain `customXml/itemN.xml` and
   `itemPropsN.xml` with the same `ds:itemID`, and does reopening it return the same `GetId()`?
6. **Custom XML escaping:** check the output of `GetXml()` and of the saved part for values
   containing `&`, `<` and `"`, set through `Add`, `SetText` and `SetAttribute`.
7. **Custom XML collaboration:** do edits propagate to a second browser in `fast` mode? Does Ctrl+Z
   in the other user's editor revert them? Do two concurrent edits resolve as last-writer-wins?
8. **Data binding:** confirm that `SetDataBinding` and `UpdateFromXmlMapping()` do nothing in CE
   9.4.0.1.
9. **Locks:** confirm the lock matrix of section 8 on `sdtContentLocked` controls. Does
   `SetLock("unlocked")` followed by edits and a relock inside one `callCommand` work, and is it a
   single undo step?
10. **View mode:** does a `panelRight` plugin with `isViewer: true` autostart and show its panel? Do
    reads through `callCommand` work? Are writes rolled back silently, with the callback receiving
    `undefined`? What happens with `isViewer: false`?
11. **Events:** are `onContextMenuShow`, `onContextMenuClick` and `onToolbarMenuClick` delivered as
    described? Is the payload key really lowercase `type`? Does `GetCurrentContentControl` work from
    inside the `onContextMenuShow` handler? Does `onChangeContentControl` fire for remote changes?
    Is `onDocumentContentReady` replayed to an autostarted plugin?
12. **Plugin hosting:** do `pluginsData` and the plugin iframe work from the portal origin, with
    CORS on `config.json` and framing allowed? Are cookies sent to the portal from the nested plugin
    frame? Otherwise, use a token passed in `editorConfig.plugins.options`.
13. **Plugin identity:** what does `Asc.plugin.info.jwt` contain at `init` time (session token or
    config token), and can the portal verify it with `JWT_SECRET`?
14. **Startup:** measure startup time with `GENERATE_FONTS=true` versus `false`. Check the
    behaviour of `PLUGINS_ENABLED=true` without Internet access.
15. **arm64:** is behaviour identical to amd64 for the scenarios above?

## 16. Editing sessions after a configuration is signed (observed, 9.4.0)

Observed on the stack while working on #54:

- The Document Server calls back with status 1 whenever someone joins a session:
  `{"status":1,"users":["alice"],"actions":[{"type":1,"userid":"alice"}]}`; a session that closes
  without changes calls back with status 4 and an action of type 0.
- The command service's `info` answers at once with the connected users:
  `{"error":0,"users":["alice","bob"]}`, besides calling back.
- `drop` disconnects users from a session: their editor shows "The file cannot be accessed right
  now.", stops editing and keeps showing what it had loaded; `info` no longer lists them. Without
  `users`, it disconnects every connection of the document, viewers included
  (`dropUserFromDocument` in `DocsCoServer.js`).
- Callbacks and `info` report editors only: a viewer joins a session unreported.
- A session with changes ends with status 2, even when a forced save stored them before.
- An editor configuration whose key's version was saved opens nothing: the editor raises
  `onRequestRefreshFile`, asking its page for a new configuration.

<!-- Links -->

[sdkjs-tag]: https://github.com/ONLYOFFICE/sdkjs/tree/v9.4.0.129
[webapps-tag]: https://github.com/ONLYOFFICE/web-apps/tree/v9.4.0.129
[server-tag]: https://github.com/ONLYOFFICE/server/tree/v9.4.0.129
[core-tag]: https://github.com/ONLYOFFICE/core/tree/v9.4.0.129
[docker-tag]: https://github.com/ONLYOFFICE/Docker-DocumentServer/tree/v9.4.0.129
[dsp-tag]: https://github.com/ONLYOFFICE/document-server-package/tree/v9.4.0.129
[ds-meta]: https://github.com/ONLYOFFICE/DocumentServer/tree/v9.4.0
[ds-changelog-backend]: https://github.com/ONLYOFFICE/DocumentServer/blob/v9.4.0/CHANGELOG.md#L47-L54
[ds-changelog-disable]: https://github.com/ONLYOFFICE/DocumentServer/blob/v9.4.0/CHANGELOG.md#L56-L60
[ds-changelog-sec]: https://github.com/ONLYOFFICE/DocumentServer/blob/v9.4.0/CHANGELOG.md#L42-L43

[d-run]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh
[d-run-exit]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L10-L19
[d-run-ca]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L72-L88
[d-run-nginx]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L618-L673
[d-run-jwt]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L110-L123
[d-run-available]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L131-L132
[d-run-readsetting]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L158-L217
[d-run-wopi]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L385-L436
[d-run-plugins]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L805-L816
[d-run-tail]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/run-document-server.sh#L836-L845
[d-dockerfile-expose]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/Dockerfile#L71
[d-dockerfile-editions]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/Dockerfile#L86-L116
[d-dockerfile-volume]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/Dockerfile#L139-L146
[d-compose]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/docker-compose.yml#L17-L25
[d-readme-env]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/README.md#L194-L245
[d-readme-volumes]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/README.md#L71-L110
[d-bake]: https://github.com/ONLYOFFICE/Docker-DocumentServer/blob/v9.4.0.129/docker-bake.hcl#L113

[p-http]: https://github.com/ONLYOFFICE/document-server-package/blob/v9.4.0.129/common/documentserver/nginx/includes/http-common.conf.m4#L1-L45
[p-docsvc]: https://github.com/ONLYOFFICE/document-server-package/blob/v9.4.0.129/common/documentserver/nginx/includes/ds-docservice.conf.m4
[p-ssl]: https://github.com/ONLYOFFICE/document-server-package/blob/v9.4.0.129/common/documentserver/nginx/ds-ssl.conf.tmpl.m4

[v-profile]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/runtime/profile.js#L37-L64
[v-guard]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/runtime/memoryGuard.js#L36-L125
[v-guard-apply]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L634-L671
[v-license]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/license.js#L44-L70
[v-const-lic]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/constants.js#L95
[v-const-docid]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/constants.js#L38-L42
[v-const-proto]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/constants.js#L55
[v-baseconn]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/databaseConnectors/baseConnector.js#L37
[v-pubsub]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/pubsubRabbitMQ.js#L37
[v-taskq]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/taskqueueRabbitMQ.js#L37
[v-memconn]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/databaseConnectors/memoryConnector.js#L36-L44
[v-shutdown]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/shutdown.js#L36-L110
[v-serverjs-routes]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/server.js#L234-L293
[v-serverjs-plugins]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/server.js#L373-L416
[v-healthcheck]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L4483-L4535
[v-default]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json
[v-default-server]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json#L320-L352
[v-default-urlexp]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json#L105-L111
[v-default-extreq]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json#L303-L318
[v-default-token]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json#L463-L504
[v-default-plugins]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json#L505-L508
[v-default-maxchanges]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json#L512-L521
[v-default-backoff]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json#L536-L545
[v-default-conv]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/default.json#L554-L563
[v-prodlinux]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/config/production-linux.json
[v-pkg]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/package.json#L26
[v-status]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L241-L250
[v-filljwtconn]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L535-L567
[v-sendserverreq]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L796-L829
[v-startforcesave]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L1069-L1180
[v-reply1]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L1481-L1487
[v-checkjwt]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L1656-L1696
[v-reqparams]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L1697-L1742
[v-docid-reject]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L1916-L1920
[v-validate]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L2696-L2712
[v-filljwt]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L2713-L2819
[v-validate-use]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L2874-L2890
[v-auth-withauth]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L2918-L2923
[v-auth-callback]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L2944-L2953
[v-validateinput]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L4538-L4553
[v-cmd-forcesave]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/DocsCoServer.js#L4670-L4686
[v-defs-sfc]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/commondefines.js#L832-L872
[v-defs-enums]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/commondefines.js#L1175-L1206
[v-utils-direct]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/utils.js#L268-L330
[v-utils-post]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/utils.js#L435-L520
[v-utils-baseurl]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/utils.js#L826-L895
[v-utils-hostfilter]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/utils.js#L1035-L1049
[v-utils-filljwt]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/utils.js#L1135-L1149
[v-utils-canoutbox]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/utils.js#L1191-L1203
[v-utils-exthost]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/utils.js#L1305-L1309
[v-conv-download]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/FileConverter/sources/converter.js#L510-L552
[v-conv-task]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/FileConverter/sources/converter.js#L1205-L1226
[v-canvas-fixlen]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/canvasservice.js#L1033-L1042
[v-canvas-url]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/canvasservice.js#L1170-L1181
[v-canvas-reply]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/canvasservice.js#L1200-L1303
[v-canvas-forgotten]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/DocService/sources/canvasservice.js#L1302-L1330
[v-storage]: https://github.com/ONLYOFFICE/server/blob/v9.4.0.129/Common/sources/storage/storage-base.js#L161-L200

[w-api-ctor]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L402-L407
[w-api-replace]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L611-L623
[w-api-pluginsflag]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L278-L279
[w-api-appready]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L458-L503
[w-api-check]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L506-L575
[w-api-shard]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L1041-L1050
[w-api-view]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L1186-L1277
[w-api-iframe]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L1279-L1297
[w-api-msg]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/api/documents/api.js#L1015-L1030
[w-plugins-load]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L132-L183
[w-plugins-setapi]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L198-L216
[w-plugins-sidemenu]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L616-L668
[w-plugins-show]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L780-L806
[w-plugins-autostart]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L859-L863
[w-plugins-parse]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L886-L1062
[w-plugins-visible]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L920-L930
[w-plugins-fetch]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/controller/Plugins.js#L1063-L1131
[w-panel]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/view/PluginPanel.js#L130-L157
[w-gateway]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/Gateway.js#L225-L350
[w-main-user]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/documenteditor/main/app/controller/Main.js#L440-L443
[w-main-docinfo]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/documenteditor/main/app/controller/Main.js#L551-L567
[w-main-ready]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/documenteditor/main/app/controller/Main.js#L1562-L1565
[w-main-macroperm]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/documenteditor/main/app/controller/Main.js#L3279-L3319
[w-utils-user]: https://github.com/ONLYOFFICE/web-apps/blob/v9.4.0.129/apps/common/main/lib/util/utils.js#L1015-L1023

[s-plugins-mainevents]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L165-L168
[s-plugins-event2]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L655-L700
[s-plugins-editorsupport]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L504-L531
[s-plugins-options]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L727-L743
[s-plugins-run]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L975-L1086
[s-plugins-show]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L1106-L1200
[s-plugins-correctdata]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L1359-L1388
[s-plugins-origin]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L1457-L1476
[s-plugins-callcommand]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L1551-L1648
[s-plugins-handshake]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L1748-L1793
[s-plugins-attach]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins.js#L1893-L1913
[s-pbase-onmsg]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins/plugin_base.js#L607-L852
[s-pbase]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins/plugin_base.js#L1-L34
[s-pbaseapi-ctxdoc]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins/plugin_base_api.js#L259-L294
[s-pbaseapi-execmethod]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins/plugin_base_api.js#L424-L452
[s-pbaseapi-callcommand]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/plugins/plugin_base_api.js#L529-L620
[s-apicommon-guid]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiCommon.js#L125-L133
[s-apicommon-type]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiCommon.js#L7278-L7312
[s-apicommon-variation]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiCommon.js#L7314-L7498
[s-apicommon-cplugin]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiCommon.js#L7500-L7620
[s-apicommon-checkret]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiCommon.js#L9571-L9630
[s-macros-xhr]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/macros.js#L310-L440
[s-macros-safeeval]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/macros.js#L443-L595
[s-apibase-editorname]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L474-L492
[s-apibase-user]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L630-L636
[s-apibase-eval]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L4590-L4650
[s-apibase-perm]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L4743-L4752
[s-apibase-ctx]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase.js#L5329-L5436
[s-apibaseplug-ctx]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase_plugins.js#L2052-L2108
[s-apibaseplug-toolbar]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/apiBase_plugins.js#L2127-L2215
[s-wordapi-builder]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/api.js#L10265-L10292
[s-wordapi-ccevents]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/api.js#L11679-L11708
[s-wordapi-ctxinfo]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/api.js#L14313-L14342
[s-wordplug-getall]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/api_plugins.js#L209-L346
[s-wordplug-addcc]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/api_plugins.js#L624-L643
[s-plugevents]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/plugin-events.js
[s-builder-byid]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L4627-L4665
[s-builder-color]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L5031-L5072
[s-builder-create]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L5573-L5583
[s-builder-inherit]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L3138-L3139
[s-builder-current]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L6565-L6578
[s-builder-cxparts]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L6677-L6794
[s-builder-cxpart]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L6795-L6993
[s-builder-cxnode]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L6995-L7303
[s-builder-insert]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L7514-L7580
[s-builder-enum]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L7874-L7990
[s-builder-getcx]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L10152-L10164
[s-builder-getcp]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L10178-L10189
[s-builder-setlock]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L23101-L23163
[s-builder-border]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L23771-L23870
[s-builder-sdt]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L24769-L25490
[s-builder-cp]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L30375-L30446
[s-builder-canbe]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/apiBuilder.js#L33168-L33185
[s-doc-cxmgr]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Document.js#L1205
[s-doc-finalize]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Document.js#L2214-L2490
[s-doc-lockcheck]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Document.js#L13905-L13915
[s-doc-ccfinalize]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Document.js#L2691-L2697
[s-doc-ccchange]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Document.js#L26676-L26689
[s-doc-movecursor]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Document.js#L23261-L23315
[s-hist-checklock]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/History.js#L1734-L1790
[s-pcb-checklock]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/ParagraphContentBase.js#L5071-L5096
[s-sdtpr-event]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/StructuredDocumentTags/SdtPr.js#L493-L545
[s-sdtbase-bind]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/StructuredDocumentTags/SdtBase.js#L1278-L1287
[s-cxchg]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml-changes.js#L43-L281
[s-cxmgr]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml-manager.js#L45-L466
[s-cx-class]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml.js#L49-L106
[s-cx-write]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml.js#L132-L150
[s-cx-ns]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml.js#L164-L176
[s-cx-xpath]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml.js#L240-L358
[s-cx-change]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml.js#L447-L467
[s-cx-buffer]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml.js#L621-L680
[s-cx-parse]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/custom-xml/custom-xml.js#L751-L810
[s-cxser]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/custom-xml/serialize-custom-xml.js#L57-L206
[s-ser2-write]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Serialize2.js#L1960-L1978
[s-ser2-read]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Serialize2.js#L8095-L8098
[s-ser2-sdtid]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/word/Editor/Serialize2.js#L6771
[s-tableid-add]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/TableId.js#L67-L76
[s-tableid-factory]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/TableId.js#L359
[s-histcommon-types]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/HistoryCommon.js#L1513-L1514
[s-histcommon-checklock]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/HistoryCommon.js#L4973-L4975
[s-histcommon-inherit]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/HistoryCommon.js#L5930-L5933
[s-commondef-lock]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/commonDefines.js#L3176-L3181
[s-commondef-ctx]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/commonDefines.js#L3861-L3868
[s-edcommon-ext]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/editorscommon.js#L2189-L2203
[s-edcommon-ctxinfo]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/editorscommon.js#L15118-L15145
[s-docscoapi-path]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/docscoapi.js#L1677
[s-docscoapi-jwt]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/docscoapi.js#L1655-L1725
[s-docscoapi-getjwt]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/docscoapi.js#L695-L697
[s-metafile]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/Drawings/Metafile.js#L922-L1000
[s-easysax]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/vendor/easysax.js#L1435-L1437
[s-format-cp]: https://github.com/ONLYOFFICE/sdkjs/blob/v9.4.0.129/common/Drawings/Format/Format.js#L14930-L14945

[c-bwd]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Document/BinWriter/BinaryWriterD.cpp#L9738-L9786
[c-brd]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Document/BinReader/BinaryReaderD.cpp#L3673-L3740
[c-cxw]: https://github.com/ONLYOFFICE/core/blob/v9.4.0.129/OOXML/Binary/Document/BinReader/CustomXmlWriter.cpp#L47-L109

[g-plugins]: https://github.com/ONLYOFFICE/onlyoffice.github.io/blob/ebcb847500724bdbb2f5d49815e79e992391267b/sdkjs-plugins/v1/plugins.js
[g-v1]: https://github.com/ONLYOFFICE/onlyoffice.github.io/tree/4d02c4fde76dd98b94129881a0d68366ae0e56e5/sdkjs-plugins/v1
[g-license]: https://github.com/ONLYOFFICE/onlyoffice.github.io/blob/4d02c4fde76dd98b94129881a0d68366ae0e56e5/LICENSE
[sp-ctx]: https://github.com/ONLYOFFICE/sdkjs-plugins/blob/06c4b858e6f1f49b27257c707f0bf71884e141d5/context_menu_example/scripts/context_menu.js
[sp-ctx-cfg]: https://github.com/ONLYOFFICE/sdkjs-plugins/blob/06c4b858e6f1f49b27257c707f0bf71884e141d5/context_menu_example/config.json#L63
[sp-cx]: https://github.com/ONLYOFFICE/sdkjs-plugins/blob/3e0bbcdec70cd81da16ba16742ab45792b0d33d2/custom-xml/scripts/code.js
[sp-license]: https://github.com/ONLYOFFICE/sdkjs-plugins/blob/06c4b858e6f1f49b27257c707f0bf71884e141d5/LICENSE

[a-config]: https://api.onlyoffice.com/docs/docs-api/usage-api/config/
[a-document]: https://api.onlyoffice.com/docs/docs-api/usage-api/config/document/
[a-perms]: https://api.onlyoffice.com/docs/docs-api/usage-api/config/document/permissions/
[a-editor]: https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/
[a-pluginscfg]: https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/plugins/
[a-events]: https://api.onlyoffice.com/docs/docs-api/usage-api/config/events/
[a-callback]: https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/
[a-doceditor]: https://api.onlyoffice.com/docs/docs-api/usage-api/doceditor/
[a-cmd]: https://api.onlyoffice.com/docs/docs-api/additional-api/command-service/
[a-forcesave]: https://api.onlyoffice.com/docs/docs-api/additional-api/command-service/forcesave/
[a-sig]: https://api.onlyoffice.com/docs/docs-api/additional-api/signature/
[a-sigbrowser]: https://api.onlyoffice.com/docs/docs-api/additional-api/signature/browser/
[a-tokenbody]: https://api.onlyoffice.com/docs/docs-api/additional-api/signature/request/token-in-body/
[a-tokenheader]: https://api.onlyoffice.com/docs/docs-api/additional-api/signature/request/token-in-header/
[a-saving]: https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/saving-file/
[a-coedit]: https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/co-editing/
[a-viewing]: https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/viewing/
[a-selfhosted]: https://api.onlyoffice.com/docs/docs-api/get-started/installation/self-hosted/
[a-servercfg]: https://api.onlyoffice.com/docs/docs-api/get-started/configuration/server-config/
[a-servercfg-rfa]: https://api.onlyoffice.com/docs/docs-api/get-started/configuration/server-config/#request-filtering-agent
[a-p-config]: https://api.onlyoffice.com/docs/plugins/configuration/
[a-p-types]: https://api.onlyoffice.com/docs/plugins/configuration/types/
[a-p-entry]: https://api.onlyoffice.com/docs/plugins/configuration/entry-point/
[a-p-ctx]: https://api.onlyoffice.com/docs/plugins/customization/context-menu/
[a-p-toolbar]: https://api.onlyoffice.com/docs/plugins/customization/toolbar/
[a-p-asc]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/overview/asc-plugin/
[a-p-cmd]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/overview/how-to-call-commands/
[a-p-events]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/overview/how-to-attach-events/
[a-p-methods]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/overview/how-to-call-methods/
[a-p-focus]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Events/onFocusContentControl/
[a-p-change]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Events/onChangeContentControl/
[a-p-blur]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Events/onBlurContentControl/
[a-p-cc]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Enumeration/ContentControl/
[a-p-cclock]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Enumeration/ContentControlLock/
[a-p-getall]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Methods/GetAllContentControls/
[a-p-select]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Methods/SelectContentControl/
[a-p-move]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Methods/MoveCursorToContentControl/
[a-p-addcc]: https://api.onlyoffice.com/docs/plugins/interacting-with-editors/document-api/Methods/AddContentControl/
[a-p-errors]: https://api.onlyoffice.com/docs/plugins/development-workflow/debugging/common-errors-solutions/
[a-o-cxparts]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiCustomXmlParts/
[a-o-cxpart]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiCustomXmlPart/
[a-o-cxnode]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiCustomXmlNode/
[a-o-getcx]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiDocument/Methods/GetCustomXmlParts/
[a-o-getcp]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiDocument/Methods/GetCustomProperties/
[a-o-cp]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiCustomProperties/
[a-o-setlock]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiBlockLvlSdt/Methods/SetLock/
[a-o-setborder]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiBlockLvlSdt/Methods/SetBorderColor/
[a-o-insert]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiDocument/Methods/InsertContent/
[a-o-getallcc]: https://api.onlyoffice.com/docs/office-api/usage-api/document-api/ApiDocument/Methods/GetAllContentControls/
[a-o-changelog]: https://api.onlyoffice.com/docs/office-api/more-information/changelog/
