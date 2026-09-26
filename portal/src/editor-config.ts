import { SignJWT } from 'jose';
import type { PortalConfig } from './config.ts';
import type { StoredDocument } from './documents.ts';

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
    lang: string;
    mode: 'edit' | 'view';
    user: EditorUser;
    coEditing: { mode: 'fast'; change: boolean };
  };
}

export interface SignedEditorConfig extends EditorConfig {
  token: string;
}

export function buildEditorConfig(document: StoredDocument, user: EditorUser, config: PortalConfig): EditorConfig {
  const documentUrl = `${config.portalInternalUrl}/internal/documents/${document.id}`;
  return {
    document: {
      fileType: 'docx',
      key: document.key,
      title: document.fileName,
      url: `${documentUrl}/content`,
      permissions: { edit: true, download: true },
    },
    documentType: 'word',
    editorConfig: {
      callbackUrl: `${documentUrl}/callback`,
      lang: 'en',
      mode: 'edit',
      user,
      coEditing: { mode: 'fast', change: false },
    },
  };
}

// The Document Server only accepts a configuration whose fields are repeated,
// signed, in the `token` field.
export async function signEditorConfig(editorConfig: EditorConfig, secret: string): Promise<SignedEditorConfig> {
  const token = await new SignJWT({ ...editorConfig })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(new TextEncoder().encode(secret));
  return { ...editorConfig, token };
}
