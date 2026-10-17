'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CatData, saveCatOrder } from '@/hooks/useCatData';
import { sortCatsByOrder } from '@/lib/sort-cats-by-order';
import { apiFetch } from '@/utils/api-client';
import { reorderMemberIds } from './member-projection';
import { useMemberAccounts } from './useMemberAccounts';

export function useMemberList(cats: CatData[]) {
  const accounts = useMemberAccounts();
  const [defaultId, setDefaultId] = useState('');
  const [defaultKnown, setDefaultKnown] = useState(false);
  const [failedDefaultId, setFailedDefaultId] = useState<string | null>(null);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const [defaultLoading, setDefaultLoading] = useState(true);
  const [savingDefault, setSavingDefault] = useState(false);
  const [order, setOrder] = useState<string[] | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const inFlight = useRef(false);
  const defaultReadSequence = useRef(0);
  const readDefault = useCallback(async () => {
    const sequence = ++defaultReadSequence.current;
    setDefaultLoading(true);
    setDefaultError(null);
    setFailedDefaultId(null);
    try {
      const res = await apiFetch('/api/config/default-cat');
      if (!res.ok) throw new Error('默认猫读取失败');
      const data = (await res.json()) as { catId: string };
      if (sequence !== defaultReadSequence.current) return;
      setDefaultId(data.catId);
      setDefaultKnown(true);
    } catch {
      if (sequence === defaultReadSequence.current) {
        setDefaultKnown(false);
        setDefaultError('默认猫读取失败，请重试');
      }
    } finally {
      if (sequence === defaultReadSequence.current) setDefaultLoading(false);
    }
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: registry changes affect the resolved default.
  useEffect(() => {
    void readDefault();
    return () => {
      defaultReadSequence.current += 1;
    };
  }, [readDefault, cats]);
  const saveDefault = async (catId: string) => {
    if (savingDefault) return;
    defaultReadSequence.current += 1;
    setDefaultLoading(false);
    setSavingDefault(true);
    setDefaultError(null);
    setFailedDefaultId(null);
    try {
      const res = await apiFetch('/api/config/default-cat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catId }),
      });
      if (!res.ok) throw new Error('默认猫保存失败');
      const body = (await res.json()) as { warning?: string };
      defaultReadSequence.current += 1;
      setDefaultId(catId);
      setDefaultKnown(true);
      setDefaultLoading(false);
      setDefaultError(body.warning ?? null);
    } catch {
      setDefaultError('默认猫保存失败，请重试');
      setFailedDefaultId(catId);
    } finally {
      setSavingDefault(false);
    }
  };
  const allCats = order ? sortCatsByOrder(cats, order) : cats;
  const move = async (source: string, target: string) => {
    if (inFlight.current) return;
    const ids = allCats.map((cat) => cat.id);
    const next = reorderMemberIds(ids, source, target);
    if (next === ids) return;
    const before = order;
    inFlight.current = true;
    setSavingOrder(true);
    setOrder(next);
    setOrderError(null);
    try {
      await saveCatOrder(next);
    } catch {
      setOrder(before);
      setOrderError('排序保存失败，请重试');
    } finally {
      inFlight.current = false;
      setSavingOrder(false);
    }
  };
  return {
    accounts,
    allCats,
    defaultId,
    defaultKnown,
    defaultError,
    defaultLoading,
    savingDefault,
    saveDefault,
    readDefault,
    retryDefault: () => (failedDefaultId !== null ? saveDefault(failedDefaultId) : readDefault()),
    move,
    orderError,
    savingOrder,
  };
}
