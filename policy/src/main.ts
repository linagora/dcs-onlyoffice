import { buildPolicyServer } from './server.ts';

const server = await buildPolicyServer({
  spifDirectory: process.env.SPIF_DIR ?? '/spif',
  markingLanguage: process.env.MARKING_LANGUAGE ?? 'fr',
  logger: true,
});
await server.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '3001') });
