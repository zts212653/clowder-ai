'use client';

/**
 * F32-b Phase 3: Central hook for dynamic cat data from /api/cats.
 * Fetches once per session, caches module-level. All consumers share same data.
 * Falls back to static CAT_CONFIGS from @cat-cafe/shared during initial load.
 */

import { CAT_CONFIGS } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { refreshMentionData } from '@/lib/mention-highlight';
import { apiFetch } from '@/utils/api-client';
import { refreshSpeechAliases } from '@/utils/transcription-corrector';

export interface CatData {
  id: string;
  name?: string;
  displayName: string;
  nickname?: string;
  color: { primary: string; secondary: string };
  mentionPatterns: string[];
  breedId?: string;
  accountRef?: string;
  /** Legacy compatibility while older runtime data is migrated. */
  providerProfileId?: string;
  provider: string;
  defaultModel: string;
  commandArgs?: string[];
  cliConfigArgs?: string[];
  ocProviderName?: string;
  contextBudget?: {
    maxPromptTokens: number;
    maxContextTokens: number;
    maxMessages: number;
    maxContentLengthPerMsg: number;
  };
  avatar: string;
  roleDescription: string;
  personality: string;
  teamStrengths?: string;
  caution?: string | null;
  strengths?: string[];
  sessionChain?: boolean;
  /** F32-b P4: Human-readable variant label (e.g. "4.5", "Sonnet") */
  variantLabel?: string;
  /** F32-b P4: Whether this is the default variant for its breed */
  isDefaultVariant?: boolean;
  /** F32-b P4: Breed-level display name (e.g. "布偶猫"), for group headings */
  breedDisplayName?: string;
  /** F127: Seed cats come from cat-template.json; runtime cats are added later */
  source: 'seed' | 'runtime';
  /** F127: Roster metadata used by Hub ownership/lead markers */
  roster?: {
    family: string;
    roles: string[];
    lead: boolean;
    available: boolean;
    evaluation: string;
  } | null;
}

// ── Module-level cache ──────────────────────────────────
let _cached: CatData[] | null = null;
let _fetchPromise: Promise<FetchResult> | null = null;
const _listeners = new Set<(cats: CatData[]) => void>();
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10_000;

function notifyListeners(cats: CatData[]): void {
  for (const listener of _listeners) {
    listener(cats);
  }
}

function buildFallbackCats(): CatData[] {
  return Object.values(CAT_CONFIGS).map((c) => ({
    id: c.id as string,
    displayName: c.displayName,
    nickname: c.nickname,
    color: { primary: c.color.primary, secondary: c.color.secondary },
    mentionPatterns: [...c.mentionPatterns],
    breedId: undefined,
    provider: c.provider,
    defaultModel: c.defaultModel,
    avatar: c.avatar,
    roleDescription: c.roleDescription,
    personality: c.personality,
    teamStrengths: c.teamStrengths,
    caution: c.caution,
    strengths: c.strengths ? [...c.strengths] : undefined,
    sessionChain: c.sessionChain,
    roster: null,
    source: 'seed',
  }));
}

interface FetchResult {
  cats: CatData[];
  fromApi: boolean;
}

async function fetchCats(): Promise<FetchResult> {
  try {
    const res = await apiFetch('/api/cats');
    if (!res.ok) return { cats: buildFallbackCats(), fromApi: false };
    const data = await res.json();
    const cats = Array.isArray(data?.cats) ? normalizeCats(data.cats) : null;
    return cats ? { cats, fromApi: true } : { cats: buildFallbackCats(), fromApi: false };
  } catch {
    return { cats: buildFallbackCats(), fromApi: false };
  }
}

function normalizeCats(rawCats: unknown[]): CatData[] {
  return rawCats.map((raw) => {
    const cat = raw as Partial<CatData>;
    return {
      ...cat,
      id: cat.id ?? '',
      displayName: cat.displayName ?? cat.id ?? '',
      color: cat.color ?? { primary: '#000000', secondary: '#ffffff' },
      mentionPatterns: Array.isArray(cat.mentionPatterns) ? cat.mentionPatterns : [],
      accountRef: cat.accountRef ?? cat.providerProfileId,
      provider: cat.provider ?? 'openai',
      defaultModel: cat.defaultModel ?? '',
      avatar: cat.avatar ?? '',
      roleDescription: cat.roleDescription ?? '',
      personality: cat.personality ?? '',
      teamStrengths: cat.teamStrengths,
      caution: cat.caution,
      strengths: Array.isArray(cat.strengths) ? cat.strengths : undefined,
      sessionChain: cat.sessionChain,
      roster: cat.roster ?? null,
      source: cat.source ?? 'seed',
    };
  });
}

async function refreshCatsNow(): Promise<FetchResult> {
  _cached = null;
  _fetchPromise = fetchCats();
  const result = await _fetchPromise;
  if (result.fromApi) {
    _cached = result.cats;
  } else {
    _fetchPromise = null;
  }
  refreshMentionData(result.cats);
  refreshSpeechAliases(result.cats);
  notifyListeners(result.cats);
  return result;
}

// ── Hook ────────────────────────────────────────────────

export function useCatData() {
  const [cats, setCats] = useState<CatData[]>(() => _cached ?? buildFallbackCats());
  const [isLoading, setIsLoading] = useState(!_cached);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const listener = (nextCats: CatData[]) => {
      setCats(nextCats);
      setIsLoading(false);
    };
    _listeners.add(listener);
    return () => {
      _listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (_cached) {
      setCats(_cached);
      setIsLoading(false);
      return;
    }
    if (!_fetchPromise) {
      _fetchPromise = fetchCats();
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    _fetchPromise.then(({ cats: result, fromApi }) => {
      if (fromApi) {
        _cached = result;
      } else {
        _fetchPromise = null;
        // Schedule retry for already-mounted hooks (max 3 attempts, 10s apart)
        if (retryCount < MAX_RETRIES) {
          retryTimer = setTimeout(() => {
            if (!cancelled) setRetryCount((c) => c + 1);
          }, RETRY_DELAY_MS);
        }
      }
      refreshMentionData(result);
      refreshSpeechAliases(result);
      notifyListeners(result);
      if (!cancelled) {
        setCats(result);
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [retryCount]);

  const refresh = useMemo(
    () => async () => {
      setIsLoading(true);
      const result = await refreshCatsNow();
      setCats(result.cats);
      setIsLoading(false);
      return result.cats;
    },
    [],
  );

  const getCatById = useMemo(() => {
    const map = new Map(cats.map((c) => [c.id, c]));
    return (id: string) => map.get(id);
  }, [cats]);

  const getCatsByBreed = useMemo(() => {
    return () => {
      const groups = new Map<string, CatData[]>();
      for (const cat of cats) {
        const key = cat.breedId ?? cat.id;
        const arr = groups.get(key) ?? [];
        arr.push(cat);
        groups.set(key, arr);
      }
      return groups;
    };
  }, [cats]);

  return { cats, isLoading, getCatById, getCatsByBreed, refresh };
}

/** Format cat name with optional variant label for multi-variant disambiguation */
export function formatCatName(cat: { displayName: string; variantLabel?: string }): string {
  return cat.variantLabel ? `${cat.displayName}（${cat.variantLabel}）` : cat.displayName;
}

/** Get cached cats synchronously (for non-hook contexts). Returns fallback if not loaded. */
export function getCachedCats(): CatData[] {
  return _cached ?? buildFallbackCats();
}

/** Reset module-level cache (for testing) */
export function _resetCatDataCache(): void {
  _cached = null;
  _fetchPromise = null;
  _listeners.clear();
}
