'use client';

import type { ApprovalItem, MeetingIntakeOutput } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { MeetingThreadDestinationPicker } from './MeetingThreadDestinationPicker';

const OUTPUTS: ReadonlyArray<{ id: MeetingIntakeOutput; label: string }> = [
  { id: 'minutes', label: '会议纪要' },
  { id: 'decisions', label: '决策清单' },
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'tasks', label: '行动项' },
];

interface RepairView {
  readonly code: string;
  readonly action: 'retry' | 'regrant' | 'manual_import';
  readonly safeDetail?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function repairView(value: unknown): RepairView | null {
  const candidate = record(value);
  if (
    typeof candidate.code !== 'string' ||
    (candidate.action !== 'retry' && candidate.action !== 'regrant' && candidate.action !== 'manual_import')
  ) {
    return null;
  }
  return {
    code: candidate.code,
    action: candidate.action,
    ...(typeof candidate.safeDetail === 'string' ? { safeDetail: candidate.safeDetail } : {}),
  };
}

function speakerText(value: unknown): string {
  return Object.entries(record(value))
    .map(([speaker, name]) => `${speaker}=${String(name)}`)
    .join('\n');
}

function parseSpeakers(value: string): Record<string, string> | null {
  const entries = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      return separator > 0 ? ([line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const) : null;
    });
  if (entries.length === 0 || entries.some((entry) => !entry?.[0] || !entry[1])) return null;
  return Object.fromEntries(entries as ReadonlyArray<readonly [string, string]>);
}

function errorMessage(body: unknown, status: number): string {
  const value = record(body);
  return typeof value.error === 'string' ? value.error : `操作失败 (${status})`;
}

