# Clearances live in a directory, in the security policy's terms

Each person's clearance (security policy, highest classification, categories held, validity period) is stored in a clearance directory owned by the policy service, in the vocabulary of the security policy, and OpenTDF's multi-strategy entity resolution reads it at every key request, finding the person by the email in the access token. A revocation then takes effect at the next key request, identities from the local identity provider and from a corporate SSO resolve the same way, and the SPIF stays the only vocabulary for both labels and clearances.

## Considered Options

- **Clearances inside the access token** (OpenTDF's stable claims mode): a corporate SSO cannot carry fictional clearances, and a revocation would wait for the token to expire, which can take hours with a corporate SSO.
- **Real-world facts plus rules** (nationality, then rules deriving categories such as SPECIAL FRANCE): closer to an existing personnel directory, but it needs a rules table beside each SPIF. It fits a later connector to such a directory.

## Consequences

- Multi-strategy entity resolution is a preview in OpenTDF 0.27: a time-boxed trial comes first, with the claims mode as the fallback for the standalone profile only.
- The policy service validates every clearance against the SPIF, and a test checks that OpenTDF's decision equals the SPIF access decision for every clearance and label of the demo.
