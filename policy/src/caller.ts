import type { FastifyRequest } from 'fastify';

// The portal relay sends the caller's identity URI-encoded.
export function callerEmail(request: FastifyRequest): string | null {
  const header = request.headers['x-user-email'];
  const value = typeof header === 'string' ? decodeURIComponent(header) : '';
  return value === '' ? null : value;
}
