# The OpenTDF attribute namespace is declared by the security policy

OpenTDF attributes are generated from the SPIF rather than written by hand: the classification becomes a hierarchy, each restrictive set of categories an all-of rule, each permissive set an any-of rule, and informative categories nothing. Their namespace is declared by the SPIF itself, in its extensions (the demo policy declares `demo-fr.dcs.linagora.com`), because attribute names are written in clear in every envelope and can never change once documents exist, and because the namespace belongs to the organisation that owns the policy, not to this project.

## Considered Options

- **One fixed namespace for the project**, with the policy name inside each attribute name: every organisation's envelopes would carry LINAGORA's namespace.
- **A namespace derived from the policy name**: a renamed policy would silently orphan every existing envelope.
