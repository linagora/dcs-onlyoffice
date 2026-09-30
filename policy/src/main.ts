import { PostgresClearanceStore } from './directory/store.ts';
import { isRollupRule, ROLLUP_RULES } from './rollup.ts';
import { buildPolicyServer, type PolicyServerOptions } from './server.ts';

const rollupRule = process.env.ROLLUP_RULE ?? 'clear-parts';
if (!isRollupRule(rollupRule)) {
  throw new Error(`ROLLUP_RULE must be one of ${ROLLUP_RULES.join(', ')}`);
}

const portionLockLeaseSeconds = Number(process.env.PORTION_LOCK_LEASE_SECONDS ?? '300');
if (!Number.isInteger(portionLockLeaseSeconds) || portionLockLeaseSeconds <= 0) {
  throw new Error('PORTION_LOCK_LEASE_SECONDS must be a positive number of seconds');
}

const options: PolicyServerOptions = {
  spifDirectory: process.env.SPIF_DIR ?? '/spif',
  rollupRule,
  markingLanguage: process.env.MARKING_LANGUAGE ?? 'fr',
  portionLockLeaseMs: portionLockLeaseSeconds * 1000,
  logger: true,
};
// Without a label mapping, stored documents get no sensitivity label.
const labelMappingFile = process.env.LABEL_MAPPING_FILE ?? '';
if (labelMappingFile !== '') {
  options.labelMappingFile = labelMappingFile;
}
// Without a database, the service runs without a clearance directory.
const directoryHost = process.env.DIRECTORY_DB_HOST ?? '';
if (directoryHost !== '') {
  options.clearanceDirectory = {
    store: new PostgresClearanceStore({
      host: directoryHost,
      port: Number(process.env.DIRECTORY_DB_PORT ?? '5432'),
      database: process.env.DIRECTORY_DB_NAME ?? 'opentdf',
      user: process.env.DIRECTORY_DB_USER ?? 'dcs_directory',
      password: process.env.DIRECTORY_DB_PASSWORD ?? '',
    }),
    seedFolder: process.env.DIRECTORY_SEED_DIR ?? null,
  };
  // Without the secret it shares with the portal, nobody administers the directory.
  const administrationSecret = process.env.DIRECTORY_ADMINISTRATION_SECRET ?? '';
  if (administrationSecret !== '') {
    options.directoryAdministrationSecret = administrationSecret;
  }
}

// Without its key, its certificate and the secret it shares with the portal,
// the service signs no binding. The key, the certificate, the certificates of
// the authorities trusted to issue signing certificates and their revocation
// lists are base64-encoded PEM, which keeps each on one line of deploy/.env;
// the last two may hold several. Without authorities, the signing
// certificate alone is trusted.
const signingKey = process.env.BINDING_SIGNING_KEY ?? '';
const signingCertificate = process.env.BINDING_SIGNING_CERTIFICATE ?? '';
const signatureSecret = process.env.BINDING_SIGNATURE_SECRET ?? '';
if (signingKey !== '' && signingCertificate !== '' && signatureSecret !== '') {
  options.bindingSignature = {
    secret: signatureSecret,
    signer: { privateKey: decodedPem(signingKey), certificate: decodedPem(signingCertificate) },
    trustAnchors: decodedPem(process.env.BINDING_TRUST_ANCHORS ?? ''),
    revocationLists: decodedPem(process.env.BINDING_REVOCATION_LISTS ?? ''),
  };
}

function decodedPem(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

const server = await buildPolicyServer(options);
await server.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '3001') });
