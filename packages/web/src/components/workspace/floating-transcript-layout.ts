'use client';

const STORAGE_KEY = 'cat-cafe-floating-transcript';

export interface PersistedLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersistedLayout;
  } catch {}
  return { x: 100, y: 100, width: 380, height: 420 };
}

export function saveLayout(layout: PersistedLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {}
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface InterventionAdvisory {
  type: 'intervention_advisory';
  ts: number;
  reason: string;
  confidence: number;
  source_chunk_num: number;
  source_text: string;
  talking_point: string | null;
}
