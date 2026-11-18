import {
  type AccountQuotaObservation,
  accountQuotaOwnerMatches,
  builtinAccountIdForClient,
  claudeQuotaWindows,
} from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import {
  accountDisplayName,
  accountIsSelected,
  accountLoginReady,
  accountMembers,
  accountProvider,
} from '../../accounts/account-directory-view';
import { accountMessage } from '../../accounts/account-message';
import { accountsCopy } from '../../accounts/accounts.shell-copy';
import { claudeQuotaCopy } from '../../accounts/claude-quota.shell-copy';
import { remainingQuota } from '../../codex-accounts/quota-state';
import type { AccountSelection, ProfileItem } from '../../hub-accounts.types';

export const QUOTA_STALE_THRESHOLD_MS = 10 * 60_000;

export type QuotaFamilyId = 'claude' | 'codex' | 'agy' | 'kimi';

export const QUOTA_FAMILY_ORDER: readonly QuotaFamilyId[] = ['claude', 'codex', 'agy', 'kimi'] as const;

export const QUOTA_FAMILY_COLOR_TOKEN: Readonly<Record<QuotaFamilyId, string>> = {
  claude: 'var(--family-ragdoll-ring)',
  codex: 'var(--family-mainecoon-ring)',
  agy: 'var(--family-siamese-ring)',
  kimi: 'var(--family-turkish-van-ring)',
};

export interface KimiAccountQuotaView {
  readonly owner: {
    readonly accountRef: string;
    readonly credentialVersion: string;
  };
  readonly observedAt: number;
  readonly items: AccountQuotaObservation['items'];
}

export interface AgyAccountQuotaView {
  readonly owner: {
    readonly accountRef: string;
    readonly credentialVersion: string;
  };
  readonly observedAt: number;
  readonly items: AccountQuotaObservation['items'];
}

export type QuotaRingProfileItem = ProfileItem & {
  readonly kimiLoginReady?: boolean;
  readonly kimiQuota?: KimiAccountQuotaView;
  readonly agyQuotaReady?: boolean;
  readonly agyQuota?: AgyAccountQuotaView;
};

export interface QuotaRingWindowView {
  readonly id: string;
  readonly poolId?: string;
  readonly label: string;
  readonly kind: 'percent' | 'credits';
  readonly remainingPercent?: number;
  readonly creditsValue?: number;
  readonly low: boolean;
  readonly exhausted: boolean;
  readonly resetsAtMs?: number;
  readonly resetsText?: string;
  readonly elapsed: boolean;
  readonly observedAt: number;
  readonly stale: boolean;
}

export interface QuotaRingAccountView {
  readonly id: string;
  readonly family: QuotaFamilyId;
  readonly provider: string;
  readonly displayName: string;
  readonly inUse: boolean;
  readonly activeMemberCount: number;
  readonly isActiveForFamily: boolean;
  readonly canRefresh: boolean;
  readonly refreshKind: 'codex' | 'claude' | 'agy' | 'kimi' | null;
  readonly windows: readonly QuotaRingWindowView[];
}

export interface QuotaFamilyBarSummary {
  readonly family: QuotaFamilyId;
  readonly remainingPercent: number | null;
  readonly low: boolean;
  readonly exhausted: boolean;
}

export interface QuotaRingSummary {
  readonly hasReading: boolean;
  readonly bars: readonly QuotaFamilyBarSummary[];
  readonly tightestPercent: number | null;
  readonly low: boolean;
  readonly exhausted: boolean;
}

function familyForAccount(account: ProfileItem): QuotaFamilyId | null {
  if (account.googleCloud) return null;
  if (account.clientId === 'anthropic') return 'claude';
  if (account.clientId === 'openai') return 'codex';
  if (account.clientId === 'google') return 'agy';
  if (account.clientId === 'kimi') return 'kimi';
  return null;
}

