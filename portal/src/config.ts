import path from 'node:path';
import type { OidcSettings } from './auth/oidc.ts';
import { EDITOR_LANGUAGES, type EditorLanguage, isEditorLanguage } from './editor-config.ts';
import type { JournalDatabaseSettings } from './journal.ts';

export interface PortalConfig {
  domain: string;
  portalPublicUrl: string;
  docsPublicUrl: string;
  opentdfPublicUrl: string;
  portalInternalUrl: string;
  onlyofficeInternalUrl: string;
  policyInternalUrl: string;
  opentdfInternalUrl: string;
  onlyofficeJwtSecret: string;
  // Shared with the policy service: only the portal administers the
  // clearance directory.
  directoryAdministrationSecret: string;
  // Held to have the policy service sign the bindings of saves.
  bindingSignatureSecret: string;
  // Language editors open in, unless a document's address asks for another.
  editorLanguage: EditorLanguage;
  documentsDirectory: string;
  templatesDirectory: string;
  pluginDirectory: string;
  port: number;
  oidc: OidcSettings;
  // Where the journal is kept, with the role that may only add entries and
  // read them.
  journalDatabase: JournalDatabaseSettings;
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
    opentdfPublicUrl: `https://tdf.${domain}`,
    portalInternalUrl: env.PORTAL_INTERNAL_URL ?? 'http://portal:3000',
    onlyofficeInternalUrl: env.ONLYOFFICE_INTERNAL_URL ?? 'http://onlyoffice',
    policyInternalUrl: env.POLICY_INTERNAL_URL ?? 'http://policy:3001',
    opentdfInternalUrl: env.OPENTDF_INTERNAL_URL ?? 'http://opentdf:8080',
    onlyofficeJwtSecret: requireEnv(env, 'ONLYOFFICE_JWT_SECRET'),
    directoryAdministrationSecret: requireEnv(env, 'DIRECTORY_ADMINISTRATION_SECRET'),
    bindingSignatureSecret: requireEnv(env, 'BINDING_SIGNATURE_SECRET'),
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
    journalDatabase: {
      host: env.JOURNAL_DB_HOST ?? 'postgres',
      port: Number(env.JOURNAL_DB_PORT ?? '5432'),
      database: env.JOURNAL_DB_NAME ?? 'opentdf',
      user: env.JOURNAL_DB_USER ?? 'dcs_journal',
      password: requireEnv(env, 'JOURNAL_DB_PASSWORD'),
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
