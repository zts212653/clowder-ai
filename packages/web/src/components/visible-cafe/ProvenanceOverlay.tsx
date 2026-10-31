/**
 * F258 Visible Café — ProvenanceOverlay
 *
 * AC-A3: Click cat → floating panel shows current posture source chain.
 * INV-4: every non-unknown posture back-references its source event.
 *
 * 🚫 Defense Line 1: zero state. Reads from props + render log.
 *
 * No 'use client' — imported only by StarryRoom (already client boundary).
 */

import type { CatPresenceSnapshot } from '@/lib/visible-cafe/presence-types';
import { globalRenderLog } from '@/lib/visible-cafe/render-log';
import typographyTokens from '@/styles/typography-tokens.json';

interface ProvenanceOverlayProps {
  snapshot: CatPresenceSnapshot;
  onClose: () => void;
}

export function ProvenanceOverlay({ snapshot, onClose }: ProvenanceOverlayProps) {
  const recentEntries = globalRenderLog.recent(8);

  return (
    <div
      style={{
        position: 'absolute',
        bottom: '40%',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(20, 10, 40, 0.92)',
        border: '1px solid rgba(200, 180, 255, 0.3)',
        borderRadius: 12,
        padding: '16px 20px',
        color: '#e8e0f0',
        fontSize: typographyTokens.fontSizePx.compact,
        fontFamily: 'monospace',
        maxWidth: 360,
        minWidth: 240,
        zIndex: 10,
        backdropFilter: 'blur(8px)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: typographyTokens.fontSizePx.sm }}>🐱 Posture Provenance</span>
        <button
          onClick={onClose}
          type="button"
          style={{
            background: 'none',
            border: 'none',
            color: '#a090c0',
            cursor: 'pointer',
            fontSize: typographyTokens.fontSizePx.base,
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div>
          <strong>State:</strong> {snapshot.state}
        </div>
        <div>
          <strong>Posture:</strong> {snapshot.posture}
        </div>
        <div>
          <strong>Confidence:</strong> {snapshot.confidence}
        </div>
        <div>
          <strong>Source:</strong> {snapshot.sourceRef ?? '(none)'}
        </div>
        <div>
          <strong>Observed:</strong>{' '}
          {snapshot.observedAt > 0 ? new Date(snapshot.observedAt).toLocaleTimeString() : '(never)'}
        </div>
        <div>
          <strong>Expires:</strong>{' '}
          {snapshot.expiresAt > 0 ? new Date(snapshot.expiresAt).toLocaleTimeString() : '(never)'}
        </div>
      </div>

      {recentEntries.length > 0 && (
        <>
          <div style={{ fontSize: typographyTokens.fontSizePx.label, color: '#a090c0', marginBottom: 4 }}>
            Recent transitions ({globalRenderLog.size} total):
          </div>
          <div style={{ maxHeight: 120, overflowY: 'auto', fontSize: typographyTokens.fontSizePx.label }}>
            {recentEntries.map((entry, i) => (
              <div
                key={`${entry.ts}-${i}`}
                style={{
                  padding: '2px 0',
                  borderBottom: '1px solid rgba(200, 180, 255, 0.1)',
                }}
              >
                {new Date(entry.ts).toLocaleTimeString()} → {entry.posture} ({entry.state})
                {entry.sourceRef && <span style={{ color: '#8070a0' }}> [{entry.sourceRef}]</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
