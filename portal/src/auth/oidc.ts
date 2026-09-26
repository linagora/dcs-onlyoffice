import * as client from 'openid-client';
import type { SessionTokens, UserIdentity } from './sessions.ts';

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
}

export interface AuthorizationRequest {
  url: URL;
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface AuthorizationChecks {
  state: string;
  codeVerifier: string;
  nonce: string;
}

export interface SignInResult {
  user: UserIdentity;
  tokens: SessionTokens;
}

export class OidcClient {
  #settings: OidcSettings;
  #configuration: Promise<client.Configuration> | null = null;

  constructor(settings: OidcSettings) {
    this.#settings = settings;
  }

  async startAuthorization(): Promise<AuthorizationRequest> {
    const configuration = await this.#getConfiguration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.#settings.redirectUri,
      scope: this.#settings.scopes,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url, state, codeVerifier, nonce };
  }

  async completeAuthorization(callbackUrl: URL, checks: AuthorizationChecks): Promise<SignInResult> {
    const configuration = await this.#getConfiguration();
    const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const idClaims = tokens.claims();
    if (idClaims === undefined) {
      throw new Error('The IdP returned no ID token');
    }
    const userInfo = await client.fetchUserInfo(configuration, tokens.access_token, idClaims.sub);
    const claims: Record<string, unknown> = { ...idClaims, ...userInfo };
    return {
      user: toUserIdentity(idClaims.sub, claims),
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        idToken: tokens.id_token ?? null,
        accessTokenExpiresAt: tokens.expires_in === undefined ? null : Date.now() + tokens.expires_in * 1000,
      },
    };
  }

  // Online refresh tokens die with the IdP session: a failure means the user
  // has to sign in again.
  async refresh(tokens: SessionTokens): Promise<SessionTokens | null> {
    if (tokens.refreshToken === null) {
      return null;
    }
    const configuration = await this.#getConfiguration();
    try {
      const refreshed = await client.refreshTokenGrant(configuration, tokens.refreshToken);
      return {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
        idToken: refreshed.id_token ?? tokens.idToken,
        accessTokenExpiresAt: refreshed.expires_in === undefined ? null : Date.now() + refreshed.expires_in * 1000,
      };
    } catch (error: unknown) {
      if (error instanceof client.ResponseBodyError) {
        return null;
      }
      throw error;
    }
  }

  async endSessionUrl(idToken: string | null): Promise<URL> {
    const configuration = await this.#getConfiguration();
    const parameters: Record<string, string> = { post_logout_redirect_uri: this.#settings.postLogoutRedirectUri };
    if (idToken !== null) {
      parameters.id_token_hint = idToken;
    }
    return client.buildEndSessionUrl(configuration, parameters);
  }

  // Discovery happens on first use and is retried after a failure, so the
  // portal can start before the IdP is reachable.
  async #getConfiguration(): Promise<client.Configuration> {
    if (this.#configuration === null) {
      const discovery = client.discovery(
        new URL(this.#settings.issuer),
        this.#settings.clientId,
        undefined,
        client.ClientSecretBasic(this.#settings.clientSecret),
      );
      discovery.catch(() => {
        this.#configuration = null;
      });
      this.#configuration = discovery;
    }
    return this.#configuration;
  }
}

function toUserIdentity(subject: string, claims: Record<string, unknown>): UserIdentity {
  const username = stringClaim(claims, 'preferred_username');
  const email = stringClaim(claims, 'email');
  return {
    id: subject,
    name: stringClaim(claims, 'name') ?? username ?? email ?? subject,
    email,
    username,
    groups: groupsClaim(claims.groups),
  };
}

// The local IdP releases groups as a JSON array; some LemonLDAP::NG setups
// release a string holding that array, or a separated list.
function groupsClaim(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((group): group is string => typeof group === 'string' && group !== '');
  }
  if (typeof value !== 'string') {
    return [];
  }
  const text = value.trim();
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      return groupsClaim(Array.isArray(parsed) ? parsed : []);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return [];
      }
      throw error;
    }
  }
  return text.split(/[;,]\s*/).filter((group) => group !== '');
}

function stringClaim(claims: Record<string, unknown>, name: string): string | null {
  const value = claims[name];
  return typeof value === 'string' && value !== '' ? value : null;
}
