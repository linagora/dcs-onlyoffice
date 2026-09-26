export interface PortalConfig {
  domain: string;
  portalPublicUrl: string;
  docsPublicUrl: string;
  portalInternalUrl: string;
  onlyofficeInternalUrl: string;
  onlyofficeJwtSecret: string;
  documentsDirectory: string;
  templatesDirectory: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): PortalConfig {
  const domain = requireEnv(env, 'DOMAIN');
  return {
    domain,
    portalPublicUrl: `https://portail.${domain}`,
    docsPublicUrl: `https://docs.${domain}`,
    portalInternalUrl: env.PORTAL_INTERNAL_URL ?? 'http://portal:3000',
    onlyofficeInternalUrl: env.ONLYOFFICE_INTERNAL_URL ?? 'http://onlyoffice',
    onlyofficeJwtSecret: requireEnv(env, 'ONLYOFFICE_JWT_SECRET'),
    documentsDirectory: env.DOCUMENTS_DIR ?? '/data/documents',
    templatesDirectory: env.TEMPLATES_DIR ?? '/templates',
    port: Number(env.PORT ?? '3000'),
  };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