function codexWindowShortLabel(label: string, language: 'zh' | 'en'): string {
  const weekly = /^(.*?)(?:每周使用限额|Weekly usage limit)$/i.exec(label);
  if (weekly) return `${weekly[1]}${language === 'zh' ? '本周' : 'Week'}`;
  const hours = /^(.*?)(\d+)小时使用限额$/.exec(label);
  if (hours) return `${hours[1]}${hours[2]}${language === 'zh' ? ' 小时' : ' hours'}`;
  return accountMessage(label, language);
}

function localizeResetText(raw: string | undefined, language: 'zh' | 'en'): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^reset$/i.test(trimmed)) {
    return language === 'zh' ? '已重置' : 'Reset';
  }
  if (language === 'zh') {
    const match = /^Resets in\s+(.+)$/i.exec(trimmed);
    if (match?.[1]) return `${match[1].trim()} 后重置`;
  }
  return raw;
}

function parseRelativeDurationMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^reset$/i.test(trimmed)) return 0;
  const body = trimmed.replace(/^resets\s+in\s+/i, '').trim();
  if (!body) return undefined;
  const tokenRe = /(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)(?=\s|$|\d|,)/gi;
  let totalMs = 0;
  let matchedCount = 0;
  for (const match of body.matchAll(tokenRe)) {
    const value = Number.parseFloat(match[1] ?? '');
    const unit = (match[2] ?? '').toLowerCase()[0];
    if (!Number.isFinite(value) || value < 0) return undefined;
    const unitMs =
      unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 0;
    if (!unitMs) return undefined;
    totalMs += Math.round(value * unitMs);
    matchedCount += 1;
  }
  if (matchedCount === 0 || totalMs < 0) return undefined;
  const remainder = body.replace(tokenRe, '').replace(/[\s,]+/g, '');
  if (remainder.length > 0) return undefined;
  return totalMs;
}

function projectCodexWindows(account: ProfileItem, now: number, language: 'zh' | 'en'): QuotaRingWindowView[] {
  const quota = account.quota;
  const native = account.nativeLogin?.identity;
  const identity = account.codex?.identity ?? (native?.userId ? { ...native, userId: native.userId } : undefined);
  const reading = quota?.status === 'ok' ? quota : quota?.lastSuccess;
  if (
    !accountLoginReady(account) ||
    !reading?.items.length ||
    !identity ||
    !accountQuotaOwnerMatches(quota, account.id, identity)
  ) {
    return [];
  }
  return reading.items.map((item, idx) => {
    const parsedReset = item.resetsAt ? Date.parse(item.resetsAt) : NaN;
    const resetsAtMs = Number.isFinite(parsedReset) ? parsedReset : undefined;
    const elapsed = resetsAtMs !== undefined && now >= resetsAtMs;
    const stale =
      quota?.status !== 'ok' ||
      elapsed ||
      now - reading.observedAt >= QUOTA_STALE_THRESHOLD_MS ||
      reading.observedAt > now;
    if (item.poolId === 'codex-overflow') {
      return {
        id: `${item.poolId}:${idx}`,
        label: codexWindowShortLabel(item.label, language),
        kind: 'credits',
        creditsValue: Math.round(item.usedPercent),
        low: false,
        exhausted: false,
        resetsAtMs,
        resetsText: localizeResetText(item.resetsText, language),
        elapsed,
        observedAt: reading.observedAt,
        stale,
      };
    }
    const pct = remainingQuota(item);
    return {
      id: `${item.poolId ?? 'main'}:${item.label}:${idx}`,
      label: codexWindowShortLabel(item.label, language),
      kind: 'percent',
      remainingPercent: pct,
      low: pct < 20,
      exhausted: pct <= 0,
      resetsAtMs,
      resetsText: localizeResetText(item.resetsText, language),
      elapsed,
      observedAt: reading.observedAt,
      stale,
    };
  });
}

function claudeWindowLabel(key: string, model: string, ct: (typeof claudeQuotaCopy)['zh']): string {
  if (key === 'five_hour') return ct.fiveHour;
  if (key === 'seven_day') return ct.weekly;
  if (key === 'seven_day_overage_included' && /fable/i.test(model)) return ct.fable;
  return `${key} (${model})`;
}

