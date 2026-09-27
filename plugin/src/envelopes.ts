import {
  type CreateTDFOptions,
  DecryptError,
  IntegrityError,
  InvalidFileError,
  OpenTDF,
  type OpenTDFOptions,
  PermissionDeniedError,
} from '@opentdf/sdk';
import { describeError } from './log.ts';
import { messages } from './messages.ts';
import type { PluginInfo } from './onlyoffice.ts';
import { withTimeout } from './time.ts';

type Interceptor = NonNullable<OpenTDFOptions['interceptors']>[number];
type AssertionConfig = NonNullable<CreateTDFOptions['assertionConfigs']>[number];

// A failure worth retrying (an unreachable service) or not (a damaged envelope).
export type OpenedEnvelope = { status: 'opened'; text: string } | { status: 'denied' } | { status: 'failed'; reason: string; retry: boolean };

export type SealedEnvelope = { status: 'sealed'; envelope: Uint8Array } | { status: 'failed'; reason: string };

// What opens the envelopes of a document.
export interface EnvelopeOpener {
  open(envelope: Uint8Array): Promise<OpenedEnvelope>;
}

const LABEL_NAMESPACE = 'urn:nato:stanag:4774:confidentialitymetadatalabel:1:0';

// A key request that never answers must not hold a portion forever.
const OPEN_TIMEOUT_MS = 30_000;

// The SDK's calls that need a token go to the portal's relay, which adds the
// access token the portal keeps (ADR 0001); the others, the KAS public key and
// the platform's well-known configuration, go straight to OpenTDF.
const relayThroughPortal: Interceptor = (next) => async (request) =>
  next({ ...request, url: `${window.location.origin}/api/opentdf${new URL(request.url).pathname}` });

// Seals portion texts into envelopes and opens them, with the OpenTDF platform
// the host named in the editor configuration.
export class EnvelopeClient implements EnvelopeOpener {
  #client: OpenTDF;
  #kasUrl: string;

  constructor(platformUrl: string) {
    this.#kasUrl = `${platformUrl}/kas`;
    this.#client = new OpenTDF({ platformUrl, interceptors: [relayThroughPortal], disableDPoP: true });
  }

  // The envelope carries the portion label as a handling assertion, bound to
  // the envelope, and names the stack's KAS.
  async seal(text: string, labelXml: string): Promise<SealedEnvelope> {
    const label: AssertionConfig = {
      id: 'portion-label',
      type: 'handling',
      scope: 'tdo',
      appliesToState: 'unencrypted',
      statement: { format: 'xml', schema: LABEL_NAMESPACE, value: labelXml },
    };
    try {
      const stream = await this.#client.createTDF({
        source: { type: 'buffer', location: new TextEncoder().encode(text) },
        defaultKASEndpoint: this.#kasUrl,
        assertionConfigs: [label],
      });
      return { status: 'sealed', envelope: new Uint8Array(await new Response(stream).arrayBuffer()) };
    } catch (error: unknown) {
      return { status: 'failed', reason: describeError(error) };
    }
  }

  async open(envelope: Uint8Array): Promise<OpenedEnvelope> {
    try {
      return await withTimeout(this.#read(envelope), OPEN_TIMEOUT_MS, 'The key service did not answer');
    } catch (error: unknown) {
      if (error instanceof PermissionDeniedError) {
        return { status: 'denied' };
      }
      const damaged = error instanceof IntegrityError || error instanceof InvalidFileError || error instanceof DecryptError;
      return { status: 'failed', reason: describeError(error), retry: !damaged };
    }
  }

  async #read(envelope: Uint8Array): Promise<OpenedEnvelope> {
    const stream = await this.#client.read({ source: { type: 'buffer', location: envelope }, allowedKASEndpoints: [this.#kasUrl] });
    return { status: 'opened', text: await new Response(stream).text() };
  }
}

// The host names the OpenTDF platform in the plugin's options.
export function envelopeClientFor(info: PluginInfo): EnvelopeClient {
  const options = info.options;
  if (typeof options !== 'object' || options === null || !('opentdfUrl' in options) || typeof options.opentdfUrl !== 'string') {
    throw new Error(messages.noOpentdfPlatform);
  }
  return new EnvelopeClient(options.opentdfUrl);
}

// Stands in for the client when there is none: every envelope fails to open,
// for the reason the client could not be made.
export function unavailableOpener(reason: string): EnvelopeOpener {
  return {
    open: async (): Promise<OpenedEnvelope> => ({ status: 'failed', reason, retry: false }),
  };
}
