import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';

const config = loadConfig(process.env);
const server = buildServer(config);
await server.listen({ host: '0.0.0.0', port: config.port });
