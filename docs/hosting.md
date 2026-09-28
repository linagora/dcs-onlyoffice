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

- **Provisioning client** `dcs-provisioner`, registered at the same provider, for the job that writes OpenTDF's KAS key and attributes when the stack starts:
  - confidential client allowed the client credentials grant only: no redirect URI, no password grant, since OpenTDF makes it an administrator;
  - the scope `openid` allowed;
  - access tokens as JWT signed RS256 with a key id, carrying the `client_id` claim and the audience `https://tdf.<DOMAIN>`.

  OpenTDF recognises this client by the `client_id` claim of its tokens, and its authorization policy in `deploy/opentdf/opentdf.yaml` makes it an administrator (`g, client:dcs-provisioner, role:admin`): the client needs no group or role at the provider, but its id must be `dcs-provisioner`.

With LemonLDAP::NG, these are options of the relying party: JWT format for access tokens, claims released in access tokens, additional audiences, the `groups` attribute exported as an array and, for the provisioning client, the client credentials grant.

## Configuration

Create `deploy/.env` with `deploy/scripts/init-env.sh`, which generates the secrets, then set the values below. After an upgrade, run the script again: it adds the secrets a new version introduces and changes nothing else.

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
| `OPENTDF_PROVISIONER_CLIENT_SECRET` | the provisioning client's secret |
| `PORTION_LOCK_LEASE_SECONDS` | remove the example's 20, meant for tests: an author then keeps a portion lock 5 minutes without renewing it |

`deploy/.env` holds secrets: it is ignored by Git and must stay on the host.

`OPENTDF_KAS_ROOT_KEY` wraps the KAS's private keys, which OpenTDF keeps in its database. Back up the key with the database, and never change it once the stack has started: without it, no envelope can be read. Versions before the hybrid key wrapped portion keys with static RSA keys, which the KAS no longer loads: the portions they encrypted can no longer be read. After such an upgrade, the `dcs_opentdf-keys` volume still holds those keys; delete it with `docker volume rm dcs_opentdf-keys` once you no longer need them.

`BINDING_SIGNING_KEY` and `BINDING_SIGNING_CERTIFICATE` hold the key that signs the document label's binding at each save, and its certificate, as base64-encoded PEM. The script generates a demo key with a self-signed certificate. To sign with a certificate that your PKI issues, give it an ECDSA P-256 key, the algorithm ADatP-4778.2 requires, then set both values, for instance with `openssl base64 -A < signer.key`, and restart the policy service. Verifiers then trust your PKI's certificate authority instead of the demo certificate. The portal's own check trusts the configured certificate only: until their next save, it logs the files signed with the previous key as no longer matching their signature.

Since the OpenTDF platform has a database role of its own, the `database-setup` job hands it the platform's schemas at each start, and the `directory-setup` job of earlier versions is gone: run `docker compose up -d --remove-orphans` once to remove its container.

