import type { FastifyInstance } from 'fastify';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { LiveCompanionSessions } from '../domains/concierge/live/LiveCompanionSessions.js';
import { LiveMeetingControl } from '../domains/concierge/meeting/live-meeting-control.js';
import { createLiveMeetingRequestAuthority } from '../domains/concierge/meeting/live-meeting-request-authority.js';
import { createF317MeetingAudioPort } from './f317-meeting-audio-port.js';
import { createF317MeetingShareService } from './f317-meeting-share.js';

/** A's single-writer composition installs this bundle in both the owner UI and Live callback routes. */
export function createF317MeetingControlBundle(
  app: FastifyInstance,
  options: {
    ownerUserId: string;
    sessions: Pick<LiveCompanionSessions, 'get' | 'observeCall' | 'attach' | 'detach' | 'isAttached'>;
    messages: Pick<IMessageStore, 'getById' | 'getByThread' | 'getByThreadAfter'>;
    threadStore: Pick<IThreadStore, 'get'>;
    isCurrentThread(userId: string, threadId: string): Promise<boolean>;
  },
) {
  const audio = createF317MeetingAudioPort(app, options.ownerUserId);
  const share = createF317MeetingShareService({ ...options, host: options.sessions });
  const authorize = createLiveMeetingRequestAuthority({ ...options, threads: options.threadStore });
  const bound = new Set<string>();
  const service = new LiveMeetingControl(
    {
      audio,
      authorize: async (principal, requestId, requireRequest) => {
        const current = await authorize(principal, requestId, requireRequest);
        const call = options.sessions.get(current.scope.callId, current.scope.userId);
        if (call && !bound.has(call.id)) {
          bound.add(call.id);
          void call.finished
            .finally(async () => {
              try {
                await service.releaseCall(call.id);
              } catch (error) {
                app.log.error({ err: error, callId: call.id }, 'Meeting capture cleanup unconfirmed');
              } finally {
                bound.delete(call.id);
              }
            })
            .catch(() => undefined);
        }
        return current;
      },
      ownerOfThread: async (threadId) => (await options.threadStore.get(threadId))?.createdBy ?? null,
    },
    share,
  );
  // Revoke/drain first. Fastify no longer accepts injected routes while closing;
  // F195's existing onClose lease owner performs the actual graceful sidecar stop.
  app.addHook('preClose', async () => {
    await service.close({ controllerWillStop: true });
  });
  return { service, share };
}
