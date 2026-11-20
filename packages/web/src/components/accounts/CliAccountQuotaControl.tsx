'use client';
import { useEffect, useRef, useState } from 'react';
import { AppTooltip } from '../AppTooltip';
import { AccountRequestError, accountRequest } from '../codex-accounts/account-request';
import { quotaQueryTime } from '../codex-accounts/QuotaQueryFeedback';
import { quotaCopy } from '../codex-accounts/quota.shell-copy';
import type { AgyAccountQuotaView, KimiAccountQuotaView, ProfileItem } from '../hub-accounts.types';
import {
  agyAccountQuotaReady,
  projectAgyWindows,
  projectKimiWindows,
  type QuotaRingWindowView,
} from '../shell/quota-pin/quota-pin-model';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { claudeQuotaCopy } from './claude-quota.shell-copy';
import '../codex-accounts/codex-quota.css';
import './claude-quota.css';

type CliQuotaView = AgyAccountQuotaView | KimiAccountQuotaView;

const KNOWN_AGY_POOLS = ['agy-gemini', 'agy-claude-gpt'] as const;

function pickTightestInScope(scopedWindows: readonly QuotaRingWindowView[]): QuotaRingWindowView | undefined {
  const percentWindows = scopedWindows.filter(
    (w): w is QuotaRingWindowView & { remainingPercent: number } => w.remainingPercent !== undefined,
  );
  const nonElapsed = percentWindows.filter((w) => !w.elapsed);
  const candidates = nonElapsed.length > 0 ? nonElapsed : percentWindows;
  if (candidates.length === 0) return scopedWindows[0];
  return candidates.reduce((min, cur) => (cur.remainingPercent < min.remainingPercent ? cur : min));
}

function groupAgyPoolScopes(windows: readonly QuotaRingWindowView[]): QuotaRingWindowView[][] {
  const scopes: QuotaRingWindowView[][] = [];
  for (const poolId of KNOWN_AGY_POOLS) {
    const group = windows.filter((w) => w.poolId === poolId);
    if (group.length > 0) scopes.push(group);
  }
  const extraPools = new Map<string, QuotaRingWindowView[]>();
  for (const win of windows) {
    if (win.poolId === 'agy-gemini' || win.poolId === 'agy-claude-gpt') continue;
    const key = win.poolId ?? '__unpooled__';
    const group = extraPools.get(key) ?? [];
    group.push(win);
    extraPools.set(key, group);
  }
  scopes.push(...extraPools.values());
  return scopes;
}

export function computeTightestWindowIds(windows: readonly QuotaRingWindowView[], kind: 'agy' | 'kimi'): Set<string> {
  const result = new Set<string>();
  if (!windows.length) return result;
  const scopes = kind === 'agy' ? groupAgyPoolScopes(windows) : [[...windows]];
  for (const scope of scopes) {
    const picked = pickTightestInScope(scope);
    if (picked) result.add(picked.id);
  }
  return result;
}

function suppliedQuotaForKind(kind: 'agy' | 'kimi', account: ProfileItem): CliQuotaView | undefined {
  return kind === 'agy' ? account.agyQuota : account.kimiQuota;
}

function buildPropSignature(kind: 'agy' | 'kimi', account: ProfileItem): string {
  const ready = kind === 'agy' ? agyAccountQuotaReady(account) : account.kimiLoginReady === true;
  const supplied = suppliedQuotaForKind(kind, account);
  const ownerPart = supplied
    ? `${supplied.owner.accountRef}:${supplied.owner.credentialVersion}:${supplied.observedAt}`
    : 'none';
  return `${kind}|${account.id}|${ready}|${ownerPart}`;
}

function resolveEffectiveQuota(
  accountId: string,
  supplied: CliQuotaView | undefined,
  localOverride: { generation: number; quota: CliQuotaView } | null,
  currentGen: number,
): CliQuotaView | undefined {
  const validLocal =
    localOverride &&
    localOverride.generation === currentGen &&
    localOverride.quota.owner.accountRef === accountId &&
    Boolean(localOverride.quota.owner.credentialVersion)
      ? localOverride.quota
      : undefined;
  if (!validLocal) return supplied;
  if (!supplied || supplied.owner.accountRef !== accountId || !supplied.owner.credentialVersion) {
    return validLocal;
  }
  if (supplied.owner.credentialVersion !== validLocal.owner.credentialVersion) {
    return supplied;
  }
  return validLocal.observedAt >= supplied.observedAt ? validLocal : supplied;
}

