/**
 * F252 Phase C — Feature Story View (orchestrator)
 *
 * Data-fetching + routing shell for the feature story player.
 * Delegates visualization to BirdseyeView (swimlane + causal edges).
 *
 * Three-layer zoom model:
 * - Birdseye (BirdseyeView): Feature-level swimlane + causal edges
 * - Theater: Click session block -> single session replay (existing Phase A)
 * - Microscope: Pause + click message -> expand details (existing Phase A/B)
 */

'use client';

import type { FeatureStoryRenderingDTO } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { BirdseyeView } from './BirdseyeView';
import { FeatureTheaterContent } from './FeatureTheaterContent';
import { TheaterOverlay } from './TheaterOverlay';

// ============================================================================
// Data fetching hook
// ============================================================================

function useFeatureStoryRendering(featId: string) {
  const [data, setData] = useState<FeatureStoryRenderingDTO | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchRendering() {
      setIsLoading(true);
      setError(null);

      try {
        const res = await apiFetch(`/api/story/feat:${featId}/rendering`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || body.error || `HTTP ${res.status}`);
        }
        const dto: FeatureStoryRenderingDTO = await res.json();
        if (!cancelled) setData(dto);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchRendering();
    return () => {
      cancelled = true;
    };
  }, [featId]);

  return { data, isLoading, error };
}

// ============================================================================
// Main component
// ============================================================================

export function FeatureStoryView({ featId }: { featId: string }) {
  const { data, isLoading, error } = useFeatureStoryRendering(featId);
  const [showTheater, setShowTheater] = useState(false);

  if (isLoading) {
    return (
      <div style={styles.centeredContainer}>
        <div style={styles.spinner} />
        <p>Loading feature trajectory...</p>
        <p style={{ opacity: 0.5, fontSize: 'var(--console-font-xs)' }}>Feature: {featId}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.centeredContainer}>
        <h2>Failed to load feature story</h2>
        <p>{error}</p>
        <p style={{ opacity: 0.5, fontSize: 'var(--console-font-xs)' }}>Feature: {featId}</p>
      </div>
    );
  }

  if (!data || data.lanes.length === 0) {
    return (
      <div style={styles.centeredContainer}>
        <h2>No trajectory data</h2>
        <p>{featId} has no trajectory entries with thread associations yet.</p>
        <p style={{ opacity: 0.5, fontSize: 'var(--console-font-xs)' }}>
          Trajectory data is collected by F233 cron (thread_split / thread_merge / git-ref).
        </p>
      </div>
    );
  }

  return (
    <>
      <BirdseyeView data={data} onPlayFeature={() => setShowTheater(true)} />
      {showTheater && (
        <TheaterOverlay open onClose={() => setShowTheater(false)} title={data.title}>
          <FeatureTheaterContent featId={featId} />
        </TheaterOverlay>
      )}
    </>
  );
}

// ============================================================================
// Styles
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  centeredContainer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    color: 'var(--color-text-primary, #e0e0e0)',
    background: 'var(--color-surface, #0d0d1a)',
    gap: '8px',
    textAlign: 'center',
    padding: '20px',
  },
  spinner: {
    width: '32px',
    height: '32px',
    border: '3px solid var(--color-border, #333)',
    borderTopColor: 'var(--color-accent, #6366f1)',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
};
