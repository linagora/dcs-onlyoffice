import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

// Whether the caller holds a secret it shares with the service, as a bearer
// token. Compared as digests, whose equal lengths let the comparison take
// constant time.
export function holdsSecret(request: FastifyRequest, secret: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(request.headers.authorization ?? ''), digest(`Bearer ${secret}`));
}
