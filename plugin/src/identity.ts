import type { PluginInfo } from './onlyoffice.ts';

export interface Identity {
  name: string;
  account: string;
  source: 'editor' | 'portal';
}

// The editor may tell the plugin who the user is; otherwise the portal knows,
// and the panel shares its origin and session cookie.
export async function resolveIdentity(info: PluginInfo): Promise<Identity | null> {
  if (typeof info.userName === 'string' && info.userName !== '' && typeof info.userId === 'string' && info.userId !== '') {
    return { name: info.userName, account: info.userId, source: 'editor' };
  }
  const response = await fetch('/api/me', { credentials: 'same-origin' });
  if (!response.ok) {
    return null;
  }
  const me: unknown = await response.json();
  if (typeof me !== 'object' || me === null || !('name' in me) || typeof me.name !== 'string') {
    return null;
  }
  const account = 'username' in me && typeof me.username === 'string' ? me.username : 'id' in me && typeof me.id === 'string' ? me.id : me.name;
  return { name: me.name, account, source: 'portal' };
}