Other settings are optional or generated by the script; the [README](../README.md#configuration) lists them all.

## Accounts and clearances

People sign in with the provider's accounts, which carry no clearance: their clearances come from the clearance directory. The directory starts from the JSON files of `deploy/directory/seeds`, where `demo.json` holds the local IdP's fictional accounts. Put the hosted accounts in a file named `local-*.json` there, which Git ignores, so that no real address enters the repository. For example, `deploy/directory/seeds/local-hosted.json`:

```json
{
  "clearances": [
    {
      "email": "jane.doe@example.com",
      "name": "Jane Doe",
      "nationality": "FRA",
      "policy": "DEMO-FR",
      "classification": "DIFFUSION RESTREINTE",
      "categories": ["Special Handling:SPECIAL FRANCE", "Releasable To:NATO"],
      "validFrom": "2026-01-01T00:00:00Z",
      "validUntil": "2027-01-01T00:00:00Z"
    }
  ]
}
```

- `email` is the address that the provider puts in the access token's `email` claim, in any case: OpenTDF finds a person's clearance with it.
- `policy` is the name of a security policy in `deploy/spif`; `classification` is one of its classifications, and each category is written `<category>:<value>`, as the SPIF names them.
- `nationality`, a three-letter country code, may be left out.
- The clearance is valid from `validFrom` until just before `validUntil`, two ISO 8601 dates.

Someone without a valid clearance opens no document: a document without a base label counts as the least restrictive label, which still needs one.

The policy service loads these files when it starts, so run `docker compose restart policy` after changing one. It adds the entries the directory does not hold yet and keeps the others as they are: change an existing entry on the portal's clearance page, which members of the `dcs-maquette-admin` group reach. An invalid entry keeps the policy service from starting, and its log names the file and the entry.

## Reverse proxy

`deploy/nginx/dcs.conf.template` is an nginx site for the three host names. Render it with `envsubst`, as its header shows. It:

- redirects HTTP to HTTPS;
- passes websockets to the Document Server, which co-editing needs;
- sends `X-Forwarded-Proto` and `X-Forwarded-Host`;
- refuses `/internal/`, which only the Document Server may call from the Compose network. The portal also serves a document there only to a Document Server download token for that document, since its published port can be reached without the proxy.

No authentication gate may sit in front of these sites: the editor's websockets and the token-authenticated OpenTDF calls would break.

## Start

```sh
cd deploy
docker compose up -d --build --wait
```

The OpenTDF platform stops at startup when it cannot fetch the provider's discovery document or keys; it restarts automatically until the provider is reachable.

Once OpenTDF and the policy service are healthy, the `opentdf-provisioning` job creates the KAS's hybrid key in OpenTDF's key registry, makes it the base key that new envelopes use, applies the attributes derived from each SPIF, then exits; running it again changes nothing. The job owns the subject mappings of these attributes: a mapping written by hand on one of their values is removed at its next run. It also owns the base key, which it sets back to its hybrid key at each run. When it fails, for instance because the provisioning client is not registered yet, `docker compose up --wait` reports it and exits with an error, while the rest of the stack keeps running: until provisioning succeeds, no portion can be encrypted, and OpenTDF refuses the key of those encrypted with the labels' attributes. Its reason is in `docker compose logs opentdf-provisioning`, and `docker compose up -d` runs it again.

## Checks

```sh
curl -fsS https://portail.<DOMAIN>/healthz          # {"status":"ok"}
curl -fsS https://docs.<DOMAIN>/healthcheck         # true
curl -fsS https://tdf.<DOMAIN>/healthz              # {"status":"SERVING"}
curl -fsS https://tdf.<DOMAIN>/.well-known/opentdf-configuration | jq -r .base_key.public_key.algorithm   # hpqt:secp384r1-mlkem1024
curl -s -o /dev/null -w '%{redirect_url}\n' -H 'Accept: text/html' https://portail.<DOMAIN>/   # https://portail.<DOMAIN>/auth/login?returnTo=%2F
```

`docker compose logs opentdf-provisioning` shows `KAS key provisioned`, then `Policy provisioned` for each policy.

The portal logs every change of a base label or a portion and every deletion of a portion made in the panel, with the person who made it, and every save that lowers a label or removes a portion: `docker compose logs portal | grep -E 'Base label|Portion'`.

Each save the portal stores has a signed binding. To check one, download the document, unzip it, and run `xmlsec1 --verify` on its binding part with the certificate, mapping each `pack:///` part that the signature's `Manifest` references to its file: `--id-attr:Id urn:nato:stanag:4778:bindinginformation:1:0:MetadataBinding --enabled-reference-uris same-doc,remote --url-map:pack:///word/document.xml word/document.xml`, and so on. The line `Manifests References (ok/all)` must show every part as matching; xmlsec1 1.3 and later print it with `--verbose` only. A signature that holds proves that the platform computed the document label from the labels in clear and bound it to those parts when it stored the file, not who wrote the content. The portal logs a document label it had to replace, with `Document label replaced at save`, and a binding it could not sign, which it stores unsigned. Whenever it serves a stored file, it also has the policy service check its signature, and logs a file that no longer matches it, with `Stored file no longer matches its signature`, or a labelled file that holds none, with `Stored file unsigned`.

Then sign in with an account of the provider, open a demo document and check that the labelling panel shows your name.
