import type { UserIdentity } from './sessions.ts';

// The group of administrators registered at the IdP, which the policy service
// and OpenTDF's authorization also name.
const ADMINISTRATORS = 'dcs-maquette-admin';

export function isAdministrator(user: UserIdentity): boolean {
  return user.groups.includes(ADMINISTRATORS);
}
