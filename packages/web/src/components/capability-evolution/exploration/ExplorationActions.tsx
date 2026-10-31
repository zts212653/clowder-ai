'use client';
import { type EvolutionExplorationExperimentV1, type EvolutionExplorationNodeV1, refIdentity } from '@cat-cafe/shared';
import { useState } from 'react';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import type { EvolutionProgramProjection } from '../evolution-program-projection';
import { useEvolutionReading } from '../evolution-reading-state';
import { ExplorationIcon } from './ExplorationIcon';
import type { ExplorationBinding, ExplorationReading } from './exploration-reading';
import { explorationIntentLabels, sendExplorationRequest, useExplorationRequests } from './exploration-requests';

export function explorationBinding(
  node: EvolutionExplorationNodeV1,
  experiment?: EvolutionExplorationExperimentV1,
): ExplorationBinding {
  const base = {
    nodeRef: node.nodeRef,
    title: node.title,
    ...(experiment ? { experimentRef: experiment.experimentRef } : {}),
  };
  return node.kind === 'owner_version'
    ? { ...base, kind: node.kind, versionRef: node.versionRef }
    : { ...base, kind: node.kind };
}

export function ExplorationActions({
  projection,
  node,
  experiment,
  reading,
  onDraft,
}: {
  projection: EvolutionProgramProjection;
  node: EvolutionExplorationNodeV1;
  experiment?: EvolutionExplorationExperimentV1;
  reading: ExplorationReading;
  onDraft(draft: ExplorationReading['draft']): void;
}) {
  const [notice, setNotice] = useState('');
  const { program, origin } = projection;
  const records = useExplorationRequests((state) => state.records);
  const pending = useExplorationRequests((state) => state.pending);
  const errors = useExplorationRequests((state) => state.errors);
  const binding = reading.draft.binding ?? explorationBinding(node, experiment);
  const own = Object.values(records)
    .filter(
      (record) => record.context.workspaceId === program.workspaceId && record.context.programId === program.programId,
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sending = own.some((record) => pending[record.clientMessageId]);
  const sourceAvailable = Boolean(origin?.createdByCatId) && program.lifecycle === 'active';
  return (
    <section
      className="exploration-actions"
      aria-label="继续探索与真实回执"
      id={`exploration-actions-${program.programId}`}
    >
      <h3>
        <ExplorationIcon kind="work" />
        继续探索
      </h3>
      <p>
        基于 <strong>{binding.title}</strong> 提出下一步。
        {reading.draft.binding && refIdentity(reading.draft.binding.nodeRef) !== refIdentity(node.nodeRef) && (
          <span> 正在阅读其它版本，这份输入仍保留原来的对象。</span>
        )}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!origin?.createdByCatId || !sourceAvailable) return;
          const draft = {
            ...reading.draft,
            binding,
            text:
              reading.draft.text.trim() ||
              (reading.draft.intent === 'retest' ? '请沿本次条件补测，并回传完整结果与回放。' : ''),
          };
          if (!draft.text) {
            setNotice('先写下希望继续探索的内容。');
            return;
          }
          setNotice('');
          const id = await sendExplorationRequest({
            workspaceId: program.workspaceId,
            programId: program.programId,
            cycle: program.cycle,
            objectRef: program.objectRef,
            threadId: origin.threadId,
            catId: origin.createdByCatId,
            binding,
            draft,
          });
          if (id) {
            const currentDraft = useEvolutionReading.getState().programs[program.programId]?.exploration?.draft;
            if (JSON.stringify(currentDraft) === JSON.stringify(reading.draft))
              onDraft({ text: '', intent: 'explore' });
            setNotice('请求已送达；产生新版本或正式生效时，仍以实际回执更新。');
          }
        }}
      >
        <label className="exploration-intent">
          下一步
          <select
            aria-label="探索请求类型"
            value={reading.draft.intent}
            onChange={(event) =>
              onDraft({
                ...reading.draft,
                intent: event.target.value as ExplorationReading['draft']['intent'],
                binding,
              })
            }
          >
            <option value="explore">探索改进</option>
            <option value="retest">补测这一版</option>
            <option value="adopt" disabled={binding.kind !== 'owner_version'}>
              请求采用这一版
            </option>
          </select>
        </label>
        <textarea
          aria-label="继续探索的想法"
          id={`exploration-input-${program.programId}`}
          value={reading.draft.text}
          maxLength={8_000}
          rows={3}
          placeholder="还有什么现象值得查清，或下一轮想尝试什么？"
          onChange={(event) =>
            onDraft({ ...reading.draft, text: event.target.value, binding: event.target.value ? binding : undefined })
          }
        />
        <div className="exploration-action-footer">
          <span>
            {binding.kind === 'public_archive' ? '公开材料不会直接变成正式采用。' : '请求与批准、生效是不同回执。'}
          </span>
          <button type="submit" className="exploration-primary" disabled={!sourceAvailable || sending}>
            {sending ? '正在交给猫猫…' : '交给猫猫继续'}
          </button>
        </div>
        {!sourceAvailable && (
          <p className="exploration-caption">
            {program.lifecycle !== 'active'
              ? '项目当前未在推进，输入仍会保留。'
              : '发起对话尚不可联系；输入仍保留，恢复后可继续。'}
          </p>
        )}
        {notice && (
          <p role="status" className="exploration-notice">
            {notice}
          </p>
        )}
      </form>
      {own.length > 0 && (
        <details className="exploration-request-history" open>
          <summary>请求与回执 · {own.length}</summary>
          {own.map((record) => (
            <article key={record.clientMessageId} data-request-id={record.clientMessageId}>
              <strong>
                {record.context.binding.title} · {explorationIntentLabels[record.context.draft.intent]}
                {record.context.cycle && <span> · 第 {record.context.cycle} 轮发起</span>}
              </strong>
              <p>
                {pending[record.clientMessageId]
                  ? '正在确认同一请求…'
                  : record.receipt
                    ? '请求已送达，等待实际动作与结果。'
                    : '尚未确认送达，原始目标与重试编号已保留。'}
              </p>
              {errors[record.clientMessageId] && <p role="alert">{errors[record.clientMessageId]}</p>}
              {record.receipt ? (
                <a
                  href={`/thread/${encodeURIComponent(record.context.threadId)}`}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    useF307ExperienceWorkbenchStore.getState().exitMainAreaAttention();
                    handleTeleportEvent(
                      { threadId: record.context.threadId, messageId: record.receipt!.userMessageId },
                      useChatStore.getState().currentThreadId,
                      { pushThreadRoute: (id) => pushThreadRouteWithHistory(id, window), scrollToMessage },
                    );
                  }}
                >
                  查看原请求与回复
                </a>
              ) : (
                <button
                  type="button"
                  disabled={pending[record.clientMessageId]}
                  onClick={() => void sendExplorationRequest(record.context, record.clientMessageId)}
                >
                  重试同一请求
                </button>
              )}
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
