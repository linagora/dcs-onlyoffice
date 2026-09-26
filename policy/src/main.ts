import { ROLLUP_RULES, type RollupRule } from './rollup.ts';
import { buildPolicyServer } from './server.ts';

const rollupRule = process.env.ROLLUP_RULE ?? 'clear-parts';
if (!(ROLLUP_RULES as readonly string[]).includes(rollupRule)) {
  throw new Error(`ROLLUP_RULE must be one of ${ROLLUP_RULES.join(', ')}`);
}

const server = await buildPolicyServer({
  spifDirectory: process.env.SPIF_DIR ?? '/spif',
  rollupRule: rollupRule as RollupRule, // SAFETY: membership checked above
  markingLanguage: process.env.MARKING_LANGUAGE ?? 'fr',
  logger: true,
});
await server.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? '3001') });
