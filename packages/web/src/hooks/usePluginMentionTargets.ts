'use client';

import type { PluginMentionTarget } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface PluginTargets {
  /** Enabled instances that can be addressed now (@alias). */
  targets: PluginMentionTarget[];
  /** Every instance that has an address, for receipts and replies of earlier messages. */
  knownTargets: PluginMentionTarget[];
}

/** Addressed plugin instances, read while a view shows them; re-read when a plugin operation or address changes. */
export function usePluginTargets(needed: unknown): PluginTargets | undefined {
  const [targets, setTargets] = useState<PluginTargets>();
  useEffect(() => {
    if (!needed) return;
    let live = true;
    const read = async () => {
      const response = await apiFetch('/api/plugin-manager/addressed-targets');
      if (!response.ok || !live) return;
      const body = (await response.json()) as Partial<PluginTargets>;
      if (live) setTargets({ targets: body.targets ?? [], knownTargets: body.knownTargets ?? body.targets ?? [] });
    };
    const reread = () => void read().catch(() => undefined);
    reread();
    window.addEventListener('cat-cafe:plugin-operation-changed', reread);
    window.addEventListener('plugin-targets-changed', reread);
    return () => {
      live = false;
      window.removeEventListener('cat-cafe:plugin-operation-changed', reread);
      window.removeEventListener('plugin-targets-changed', reread);
    };
  }, [needed]);
  return targets;
}