function projectClaudeWindows(account: ProfileItem, now: number, language: 'zh' | 'en'): QuotaRingWindowView[] {
  const ct = claudeQuotaCopy[language];
  const raw = claudeQuotaWindows(account.claudeQuota?.samples ?? {});
  return raw.flatMap((window) => {
    if (window.utilization === undefined) return [];
    const pct = Math.max(0, Math.min(100, (1 - window.utilization) * 100));
    const resetsAtMs = window.resetsAt !== undefined ? window.resetsAt * 1000 : undefined;
    const elapsed = resetsAtMs !== undefined && now >= resetsAtMs;
    const stale = elapsed || now - window.observedAt >= QUOTA_STALE_THRESHOLD_MS || window.observedAt > now;
    return [
      {
        id: `${window.model}:${window.key}`,
        label: claudeWindowLabel(window.key, window.model, ct),
        kind: 'percent' as const,
        remainingPercent: pct,
        low: pct < 20,
        exhausted: pct <= 0,
        resetsAtMs,
        elapsed,
        observedAt: window.observedAt,
        stale,
      },
    ];
  });
}

function projectKimiWindows(account: QuotaRingProfileItem, now: number, language: 'zh' | 'en'): QuotaRingWindowView[] {
  const kimiQuota = account.kimiQuota;
  if (
    !account.kimiLoginReady ||
    !kimiQuota ||
    kimiQuota.owner.accountRef !== account.id ||
    !kimiQuota.owner.credentialVersion ||
    !kimiQuota.items.length ||
    !Number.isFinite(kimiQuota.observedAt)
  ) {
    return [];
  }
  const observedAt = kimiQuota.observedAt;
  return kimiQuota.items.map((item, idx) => {
    const immediateReset = /^reset$/i.test(item.resetsText?.trim() ?? '');
    const parsedIsoReset = item.resetsAt ? Date.parse(item.resetsAt) : NaN;
    const fallbackDurationMs = Number.isFinite(parsedIsoReset) ? undefined : parseRelativeDurationMs(item.resetsText);
    const resetsAtMs = Number.isFinite(parsedIsoReset)
      ? parsedIsoReset
      : fallbackDurationMs !== undefined
        ? observedAt + fallbackDurationMs
        : undefined;
    const elapsed = immediateReset || (resetsAtMs !== undefined && now >= resetsAtMs);
    const stale = elapsed || now - observedAt >= QUOTA_STALE_THRESHOLD_MS || observedAt > now;
    const pct = remainingQuota(item);
    return {
      id: `${item.poolId ?? 'kimi'}:${item.label}:${idx}`,
      label: codexWindowShortLabel(item.label, language),
      kind: 'percent',
      remainingPercent: pct,
      low: pct < 20,
      exhausted: pct <= 0,
      resetsAtMs,
      resetsText: localizeResetText(item.resetsText, language),
      elapsed,
      observedAt,
      stale,
    };
  });
}

function isLocalKimiCat(cat: CatData): boolean {
  return cat.id !== 'gpt-pro' && cat.clientId === 'kimi' && Boolean(cat.cli || cat.acp || cat.carrier === 'acp');
}

function kimiAccountActivity(
  account: ProfileItem,
  cats: readonly CatData[],
): {
  inUse: boolean;
  activeMemberCount: number;
} {
  const defaultKimiRef = builtinAccountIdForClient('kimi');
  const activeKimiCats = cats.filter((cat) => isLocalKimiCat(cat) && cat.roster?.available !== false);
  const activeBound = activeKimiCats.filter((cat) => (cat.accountRef ?? defaultKimiRef) === account.id);
  return {
    inUse: activeKimiCats.length > 0 && activeBound.length === activeKimiCats.length,
    activeMemberCount: activeBound.length,
  };
}

