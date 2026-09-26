import { randomBytes } from 'node:crypto';

export interface UserIdentity {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  groups: string[];
}

// Tokens never leave the portal: the browser only holds the session cookie.
// The ID token serves as the hint of RP-initiated logout.
export interface SessionTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: number | null;
}

export interface Session {
  id: string;
  user: UserIdentity;
  tokens: SessionTokens;
  expiresAt: number;
}

export interface PendingSignIn {
  state: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

const PENDING_SIGN_IN_LIFETIME_MS = 10 * 60 * 1000;

// Sessions and their tokens stay in the portal's memory: the browser only gets
// an opaque session id. A portal restart signs everyone out, which is fine for
// a demonstrator.
export class SessionStore {
  #sessions = new Map<string, Session>();
  #pendingSignIns = new Map<string, PendingSignIn>();
  #sessionLifetimeMs: number;

  constructor(sessionLifetimeMs: number) {
    this.#sessionLifetimeMs = sessionLifetimeMs;
  }

  createSession(user: UserIdentity, tokens: SessionTokens): Session {
    const session: Session = {
      id: randomBytes(32).toString('base64url'),
      user,
      tokens,
      expiresAt: Date.now() + this.#sessionLifetimeMs,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  findSession(id: string | undefined): Session | null {
    if (id === undefined) {
      return null;
    }
    const session = this.#sessions.get(id) ?? null;
    if (session !== null && session.expiresAt <= Date.now()) {
      this.#sessions.delete(id);
      return null;
    }
    return session;
  }

  deleteSession(id: string): boolean {
    return this.#sessions.delete(id);
  }

  savePendingSignIn(pending: Omit<PendingSignIn, 'expiresAt'>): PendingSignIn {
    this.#dropExpiredPendingSignIns();
    const saved: PendingSignIn = { ...pending, expiresAt: Date.now() + PENDING_SIGN_IN_LIFETIME_MS };
    this.#pendingSignIns.set(saved.state, saved);
    return saved;
  }

  // A pending sign-in is single use: taking it removes it.
  takePendingSignIn(state: string): PendingSignIn | null {
    const pending = this.#pendingSignIns.get(state) ?? null;
    this.#pendingSignIns.delete(state);
    if (pending === null || pending.expiresAt <= Date.now()) {
      return null;
    }
    return pending;
  }

  #dropExpiredPendingSignIns(): number {
    const now = Date.now();
    let dropped = 0;
    for (const [state, pending] of this.#pendingSignIns) {
      if (pending.expiresAt <= now) {
        this.#pendingSignIns.delete(state);
        dropped += 1;
      }
    }
    return dropped;
  }
}
