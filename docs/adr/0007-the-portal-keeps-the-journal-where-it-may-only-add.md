# The portal keeps the journal where it may only add entries

The journal lived in the portal's container log, which Docker keeps only as long as the container exists, and which administrators could not read in the portal. The portal, which writes every journal entry, now also stores each one in a `journal` schema of the stack's PostgreSQL database, through a role that may add and read entries but never change or delete them: the database setup job creates the schema, which the portal does not own. The portal keeps writing each entry to its log.

## Considered Options

- **The policy service keeps the journal**, since it already holds a connection to the database: it would become the journal's keeper as well as the authority on labels, and an entry would be lost whenever the portal could not reach it.
- **A file in the portal's documents volume**: nothing would stop the portal, or anyone who can write the volume, from rewriting it.

## Consequences

- The portal gets a connection to the database, which it did not have, with a role of its own.
- The journal is kept from the version that brings it: earlier entries stay in the container logs.
- A database administrator can still rewrite the journal; chaining the entries with signed checkpoints would show it.
