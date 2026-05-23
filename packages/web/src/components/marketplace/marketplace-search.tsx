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
      const next = ecosystemFilter.includes(eco) ? ecosystemFilter.filter((e) => e !== eco) : [...ecosystemFilter, eco];
      setEcosystemFilter(next);
    },
    [ecosystemFilter, setEcosystemFilter],
  );

  const toggleTrust = useCallback(
    (level: TrustLevel) => {
      const next = trustFilter.includes(level) ? trustFilter.filter((l) => l !== level) : [...trustFilter, level];
      setTrustFilter(next);
    },
    [trustFilter, setTrustFilter],
  );

  const isAll = ecosystemFilter.length === 0;
  const isTrustAll = trustFilter.length === 0;

  return (
    <div className="space-y-3">
      <div className="relative">
        <span className="absolute inset-y-0 left-3 flex items-center text-cafe-muted">
          <HubIcon name="search" className="h-4 w-4" />
        </span>
        <input
          type="text"
          value={inputValue}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="搜索能力..."
          className="w-full rounded-lg border border-[var(--console-border-soft)] bg-transparent py-2 pl-9 pr-3 text-xs text-cafe-secondary placeholder:text-cafe-muted outline-none transition focus:bg-[var(--console-card-bg)] focus:ring-1 focus:ring-[var(--console-input-stroke)]"
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => setEcosystemFilter([])}
          className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            isAll
              ? 'border-transparent bg-cafe-accent text-white'
              : 'border-transparent bg-[var(--console-field-bg)] text-cafe-secondary hover:bg-[var(--console-hover-bg)]'
          }`}
        >
          全部
        </button>
        {MARKETPLACE_ECOSYSTEMS.map((eco) => {
          const active = ecosystemFilter.includes(eco);
          return (
            <button
              key={eco}
              onClick={() => toggleEcosystem(eco)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'border-transparent bg-cafe-accent text-white'
                  : 'border-transparent bg-[var(--console-field-bg)] text-cafe-secondary hover:bg-[var(--console-hover-bg)]'
              }`}
            >
              {ECOSYSTEM_LABELS[eco]}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-1.5">
        <span className="self-center text-micro text-cafe-muted">信任:</span>
        <button
          onClick={() => setTrustFilter([])}
          className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
            isTrustAll
              ? 'border-transparent bg-cafe-accent text-white'
              : 'border-transparent bg-[var(--console-field-bg)] text-cafe-secondary hover:bg-[var(--console-hover-bg)]'
          }`}
        >
          全部
        </button>
        {TRUST_LEVELS.map((level) => {
          const active = trustFilter.includes(level);
          return (
            <button
              key={level}
              onClick={() => toggleTrust(level)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'border-transparent bg-cafe-accent text-white'
                  : 'border-transparent bg-[var(--console-field-bg)] text-cafe-secondary hover:bg-[var(--console-hover-bg)]'
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
