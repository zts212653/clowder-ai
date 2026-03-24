'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { CatStrategyCard } from './HubStrategyCard';
import type { CatStrategyEntry } from './hub-strategy-types';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
      <h3 className="text-xs font-semibold text-gray-700 mb-2">{title}</h3>
      {children}
    </section>
  );
}

export function HubStrategyTab() {
  const [cats, setCats] = useState<CatStrategyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/config/session-strategy');
      if (!res.ok) {
        setError('策略配置加载失败');
        return;
      }
      const data = (await res.json()) as { cats: CatStrategyEntry[] };
      setCats(data.cats);
    } catch {
      setError('网络错误');
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (error) {
    return <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>;
  }
  if (!cats) {
    return <p className="text-sm text-gray-400">加载中...</p>;
  }

  return (
    <Section title="Session 策略配置 (F33)">
      <p className="text-[11px] text-gray-500 mb-3">
        每个 Variant 猫可以独立配置 session 生命周期策略。修改后立即生效，存储在 Redis 中。
      </p>
      <div className="space-y-3">
        {cats.map((entry) => (
          <CatStrategyCard key={entry.catId} entry={entry} onSaved={fetchData} />
        ))}
      </div>
    </Section>
  );
}
