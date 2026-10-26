import { Readable } from 'node:stream';
import {
  collectiveArtifactConstraintSchema,
  collectiveArtifactPublicationOperationSchema,
  collectiveArtifactPublicationRecordSchema,
  collectiveArtifactPublicationRecoverySchema,
  collectiveArtifactRelayOperationSchema,
  collectiveArtifactRelayResponseSchema,
  collectiveCustodyPageSchema,
  collectiveCustodyPreparedSchema,
  collectiveCustodyReadySchema,
  collectiveCustodyTransferSchema,
  collectiveMediaDescriptorSchema,
  collectiveMediaOperationSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type {
  CollectiveArtifactCustodyTransferPort,
  CollectiveArtifactMediaReadPort,
  CollectiveArtifactOwnerPort,
  CollectiveCustodyOwnerAuthority,
} from '../../collaborative-content/collective-artifact/owner-port.js';
import { createCollectiveMessageAttachmentsProxy } from './collective-message-attachments.js';
import { createCollectiveRetainedMediaProxy, type RetainedMediaOwner } from './collective-retained-media.js';

const coordinates = { serviceInstanceId: true, collectiveId: true, connectionId: true, relayRef: true } as const;
const resultSchema = z.discriminatedUnion('status', [
  collectiveArtifactRelayResponseSchema.options[0].omit(coordinates),
  collectiveArtifactRelayResponseSchema.options[1].omit(coordinates),
]);

export interface CollectiveArtifactOwnerHolder {
  current?: CollectiveArtifactOwnerPort;
  retainedMedia?: RetainedMediaOwner;
}

function unavailable(): never {
  throw Object.assign(new Error('owner_unavailable'), { code: 'owner_unavailable' });
}

/** Only the verified Collective installation receives this proxy; no Host services or stores cross it. */
export function createCollectiveArtifactOwnerProxy(deps: {
  owner(): CollectiveArtifactOwnerPort | undefined;
  retainedMedia?(): RetainedMediaOwner | undefined;
  pluginInstanceId?: string;
  assertCurrent(): Promise<void>;
  signal?: AbortSignal;
}): CollectiveArtifactOwnerPort {
  async function acquire() {
    deps.signal?.throwIfAborted();
    await deps.assertCurrent();
    const owner = deps.owner();
    if (!owner) unavailable();
    const current = async () => {
      deps.signal?.throwIfAborted();
      await deps.assertCurrent();
      if (deps.owner() !== owner) unavailable();
      deps.signal?.throwIfAborted();
    };
    await current();
    return { owner, current };
  }
  function authority<T>(read: () => Promise<T>, current: () => Promise<void>, parse: (value: unknown) => T) {
    return {
      reauthorize: async () => {
        await current();
        const result = parse(await read());
        await current();
        return result;
      },
    };
  }
  function custodyAuthority(
    value: CollectiveCustodyOwnerAuthority,
    current: () => Promise<void>,
  ): CollectiveCustodyOwnerAuthority {
    return {
      authorize: async (operation) => {
        await current();
        const fresh = collectiveCustodyTransferSchema.parse(await value.authorize(operation));
        await current();
        return fresh;
      },
    };
  }
  return Object.freeze({
    attachments: createCollectiveMessageAttachmentsProxy(acquire, deps.signal),
    async execute(input, auth) {
      const operation = collectiveArtifactRelayOperationSchema.parse(input);
      const { owner, current } = await acquire();
      const result = await owner.execute(
        operation,
        authority(
          () => auth.reauthorize(),
          current,
          (value) => collectiveArtifactConstraintSchema.parse(value),
        ),
      );
      await current();
      return resultSchema.parse(result);
    },
    async publish(input, auth) {
      const operation = collectiveArtifactPublicationOperationSchema.parse(input);
      const { owner, current } = await acquire();
      if (!owner.publish) unavailable();
      const result = await owner.publish(
        operation,
        authority(
          () => auth.reauthorize(),
          current,
          (value) => collectiveArtifactPublicationRecordSchema.parse(value),
        ),
      );
      await current();
      return resultSchema.parse(result);
    },
    async recoverPublication(input) {
      const publication = collectiveArtifactPublicationRecordSchema.parse(input);
      const { owner, current } = await acquire();
      if (!owner.recoverPublication) unavailable();
      const result = await owner.recoverPublication(publication);
      await current();
      return collectiveArtifactPublicationRecoverySchema.shape.outcome.parse(result);
    },
    custody: Object.freeze({
      async prepareSource(input, auth) {
        const transfer = collectiveCustodyTransferSchema.parse(input);
        const { owner, current } = await acquire();
        if (!owner.custody) unavailable();
        const result = await owner.custody.prepareSource(transfer, custodyAuthority(auth, current));
        await current();
        return collectiveCustodyPreparedSchema.parse(result);
      },
      async readPage(input, index, auth) {
        if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('Invalid custody page index');
        const transfer = collectiveCustodyTransferSchema.parse(input);
        const { owner, current } = await acquire();
        if (!owner.custody) unavailable();
        const result = await owner.custody.readPage(transfer, index, custodyAuthority(auth, current));
        await current();
        return collectiveCustodyPageSchema.parse(result);
      },
      async stageTarget(input, page, auth) {
        const transfer = collectiveCustodyTransferSchema.parse(input),
          selected = collectiveCustodyPageSchema.parse(page);
        const { owner, current } = await acquire();
        if (!owner.custody) unavailable();
        await owner.custody.stageTarget(transfer, selected, custodyAuthority(auth, current));
        await current();
      },
      async attestReady(input, auth) {
        const transfer = collectiveCustodyTransferSchema.parse(input);
        const { owner, current } = await acquire();
        if (!owner.custody) unavailable();
        const result = await owner.custody.attestReady(transfer, custodyAuthority(auth, current));
        await current();
        return collectiveCustodyReadySchema.parse(result);
      },
      async finalize(input, auth) {
        const transfer = collectiveCustodyTransferSchema.parse(input);
        const { owner, current } = await acquire();
        if (!owner.custody) unavailable();
        await owner.custody.finalize(transfer, custodyAuthority(auth, current));
        await current();
      },
    } satisfies CollectiveArtifactCustodyTransferPort),
    media: Object.freeze({
      ...createCollectiveRetainedMediaProxy({
        pluginInstanceId: deps.pluginInstanceId,
        owner: () => deps.retainedMedia?.(),
        acquire,
      }),
      async read(input, auth, signal) {
        const operation = collectiveMediaOperationSchema.parse(input);
        const { owner, current } = await acquire();
        if (!owner.media) unavailable();
        const combined = AbortSignal.any([signal, ...(deps.signal ? [deps.signal] : [])]);
        combined.throwIfAborted();
        const result = await owner.media.read(
          operation,
          authority(
            () => auth.reauthorize(),
            current,
            (value) => collectiveArtifactConstraintSchema.parse(value),
          ),
          combined,
        );
        try {
          await current();
          combined.throwIfAborted();
        } catch (error) {
          if (result.status === 'ok') result.body.destroy();
          throw error;
        }
        if (result.status !== 'ok') return resultSchema.options[1].parse(result);
        const source = result.body;
        const body = Readable.from(
          (async function* () {
            try {
              for await (const bytes of source) {
                combined.throwIfAborted();
                await current();
                yield bytes;
              }
            } finally {
              source.destroy();
            }
          })(),
        );
        const abort = () => {
          source.destroy();
          body.destroy();
        };
        combined.addEventListener('abort', abort, { once: true });
        body.once('close', () => {
          combined.removeEventListener('abort', abort);
          source.destroy();
        });
        if (combined.aborted) abort();
        return { status: 'ok' as const, descriptor: collectiveMediaDescriptorSchema.parse(result.descriptor), body };
      },
    } satisfies CollectiveArtifactMediaReadPort),
  } satisfies CollectiveArtifactOwnerPort);
}