function selectionForFamily(
  family: QuotaFamilyId,
  input: {
    codexSelection?: AccountSelection;
    claudeSelection?: AccountSelection;
    agySelection?: AccountSelection;
  },
): AccountSelection | undefined {
  if (family === 'claude') return input.claudeSelection;
  if (family === 'agy') return input.agySelection;
  if (family === 'codex') return input.codexSelection;
  return undefined;
}

function agyAccountQuotaReady(account: QuotaRingProfileItem): boolean {
  if (typeof account.agyQuotaReady === 'boolean') return account.agyQuotaReady;
  return Boolean(account.agy) && accountLoginReady(account);
}

const MIN_VALID_RESET_TIME_MS = Date.UTC(2000, 0, 1);

function projectAgyWindows(account: QuotaRingProfileItem, now: number, language: 'zh' | 'en'): QuotaRingWindowView[] {
  const agyQuota = account.agyQuota;
  if (
    !agyAccountQuotaReady(account) ||
    !agyQuota ||
    agyQuota.owner.accountRef !== account.id ||
    !agyQuota.owner.credentialVersion ||
    !agyQuota.items.length ||
    !Number.isFinite(agyQuota.observedAt)
  ) {
    return [];
  }
  const observedAt = agyQuota.observedAt;
  return agyQuota.items.map((item, idx) => {
    const parsedIsoReset = item.resetsAt ? Date.parse(item.resetsAt) : NaN;
    const resetsAtMs =
      Number.isFinite(parsedIsoReset) && parsedIsoReset >= MIN_VALID_RESET_TIME_MS ? parsedIsoReset : undefined;
    const elapsed = resetsAtMs !== undefined && now >= resetsAtMs;
    const stale = elapsed || now - observedAt >= QUOTA_STALE_THRESHOLD_MS || observedAt > now;
    const pct = remainingQuota(item);
    return {
      id: `${item.poolId ?? 'agy'}:${item.label}:${idx}`,
      ...(item.poolId ? { poolId: item.poolId } : {}),
      label: codexWindowShortLabel(item.label, language),
      kind: 'percent',
      remainingPercent: pct,
      low: pct < 20,
      exhausted: pct <= 0,
      resetsAtMs,
      resetsText: localizeResetText(item.resetsText, language),
      elapsed,
      observedAt,
      stale,
    };
  });
}

function windowsForFamily(
  family: QuotaFamilyId,
  account: QuotaRingProfileItem,
  now: number,
  language: 'zh' | 'en',
): QuotaRingWindowView[] {
  if (family === 'codex') return projectCodexWindows(account, now, language);
  if (family === 'claude') return projectClaudeWindows(account, now, language);
  if (family === 'agy') return projectAgyWindows(account, now, language);
  if (family === 'kimi') return projectKimiWindows(account, now, language);
  return [];
}

function canRefreshFamilyAccount(family: QuotaFamilyId, account: QuotaRingProfileItem): boolean {
  if (family === 'codex') return accountLoginReady(account);
  if (family === 'claude') return !account.claude || account.claudeTokenStatus === 'saved';
  if (family === 'agy') return agyAccountQuotaReady(account);
  if (family === 'kimi') return account.kimiLoginReady === true;
  return false;
}

function refreshKindForFamily(family: QuotaFamilyId): QuotaRingAccountView['refreshKind'] {
  if (family === 'codex') return 'codex';
  if (family === 'claude') return 'claude';
  if (family === 'agy') return 'agy';
  if (family === 'kimi') return 'kimi';
  return null;
}

