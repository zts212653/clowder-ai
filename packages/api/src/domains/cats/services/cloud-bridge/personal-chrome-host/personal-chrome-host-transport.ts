import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

import type { HostAppendMessageReceipt, IConversationHostAdapter } from '../conversation-host-adapter.js';
import {
  PERSONAL_CHROME_EXTENSION_REVISION,
  PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES,
  PERSONAL_CHROME_PAGE_ADAPTER_REVISION,
  PERSONAL_CHROME_PROTOCOL_VERSION,
  type PersonalChromeAppendRequest,
  type PersonalChromeAppendResult,
  type PersonalChromeLocalEnvelope,
  parsePersonalChromeAppendRequest,
  parsePersonalChromeAppendResult,
} from './protocol.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export class PersonalChromeHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly idempotentReplay?: boolean,
    readonly diagnostic?: unknown,
  ) {
    super(message);
    this.name = 'PersonalChromeHostError';
  }
}

export interface PersonalChromeHostAdapterOptions {
  readonly socketPath: string;
  readonly pairingSecret: string;
  readonly helperArtifactRevision: string;
  readonly timeoutMs?: number;
  readonly requestId?: () => string;
}

function validateOptions(options: PersonalChromeHostAdapterOptions): void {
  if (!options.socketPath || options.socketPath.trim() !== options.socketPath) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'socketPath must be a non-empty exact path');
  }
  if (options.pairingSecret.length < 32 || options.pairingSecret.length > 512) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'pairingSecret must contain 32-512 characters');
  }
  if (!/^sha512:[a-f0-9]{128}$/.test(options.helperArtifactRevision)) {
    throw new PersonalChromeHostError(
      'INVALID_CONFIGURATION',
      'helperArtifactRevision must be a lowercase sha512 digest',
    );
  }
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 10)) {
    throw new PersonalChromeHostError('INVALID_CONFIGURATION', 'timeoutMs must be an integer of at least 10');
  }
}

function revisionsMatch(
  expected: PersonalChromeAppendRequest['expectedRevisions'],
  observed: PersonalChromeAppendResult['observedRevisions'],
): boolean {
  return (
    observed !== undefined &&
    observed.helper === expected.helper &&
    observed.extension === expected.extension &&
    observed.pageAdapter === expected.pageAdapter
  );
}

function exchangeLocalFrame(
  options: PersonalChromeHostAdapterOptions,
  envelope: PersonalChromeLocalEnvelope,
): Promise<PersonalChromeAppendResult> {
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES) {
    return Promise.reject(new PersonalChromeHostError('REQUEST_TOO_LARGE', 'local append frame exceeds limit'));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(options.socketPath);
    let settled = false;
    let input = '';
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new PersonalChromeHostError('HOST_TIMEOUT', 'personal Chrome host timed out')));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(serialized));
    socket.once('error', (error) => {
      finish(() =>
        reject(new PersonalChromeHostError('HOST_UNAVAILABLE', `personal Chrome host unavailable: ${error.message}`)),
      );
    });
    socket.on('data', (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > PERSONAL_CHROME_MAX_LOCAL_FRAME_BYTES) {
        finish(() => reject(new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'host receipt exceeds limit')));
        return;
      }
      const newline = input.indexOf('\n');
      if (newline === -1) return;
      try {
        const result = parsePersonalChromeAppendResult(JSON.parse(input.slice(0, newline)));
        finish(() => resolve(result));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        finish(() => reject(new PersonalChromeHostError('INVALID_HOST_RECEIPT', detail)));
      }
    });
    socket.once('end', () => {
      if (!settled) {
        finish(() => reject(new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'host closed without a receipt')));
      }
    });
  });
}

export class PersonalChromeHostAdapter implements IConversationHostAdapter {
  private readonly requestId: () => string;

  constructor(private readonly options: PersonalChromeHostAdapterOptions) {
    validateOptions(options);
    this.requestId = options.requestId ?? randomUUID;
  }

  async append_message(
    conversationId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<HostAppendMessageReceipt> {
    let request: PersonalChromeAppendRequest;
    try {
      request = parsePersonalChromeAppendRequest({
        v: PERSONAL_CHROME_PROTOCOL_VERSION,
        kind: 'append_message',
        requestId: this.requestId(),
        conversationId,
        text,
        idempotencyKey,
        expectedRevisions: {
          helper: this.options.helperArtifactRevision,
          extension: PERSONAL_CHROME_EXTENSION_REVISION,
          pageAdapter: PERSONAL_CHROME_PAGE_ADAPTER_REVISION,
        },
      });
    } catch (error) {
      throw new PersonalChromeHostError('INVALID_REQUEST', error instanceof Error ? error.message : String(error));
    }
    const result = await exchangeLocalFrame(this.options, {
      pairingSecret: this.options.pairingSecret,
      request,
    });
    if (result.requestId !== request.requestId || result.idempotencyKey !== request.idempotencyKey) {
      throw new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'host receipt does not match the append request');
    }
    if (result.status === 'failed') {
      const staleRevision =
        result.errorCode.startsWith('STALE_') ||
        (result.observedRevisions !== undefined &&
          !revisionsMatch(request.expectedRevisions, result.observedRevisions));
      throw new PersonalChromeHostError(
        staleRevision ? 'STALE_ADAPTER' : result.errorCode,
        staleRevision
          ? 'personal Chrome adapter revision does not match runtime'
          : `personal Chrome host failed: ${result.errorCode}`,
        result.idempotentReplay,
        result.diagnostic,
      );
    }
    if (!revisionsMatch(request.expectedRevisions, result.observedRevisions)) {
      throw new PersonalChromeHostError('STALE_ADAPTER', 'personal Chrome adapter revision does not match runtime');
    }
    if (!result.hostMessageId.trim()) {
      throw new PersonalChromeHostError('INVALID_HOST_RECEIPT', 'hostMessageId must be non-empty');
    }
    return {
      hostMessageId: result.hostMessageId,
      ...(result.idempotentReplay === undefined ? {} : { idempotentReplay: result.idempotentReplay }),
    };
  }
}