function canApplyReturnedQuota(
  accountId: string,
  latestSupplied: CliQuotaView | undefined,
  returned: CliQuotaView | undefined,
): returned is CliQuotaView {
  if (!returned || returned.owner.accountRef !== accountId || !returned.owner.credentialVersion) {
    return false;
  }
  if (!latestSupplied || latestSupplied.owner.accountRef !== accountId || !latestSupplied.owner.credentialVersion) {
    return true;
  }
  return (
    latestSupplied.owner.credentialVersion === returned.owner.credentialVersion &&
    returned.observedAt >= latestSupplied.observedAt
  );
}

function classifyQuotaError(error: unknown, ct: (typeof claudeQuotaCopy)['zh']): string {
  if (error instanceof AccountRequestError && error.status === 409) return ct.changed;
  const msg = error instanceof Error ? error.message : '';
  if (msg === 'agy_quota_owner_unknown' || msg === 'kimi_quota_owner_unknown') return ct.ownerUnknown;
  return ct.unavailable;
}

async function safeReloadAndNotify(reload: () => Promise<void>): Promise<void> {
  try {
    await reload();
  } catch {
    // Directory GET failure must not masquerade as a quota POST error or resurrect stale state.
  }
  window.dispatchEvent(new Event('accounts-changed'));
}

