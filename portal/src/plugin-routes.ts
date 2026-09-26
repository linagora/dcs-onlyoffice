import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fastifyStatic } from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { PortalConfig } from './config.ts';
import type { EditorPlugin } from './editor-config.ts';

// Serves the labelling plugin, and describes it for the editor configurations.
export function registerPluginRoutes(app: FastifyInstance, config: PortalConfig): EditorPlugin {
  // The editor derives the plugin's base URL by cutting "config.json" out of
  // this URL, so the read-only variant (EditorPlugin.viewConfigUrl) keeps the
  // same path and differs by its query.
  app.get<{ Querystring: { mode?: string } }>('/plugin/config.json', async (request, reply) =>
    reply
      .header('Access-Control-Allow-Origin', config.docsPublicUrl)
      .type('application/json; charset=utf-8')
      .send(request.query.mode === 'view' ? viewModeManifest(config) : readPluginManifest(config)),
  );
  // The editor, on the Document Server's origin, fetches the plugin
  // configuration with an XHR; the plugin page itself runs on this origin.
  app.register(fastifyStatic, {
    root: config.pluginDirectory,
    prefix: '/plugin/',
    decorateReply: false,
    setHeaders: (reply) => {
      reply.header('Access-Control-Allow-Origin', config.docsPublicUrl);
    },
  });
  return {
    guid: String(readPluginManifest(config).guid),
    configUrl: `${config.portalPublicUrl}/plugin/config.json`,
    viewConfigUrl: `${config.portalPublicUrl}/plugin/config.json?mode=view`,
  };
}

function readPluginManifest(config: PortalConfig): Record<string, unknown> {
  const manifest: unknown = JSON.parse(readFileSync(path.join(config.pluginDirectory, 'config.json'), 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || !('guid' in manifest) || typeof manifest.guid !== 'string') {
    throw new Error(`The plugin configuration in ${config.pluginDirectory} has no guid`);
  }
  return manifest as Record<string, unknown>; // SAFETY: object with a guid checked above
}

function viewModeManifest(config: PortalConfig): Record<string, unknown> {
  const manifest = readPluginManifest(config);
  const variations = Array.isArray(manifest.variations) ? manifest.variations : [];
  return {
    ...manifest,
    variations: variations.map((variation: unknown) =>
      typeof variation === 'object' && variation !== null ? { ...variation, type: 'panel' } : variation,
    ),
  };
}
