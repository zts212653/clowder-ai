import { type MediaReadInput, type MediaReadResult, validateMessagingRowInput } from '@clowder-ai/plugin-contract';
import { MessagingError } from '../../messaging/contract/host-types.js';
import type { MediaEntitlementLedger } from '../../messaging/media-entitlements.js';
import type { FileMessagingMediaLedger } from '../../messaging/media-ledger.js';

export interface PluginStreams {
  read(reference: string, options?: { readonly signal?: AbortSignal }): AsyncIterable<Uint8Array>;
}

export interface MediaReadContext {
  readonly pluginInstanceId: string;
}

const DENIED_MESSAGE = 'Media access denied';

/** One authority decision shared by the stdio Broker and in-process module carrier. */
export class PluginMediaReadService {
  constructor(
    private readonly options: {
      readonly ledger: Pick<FileMessagingMediaLedger, 'readChunk'> &
        Partial<Pick<FileMessagingMediaLedger, 'openVerifiedStream'>>;
      readonly entitlements: Pick<MediaEntitlementLedger, 'isEntitled'>;
      readonly onRejected?: (reason: 'entitlement' | 'range') => void;
    },
  ) {}

  async *stream(
    context: MediaReadContext,
    reference: string,
    options: { readonly signal?: AbortSignal; readonly assertCurrent?: () => void } = {},
  ): AsyncIterable<Uint8Array> {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();

    if (!(await this.options.entitlements.isEntitled(context.pluginInstanceId, reference)))
      throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
    const opened = await this.options.ledger.openVerifiedStream?.(reference);
    if (!opened) throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
    const abort = () => opened.stream.destroy(new DOMException('Stream read aborted', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      for await (const bytes of opened.stream) {
        options.signal?.throwIfAborted();
        options.assertCurrent?.();
        yield new Uint8Array(bytes);
      }
    } finally {
      options.signal?.removeEventListener('abort', abort);
      opened.stream.destroy();
    }
  }

  async read(context: MediaReadContext, input: MediaReadInput): Promise<MediaReadResult> {
    const validated = validateMessagingRowInput('streams.read', input);
    if (!validated.valid) {
      this.options.onRejected?.('range');
      throw new MessagingError('VALIDATION', 'streams.read input is invalid');
    }
    let entitled = false;
    try {
      entitled = await this.options.entitlements.isEntitled(context.pluginInstanceId, validated.value.reference);
    } catch {
      // A missing/corrupt audit snapshot is never authority to release bytes.
      entitled = false;
    }
    if (!entitled) {
      this.options.onRejected?.('entitlement');
      throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
    }
    try {
      const result = await this.options.ledger.readChunk(
        validated.value.reference,
        validated.value.offset,
        validated.value.limit,
      );
      if (result === undefined) {
        this.options.onRejected?.('entitlement');
        throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
      }
      return result;
    } catch (error) {
      if (error instanceof RangeError) {
        this.options.onRejected?.('range');
        throw new MessagingError('VALIDATION', 'streams.read offset is out of range');
      }
      if (error instanceof MessagingError) throw error;
      // Unknown/corrupt/missing backing bytes must not disclose whether a guessed hmr exists.
      this.options.onRejected?.('entitlement');
      throw new MessagingError('MEDIA_ACCESS_DENIED', DENIED_MESSAGE);
    }
  }
}

export function createPluginStreamsHost(
  service: PluginMediaReadService | undefined,
  context: MediaReadContext,
  assertCurrent: () => void,
): PluginStreams {
  return {
    async *read(reference, options) {
      assertCurrent();

      if (!service) throw new MessagingError('MEDIA_ACCESS_DENIED', 'Host streams are unavailable');
      yield* service.stream(context, reference, { ...options, assertCurrent });
    },
  };
}
