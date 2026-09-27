import type { IncomingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AccessTokens } from './auth/access-tokens.ts';
import { requireSession } from './auth/routes.ts';
import { sendUpstreamResponse } from './upstream-response.ts';

const RELAY_PREFIX = '/api/opentdf/';

// The OpenTDF calls that the web SDK makes with the person's token. The calls
// that need none, the well-known configuration and the KAS public key, go
// straight to OpenTDF (ADR 0001).
const RELAYED_METHODS: ReadonlySet<string> = new Set([
  'kas.AccessService/Rewrap',
  'policy.kasregistry.KeyAccessServerRegistryService/ListKeyAccessServers',
  'policy.attributes.AttributesService/GetKeyMappingsByFqns',
  'policy.attributes.AttributesService/GetAttributeValuesByFqns',
]);

// Connect headers that OpenTDF reads besides the token.
const FORWARDED_HEADERS = ['connect-protocol-version', 'connect-timeout-ms', 'x-rewrap-additional-context'];

export interface OpentdfRelayDeps {
  opentdfInternalUrl: string;
  accessTokens: AccessTokens;
}

interface RelayParams {
  '*': string;
}

// Forwards the plugin's OpenTDF calls with the access token the portal keeps,
// so that no token ever reaches the browser. A token the browser sends is
// dropped.
export function registerOpentdfRelay(app: FastifyInstance, deps: OpentdfRelayDeps): FastifyInstance {
  app.post<{ Params: RelayParams }>(`${RELAY_PREFIX}*`, async (request, reply) => {
    const session = requireSession(request);
    const method = request.params['*'];
    if (!RELAYED_METHODS.has(method)) {
      return reply.code(404).send({ error: 'Not a relayed OpenTDF call' });
    }
    if (!isConnectJson(request.headers)) {
      return reply.code(415).send({ error: 'Only JSON Connect requests are relayed' });
    }
    const accessToken = await deps.accessTokens.forSession(session, request.log);
    if (accessToken === null) {
      return reply.code(401).send({ error: 'The session has ended' });
    }
    let response: Response;
    try {
      response = await fetch(`${deps.opentdfInternalUrl}/${method}`, {
        method: 'POST',
        headers: { ...forwardedHeaders(request.headers), 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(request.body),
      });
    } catch (error: unknown) {
      request.log.error({ err: error, method }, 'OpenTDF is unreachable');
      return reply.code(502).send({ error: 'OpenTDF is unreachable' });
    }
    return sendUpstreamResponse(reply, response);
  });
  return app;
}

// Also what keeps other sites from using the relay: the session cookie is
// SameSite=Lax, so it also comes with requests from the stack's other host
// names, but no form can send JSON with the Connect protocol header, and a
// script needs a CORS preflight, which the portal never grants.
function isConnectJson(headers: IncomingHttpHeaders): boolean {
  return headers['content-type']?.split(';', 1)[0]?.trim() === 'application/json' && headers['connect-protocol-version'] === '1';
}

function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string') {
      forwarded[name] = value;
    }
  }
  return forwarded;
}
