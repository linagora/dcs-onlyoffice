import type { FastifyReply } from 'fastify';
import { renderMessagePage } from './pages.ts';

// A page reserved to administrators must not be framed: a sibling host could
// lure an administrator into clicking on it.
export const NO_FRAMING = "frame-ancestors 'none'";

// The answer to anyone else, the same for every page reserved to
// administrators.
export function forbidden(reply: FastifyReply): FastifyReply {
  return reply
    .code(403)
    .header('Content-Security-Policy', NO_FRAMING)
    .type('text/html; charset=utf-8')
    .send(renderMessagePage('Forbidden', 'This page is reserved to administrators.'));
}
