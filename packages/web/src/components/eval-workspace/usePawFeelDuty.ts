'use client';

import { isCompletePawFeelDutyConfig, type PawFeelDutyConfig } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export type DutyReadState =
  | { status: 'loading' }
  | { status: 'unassigned' }
  | { status: 'incomplete'; config: PawFeelDutyConfig }
  | {
      status: 'assigned';
      config: PawFeelDutyConfig & { primaryCatId: string; backupCatId: string };
    }
  | { status: 'unavailable' };

function isDutyConfig(value: unknown): value is PawFeelDutyConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<PawFeelDutyConfig>;
  return (
    config.systemThreadId === 'thread_eval_friction' &&
    typeof config.version === 'number' &&
    typeof config.updatedAt === 'string' &&
    typeof config.updatedBy === 'string'
  );
}

async function readDutyState(): Promise<DutyReadState> {
  try {
    const response = await apiFetch('/api/paw-feel/duty');
    if (!response.ok) return { status: 'unavailable' };
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== 'object' || !('config' in payload)) return { status: 'unavailable' };
    const config = (payload as { config?: unknown }).config;
    if (config === null) return { status: 'unassigned' };
    if (!isDutyConfig(config)) return { status: 'unavailable' };
    return isCompletePawFeelDutyConfig(config) ? { status: 'assigned', config } : { status: 'incomplete', config };
  } catch {
    return { status: 'unavailable' };
  }
}

export function usePawFeelDuty(variant: 'workspace' | 'history'): DutyReadState {
  const [duty, setDuty] = useState<DutyReadState>({ status: 'loading' });
  useEffect(() => {
    if (variant !== 'workspace') return;
    let active = true;
    void readDutyState().then((next) => {
      if (active) setDuty(next);
    });
    return () => {
      active = false;
    };
  }, [variant]);
  return duty;
}
