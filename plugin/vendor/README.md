# OpenTDF web SDK with hybrid key wrapping

`opentdf-sdk-0.21.0-hybrid.1.tgz` is `@opentdf/sdk` 0.21.0 with hybrid
post-quantum key wrapping added: envelopes whose KAS key is
`hpqt:secp384r1-mlkem1024` (or `hpqt:secp256r1-mlkem768`) get a
`hybrid-wrapped` key access object, as the OpenTDF platform expects. No
release of the SDK supports these keys yet (opentdf/web-sdk#1048); the change
is proposed upstream in opentdf/web-sdk#1049.

It is built from commit `9d07346b24a87bf3e400ed95dac108a8d850bd7d` of
`mmaudet/web-sdk`, branch `feat/hybrid-key-wrapping-0.21`: release
`sdk-v0.21.0`, the hybrid commit of the upstream pull request, and a version
bump. To rebuild it, with Node.js 24:

```sh
git clone https://github.com/mmaudet/web-sdk.git && cd web-sdk
git checkout 9d07346b24a87bf3e400ed95dac108a8d850bd7d
cd lib && npm ci && npm pack
```

The rebuilt package is identical to this one, whose SHA-256 is
`5a10257a9ecded039fc56da9e0b90f067fc8cadc229c6d0f731ff355ba70d7b6`.

The OpenTDF web SDK is licensed under the BSD 3-Clause Clear license, whose
text is in [`LICENSE`](LICENSE): the package itself does not carry it.
Replace this package with the released SDK once it supports hybrid keys.