export function MeetingIntakeCard({ item }: { item: ApprovalItem }) {
  const fetchPending = useApprovalHubStore((state) => state.fetchPending);
  const rawThreads = useChatStore((state) => state.threads as Thread[] | unknown);
  const currentProjectPath = useChatStore((state) => state.currentProjectPath);
  const isLoadingThreads = useChatStore((state) => state.isLoadingThreads);
  const threads = useMemo(
    () =>
      (Array.isArray(rawThreads) ? rawThreads : []).filter(
        (thread): thread is Thread =>
          typeof thread === 'object' &&
          thread !== null &&
          thread.createdBy !== 'system' &&
          !thread.deletedAt &&
          thread.systemKind === undefined,
      ),
    [rawThreads],
  );
  const detail = record(item.detail);
  const choices = record(detail.choices);
  const revision = Number.isSafeInteger(detail.revision) ? Number(detail.revision) : 0;
  const repair = repairView(detail.repair);
  const metadata = record(detail.metadata);
  const source = record(detail.source);

  const [speakers, setSpeakers] = useState(() => speakerText(choices.speakerMap));
  const [context, setContext] = useState(() => (typeof choices.context === 'string' ? choices.context : ''));
  const [destination, setDestination] = useState(() =>
    typeof choices.destinationHandle === 'string' ? choices.destinationHandle : '',
  );
  const [outputs, setOutputs] = useState<MeetingIntakeOutput[]>(() =>
    Array.isArray(choices.outputs)
      ? choices.outputs.filter((value): value is MeetingIntakeOutput => OUTPUTS.some((output) => output.id === value))
      : [],
  );
  const [manualTranscript, setManualTranscript] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedSpeakers = parseSpeakers(speakers);
  const canConfirm = Boolean(parsedSpeakers && context.trim() && destination && outputs.length > 0 && !busy);

  async function action(name: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/meeting-intakes/${item.proposalId}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(errorMessage(body, response.status));
        if (response.status === 409) await fetchPending();
        return null;
      }
      await fetchPending();
      return record(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!parsedSpeakers || !canConfirm) return;
    await action('confirm', {
      expectedRevision: revision,
      choices: {
        speakerMap: parsedSpeakers,
        context: context.trim(),
        destinationHandle: destination,
        outputs,
      },
    });
  }

  return (
    <article
      className="space-y-3 rounded-lg border border-[var(--cafe-border)] p-3"
      data-testid={`approval-item-${item.proposalId}`}
    >
      <header className="flex items-center gap-2">
        <span className="rounded-md bg-[var(--semantic-info)] px-1.5 py-0.5 text-micro font-medium text-[var(--cafe-surface)]">
          Meeting
        </span>
        <span className="text-micro font-medium text-[var(--cafe-text-secondary)]">Needs Me</span>
        <span className="ml-auto text-micro text-[var(--cafe-text-secondary)]">rev {revision}</span>
      </header>

      <div>
        <h3 className="text-sm font-semibold">{item.summary}</h3>
        <p className="mt-1 truncate text-micro text-[var(--cafe-text-secondary)]">
          {typeof source.handle === 'string' ? source.handle : '飞书会议记录'}
        </p>
        {typeof metadata.meetingId === 'string' && (
          <p className="text-micro text-[var(--cafe-text-secondary)]">Meeting {metadata.meetingId}</p>
        )}
      </div>

      {repair && (
        <div className="rounded-md bg-[var(--semantic-warning-subtle)] p-2 text-micro" data-testid="meeting-repair">
          <p className="font-medium">需要修复：{repair.code}</p>
          {repair.safeDetail && <p className="mt-1 text-[var(--cafe-text-secondary)]">{repair.safeDetail}</p>}
        </div>
      )}

      {detail.judgmentState === 'unresolved' && (
        <div className="space-y-2">
          <label className="block text-micro font-medium">
            说话人映射
            <textarea
              value={speakers}
              onChange={(event) => setSpeakers(event.target.value)}
              placeholder="1=You"
              rows={2}
              className="mt-1 w-full rounded-md border border-[var(--cafe-border)] bg-[var(--cafe-surface)] p-2 text-sm"
              data-testid="meeting-speakers"
            />
          </label>
          <label className="block text-micro font-medium">
            会议背景
            <textarea
              value={context}
              onChange={(event) => setContext(event.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-[var(--cafe-border)] bg-[var(--cafe-surface)] p-2 text-sm"
              data-testid="meeting-context"
            />
          </label>
          <MeetingThreadDestinationPicker
            threads={threads}
            value={destination}
            suggestedTitle={typeof metadata.title === 'string' ? metadata.title : '会议跟进'}
            projectPath={currentProjectPath}
            loading={isLoadingThreads}
            disabled={busy}
            onChange={setDestination}
          />
          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-1 text-micro font-medium">产物</legend>
            {OUTPUTS.map((output) => (
              <label key={output.id} className="flex items-center gap-1.5 text-micro">
                <input
                  type="checkbox"
                  checked={outputs.includes(output.id)}
                  onChange={(event) =>
                    setOutputs((current) =>
                      event.target.checked
                        ? [...current, output.id]
                        : current.filter((candidate) => candidate !== output.id),
                    )
                  }
                  data-testid={`meeting-output-${output.id}`}
                />
                {output.label}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!canConfirm}
            className="rounded-md bg-[var(--semantic-success)] px-3 py-1.5 text-micro font-medium text-[var(--cafe-surface)] disabled:opacity-50"
            data-testid="meeting-confirm"
          >
            {busy ? '处理中…' : '投递给猫猫整理'}
          </button>
        </div>
      )}

      {repair?.action === 'retry' && (
        <button
          type="button"
          onClick={() => void action('retry', { expectedRevision: revision })}
          disabled={busy}
          className="rounded-md bg-[var(--semantic-warning)] px-3 py-1.5 text-micro font-medium text-[var(--cafe-surface)] disabled:opacity-50"
          data-testid="meeting-retry"
        >
          重试
        </button>
      )}
      {repair?.action === 'regrant' && (
        <div className="flex flex-wrap gap-2">
          <a
            href="/settings?s=plugins"
            className="inline-block rounded-md bg-[var(--semantic-warning)] px-3 py-1.5 text-micro font-medium text-[var(--cafe-surface)]"
            data-testid="meeting-regrant"
          >
            去插件设置连接飞书
          </a>
          <button
            type="button"
            onClick={() => void action('retry', { expectedRevision: revision })}
            disabled={busy}
            className="rounded-md border border-[var(--semantic-warning)] px-3 py-1.5 text-micro font-medium disabled:opacity-50"
            data-testid="meeting-regrant-retry"
          >
            已连接，重试
          </button>
        </div>
      )}
      {repair?.action === 'manual_import' && (
        <div className="space-y-2">
          <textarea
            value={manualTranscript}
            onChange={(event) => setManualTranscript(event.target.value)}
            rows={5}
            placeholder="粘贴文字稿"
            className="w-full rounded-md border border-[var(--cafe-border)] bg-[var(--cafe-surface)] p-2 text-sm"
            data-testid="meeting-manual-transcript"
          />
          <button
            type="button"
            onClick={() => void action('manual-import', { expectedRevision: revision, transcript: manualTranscript })}
            disabled={busy || !manualTranscript.trim()}
            className="rounded-md bg-[var(--semantic-warning)] px-3 py-1.5 text-micro font-medium text-[var(--cafe-surface)] disabled:opacity-50"
            data-testid="meeting-manual-import"
          >
            导入并投递
          </button>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => void action('dismiss', { expectedRevision: revision })}
          disabled={busy}
          className="rounded-md border border-[var(--cafe-border)] px-3 py-1.5 text-micro hover:bg-[var(--cafe-muted)] disabled:opacity-50"
          data-testid="meeting-dismiss"
        >
          忽略这次会议
        </button>
        {error && <p className="text-micro text-[var(--semantic-error)]">{error}</p>}
      </div>
    </article>
  );
}
