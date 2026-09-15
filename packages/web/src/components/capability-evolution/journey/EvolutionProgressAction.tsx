'use client';

import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { useCatData } from '@/hooks/useCatData';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import {
  progressRequestKey,
  progressRequestLabel,
  requestEvolutionProgress,
  useEvolutionProgressRequests,
} from './evolution-progress-request';

export function EvolutionProgressAction({
  projection,
  compact = false,
}: {
  projection: EvolutionProgramProjection;
  compact?: boolean;
}) {
  const key = progressRequestKey(projection);
  const receipt = useEvolutionProgressRequests((state) => state.records[key]?.receipt);
  const pending = useEvolutionProgressRequests((state) => state.pending[key] ?? false);
  const error = useEvolutionProgressRequests((state) => state.errors[key]);
  const { cats } = useCatData({ fetch: false });
  const { origin } = projection;
  const label = progressRequestLabel(projection);
  if (!label) return null;
  if (!origin?.createdByCatId)
    return <p className="evolution-empty mt-4">尚未找到可联系的发起猫猫，请回到发起对话确认接手者。</p>;
  const contact = cats.find((cat) => cat.id === origin.createdByCatId)?.displayName ?? origin.createdByCatId;
  return (
    <section
      aria-label="推进项目"
      className={compact ? 'evolution-progress-compact' : 'evolution-focus my-5 space-y-3'}
    >
      <p className="text-sm font-semibold text-cafe">{compact ? '项目推进' : '交给猫猫推进'}</p>
      {!compact && (
        <p className="evolution-empty">
          交给发起猫猫 {contact}，在「{origin.title}」中继续已有任务、补齐缺口。
        </p>
      )}
      {receipt ? (
        <>
          <output className="block text-sm text-cafe-secondary">
            {receipt.status === 'queued' ? '推进请求已排队，等猫猫接续处理。' : '推进请求已送达，请到原对话查看进展。'}
          </output>
          <a
            data-testid="evolution-progress-receipt"
            className="evolution-link"
            href={`/thread/${encodeURIComponent(origin.threadId)}`}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention();
              handleTeleportEvent(
                { threadId: origin.threadId, messageId: receipt.userMessageId },
                useChatStore.getState().currentThreadId,
                {
                  pushThreadRoute: (threadId) => pushThreadRouteWithHistory(threadId, window),
                  scrollToMessage,
                },
              );
            }}
          >
            查看请求与猫猫回复 →
          </a>
          <button
            type="button"
            className="evolution-link ml-4 disabled:opacity-50"
            disabled={pending}
            onClick={() => void requestEvolutionProgress(projection, true)}
          >
            {pending ? '正在交给猫猫…' : '再提醒一次'}
          </button>
        </>
      ) : (
        <button
          type="button"
          className={`${compact ? 'evolution-link' : 'evolution-primary'} disabled:opacity-50 disabled:cursor-wait`}
          disabled={pending}
          onClick={() => void requestEvolutionProgress(projection)}
        >
          {pending ? '正在交给猫猫…' : label}
        </button>
      )}
      {error && (
        <p role="alert" className="evolution-empty">
          {error}
        </p>
      )}
    </section>
  );
}
