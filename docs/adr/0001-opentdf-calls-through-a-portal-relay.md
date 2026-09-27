# The plugin reaches OpenTDF through a portal relay

The labelling plugin runs in the browser, but the portal keeps every access token on the server. The plugin's OpenTDF calls that need a token (key rewrap and the policy lookups the SDK makes) therefore go to a relay on the portal, which adds the Bearer token it holds and forwards only an allowlist of those calls; envelopes keep the canonical KAS address, and the SDK rewrites it to the relay. Without DPoP, OpenTDF lets whoever holds a token obtain keys, so a token handed to the page would be worth stealing.

## Considered Options

- **Hand the plugin a token**, as first planned: simpler, but any script in the editor page could take the token and request keys with it.
- **A DPoP-bound token**: the identity provider must bind tokens to a browser key, and the page still receives a token. Worth reconsidering for production.

## Consequences

- The portal refreshes the tokens it holds.
- The relay only sees keys rewrapped for the browser's ephemeral key pair, never portion text.
- Fetching the KAS public key needs no token and goes straight to OpenTDF, which already allows the portal's origin.
