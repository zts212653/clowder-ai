/**
 * F252 Story Player — Page Route
 *
 * Route: /story/:storyId
 *
 * `feat:<featId>` → feature story (multi-thread swimlane + causal edges)
 * `session:<sessionId>` → SUNSET (Phase E AC-E1): deprecation notice
 *
 * Full-screen immersive layout. Feature stories are the canonical view.
 */

'use client';

import { useParams } from 'next/navigation';
import { FeatureStoryView } from '@/components/story-player/FeatureStoryView';
import { parseStoryId } from './parseStoryId';

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function StoryPlayerPage() {
  const params = useParams();
  const storyId = typeof params.storyId === 'string' ? params.storyId : '';
  const parsed = parseStoryId(storyId);

  if (!parsed) {
    return (
      <div style={styles.errorContainer}>
        <h2>Invalid Story ID</h2>
        <p>
          Story ID must be in format <code>session:{'<sessionId>'}</code> or <code>feat:{'<featId>'}</code>.
        </p>
        <p style={{ opacity: 0.6, fontSize: 'var(--console-font-compact)' }}>
          Received: <code>{storyId}</code>
        </p>
      </div>
    );
  }

  if (parsed.type === 'feat') {
    return <FeatureStoryView featId={parsed.featId} />;
  }

  return <SessionReplayView sessionId={parsed.sessionId} />;
}

// ---------------------------------------------------------------------------
// Session Replay View (SUNSET — AC-E1)
// ---------------------------------------------------------------------------

/**
 * Standalone session replay is sunset in Phase E.
 * Sessions are now replayed through the Feature Story view (Theater mode).
 * This component shows a deprecation notice with a link to the feature view.
 */
function SessionReplayView({ sessionId }: { sessionId: string }) {
  return (
    <div style={styles.errorContainer}>
      <h2 style={{ marginBottom: '12px' }}>Session Replay Moved</h2>
      <p style={{ maxWidth: '480px', lineHeight: 1.6 }}>
        Standalone session replay has been replaced by the Feature Story view, which shows sessions in context with
        multi-thread layout and visual effects.
      </p>
      <p style={{ opacity: 0.5, fontSize: 'var(--console-font-xs)', marginTop: '16px' }}>
        Session: <code>{sessionId.slice(0, 24)}...</code>
      </p>
      <p style={{ opacity: 0.4, fontSize: 'var(--console-font-xs)', marginTop: '8px' }}>
        Use <code>feat:&lt;featId&gt;</code> to view sessions through their feature story.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  errorContainer: {
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
};
