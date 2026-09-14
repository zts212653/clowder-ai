'use client';

/**
 * Machine-local CLI availability for the member being edited.
 *
 * Read-only by design: a member's `cli` block is server-derived from the descriptor registry,
 * so this card never offers to edit it. Its job is to answer the question the editor could not
 * answer before — "is the CLI this member needs actually installed here?" — and, when it is
 * not, to hand over the exact install command instead of letting the first task fail.
 *
 * It only answers that question for members that dispatch through the standard local CLI path.
 * Availability is probed per clientId, but the need is per member and the two diverge: a
 * cloud-only member spawns no local CLI at all, an ACP member spawns a user-configured command
 * the probe never inspects, and bridge/remote clients have no local binary. For those the card
 * states the situation instead of reporting a binary the member will never run. See
 * `resolveMemberCliDispatch`.
 *
 * Detection is user-triggered rather than fetched on mount, on purpose. A self-fetching child
 * fires its request before its parent's effects do (React runs effects bottom-up), which
 * silently reorders any caller that queues responses in call order — it broke
 * `hub-cat-editor.test.tsx` exactly that way. It also means merely opening the editor would
 * touch the filesystem.
 *
 * Neither a failed request nor a failed re-check may read as "not installed": the first shows
 * an unavailable notice, the second keeps the previous results on screen.
 */

