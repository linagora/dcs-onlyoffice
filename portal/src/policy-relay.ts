import type { FastifyInstance } from 'fastify';
import { requireSession } from './auth/routes.ts';
import type { UserIdentity } from './auth/sessions.ts';
import { sendUpstreamResponse } from './upstream-response.ts';

const RELAY_PREFIX = '/api/policy';

// The policy service is only reachable from the Compose network. The relay
// forwards the plugin's calls and tells the service who is asking.
export function registerPolicyRelay(app: FastifyInstance, policyInternalUrl: string): FastifyInstance {
  app.route({
    method: ['GET', 'POST'],
    url: `${RELAY_PREFIX}/*`,
    handler: async (request, reply) => {
      const { user } = requireSession(request);
      const target = policyServiceUrl(request.url.slice(RELAY_PREFIX.length), policyInternalUrl);
      if (target === null) {
        return reply.code(400).send({ error: 'Invalid policy path' });
      }
      const response = await fetch(target, {
        method: request.method,
        headers: { 'Content-Type': 'application/json', ...identityHeaders(user) },
        body: request.method === 'GET' ? null : JSON.stringify(request.body ?? {}),
      });
      return sendUpstreamResponse(reply, response);
    },
  });
  return app;
}

// The relayed path must stay a path of the policy service: a suffix starting
// with "//" (or a backslash, which URLs read as a slash) would otherwise name
// another host.
function policyServiceUrl(suffix: string, policyInternalUrl: string): URL | null {
  const base = new URL(policyInternalUrl);
  const target = new URL(suffix.replace(/^[/\\]+/, '/'), base);
  return target.origin === base.origin ? target : null;
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
