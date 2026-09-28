import type { FastifyRequest } from 'fastify';

// The portal relay sends the caller's identity URI-encoded.
export function callerEmail(request: FastifyRequest): string | null {
  const header = request.headers['x-user-email'];
  const value = typeof header === 'string' ? decodeURIComponent(header) : '';
  return value === '' ? null : value;
}

// The group of administrators registered at the IdP, which the portal and
// OpenTDF's authorization also name.
const ADMINISTRATORS = 'dcs-maquette-admin';

// The relay sends the caller's groups URI-encoded, separated by commas.
export function callerIsAdministrator(request: FastifyRequest): boolean {
  const header = request.headers['x-user-groups'];
  const groups = typeof header === 'string' && header !== '' ? header.split(',').map(decodeURIComponent) : [];
  return groups.includes(ADMINISTRATORS);
}

export interface CallerIdentity {
  id: string;
  name: string;
}

// The caller's user id and display name, which the relay sends URI-encoded;
// null without an id.
export function callerIdentity(request: FastifyRequest): CallerIdentity | null {
  const id = request.headers['x-user-id'];
  const name = request.headers['x-user-name'];
  const decodedId = typeof id === 'string' ? decodeURIComponent(id) : '';
  if (decodedId === '') {
    return null;
  }
  return { id: decodedId, name: typeof name === 'string' && name !== '' ? decodeURIComponent(name) : decodedId };
}
