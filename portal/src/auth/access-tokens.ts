import type { FastifyBaseLogger } from 'fastify';
import type { OidcClient } from './oidc.ts';
import type { Session, SessionStore, SessionTokens } from './sessions.ts';

// Refreshed this long before it expires, so that a token never expires on its
// way to OpenTDF.
const REFRESH_MARGIN_MS = 30_000;

// Hands out each session's access token, refreshed shortly before it expires.
// Concurrent callers share one refresh, since the IdP may accept each refresh
// token only once.
export class AccessTokens {
  #oidc: OidcClient;
  #sessions: SessionStore;
  #refreshing = new Map<string, Promise<string | null>>();

  constructor(oidc: OidcClient, sessions: SessionStore) {
    this.#oidc = oidc;
    this.#sessions = sessions;
  }

  // The session's valid access token, or null once the session has ended
  // because its token could not be refreshed.
  async forSession(session: Session, log: FastifyBaseLogger): Promise<string | null> {
    const expiresAt = session.tokens.accessTokenExpiresAt;
    if (expiresAt === null || expiresAt - Date.now() > REFRESH_MARGIN_MS) {
      return session.tokens.accessToken;
    }
    let refresh = this.#refreshing.get(session.id) ?? null;
    if (refresh === null) {
      refresh = this.#refresh(session, log);
      this.#refreshing.set(session.id, refresh);
    }
    try {
      return await refresh;
    } finally {
      if (this.#refreshing.get(session.id) === refresh) {
        this.#refreshing.delete(session.id);
      }
    }
  }

  // A token that cannot be refreshed ends the session: the person signs in
  // again. A session that ended during the refresh, by signing out, stays
  // ended.
  async #refresh(session: Session, log: FastifyBaseLogger): Promise<string | null> {
    const tokens = await this.#refreshedTokens(session, log);
    if (tokens === null) {
      this.#sessions.deleteSession(session.id);
      return null;
    }
    return this.#sessions.replaceTokens(session.id, tokens) === null ? null : tokens.accessToken;
  }

  async #refreshedTokens(session: Session, log: FastifyBaseLogger): Promise<SessionTokens | null> {
    const { refreshToken, idToken } = session.tokens;
    if (refreshToken === null) {
      log.warn({ user: session.user.id }, 'The session has no refresh token and ends');
      return null;
    }
    try {
      return await this.#oidc.refreshTokens(refreshToken, idToken);
    } catch (error: unknown) {
      log.warn({ err: error, user: session.user.id }, 'Refreshing the access token failed; the session ends');
      return null;
    }
  }
}
