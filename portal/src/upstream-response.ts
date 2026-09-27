import type { FastifyReply } from 'fastify';

// Hands a relayed service's answer back to the browser: its status, content
// type and body, and none of its other headers.
export async function sendUpstreamResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  return reply
    .code(response.status)
    .type(response.headers.get('content-type') ?? 'application/json')
    .send(Buffer.from(await response.arrayBuffer()));
}
