import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.ts';
import type { UserIdentity } from './auth/sessions.ts';

const RELAY_PREFIX = '/api/policy';

// The policy service is only reachable from the Compose network. The relay
// forwards the plugin's calls and tells the service who is asking.
export function registerPolicyRelay(app: FastifyInstance, policyInternalUrl: string): FastifyInstance {
  app.route({
    method: ['GET', 'POST'],
    url: `${RELAY_PREFIX}/*`,
    handler: async (request, reply) => {
      const { user } = requireSession(request);
      const target = new URL(request.url.slice(RELAY_PREFIX.length), policyInternalUrl);
      const response = await fetch(target, {
        method: request.method,
        headers: { 'Content-Type': 'application/json', ...identityHeaders(user) },
        body: request.method === 'GET' ? null : JSON.stringify(request.body ?? {}),
      });
      return reply
        .code(response.status)
        .type(response.headers.get('content-type') ?? 'application/json')
        .send(Buffer.from(await response.arrayBuffer()));
    },
  });
  return app;
}

// Header values must stay ASCII, so free-text fields are URI-encoded.
function identityHeaders(user: UserIdentity): Record<string, string> {
  return {
    'X-User-Id': encodeURIComponent(user.id),
    'X-User-Name': encodeURIComponent(user.name),
    'X-User-Email': encodeURIComponent(user.email ?? ''),
    'X-User-Groups': user.groups.map(encodeURIComponent).join(','),
  };
}
