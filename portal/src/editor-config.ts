import type { PortalConfig } from './config.ts';
import type { StoredDocument } from './documents.ts';
import { signOnlyofficeToken } from './onlyoffice.ts';

export interface EditorUser {
  id: string;
  name: string;
}

export interface EditorConfig {
  document: {
    fileType: 'docx';
    key: string;
    title: string;
    url: string;
    permissions: { edit: boolean; download: boolean };
  };
  documentType: 'word';
  editorConfig: {
    callbackUrl: string;
    lang: EditorLanguage;
    mode: 'edit' | 'view';
    user: EditorUser;
    coEditing: { mode: 'fast'; change: boolean };
    plugins: { autostart: string[]; pluginsData: string[]; options: Record<string, PluginOptions> };
  };
}

// What the labelling plugin reads from the editor: the OpenTDF platform whose
// KAS address goes into every envelope, and the stored document, whose base
// label changes it reports to the portal.
export interface PluginOptions {
  opentdfUrl: string;
  documentId: string;
}

export interface EditorPlugin {
  guid: string;
  configUrl: string;
  // ONLYOFFICE 9.4 crashes when it adds a right-panel plugin to the viewer,
  // whose right menu does not exist; read-only sessions load a left panel.
  viewConfigUrl: string;
}

export interface SignedEditorConfig extends EditorConfig {
  token: string;
}

export type EditorMode = 'edit' | 'view';

// Languages the labelling plugin speaks (plugin/src/messages.ts); the editor
// itself knows more.
export type EditorLanguage = 'en' | 'fr';

export const EDITOR_LANGUAGES: readonly EditorLanguage[] = ['en', 'fr'];

export function isEditorLanguage(value: unknown): value is EditorLanguage {
  const languages: readonly unknown[] = EDITOR_LANGUAGES;
  return languages.includes(value);
}

// The routes the Document Server calls, on the Compose network: the reverse
// proxy refuses /internal/.
export const INTERNAL_DOCUMENTS_PATH = '/internal/documents';

export function internalDocumentUrl(config: PortalConfig, documentId: string, route: 'content' | 'callback'): string {
  return `${config.portalInternalUrl}${INTERNAL_DOCUMENTS_PATH}/${documentId}/${route}`;
}

export function buildEditorConfig(
  document: StoredDocument,
  user: EditorUser,
  plugin: EditorPlugin,
  mode: EditorMode,
  language: EditorLanguage,
  config: PortalConfig,
): EditorConfig {
  return {
    document: {
      fileType: 'docx',
      key: document.key,
      title: document.fileName,
      url: internalDocumentUrl(config, document.id, 'content'),
      permissions: { edit: mode === 'edit', download: true },
    },
    documentType: 'word',
    editorConfig: {
      callbackUrl: internalDocumentUrl(config, document.id, 'callback'),
      lang: language,
      mode,
      user,
      coEditing: { mode: 'fast', change: false },
      plugins: {
        autostart: [plugin.guid],
        pluginsData: [mode === 'view' ? plugin.viewConfigUrl : plugin.configUrl],
        options: { [plugin.guid]: { opentdfUrl: config.opentdfPublicUrl, documentId: document.id } },
      },
    },
  };
}

// The Document Server only accepts a configuration whose fields are repeated,
// signed, in the `token` field.
export async function signEditorConfig(editorConfig: EditorConfig, secret: string): Promise<SignedEditorConfig> {
  return { ...editorConfig, token: await signOnlyofficeToken({ ...editorConfig }, secret) };
}
