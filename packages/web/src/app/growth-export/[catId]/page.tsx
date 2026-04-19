'use client';

/**
 * F157 AC-A3: Journey Card Export Page
 *
 * Standalone page that renders a single CatProfileCard for Puppeteer screenshot.
 * ImageExporter navigates here, waits for data-export-ready="true", then captures.
 * Designed for tight 480px viewport — no centering, card fills width.
 *
 * URL: /growth-export/:catId?export=true&userId=...
 */

import type { CatGrowthProfile } from '@cat-cafe/shared';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CatProfileCard } from '@/components/growth/CatProfileCard';
import { apiFetch } from '@/utils/api-client';

export default function GrowthExportPage() {
  const { catId } = useParams<{ catId: string }>();
  const [profile, setProfile] = useState<CatGrowthProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!catId) return;
    apiFetch(`/api/journey/${catId}`)
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `Failed to load profile (${res.status})`);
          return;
        }
        setProfile((await res.json()) as CatGrowthProfile);
      })
      .catch(() => setError('Network error'));
  }, [catId]);

  const ready = profile !== null;

  return (
    <div className="bg-cafe-surface-elevated p-5" {...(ready ? { 'data-export-ready': 'true' } : {})}>
      {error ? (
        <div className="text-sm text-red-500">{error}</div>
      ) : profile ? (
        <>
          <CatProfileCard profile={profile} />
          {/* Brand footer for shared images */}
          <div className="mt-3 text-center text-[10px] text-cafe-muted">Clowder AI · Cat Journey</div>
        </>
      ) : (
        <div className="text-sm text-cafe-muted">Loading...</div>
      )}
    </div>
  );
}
