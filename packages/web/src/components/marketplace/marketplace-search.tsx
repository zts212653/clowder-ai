'use client';

import type { MarketplaceEcosystem, TrustLevel } from '@cat-cafe/shared';
import { MARKETPLACE_ECOSYSTEMS, TRUST_LEVELS } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMarketplaceStore } from '@/stores/marketplaceStore';
import { HubIcon } from '../hub-icons';

const ECOSYSTEM_LABELS: Record<MarketplaceEcosystem, string> = {
  claude: 'Claude',
  codex: 'Codex',
  openclaw: 'OpenClaw',
  antigravity: 'Antigravity',
};

const TRUST_LABELS: Record<TrustLevel, string> = {
  official: '官方',
  verified: '已验证',
  community: '社区',
};

export function MarketplaceSearch() {
  const [inputValue, setInputValue] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = useMarketplaceStore((s) => s.search);
  const browse = useMarketplaceStore((s) => s.browse);
  const ecosystemFilter = useMarketplaceStore((s) => s.ecosystemFilter);
  const setEcosystemFilter = useMarketplaceStore((s) => s.setEcosystemFilter);
  const trustFilter = useMarketplaceStore((s) => s.trustFilter);
  const setTrustFilter = useMarketplaceStore((s) => s.setTrustFilter);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setInputValue(v);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (v.trim()) {
        debounceRef.current = setTimeout(() => search(v.trim()), 300);
      } else {
        browse();
      }
    },
    [search, browse],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && inputValue.trim()) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        search(inputValue.trim());
      }
    },
    [inputValue, search],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const toggleEcosystem = useCallback(
    (eco: MarketplaceEcosystem) => {
      setEcosystemFilter(ecosystemFilter.includes(eco) ? [] : [eco]);
    },
    [ecosystemFilter, setEcosystemFilter],
  );

  const toggleTrust = useCallback(
    (level: TrustLevel) => {
      setTrustFilter(trustFilter.includes(level) ? [] : [level]);
    },
    [trustFilter, setTrustFilter],
  );

  const isAll = ecosystemFilter.length === 0;
  const isTrustAll = trustFilter.length === 0;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5 rounded-lg bg-[var(--console-card-bg)] px-2.5 h-8 shadow-[0_1px_3px_rgba(43,33,26,0.06)]">
        <HubIcon name="search" className="h-4 w-4 shrink-0 text-cafe-muted" />
        <input
          type="text"
          value={inputValue}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="搜索能力..."
          className="min-w-0 flex-1 bg-transparent text-xs text-cafe outline-none placeholder:text-cafe-muted"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setEcosystemFilter([])}
          className={`h-7 rounded-lg px-2.5 text-[11px] font-medium transition-colors ${
            isAll
              ? 'bg-[var(--cafe-accent)] text-[var(--cafe-accent-foreground)]'
              : 'bg-[var(--console-card-bg)] text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] hover:text-cafe'
          }`}
        >
          全部
        </button>
        {MARKETPLACE_ECOSYSTEMS.map((eco) => {
          const active = ecosystemFilter.includes(eco);
          return (
            <button
              type="button"
              key={eco}
              onClick={() => toggleEcosystem(eco)}
              className={`h-7 rounded-lg px-2.5 text-[11px] font-medium transition-colors ${
                active
                  ? 'bg-[var(--cafe-accent)] text-[var(--cafe-accent-foreground)]'
                  : 'bg-[var(--console-card-bg)] text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] hover:text-cafe'
              }`}
            >
              {ECOSYSTEM_LABELS[eco]}
            </button>
          );
        })}
        <span className="mx-1 h-4 w-px bg-[var(--console-border-soft)]" />
        <span className="text-[10px] text-cafe-muted">信任:</span>
        <button
          type="button"
          onClick={() => setTrustFilter([])}
          className={`h-7 rounded-lg px-2.5 text-[11px] font-medium transition-colors ${
            isTrustAll
              ? 'bg-[var(--cafe-accent)] text-[var(--cafe-accent-foreground)]'
              : 'bg-[var(--console-card-bg)] text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] hover:text-cafe'
          }`}
        >
          全部
        </button>
        {TRUST_LEVELS.map((level) => {
          const active = trustFilter.includes(level);
          return (
            <button
              type="button"
              key={level}
              onClick={() => toggleTrust(level)}
              className={`h-7 rounded-lg px-2.5 text-[11px] font-medium transition-colors ${
                active
                  ? 'bg-[var(--cafe-accent)] text-[var(--cafe-accent-foreground)]'
                  : 'bg-[var(--console-card-bg)] text-cafe-secondary shadow-[0_1px_3px_rgba(43,33,26,0.06)] hover:text-cafe'
              }`}
            >
              {TRUST_LABELS[level]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
