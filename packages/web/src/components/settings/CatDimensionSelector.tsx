'use client';

/**
 * F237 AC-10 — Per-cat dimension selector.
 * Shows a dropdown of available cats and highlights which segments
 * would be active for the selected cat based on breed and provider.
 */

import { useCatData } from '@/hooks/useCatData';
import type { ClientId } from '../hub-cat-editor.model';
import { defaultMcpSupportForClient } from '../hub-cat-editor.protocols';

interface CatDimensionSelectorProps {
  onSelect: (catId: string | null) => void;
  selected: string | null;
}

export function CatDimensionSelector({ onSelect, selected }: CatDimensionSelectorProps) {
  const { cats } = useCatData();
  const availableCats = cats.filter((c) => c.roster?.available !== false);

  if (availableCats.length === 0) return null;

  return (
    <select
      value={selected ?? ''}
      onChange={(e) => onSelect(e.target.value || null)}
      className="min-w-0 truncate rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-field-bg)] px-2 py-1.5 text-xs text-cafe-secondary"
    >
      <option value="">选择成员预览</option>
      {availableCats.map((cat) => (
        <option key={cat.id} value={cat.id}>
          {cat.displayName}
        </option>
      ))}
    </select>
  );
}

/**
 * Determine if a segment would be active for a given cat.
 * Uses heuristic matching based on trigger conditions in the manifest.
 * @param catClientId — CLI client identity (anthropic/openai/google/etc.)
 */
export function isSegmentActiveForCat(
  trigger: string,
  _catBreed: string | undefined,
  catClientId: string | undefined,
): boolean {
  const t = trigger.toLowerCase();

  // Always-on segments
  if (t === 'always' || t === 'session start' || t === 'session stop') return true;

  // MCP segments: use canonical defaultMcpSupportForClient (single source of truth)
  if (t.includes('mcpavailable') || t.includes('mcp')) {
    if (!catClientId) return true; // no filter = assume active
    return defaultMcpSupportForClient(catClientId as ClientId);
  }

  // Breed-specific workflow triggers
  if (t.includes('workflow_triggers') || t.includes('breedid')) return true;

  // A2A segments: active when not parallel
  if (t.includes('a2aenabled') || t.includes("mode !== 'parallel'")) return true;

  // Default: assume active
  return true;
}
