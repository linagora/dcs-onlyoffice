import { PostgresClearanceStore } from './directory/store.ts';
import { isRollupRule, ROLLUP_RULES } from './rollup.ts';
import { buildPolicyServer, type PolicyServerOptions } from './server.ts';

const rollupRule = process.env.ROLLUP_RULE ?? 'clear-parts';
if (!isRollupRule(rollupRule)) {
  throw new Error(`ROLLUP_RULE must be one of ${ROLLUP_RULES.join(', ')}`);
}

const options: PolicyServerOptions = {
  spifDirectory: process.env.SPIF_DIR ?? '/spif',
  rollupRule,
  markingLanguage: process.env.MARKING_LANGUAGE ?? 'fr',
  logger: true,
};
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

const server = await buildPolicyServer(options);
await server.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '3001') });
