'use client';

import type { RuntimeInteractionRecord, RuntimeInteractionResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RichCardBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { RuntimeInteractionDecisionActions } from './RuntimeInteractionDecisionActions';
import { RuntimeInteractionElicitationForm } from './RuntimeInteractionElicitationForm';
import { RuntimeInteractionQuestionForm } from './RuntimeInteractionQuestionForm';

export function isRuntimeInteractionCardBlock(block: RichCardBlock): boolean {
  return block.meta?.kind === 'runtime_interaction' && typeof block.meta.interactionId === 'string';
}

export function RuntimeInteractionCard({ block, messageId }: { block: RichCardBlock; messageId?: string }) {
  const interactionId = String(block.meta?.interactionId ?? '');
  const [record, setRecord] = useState<RuntimeInteractionRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchGeneration = useRef(0);
  const submittingRef = useRef(false);

  const hydrate = useCallback(async () => {
    const generation = ++fetchGeneration.current;
    setLoading(true);
    try {
      const response = await apiFetch(`/api/runtime-interactions/${encodeURIComponent(interactionId)}`);
      if (!response.ok) throw new Error('交互状态同步失败');
      const body = (await response.json()) as { interaction: RuntimeInteractionRecord };
      if (fetchGeneration.current === generation && !submittingRef.current) {
        setRecord(body.interaction);
        setError(null);
      }
    } catch (caught) {
      if (fetchGeneration.current === generation) setError(errorMessage(caught));
    } finally {
      if (fetchGeneration.current === generation) setLoading(false);
    }
  }, [interactionId]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ interactionId?: string }>).detail;
      if (detail?.interactionId === interactionId) void hydrate();
    };
    window.addEventListener('cat-cafe:runtime-interaction-updated', handler);
    return () => window.removeEventListener('cat-cafe:runtime-interaction-updated', handler);
  }, [hydrate, interactionId]);

  const submit = async (runtimeResponse: RuntimeInteractionResponse): Promise<void> => {
    if (!record?.cardRef || submittingRef.current) return;
    submittingRef.current = true;
    fetchGeneration.current += 1;
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/runtime-interactions/${encodeURIComponent(interactionId)}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardRef: record.cardRef, response: runtimeResponse }),
      });
      const body = await readSubmitBody(response);
      if (response.status === 409) {
        submittingRef.current = false;
        setSubmitting(false);
        await hydrate();
        return;
      }
      if (!response.ok || !body.interaction) throw new Error(body.error ?? '提交失败');
      fetchGeneration.current += 1;
      setRecord(body.interaction);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const canonical = Boolean(
    record?.cardRef && messageId === record.cardRef.messageId && block.id === record.cardRef.blockId,
  );

  return (
    <section
      className="rounded-2xl border border-cafe bg-cafe-surface p-3 shadow-sm"
      data-testid="runtime-interaction-card"
    >
      <header className="mb-3 flex items-start gap-2">
        <div className="min-w-0">
          <p className="text-micro font-medium text-[var(--semantic-info)]">{kindLabel(record?.request.kind)}</p>
          <h3 className="text-sm font-semibold">{record?.request.title ?? block.title}</h3>
          {record?.request.description ? (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-cafe-muted">{record.request.description}</p>
          ) : null}
        </div>
        <span className="ml-auto text-micro text-cafe-muted">{statusLabel(record?.status)}</span>
      </header>

      {loading && !record ? <p className="text-sm text-cafe-muted">正在同步请求…</p> : null}
      {error ? <p className="mb-2 text-sm text-[var(--semantic-critical)]">{error}</p> : null}
      {record && record.status === 'staged' ? <p className="text-sm text-cafe-muted">正在准备请求…</p> : null}
      {record && record.status !== 'staged' && !canonical ? (
        <p className="text-sm text-cafe-muted">只读副本：请回到原消息处理这个请求。</p>
      ) : null}
      {record && canonical && record.status !== 'staged' && record.status !== 'pending' ? (
        <TerminalState record={record} />
      ) : null}
      {record && canonical && record.status === 'pending' ? (
        <PendingSurface record={record} disabled={submitting} onSubmit={(response) => void submit(response)} />
      ) : null}
    </section>
  );
}

function PendingSurface({
  record,
  disabled,
  onSubmit,
}: {
  record: RuntimeInteractionRecord;
  disabled: boolean;
  onSubmit: (response: RuntimeInteractionResponse) => void;
}) {
  const request = record.request;
  if (request.kind === 'question') {
    return <RuntimeInteractionQuestionForm request={request} disabled={disabled} onSubmit={onSubmit} />;
  }
  if (request.kind === 'elicitation') {
    return <RuntimeInteractionElicitationForm request={request} disabled={disabled} onSubmit={onSubmit} />;
  }
  return (
    <RuntimeInteractionDecisionActions
      decisions={request.decisions}
      disabled={disabled}
      onSelect={(decision) => onSubmit({ kind: 'decision', decisionId: decision.id })}
    />
  );
}

function TerminalState({ record }: { record: RuntimeInteractionRecord }) {
  return <p className="text-sm text-cafe-muted">{terminalCopy(record)}</p>;
}

function terminalCopy(record: RuntimeInteractionRecord): string {
  if (record.status === 'answered') return record.request.kind === 'question' ? '回答已提交。' : '请求已处理。';
  if (record.terminal?.reasonCode === 'user_rejected') return '你已拒绝这次请求。';
  if (record.terminal?.reasonCode === 'user_cancelled') return '你已取消这次请求。';
  if (record.terminal?.reasonCode === 'host_restarted') return '服务重启后，这个旧请求已失效。';
  if (record.terminal?.reasonCode === 'transport_lost') return '运行连接已中断，这个请求已失效。';
  if (record.terminal?.reasonCode === 'confirmation_unavailable') return '此运行没有可用的确认界面。';
  if (record.terminal?.reasonCode === 'surface_publication_failed') return '请求界面发布失败，未执行任何操作。';
  return '这个请求已失效，不能再提交。';
}

function kindLabel(kind: RuntimeInteractionRecord['request']['kind'] | undefined): string {
  if (kind === 'approval') return '需要确认';
  if (kind === 'question') return '需要回答';
  if (kind === 'elicitation') return '需要补充';
  return '运行时请求';
}

function statusLabel(status: RuntimeInteractionRecord['status'] | undefined): string {
  if (!status || status === 'staged') return '同步中';
  if (status === 'pending') return '等待你处理';
  if (status === 'answered') return '已处理';
  if (status === 'declined') return '已拒绝';
  if (status === 'cancelled') return '已取消';
  return '已失效';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readSubmitBody(
  response: Response,
): Promise<{ interaction?: RuntimeInteractionRecord; error?: string; reasonCode?: string }> {
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object'
      ? (body as { interaction?: RuntimeInteractionRecord; error?: string; reasonCode?: string })
      : {};
  } catch {
    return {};
  }
}