function QuotaWindowItem({
  win,
  tightest,
  ct,
  qt,
  formatReset,
}: {
  win: QuotaRingWindowView;
  tightest: boolean;
  ct: (typeof claudeQuotaCopy)['zh'];
  qt: (typeof quotaCopy)['zh'];
  formatReset: (win: QuotaRingWindowView) => string;
}) {
  const rawPct = win.remainingPercent === undefined ? 0 : win.remainingPercent;
  const rounded = Math.round(rawPct);
  const clamped = Math.max(0, Math.min(100, rawPct));
  const valueLabel = ct.left(rawPct.toFixed(0));
  const resetText = formatReset(win);
  const activeLow = !win.elapsed && win.low;

  return (
    <div
      className="account-quota-window claude-quota-reading"
      data-tightest={tightest}
      data-low={activeLow}
      data-stale={win.stale}
      data-elapsed={win.elapsed}
    >
      <div className="account-quota-summary">
        <span className="account-quota-label" title={win.label}>
          {win.label}
        </span>
        <span className="account-quota-value">{valueLabel}</span>
        {activeLow && <span className="account-quota-warning">{win.exhausted ? qt.usedUp : qt.nearLimit}</span>}
      </div>
      <span
        role="meter"
        aria-label={win.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={rounded}
        aria-valuetext={valueLabel}
        className="account-quota-meter"
      >
        <span style={{ width: `${clamped}%` }} />
      </span>
      <span className="account-quota-reset" title={resetText}>
        {resetText}
      </span>
    </div>
  );
}

export function CliAccountQuotaControl({
  kind,
  account,
  reload,
}: {
  kind: 'agy' | 'kimi';
  account: ProfileItem;
  reload: () => Promise<void>;
}) {
  const ct = useShellCopy(claudeQuotaCopy);
  const qt = useShellCopy(quotaCopy);
  const language = useShellLanguage();
  const locale = language === 'zh' ? 'zh-CN' : 'en-US';

  const signature = buildPropSignature(kind, account);
  const generationRef = useRef(0);
  const lastSignatureRef = useRef(signature);
  if (lastSignatureRef.current !== signature) {
    generationRef.current += 1;
    lastSignatureRef.current = signature;
  }
  const currentGen = generationRef.current;

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const latestRef = useRef({ account, reload });
  latestRef.current = { account, reload };
  const inFlightRef = useRef<{ ticket: symbol; generation: number } | null>(null);

  const [localOverride, setLocalOverride] = useState<{ generation: number; quota: CliQuotaView } | null>(null);
  const [pendingGen, setPendingGen] = useState<number | null>(null);
  const [errorState, setErrorState] = useState<{ generation: number; message: string } | null>(null);
  const [now, setNow] = useState(Date.now);

  const supplied = suppliedQuotaForKind(kind, account);
  const effectiveQuota = resolveEffectiveQuota(account.id, supplied, localOverride, currentGen);
  const effectiveAccount: ProfileItem =
    kind === 'agy'
      ? { ...account, agyQuota: effectiveQuota as AgyAccountQuotaView | undefined }
      : { ...account, kimiQuota: effectiveQuota as KimiAccountQuotaView | undefined };

  const windows =
    kind === 'agy'
      ? projectAgyWindows(effectiveAccount, now, language)
      : projectKimiWindows(effectiveAccount, now, language);

  const futureResets = windows.flatMap((w) => (w.resetsAtMs && w.resetsAtMs > now ? [w.resetsAtMs] : []));
  const nextTick = Math.min(60_000, ...futureResets.map((time) => time - now + 1));
  const tickAt = now + nextTick;
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), Math.max(1, tickAt - Date.now()));
    return () => clearTimeout(timer);
  }, [tickAt]);

  const formatDate = (ms: number) =>
    new Date(ms).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  const formatReset = (win: QuotaRingWindowView) => {
    if (win.elapsed) return ct.resetElapsed;
    if (win.resetsAtMs !== undefined) return ct.resets(formatDate(win.resetsAtMs));
    return win.resetsText ? win.resetsText : ct.resetUnknown;
  };

  function applyQueryResult(
    requestedAccountId: string,
    requestedGen: number,
    result: { agyQuota?: AgyAccountQuotaView; kimiQuota?: KimiAccountQuotaView },
  ) {
    const returned = kind === 'agy' ? result.agyQuota : result.kimiQuota;
    const latestSupplied = suppliedQuotaForKind(kind, latestRef.current.account);
    if (canApplyReturnedQuota(requestedAccountId, latestSupplied, returned)) {
      setLocalOverride({ generation: requestedGen, quota: returned });
    }
    setNow(Date.now());
  }

  async function query() {
    if (inFlightRef.current?.generation === currentGen) return;
    const requestedGen = currentGen;
    const requestedAccountId = account.id;
    const ticket = Symbol();
    inFlightRef.current = { ticket, generation: requestedGen };
    setPendingGen(requestedGen);
    setErrorState(null);
    try {
      const result = await accountRequest<{ agyQuota?: AgyAccountQuotaView; kimiQuota?: KimiAccountQuotaView }>(
        `/api/accounts/${encodeURIComponent(requestedAccountId)}/${kind}/quota`,
        {},
      );
      if (!mountedRef.current || generationRef.current !== requestedGen) return;
      applyQueryResult(requestedAccountId, requestedGen, result);
      await safeReloadAndNotify(latestRef.current.reload);
    } catch (e) {
      if (!mountedRef.current || generationRef.current !== requestedGen) return;
      setErrorState({ generation: requestedGen, message: classifyQuotaError(e, ct) });
      await safeReloadAndNotify(latestRef.current.reload);
    } finally {
      if (mountedRef.current && inFlightRef.current?.ticket === ticket) {
        inFlightRef.current = null;
        setPendingGen((prev) => (prev === requestedGen ? null : prev));
      }
    }
  }

  const busy = pendingGen === currentGen;
  const error = errorState?.generation === currentGen ? errorState.message : '';
  const tightestIds = computeTightestWindowIds(windows, kind);
  const observedAt = windows[0]?.observedAt;
  const anyStale = windows.some((w) => w.stale);

  return (
    <div className="account-quota" aria-busy={busy}>
      {windows.length > 0 ? (
        <>
          <div className="account-quota-main">
            <div className="account-quota-windows">
              {windows.map((win) => (
                <QuotaWindowItem
                  key={win.id}
                  win={win}
                  tightest={tightestIds.has(win.id)}
                  ct={ct}
                  qt={qt}
                  formatReset={formatReset}
                />
              ))}
            </div>
            {observedAt !== undefined && (
              <AppTooltip label={`${qt.refresh} · ${qt.updated(quotaQueryTime(observedAt, language))}`}>
                <button
                  type="button"
                  className="account-quota-refresh"
                  aria-label={qt.refresh}
                  disabled={busy}
                  onClick={() => void query()}
                >
                  <svg
                    className={busy ? 'account-quota-spinning' : undefined}
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7M20 12l-3-5" />
                  </svg>
                </button>
              </AppTooltip>
            )}
          </div>
          {observedAt !== undefined && (
            <small className="claude-quota-time">
              {anyStale ? `${ct.stale} · ` : ''}
              {ct.observed(formatDate(observedAt))}
            </small>
          )}
        </>
      ) : (
        <div className="claude-quota">
          <div className="account-quota-windows">
            <small>{ct.unknown}</small>
          </div>
          <button
            type="button"
            className="account-button account-quota-query"
            disabled={busy}
            onClick={() => void query()}
          >
            {busy ? qt.querying : qt.check}
          </button>
        </div>
      )}
      {error && (
        <small role="alert" className="account-quota-error">
          {error}
        </small>
      )}
    </div>
  );
}
