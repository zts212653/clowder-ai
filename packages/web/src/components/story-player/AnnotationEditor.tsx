/**
 * F252 Phase D — Annotation Editor Modal (AC-D1).
 *
 * Modal form for creating/editing story annotations.
 * Pre-fills timestamp from current playback position.
 */

'use client';

import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnnotationEditorProps {
  storyId: string;
  /** Current playback timestamp in ms since epoch */
  currentTime: number;
  /** Time range of the story for validation display */
  timeRange: { start: number; end: number };
  onSave: () => void;
  onClose: () => void;
}

type AnnotationKind = 'narration' | 'highlight';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AnnotationEditor({ storyId, currentTime, timeRange, onSave, onClose }: AnnotationEditorProps) {
  const [kind, setKind] = useState<AnnotationKind>('narration');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(async () => {
    if (!content.trim()) {
      setError('Content is required');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiFetch(`/api/story/${encodeURIComponent(storyId)}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at: currentTime, kind, content: content.trim() }),
      });
      onSave();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save annotation');
    } finally {
      setSaving(false);
    }
  }, [storyId, currentTime, kind, content, onSave, onClose]);

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Add annotation">
        <h3 style={styles.title}>📝 Add Annotation</h3>

        {/* Timestamp display */}
        <div style={styles.field}>
          <label style={styles.label}>At</label>
          <span style={styles.timestamp}>{formatTimestamp(currentTime)}</span>
        </div>

        {/* Kind selector */}
        <div style={styles.field}>
          <label style={styles.label}>Type</label>
          <div style={styles.kindSelector}>
            <button
              type="button"
              onClick={() => setKind('narration')}
              style={{ ...styles.kindButton, ...(kind === 'narration' ? styles.kindActive : {}) }}
            >
              💬 Narration
            </button>
            <button
              type="button"
              onClick={() => setKind('highlight')}
              style={{ ...styles.kindButton, ...(kind === 'highlight' ? styles.kindActive : {}) }}
            >
              ✨ Highlight
            </button>
          </div>
        </div>

        {/* Content textarea */}
        <div style={styles.field}>
          <label style={styles.label}>Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={kind === 'narration' ? 'Add your narration...' : 'What to highlight...'}
            rows={4}
            style={styles.textarea}
          />
        </div>

        {/* Error display */}
        {error && <p style={styles.error}>{error}</p>}

        {/* Actions */}
        <div style={styles.actions}>
          <button type="button" onClick={onClose} style={styles.cancelButton}>
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !content.trim()}
            style={{
              ...styles.saveButton,
              opacity: saving || !content.trim() ? 0.5 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>

        {/* Time range info */}
        <p style={styles.timeInfo}>
          Story range: {formatTimestamp(timeRange.start)} – {formatTimestamp(timeRange.end)}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 300,
  },
  modal: {
    background: 'var(--color-surface-elevated, #1a1a2e)',
    border: '1px solid var(--color-border, #333)',
    borderRadius: '8px',
    padding: '20px',
    width: '400px',
    maxWidth: '90vw',
    color: 'var(--color-text-primary, #e0e0e0)',
  },
  title: {
    margin: '0 0 16px 0',
    fontSize: 'var(--console-font-base)',
  },
  field: { marginBottom: '12px' },
  label: {
    display: 'block',
    fontSize: 'var(--console-font-xs)',
    opacity: 0.7,
    marginBottom: '4px',
  },
  timestamp: {
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: 'var(--console-font-compact)',
    color: 'var(--color-accent, #6366f1)',
  },
  kindSelector: { display: 'flex', gap: '8px' },
  kindButton: {
    flex: 1,
    padding: '6px 12px',
    background: 'transparent',
    border: '1px solid var(--color-border, #555)',
    borderRadius: '4px',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 'var(--console-font-xs)',
  },
  kindActive: {
    background: 'var(--color-accent, #6366f1)',
    borderColor: 'var(--color-accent, #6366f1)',
    color: '#fff',
  },
  textarea: {
    width: '100%',
    padding: '8px',
    background: 'var(--color-surface, #0d0d1a)',
    border: '1px solid var(--color-border, #555)',
    borderRadius: '4px',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'var(--console-font-compact)',
    resize: 'vertical',
  },
  error: {
    color: '#ef4444',
    fontSize: 'var(--console-font-xs)',
    margin: '0 0 8px 0',
  },
  actions: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
  cancelButton: {
    padding: '6px 16px',
    background: 'transparent',
    border: '1px solid var(--color-border, #555)',
    borderRadius: '4px',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 'var(--console-font-xs)',
  },
  saveButton: {
    padding: '6px 16px',
    background: 'var(--color-accent, #6366f1)',
    border: 'none',
    borderRadius: '4px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 'var(--console-font-xs)',
  },
  timeInfo: {
    marginTop: '12px',
    fontSize: 'var(--console-font-label)',
    opacity: 0.4,
    textAlign: 'center',
  },
};
