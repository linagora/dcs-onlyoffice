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

// An opened envelope gives the text and the ADatP-4774 XML of the label bound
// to it, which the SDK has verified. A failure is worth retrying (an
// unreachable service) or not (a damaged envelope).
export type OpenedEnvelope =
  | { status: 'opened'; text: string; boundLabelXml: string | null }
  | { status: 'denied' }
  | { status: 'failed'; reason: string; retry: boolean };

export type SealedEnvelope = { status: 'sealed'; envelope: Uint8Array } | { status: 'failed'; reason: string };

// A portion label as its envelope carries it: its ADatP-4774 XML, and the
// attribute values from which the KAS decides who may read the portion.
export interface EnvelopeLabel {
  xml: string;
  attributes: string[];
}

// What opens the envelopes of a document.
export interface EnvelopeOpener {
  open(envelope: Uint8Array): Promise<OpenedEnvelope>;
}

const LABEL_NAMESPACE = 'urn:nato:stanag:4774:confidentialitymetadatalabel:1:0';
const LABEL_ASSERTION_ID = 'portion-label';

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

  // The envelope names the stack's KAS, carries the label's attribute values
  // and the label itself as a handling assertion, bound to the envelope.
  async seal(text: string, label: EnvelopeLabel): Promise<SealedEnvelope> {
    // Without attribute values, the KAS would hand the key to anyone signed in.
    if (label.attributes.length === 0) {
      return { status: 'failed', reason: 'the label gives no attribute value to restrict its readers' };
    }
    const assertion: AssertionConfig = {
      id: LABEL_ASSERTION_ID,
      type: 'handling',
      scope: 'tdo',
      appliesToState: 'unencrypted',
      statement: { format: 'xml', schema: LABEL_NAMESPACE, value: label.xml },
    };
    try {
      const stream = await this.#client.createTDF({
        source: { type: 'buffer', location: new TextEncoder().encode(text) },
        defaultKASEndpoint: this.#kasUrl,
        attributes: label.attributes,
        assertionConfigs: [assertion],
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

  // The SDK checks every assertion's binding while it decrypts, so the bound
  // label cannot have been changed without the envelope's key.
  async #read(envelope: Uint8Array): Promise<OpenedEnvelope> {
    const stream = await this.#client.read({ source: { type: 'buffer', location: envelope }, allowedKASEndpoints: [this.#kasUrl] });
    const text = await new Response(stream).text();
    const assertions = (await stream.manifest)?.assertions ?? [];
    const label = assertions.find((assertion) => assertion.id === LABEL_ASSERTION_ID && assertion.statement.schema === LABEL_NAMESPACE);
    return { status: 'opened', text, boundLabelXml: label?.statement.value ?? null };
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
