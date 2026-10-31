import { useEffect, useState } from 'react';
import { experiments, type Role, type SchemeId } from './solution-example';

const KEY = 'f311-solution-design-reading-v1';
export interface Reading {
  scheme: SchemeId;
  runs: Record<SchemeId, string>;
  members: boolean;
  role: Role;
  compare: boolean;
  source: string | null;
  scroll: number;
}
const initial: Reading = {
  scheme: 'S2',
  runs: { S1: 'X1', S2: 'X2', S3: 'X4' },
  members: false,
  role: 'all',
  compare: false,
  source: null,
  scroll: 0,
};
function read(): Reading {
  const raw = localStorage.getItem(KEY);
  if (!raw) return initial;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new Error('invalid reading');
  const item = value as Partial<Reading>;
  if (
    !['S1', 'S2', 'S3'].includes(item.scheme ?? '') ||
    !['all', 'changed', 'observation', 'rubric'].includes(item.role ?? '') ||
    typeof item.members !== 'boolean' ||
    typeof item.compare !== 'boolean' ||
    !item.runs ||
    !(['S1', 'S2', 'S3'] as const).every((id) =>
      experiments.some((run) => run.scheme === id && run.id === item.runs?.[id]),
    ) ||
    (item.source !== null && !['archive-index', 'archive-frame', 'archive-summary'].includes(item.source ?? '')) ||
    typeof item.scroll !== 'number' ||
    !Number.isFinite(item.scroll) ||
    item.scroll < 0
  )
    throw new Error('invalid reading');
  return item as Reading;
}
export function useSolutionReading() {
  const [reading, setReading] = useState<Reading>(initial);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    try {
      setReading(read());
    } catch {
      setNotice('上次阅读位置无法恢复；已回到方案总览。');
    }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(reading));
    } catch {
      setNotice('浏览器未能保存阅读位置；本次阅读仍可继续。');
    }
  }, [reading, ready]);
  return {
    reading,
    ready,
    notice,
    update: (patch: Partial<Reading>) => setReading((current) => ({ ...current, ...patch })),
  };
}
