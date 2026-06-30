/**
 * F252 Phase D — Public Story Viewer (AC-D2).
 *
 * Route: /story/:storyId/public
 *
 * Serves a sanitized, read-only replay of a story export.
 * No authentication required — the export is pre-sanitized.
 */

'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { decodeStoryParam } from '../parseStoryId';

// ---------------------------------------------------------------------------
// Types (matching export pack shape)
// ---------------------------------------------------------------------------

interface SanitizedEvent {
  id: string;
  at: number;
  kind: string;
  content: string;
  toolName?: string;
  catId?: string;
}

interface StoryAnnotation {
  id: string;
  at: number;
  kind: 'narration' | 'highlight';
  content: string;
}

interface ExportManifest {
  exportId: string;
  storyId: string;
  title: string;
  exportedAt: number;
  sanitizationRules: string[];
  eventCount: number;
  annotations: StoryAnnotation[];
}

interface ExportPack {
  manifest: ExportManifest;
  events: SanitizedEvent[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PublicStoryViewerPage() {
  const params = useParams();
  const rawStoryId = typeof params.storyId === 'string' ? params.storyId : '';

  // Decode URL-encoded storyId from Next.js params — colons arrive as %3A.
  // Without decoding, encodeURIComponent double-encodes %3A → %253A, causing 404.
  // Uses shared decodeStoryParam (same decode logic as main page's parseStoryId).
  const storyId = decodeStoryParam(rawStoryId);

  const [pack, setPack] = useState<ExportPack | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!storyId) return;

    const apiBase = process.env.NEXT_PUBLIC_API_URL || '';
    fetch(`${apiBase}/api/story/${encodeURIComponent(storyId)}/public`)
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'No public export available' : `HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => setPack(data as ExportPack))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [storyId]);

  if (loading) {
    return (
      <div style={styles.center}>
        <p>Loading public story...</p>
      </div>
    );
  }

  if (error || !pack) {
    return (
      <div style={styles.center}>
        <h2>Public Story Not Available</h2>
        <p>{error ?? 'Export not found.'}</p>
        <p style={{ opacity: 0.5, fontSize: 'var(--console-font-label)' }}>Story: {storyId}</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.title}>{pack.manifest.title}</h1>
        <div style={styles.meta}>
          <span>📅 {new Date(pack.manifest.exportedAt).toLocaleDateString()}</span>
          <span>📊 {pack.manifest.eventCount} events</span>
          <span>🔒 Sanitized: {pack.manifest.sanitizationRules.join(', ')}</span>
        </div>
      </div>

      {/* Annotations */}
      {pack.manifest.annotations.length > 0 && (
        <div style={styles.annotationsSection}>
          <h3 style={styles.sectionTitle}>📝 Annotations</h3>
          {pack.manifest.annotations.map((a) => (
            <div key={a.id} style={styles.annotationCard}>
              <span style={styles.annotationKind}>{a.kind === 'narration' ? '💬' : '✨'}</span>
              <span style={styles.annotationContent}>{a.content}</span>
              <span style={styles.annotationTime}>{new Date(a.at).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}

      {/* Event timeline */}
      <div style={styles.eventsSection}>
        <h3 style={styles.sectionTitle}>Timeline ({pack.events.length} events)</h3>
        {pack.events.map((event) => (
          <div key={event.id} style={styles.eventCard}>
            <div style={styles.eventHeader}>
              {event.catId && <span style={styles.catBadge}>{event.catId}</span>}
              <span style={styles.eventKind}>{event.kind}</span>
              <span style={styles.eventTime}>{new Date(event.at).toLocaleTimeString()}</span>
            </div>
            <div style={styles.eventContent}>{event.content}</div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={styles.footer}>
        <p>Exported from Clowder AI Story Player • Export ID: {pack.manifest.exportId.slice(0, 8)}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  center: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    color: 'var(--color-text-primary, #e0e0e0)',
    background: 'var(--color-surface, #0d0d1a)',
    gap: '8px',
  },
  container: {
    minHeight: '100vh',
    background: 'var(--color-surface, #0d0d1a)',
    color: 'var(--color-text-primary, #e0e0e0)',
    padding: '0 0 40px 0',
  },
  header: {
    padding: '24px 20px',
    borderBottom: '1px solid var(--color-border, #333)',
    background: 'var(--color-surface-elevated, #1a1a2e)',
  },
  title: {
    margin: 0,
    fontSize: 'var(--console-font-sm)',
    fontWeight: 600,
  },
  meta: {
    marginTop: '8px',
    display: 'flex',
    gap: '16px',
    fontSize: 'var(--console-font-label)',
    opacity: 0.6,
  },
  annotationsSection: { padding: '16px 20px' },
  sectionTitle: {
    fontSize: 'var(--console-font-compact)',
    fontWeight: 600,
    marginBottom: '8px',
    opacity: 0.8,
  },
  annotationCard: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    padding: '8px 12px',
    background: 'var(--color-surface-elevated, #1a1a2e)',
    border: '1px solid var(--color-border, #333)',
    borderRadius: '6px',
    marginBottom: '6px',
    fontSize: 'var(--console-font-compact)',
  },
  annotationKind: { fontSize: 'var(--console-font-base)' },
  annotationContent: { flex: 1 },
  annotationTime: {
    fontSize: 'var(--console-font-label)',
    opacity: 0.5,
    fontFamily: 'var(--font-mono, monospace)',
  },
  eventsSection: { padding: '16px 20px' },
  eventCard: {
    padding: '10px 12px',
    background: 'var(--color-surface-elevated, #1a1a2e)',
    border: '1px solid var(--color-surface-secondary, #2a2a3e)',
    borderRadius: '6px',
    marginBottom: '4px',
  },
  eventHeader: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    marginBottom: '4px',
  },
  catBadge: {
    padding: '1px 6px',
    background: 'var(--color-accent, #6366f1)',
    borderRadius: '3px',
    fontSize: 'var(--console-font-label)',
    fontWeight: 600,
    color: '#fff',
  },
  eventKind: {
    fontSize: 'var(--console-font-label)',
    opacity: 0.6,
    textTransform: 'uppercase',
  },
  eventTime: {
    marginLeft: 'auto',
    fontSize: 'var(--console-font-label)',
    fontFamily: 'var(--font-mono, monospace)',
    opacity: 0.4,
  },
  eventContent: {
    fontSize: 'var(--console-font-compact)',
    lineHeight: 1.4,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  footer: {
    textAlign: 'center',
    padding: '20px',
    fontSize: 'var(--console-font-label)',
    opacity: 0.3,
  },
};
