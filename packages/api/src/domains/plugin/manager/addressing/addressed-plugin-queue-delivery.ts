import { createHash } from 'node:crypto';
import type { InvocationQueue, QueueEntry } from '../../../cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { projectEnvelope } from '../../../messaging/envelope.js';
import type { MediaEntitlementLedger } from '../../../messaging/media-entitlements.js';
import type { PluginManagerService } from '../plugin-manager-service.js';
import type { PluginAddressedTargets } from './plugin-addressed-targets.js';

export class AddressedPluginQueueDelivery {
  constructor(
    readonly options: {
      targets: PluginAddressedTargets;
      manager: Pick<PluginManagerService, 'deliverAddressed'>;
      queue: InvocationQueue;
      messageStore: IMessageStore;
      entitlements?: Pick<MediaEntitlementLedger, 'grantMany' | 'revoke'>;
      timeoutMs?: number;
    },
  ) {}

  handles(id: string): Promise<boolean> {
    return this.options.targets.isInstanceId(id);
  }
  async deliver(entry: QueueEntry, targetId: string): Promise<StoredMessage> {
    const { messageStore, queue, manager } = this.options;
    const source = entry.payload.messageId ? await messageStore.getById(entry.payload.messageId) : null;
    if (
      !source ||
      source.threadId !== entry.threadId ||
      source.visibility === 'whisper' ||
      source.recall ||
      source.deliveryStatus === 'canceled' ||
      !entry.targets.includes(targetId)
    ) {
      throw new Error('Plugin delivery source is unavailable');
    }
    // Win the existing delivery CAS before exposing the input outside the Host.
    // A concurrent recall/cancel must not remain successful after exposure.
    const admitted = await messageStore.markDelivered(source.id, Date.now());
    // Published agent speech has no deliveryStatus. markDelivered leaves it in
    // place; only queued inputs need the publication transition.
    if (!admitted || admitted.deliveryStatus === 'canceled' || admitted.recall || admitted.visibility === 'whisper')
      throw new Error('Plugin input was canceled before delivery');
    const deliveryId = `ad_${createHash('sha256').update(targetId).update('\0').update(source.id).digest('hex')}`;
    const receiptKey = `plugin-addressed:${deliveryId}`;
    let status = await messageStore.getByIdempotencyKey('system', source.threadId, receiptKey);
    if (!status) {
      const envelope = projectEnvelope(source);
      if (!envelope) throw new Error('Plugin delivery envelope is unavailable');
      const media = envelope.payload.elements.flatMap((element) =>
        element.kind === 'media_ref' && element.payload.reference.startsWith('hmr_')
          ? [
              {
                instanceId: targetId,
                scope: { kind: 'delivery' as const, deliveryId },
                elementId: element.elementId,
                hmrId: element.payload.reference,
              },
            ]
          : [],
      );
      if (media.length && !this.options.entitlements) throw new Error('Media entitlement service is unavailable');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let accepted = false;
      try {
        if (media.length) await this.options.entitlements!.grantMany(media);
        await Promise.race([
          manager.deliverAddressed(targetId, {
            kind: 'message',
            reason: 'addressed',
            deliveryId,
            threadId: source.threadId,
            envelope,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Plugin delivery timed out')), this.options.timeoutMs ?? 30_000);
          }),
        ]);
        accepted = true;
      } catch {
        // A timeout does not prove rejection. End this delivery attempt honestly;
        // do not spin the ordinary queue or claim an external reply completed.
      } finally {
        if (timer) clearTimeout(timer);
        await this.options.entitlements?.revoke({ scope: { kind: 'delivery', deliveryId } }, 'action_returned');
      }
      status = await messageStore.append({
        userId: 'system',
        threadId: source.threadId,
        from: { kind: 'system', service: 'plugin_delivery' },
        content: accepted ? '插件已接收消息。' : '插件未确认接收，请检查插件状态后重新发送。',
        extra: { pluginAddressedReceipt: { targetId, inputMessageId: source.id, accepted } },
        mentions: [],
        timestamp: Date.now(),
        idempotencyKey: receiptKey,
      });
    }
    const identity = {
      orderKey: source.lifecycle?.orderKey ?? source.id,
      ...(source.lifecycle?.producerInvocationId
        ? { producerInvocationId: source.lifecycle.producerInvocationId }
        : {}),
      targetId,
      statusMessageId: status.id,
    };
    const existing = source.lifecycle?.dispatchRefs?.find((ref) => ref.targetId === targetId);
    if (!existing) {
      const dispatched = await messageStore.advanceLifecycleInputDispatch(source.id, {
        ...identity,
        phase: 'dispatched',
        dispatchedAt: status.timestamp,
      });
      if (dispatched.kind !== 'applied' && dispatched.kind !== 'replayed')
        throw new Error('Plugin acceptance history conflict');
    } else if (existing.statusMessageId !== status.id) throw new Error('Plugin acceptance identity conflict');
    const settled = await messageStore.advanceLifecycleInputDispatch(source.id, { ...identity, phase: 'settled' });
    if (settled.kind !== 'applied' && settled.kind !== 'replayed')
      throw new Error('Plugin acceptance settlement conflict');
    const retired = await queue.retireClaimedLifecycleTarget(source.threadId, entry.id, targetId);
    if (retired.outcome !== 'retired') throw new Error('Plugin acceptance queue retirement conflict');
    return status;
  }
}
