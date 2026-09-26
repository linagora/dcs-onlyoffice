import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { renderMessagePage } from '../pages.ts';
import type { OidcClient } from './oidc.ts';
import type { Session, SessionStore } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: Session | null;
  }
}

export interface AuthDependencies {
  oidc: OidcClient;
  sessions: SessionStore;
  portalPublicUrl: string;
}

interface LoginQuery {
  returnTo?: string;
}

interface CallbackQuery {
  state?: string;
  error?: string;
}

export const SESSION_COOKIE = 'dcs_session';

// The Document Server calls /internal from the Compose network; the proxy
// refuses these paths from outside. The editor fetches the plugin's files
// without credentials.
const PUBLIC_PATH_PREFIXES = ['/healthz', '/static/', '/plugin/', '/auth/', '/internal/'];

export function registerAuth(app: FastifyInstance, deps: AuthDependencies): FastifyInstance {
  app.decorateRequest('session', null);

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicPath(request.url)) {
      return;
    }
    const session = deps.sessions.findSession(request.cookies[SESSION_COOKIE]);
    if (session === null) {
      return rejectAnonymous(request, reply);
    }
    request.session = session;
  });

  app.get<{ Querystring: LoginQuery }>('/auth/login', async (request, reply) => {
    const authorization = await deps.oidc.startAuthorization();
    deps.sessions.savePendingSignIn({
      state: authorization.state,
      codeVerifier: authorization.codeVerifier,
      nonce: authorization.nonce,
      returnTo: safeReturnPath(request.query.returnTo),
    });
    return reply.redirect(authorization.url.href, 303);
  });

  app.get<{ Querystring: CallbackQuery }>('/auth/callback', async (request, reply) => {
    if (request.query.error !== undefined) {
      return reply
        .code(403)
        .type('text/html; charset=utf-8')
        .send(renderMessagePage('Sign-in refused', `The identity provider refused the sign-in (${request.query.error}).`));
    }
    const pending = request.query.state === undefined ? null : deps.sessions.takePendingSignIn(request.query.state);
    if (pending === null) {
      return reply
        .code(400)
        .type('text/html; charset=utf-8')
        .send(renderMessagePage('Sign-in expired', 'This sign-in attempt has expired or was already used.'));
    }
    const result = await deps.oidc.completeAuthorization(new URL(request.url, deps.portalPublicUrl), pending);
    const session = deps.sessions.createSession(result.user, result.tokens);
    request.log.info({ user: session.user.id }, 'Signed in');
    return reply
      .setCookie(SESSION_COOKIE, session.id, {
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        expires: new Date(session.expiresAt),
      })
      .redirect(pending.returnTo, 303);
  });

  app.post('/auth/logout', async (request, reply) => {
    const session = deps.sessions.findSession(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    if (session === null) {
      return reply.redirect('/', 303);
    }
    deps.sessions.deleteSession(session.id);
    request.log.info({ user: session.user.id }, 'Signed out');
    return reply.redirect((await deps.oidc.endSessionUrl(session.tokens.idToken)).href, 303);
  });

  return app;
}

// Protected routes run after the authentication hook, which guarantees a session.
export function requireSession(request: FastifyRequest): Session {
  if (request.session === null) {
    throw new Error(`No session on protected route ${request.url}`);
  }
  return request.session;
}

async function rejectAnonymous(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const wantsPage = request.method === 'GET' && (request.headers.accept ?? '').includes('text/html');
  if (wantsPage) {
    return reply.redirect(`/auth/login?returnTo=${encodeURIComponent(request.url)}`, 303);
  }
  return reply.code(401).send({ error: 'Authentication required' });
}

function isPublicPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? '';
  return PUBLIC_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

// Only same-origin paths are accepted, so the sign-in cannot redirect elsewhere.
function safeReturnPath(returnTo: string | undefined): string {
  if (returnTo === undefined || !returnTo.startsWith('/') || returnTo.startsWith('//') || returnTo.includes('\\')) {
    return '/';
  }
  return returnTo;
}
