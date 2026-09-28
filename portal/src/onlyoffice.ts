import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

// Statuses of the Document Server's save callbacks.
export const CALLBACK_STATUS = {
  editing: 1,
  readyForSaving: 2,
  savingError: 3,
  closedWithoutChanges: 4,
  forceSaved: 6,
  forceSavingError: 7,
} as const;

export type CallbackStatus = (typeof CALLBACK_STATUS)[keyof typeof CALLBACK_STATUS];

// Answers the Document Server expects from a callback handler.
export const CALLBACK_RECEIVED = { error: 0 } as const;
export const CALLBACK_FAILED = { error: 1 } as const;

export interface CallbackPayload {
  key: string;
  status: CallbackStatus;
  url: string | null;
  // The ids of the users of the editing session.
  users: string[];
  // The ids of the users the callback reports as having just joined the
  // session. The Document Server reports editors only, never viewers.
  joined: string[];
}

// Where the portal reaches the Document Server's command service, and the
// secret that signs its commands.
export interface CommandService {
  internalUrl: string;
  secret: string;
}

export type ForceSaveOutcome = 'accepted' | 'no-changes' | 'unknown-document' | 'failed';

const CALLBACK_STATUSES: readonly number[] = Object.values(CALLBACK_STATUS);

// Error codes in the command service's answers.
const COMMAND_ERROR = { none: 0, unknownKey: 1, notModified: 4 } as const;

// Types of the callbacks' `actions` entries.
const CALLBACK_ACTION = { joined: 1 } as const;

export async function signOnlyofficeToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(encodeSecret(secret));
}

export async function verifyOnlyofficeToken(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, encodeSecret(secret), { algorithms: ['HS256'] });
    return payload;
  } catch (error: unknown) {
    if (error instanceof Error && error.name.startsWith('JW')) {
      return null;
    }
    throw error;
  }
}

// The Document Server signs its callbacks either in the body (`token`) or in
// the Authorization header, where the original body sits under `payload`.
export async function readVerifiedCallback(
  body: unknown,
  authorization: string | undefined,
  secret: string,
): Promise<CallbackPayload | null> {
  const bodyToken = isRecord(body) && typeof body.token === 'string' ? body.token : null;
  const token = bodyToken ?? bearerToken(authorization);
  if (token === null) {
    return null;
  }
  const verified = await verifyOnlyofficeToken(token, secret);
  if (verified === null) {
    return null;
  }
  return parseCallbackPayload(isRecord(verified.payload) ? verified.payload : verified);
}

// The Document Server signs its download requests with { payload: { url } }:
// the URL of a verified token of that shape, null for any other token, such
// as an editor configuration, which every browser receives.
export async function readVerifiedDownloadUrl(authorization: string | undefined, secret: string): Promise<string | null> {
  const token = bearerToken(authorization);
  const verified = token === null ? null : await verifyOnlyofficeToken(token, secret);
  const payload: unknown = verified === null ? null : verified.payload;
  return isRecord(payload) && typeof payload.url === 'string' ? payload.url : null;
}

export function bearerToken(authorization: string | undefined): string | null {
  return authorization?.startsWith('Bearer ') === true ? authorization.slice('Bearer '.length) : null;
}

export async function requestForceSave(service: CommandService, key: string): Promise<ForceSaveOutcome> {
  switch (commandError(await sendCommand(service, { c: 'forcesave', key }))) {
    case COMMAND_ERROR.none:
      return 'accepted';
    case COMMAND_ERROR.notModified:
      return 'no-changes';
    case COMMAND_ERROR.unknownKey:
      return 'unknown-document';
    default:
      return 'failed';
  }
}

// The ids of the editors connected to the session of a key: none when no
// session is open, null when the Document Server does not answer. Viewers
// are not listed.
export async function requestSessionEditors(service: CommandService, key: string): Promise<string[] | null> {
  const result = await sendCommand(service, { c: 'info', key });
  switch (commandError(result)) {
    case COMMAND_ERROR.unknownKey:
      return [];
    case COMMAND_ERROR.none:
      return Array.isArray(result?.users) ? stringsOf(result.users) : null;
    default:
      return null;
  }
}

// Disconnects some editors from the session of a key, or every connection,
// viewers included, when `users` is null. Their editors stop editing and
// keep showing what they had loaded.
export async function dropFromSession(service: CommandService, key: string, users: string[] | null): Promise<boolean> {
  const error = commandError(await sendCommand(service, users === null ? { c: 'drop', key } : { c: 'drop', key, users }));
  return error === COMMAND_ERROR.none || error === COMMAND_ERROR.unknownKey;
}

// The command service's answer, null when it cannot be had.
async function sendCommand(service: CommandService, command: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const token = await signOnlyofficeToken(command, service.secret);
  const response = await fetch(`${service.internalUrl}/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...command, token }),
  });
  if (!response.ok) {
    return null;
  }
  const result: unknown = await response.json();
  return isRecord(result) ? result : null;
}

function commandError(result: Record<string, unknown> | null): number | null {
  return typeof result?.error === 'number' ? result.error : null;
}

// Saved files are served by the Document Server under its public origin; the
// portal fetches them over the internal network instead.
export function toInternalUrl(fileUrl: string, onlyofficeInternalUrl: string): string {
  const source = new URL(fileUrl);
  const internal = new URL(onlyofficeInternalUrl);
  source.protocol = internal.protocol;
  source.host = internal.host;
  return source.toString();
}

function parseCallbackPayload(value: unknown): CallbackPayload | null {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.status !== 'number' || !isCallbackStatus(value.status)) {
    return null;
  }
  const users = Array.isArray(value.users) ? stringsOf(value.users) : [];
  const actions: unknown[] = Array.isArray(value.actions) ? value.actions : [];
  const joined = actions.flatMap((action) =>
    isRecord(action) && action.type === CALLBACK_ACTION.joined && typeof action.userid === 'string' ? [action.userid] : [],
  );
  return { key: value.key, status: value.status, url: typeof value.url === 'string' ? value.url : null, users, joined };
}

function stringsOf(values: unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string');
}

function isCallbackStatus(value: number): value is CallbackStatus {
  return CALLBACK_STATUSES.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}
