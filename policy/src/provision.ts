import { applyOpentdfState } from './provisioning/apply.ts';
import { field, fetchJson } from './provisioning/json.ts';
import { applyKasKey } from './provisioning/kas-key.ts';
import { OpentdfPlatform } from './provisioning/platform.ts';
import { opentdfStateOf, policyNames } from './provisioning/policy-service.ts';

// One-shot job: makes a hybrid post-quantum key the KAS's base key, then
// applies to OpenTDF the state the policy service derives from each SPIF
// (ADR 0003), with a client of the IdP that OpenTDF makes an administrator. It
// runs once OpenTDF and the policy service are healthy, and running it again
// changes nothing.

// Named by every envelope whose key it wraps.
const KAS_KEY_ID = 'hybrid-1';

interface Settings {
  policyUrl: string;
  opentdfUrl: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  kasUri: string;
  kasRootKey: Uint8Array;
}

function readSettings(env: NodeJS.ProcessEnv): Settings {
  const required = (name: string): string => {
    const value = env[name] ?? '';
    if (value === '') {
      throw new Error(`${name} is not set`);
    }
    return value;
  };
  const kasRootKey = required('KAS_ROOT_KEY');
  if (!/^[0-9a-f]{64}$/i.test(kasRootKey)) {
    throw new Error('KAS_ROOT_KEY is not 32 bytes in hex');
  }
  return {
    policyUrl: env.POLICY_URL ?? 'http://policy:3001',
    opentdfUrl: env.OPENTDF_URL ?? 'http://opentdf:8080',
    issuer: required('OIDC_ISSUER'),
    clientId: required('PROVISIONER_CLIENT_ID'),
    clientSecret: required('PROVISIONER_CLIENT_SECRET'),
    kasUri: required('KAS_URI'),
    kasRootKey: Buffer.from(kasRootKey, 'hex'),
  };
}

// Job output, one JSON line per event, like the services' logs.
function report(level: 'info' | 'error', msg: string, details: Record<string, unknown> = {}): void {
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify({ level, time: Date.now(), msg, ...details })}\n`);
}

// The client credentials grant, at the token endpoint of the issuer's
// discovery document. RFC 6749 section 2.3.1 URL-encodes the credentials, and
// LemonLDAP::NG refuses the grant without a scope.
async function clientCredentialsToken(settings: Settings): Promise<string> {
  const base = settings.issuer.endsWith('/') ? settings.issuer : `${settings.issuer}/`;
  const discovery = await fetchJson(new URL('.well-known/openid-configuration', base));
  const tokenEndpoint = field(discovery.body, 'token_endpoint');
  if (typeof tokenEndpoint !== 'string') {
    throw new Error(`the discovery document of ${settings.issuer} names no token endpoint`);
  }
  const credentials = `${encodeURIComponent(settings.clientId)}:${encodeURIComponent(settings.clientSecret)}`;
  const answer = await fetchJson(tokenEndpoint, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'openid' }),
  });
  const token = field(answer.body, 'access_token');
  if (answer.status !== 200 || typeof token !== 'string') {
    throw new Error(`the IdP refused a token to ${settings.clientId} (${answer.status} ${String(field(answer.body, 'error'))})`);
  }
  return token;
}

async function provision(settings: Settings): Promise<boolean> {
  const platform = new OpentdfPlatform(settings.opentdfUrl, await clientCredentialsToken(settings));
  const kasKey = { kasUri: settings.kasUri, keyId: KAS_KEY_ID, rootKey: settings.kasRootKey };
  report('info', 'KAS key provisioned', { kasUri: kasKey.kasUri, keyId: kasKey.keyId, changes: await applyKasKey(platform, kasKey) });
  let provisioned = true;
  for (const policy of await policyNames(settings.policyUrl)) {
    const derived = await opentdfStateOf(settings.policyUrl, policy);
    if (!derived.ok) {
      report('error', 'Policy not provisioned', { policy, reason: derived.error });
      provisioned = false;
      continue;
    }
    const changes = await applyOpentdfState(platform, derived.state);
    report('info', 'Policy provisioned', { policy, namespace: derived.state.namespace, changes });
  }
  return provisioned;
}

try {
  process.exitCode = (await provision(readSettings(process.env))) ? 0 : 1;
} catch (error: unknown) {
  report('error', 'Provisioning failed', { reason: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
