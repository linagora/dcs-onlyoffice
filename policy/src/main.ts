import { isRollupRule, ROLLUP_RULES } from './rollup.ts';
import { buildPolicyServer } from './server.ts';

const rollupRule = process.env.ROLLUP_RULE ?? 'clear-parts';
if (!isRollupRule(rollupRule)) {
  throw new Error(`ROLLUP_RULE must be one of ${ROLLUP_RULES.join(', ')}`);
}

const server = await buildPolicyServer({
  spifDirectory: process.env.SPIF_DIR ?? '/spif',
  rollupRule,
  markingLanguage: process.env.MARKING_LANGUAGE ?? 'fr',
  logger: true,
});
await server.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '3001') });