import type { ProviderAvailability } from '@cat-cafe/shared';
import { getClientDescriptor } from '@cat-cafe/shared';
import { type ReactNode, useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { MemberCliDispatch } from './hub-cat-editor.model';

interface ClientsResponse {
  detectedAt?: string;
  /** Age of the report in ms, derived server-side from `detectedAt`. `null` = unknown. */
  ageMs?: number | null;
  providers?: ProviderAvailability[];
}

interface ProviderCliStatusProps {
  clientId: string;
  /** How the edited member reaches a runtime; only `cli` may be answered by the probe. */
  dispatch: MemberCliDispatch;
}

type Phase = 'idle' | 'loading' | 'ready' | 'failed';

function StatusPill({ tone, children }: { tone: 'ok' | 'missing' | 'neutral'; children: ReactNode }) {
  const classes =
    tone === 'ok'
      ? 'bg-conn-green-bg text-conn-green-text'
      : tone === 'missing'
        ? 'bg-conn-amber-bg text-conn-amber-text'
        : 'text-cafe-muted';
  return <span className={`rounded-lg px-2 py-0.5 text-xs font-medium ${classes}`}>{children}</span>;
}

const ACTION_BUTTON_CLASS =
  'rounded-lg border border-[var(--console-border-soft)] px-2 py-0.5 text-xs text-cafe-muted transition hover:border-conn-amber-ring disabled:opacity-50';

/**
 * Render the report's age.
 *
 * The card shows the age rather than a bare verdict because a verdict is only as good as when it
 * was taken; whether an age counts as "too old to act on" is a caller decision, so no threshold
 * is applied here. `null` means the server could not derive an age, which must read as unknown —
 * never as just-checked.
 */
function formatReportAge(ageMs: number | null | undefined): string {
  if (ageMs === null || ageMs === undefined) return '未知（无法判断是否过期）';
  if (ageMs < 60_000) return '刚刚';
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** Members the clientId-level probe cannot speak for. */
function NonCliDispatchNotice({ dispatch }: { dispatch: Exclude<MemberCliDispatch, { kind: 'cli' }> }) {
  if (dispatch.kind === 'cloud') {
    return (
      <p className="text-xs leading-5 text-cafe-muted">
        该成员由云端提供（provider：{dispatch.provider}），不派发本机 CLI，无需检测。
      </p>
    );
  }
  if (dispatch.kind === 'acp') {
    return (
      <p className="break-all text-xs leading-5 text-cafe-muted">
        该成员使用 ACP 自定义命令：{dispatch.command}。CLI 探测不检查自定义命令，请在终端确认它可直接执行。
      </p>
    );
  }
  return (
    <p className="text-xs leading-5 text-cafe-muted">该成员不通过标准本地 CLI 派发（bridge / 远程），无需检测。</p>
  );
}

export function ProviderCliStatus({ clientId, dispatch }: ProviderCliStatusProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [providers, setProviders] = useState<ProviderAvailability[] | null>(null);
  const [reportAgeMs, setReportAgeMs] = useState<number | null | undefined>(undefined);
  // Kept separate from `phase` on purpose: a re-detect must not blank the results the user is
  // already reading. `phase === 'loading'` is unreachable once results are on screen, so
  // gating the button on it was both a dead branch and a TypeScript error (TS2367) under the
  // production build.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const load = useCallback(async (options: { refresh?: boolean } = {}) => {
    setRefreshError(null);
    if (options.refresh) {
      setRefreshing(true);
    } else {
      setPhase('loading');
    }
    try {
      const res = options.refresh
        ? await apiFetch('/api/clients/refresh', { method: 'POST' })
        : await apiFetch('/api/clients');
      if (!res.ok) throw new Error(`clients request failed (${res.status})`);
      const body = (await res.json()) as ClientsResponse;
      setProviders(Array.isArray(body.providers) ? body.providers : []);
      setReportAgeMs(body.ageMs);
      setPhase('ready');
    } catch {
      if (options.refresh) {
        // Keep what the user is reading. A re-check is owner-gated, so a 403 here is an
        // expected outcome for a non-owner, not a reason to blank a good report.
        setRefreshError('重新检测失败，下面显示的仍是上一次的结果。');
        return;
      }
      // Availability is advisory — an unreachable endpoint must not look like "not installed".
      setProviders(null);
      setPhase('failed');
    } finally {
      if (options.refresh) setRefreshing(false);
    }
  }, []);

  if (dispatch.kind !== 'cli') {
    return <NonCliDispatchNotice dispatch={dispatch} />;
  }

  if (phase === 'idle') {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-3">
        <span className="text-xs font-semibold text-cafe-secondary">本机 CLI 状态</span>
        <button type="button" onClick={() => void load()} className={ACTION_BUTTON_CLASS}>
          检测本机 CLI
        </button>
        <span className="text-xs text-cafe-muted">确认这个成员需要的 CLI 是否已安装</span>
      </div>
    );
  }

  if (phase === 'failed') {
    // Detection is click-triggered, so without a retry here a failed first attempt would leave
    // the user with no way back inside this mount — they would have to close and reopen the
    // editor. Network blips and an API that is still starting are the ordinary cases.
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-3">
        <span className="text-xs leading-5 text-cafe-muted">本机 CLI 状态不可用（/api/clients 请求失败）</span>
        <button type="button" onClick={() => void load()} className={ACTION_BUTTON_CLASS}>
          重试
        </button>
      </div>
    );
  }

  if (phase === 'loading' || !providers) {
    return <p className="text-xs leading-5 text-cafe-muted">正在检测本机已安装的 CLI…</p>;
  }

  const current = providers.find((provider) => provider.clientId === clientId);
  const installed = providers.filter((provider) => provider.installed && provider.localCli);
  // The canonical command for this client, per the descriptor registry. A resolved candidate that
  // differs (google's legacy `gemini` vs its default `agy`) is worth naming, but it is NOT by
  // itself a warning: some providers probe candidates in their own order, so a difference does not
  // imply a mismatch.
  const expectedCommand = getClientDescriptor(clientId)?.defaultCli.command;

  return (
    <div className="space-y-2 rounded-xl border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold text-cafe-secondary">本机 CLI 状态</span>
        <button
          type="button"
          onClick={() => void load({ refresh: true })}
          disabled={refreshing}
          className={ACTION_BUTTON_CLASS}
        >
          重新检测
        </button>
      </div>

      {refreshError ? <p className="text-xs leading-5 text-conn-amber-text">{refreshError}</p> : null}

      {current && (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-cafe">{current.label}</span>
            {current.status === 'configured' && <StatusPill tone="ok">已安装</StatusPill>}
            {current.status === 'missing' && <StatusPill tone="missing">未安装</StatusPill>}
            {current.status === 'unsupported' && <StatusPill tone="neutral">无需本机 CLI</StatusPill>}
            {current.status === 'error' && <StatusPill tone="missing">配置有误</StatusPill>}
            {current.version && <span className="text-xs text-cafe-muted">{current.version}</span>}
          </div>
          {current.status === 'configured' && (
            <p className="break-all text-xs leading-5 text-cafe-muted">
              本机解析到：{current.command}
              {expectedCommand && current.command !== expectedCommand
                ? `（该 client 的默认命令是 ${expectedCommand}）`
                : ''}
            </p>
          )}
          {current.status === 'configured' && current.resolvedPath && (
            <p className="break-all text-xs leading-5 text-cafe-muted">路径：{current.resolvedPath}</p>
          )}
          {current.reason && <p className="text-xs leading-5 text-conn-amber-text">{current.reason}</p>}
          {(current.status === 'missing' || current.status === 'error') && (
            <p className="break-all text-xs leading-5 text-cafe-muted">安装命令：{current.installHint}</p>
          )}
          {current.status === 'configured' && (
            // "已安装" is a statement about this machine, not about this member. Which binary the
            // member actually spawns is decided at runtime — a provider adapter can pick a
            // different candidate than the one that resolved here, and detection has no way to
            // know. Saying so keeps the pill from reading as "this member will work".
            <p className="text-xs leading-5 text-cafe-muted">
              该成员实际执行的二进制由运行时决定，此处只报告本机解析结果。
            </p>
          )}
        </div>
      )}

      <p className="text-xs leading-5 text-cafe-muted">报告时间：{formatReportAge(reportAgeMs)}</p>

      <p className="text-xs leading-5 text-cafe-muted">
        {installed.length > 0
          ? `本机已安装：${installed.map((provider) => provider.label).join('、')}`
          : '本机未检测到任何本地 CLI。'}
      </p>
    </div>
  );
}
