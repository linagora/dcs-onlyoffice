import path from 'node:path';
import type { OidcSettings } from './auth/oidc.ts';
import { EDITOR_LANGUAGES, type EditorLanguage, isEditorLanguage } from './editor-config.ts';

export interface PortalConfig {
  domain: string;
  portalPublicUrl: string;
  docsPublicUrl: string;
  portalInternalUrl: string;
  onlyofficeInternalUrl: string;
  policyInternalUrl: string;
  onlyofficeJwtSecret: string;
  // Language editors open in, unless a document's address asks for another.
  editorLanguage: EditorLanguage;
  documentsDirectory: string;
  templatesDirectory: string;
  pluginDirectory: string;
  port: number;
  oidc: OidcSettings;
}

export function loadConfig(env: NodeJS.ProcessEnv): PortalConfig {
  const domain = requireEnv(env, 'DOMAIN');
  // Public host names are part of the deployment, not identifiers: the
  // portal's is registered at the IdP as the redirect URI's host.
  const portalPublicUrl = `https://portail.${domain}`;
  return {
    domain,
    portalPublicUrl,
    docsPublicUrl: `https://docs.${domain}`,
    portalInternalUrl: env.PORTAL_INTERNAL_URL ?? 'http://portal:3000',
    onlyofficeInternalUrl: env.ONLYOFFICE_INTERNAL_URL ?? 'http://onlyoffice',
    policyInternalUrl: env.POLICY_INTERNAL_URL ?? 'http://policy:3001',
    onlyofficeJwtSecret: requireEnv(env, 'ONLYOFFICE_JWT_SECRET'),
    editorLanguage: readEditorLanguage(env),
    documentsDirectory: env.DOCUMENTS_DIR ?? '/data/documents',
    templatesDirectory: env.TEMPLATES_DIR ?? '/templates',
    pluginDirectory: env.PLUGIN_DIR ?? path.join(import.meta.dirname, '..', 'plugin-dist'),
    port: Number(env.PORT ?? '3000'),
    oidc: {
      issuer: requireEnv(env, 'OIDC_ISSUER'),
      clientId: requireEnv(env, 'OIDC_CLIENT_ID'),
      clientSecret: requireEnv(env, 'OIDC_CLIENT_SECRET'),
      scopes: env.OIDC_SCOPES ?? 'openid profile email',
      redirectUri: `${portalPublicUrl}/auth/callback`,
      postLogoutRedirectUri: `${portalPublicUrl}/`,
    },
  };
}

function readEditorLanguage(env: NodeJS.ProcessEnv): EditorLanguage {
  const language = env.EDITOR_LANGUAGE ?? 'en';
  if (!isEditorLanguage(language)) {
    throw new Error(`EDITOR_LANGUAGE must be one of ${EDITOR_LANGUAGES.join(', ')}`);
  }
  return language;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
