'use client';

import { type CompanionIdentitySnapshotV1, companionIdentitySnapshotV1Schema } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

/** Read the Host's current selection; historical bubbles use their own saved snapshot. */
export function useCurrentCompanionIdentity(
  dutyCatProfileId: string,
  enabled: boolean,
): CompanionIdentitySnapshotV1 | null {
  const [identity, setIdentity] = useState<CompanionIdentitySnapshotV1 | null>(null);

  useEffect(() => {
    setIdentity(null);
    if (!enabled || !dutyCatProfileId) return;

    const controller = new AbortController();
    let cancelled = false;
    const read = async () => {
      try {
        const response = await apiFetch(
          '/api/concierge/live/identity',
          { signal: controller.signal },
          { afterCurrentGet: true },
        );
        if (!response.ok) return;
        const body: unknown = await response.json();
        const candidate =
          body && typeof body === 'object' && 'status' in body && body.status === 'selected' && 'identity' in body
            ? body.identity
            : undefined;
        const parsed = companionIdentitySnapshotV1Schema.safeParse(candidate);
        if (!cancelled && parsed.success) setIdentity(parsed.data);
      } catch {
        // A remote or unavailable Host has no verified current identity to display.
      }
    };
    void read();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [dutyCatProfileId, enabled]);

  return identity?.partner.catId === dutyCatProfileId ? identity : null;
}