export function buildQuotaRingModel(input: {
  profiles: readonly QuotaRingProfileItem[];
  cats: CatData[];
  codexSelection?: AccountSelection;
  claudeSelection?: AccountSelection;
  agySelection?: AccountSelection;
  selectedAccountRefs: readonly string[] | null;
  now: number;
  language: 'zh' | 'en';
}) {
  const at = accountsCopy[input.language];
  const oauthProfiles = input.profiles.filter((p) => p.authType === 'oauth');

  const rawEntries = oauthProfiles.flatMap((account) => {
    const family = familyForAccount(account);
    if (!family) return [];
    const selection = selectionForFamily(family, input);
    const activity =
      family === 'kimi'
        ? kimiAccountActivity(account, input.cats)
        : {
            inUse: accountIsSelected(account, input.cats, selection),
            activeMemberCount: accountMembers(account, input.cats, selection).filter((m) => m.available).length,
          };
    return [
      {
        id: account.id,
        family,
        provider: accountProvider(account, at),
        displayName: accountDisplayName(account, at),
        inUse: activity.inUse,
        activeMemberCount: activity.activeMemberCount,
        canRefresh: canRefreshFamilyAccount(family, account),
        refreshKind: refreshKindForFamily(family),
        windows: windowsForFamily(family, account, input.now, input.language),
      },
    ];
  });

  const mixedByFamily = new Map<QuotaFamilyId, boolean>();
  for (const family of QUOTA_FAMILY_ORDER) {
    const selection = selectionForFamily(family, input);
    const familyItems = rawEntries.filter((e) => e.family === family);
    mixedByFamily.set(family, selection ? selection.state === 'mixed' : !familyItems.some((e) => e.inUse));
  }

  const allEntries: QuotaRingAccountView[] = rawEntries.map((entry) => ({
    ...entry,
    isActiveForFamily: entry.inUse || (Boolean(mixedByFamily.get(entry.family)) && entry.activeMemberCount > 0),
  }));

  allEntries.sort(
    (a, b) =>
      QUOTA_FAMILY_ORDER.indexOf(a.family) - QUOTA_FAMILY_ORDER.indexOf(b.family) ||
      Number(b.isActiveForFamily) - Number(a.isActiveForFamily) ||
      Number(b.inUse) - Number(a.inUse) ||
      Number(b.windows.length > 0) - Number(a.windows.length > 0) ||
      a.displayName.localeCompare(b.displayName),
  );

  const defaultIds = allEntries.map((entry) => entry.id);
  const effectiveIds = input.selectedAccountRefs ?? defaultIds;
  const byId = new Map(allEntries.map((entry) => [entry.id, entry]));
  const selectedEntries = effectiveIds
    .map((id) => byId.get(id))
    .filter((entry): entry is QuotaRingAccountView => entry !== undefined);

  const bars: QuotaFamilyBarSummary[] = QUOTA_FAMILY_ORDER.map((family) => {
    const activeFamilyEntries = selectedEntries.filter((entry) => entry.family === family && entry.isActiveForFamily);
    const nonElapsedWindows = activeFamilyEntries.flatMap((entry) =>
      entry.windows.filter(
        (w): w is QuotaRingWindowView & { remainingPercent: number } =>
          w.kind === 'percent' &&
          w.remainingPercent !== undefined &&
          !w.elapsed &&
          (family !== 'agy' || w.poolId === 'agy-gemini'),
      ),
    );
    if (nonElapsedWindows.length === 0) {
      return { family, remainingPercent: null, low: false, exhausted: false };
    }
    const min = Math.min(...nonElapsedWindows.map((w) => w.remainingPercent));
    const rounded = Math.round(min);
    return {
      family,
      remainingPercent: rounded,
      low: min < 20,
      exhausted: min <= 0,
    };
  });

  const nonNullBars = bars.filter(
    (bar): bar is QuotaFamilyBarSummary & { remainingPercent: number } => bar.remainingPercent !== null,
  );
  const summary: QuotaRingSummary =
    nonNullBars.length === 0
      ? { hasReading: false, bars, tightestPercent: null, low: false, exhausted: false }
      : {
          hasReading: true,
          bars,
          tightestPercent: Math.min(...nonNullBars.map((bar) => bar.remainingPercent)),
          low: nonNullBars.some((bar) => bar.low),
          exhausted: nonNullBars.some((bar) => bar.exhausted),
        };

  return {
    allEntries,
    effectiveIds,
    selectedEntries,
    summary,
  };
}
