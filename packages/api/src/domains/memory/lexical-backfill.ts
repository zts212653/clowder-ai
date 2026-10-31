import type { EvidenceItem } from './interfaces.js';

export interface LexicalBackfillRow {
  anchor: string;
  title: string;
  summary: string | null;
  keywords: string | null;
  updated_at: string;
  superseded_by: string | null;
  source_path: string | null;
  provenance_tier: string | null;
}

export interface LexicalBackfillSignal {
  keywordHits: number;
  titleHits: number;
  textHits: number;
}

export function splitLexicalBackfillWords(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
}

export function rankLexicalBackfillRows<T extends LexicalBackfillRow>(
  rows: T[],
  words: string[],
): { rows: T[]; signals: Map<string, LexicalBackfillSignal> } {
  const signals = new Map<string, LexicalBackfillSignal>();

  for (const row of rows) {
    signals.set(row.anchor, computeLexicalBackfillSignal(row, words));
  }

  const rankedRows = [...rows].sort((a, b) => {
    const signalOrder = compareLexicalBackfillSignals(signals.get(a.anchor), signals.get(b.anchor));
    if (signalOrder !== 0) return signalOrder;
    return compareLexicalBackfillRowQuality(a, b);
  });

  return { rows: rankedRows, signals };
}

export function compareEvidenceItemsByLexicalBackfill(
  a: EvidenceItem,
  b: EvidenceItem,
  signals: Map<string, LexicalBackfillSignal>,
  exactAnchor?: string,
): number {
  if (exactAnchor) {
    if (a.anchor === exactAnchor && b.anchor !== exactAnchor) return -1;
    if (b.anchor === exactAnchor && a.anchor !== exactAnchor) return 1;
  }

  return compareLexicalBackfillSignals(signals.get(a.anchor), signals.get(b.anchor));
}

function computeLexicalBackfillSignal(row: LexicalBackfillRow, words: string[]): LexicalBackfillSignal {
  const title = row.title.toLowerCase();
  const summary = (row.summary ?? '').toLowerCase();
  const keywords = parseKeywordList(row.keywords);

  let keywordHits = 0;
  let titleHits = 0;
  let textHits = 0;

  for (const word of words) {
    const keywordHit = keywords.some((keyword) => keyword.includes(word));
    const titleHit = title.includes(word);
    const summaryHit = summary.includes(word);

    if (keywordHit) keywordHits += 1;
    if (titleHit) titleHits += 1;
    if (keywordHit || titleHit || summaryHit) textHits += 1;
  }

  return { keywordHits, titleHits, textHits };
}

function compareLexicalBackfillSignals(a?: LexicalBackfillSignal, b?: LexicalBackfillSignal): number {
  const aSignal = a ?? { keywordHits: 0, titleHits: 0, textHits: 0 };
  const bSignal = b ?? { keywordHits: 0, titleHits: 0, textHits: 0 };

  if (aSignal.keywordHits !== bSignal.keywordHits) {
    return bSignal.keywordHits - aSignal.keywordHits;
  }
  if (aSignal.titleHits !== bSignal.titleHits) {
    return bSignal.titleHits - aSignal.titleHits;
  }
  if (aSignal.textHits !== bSignal.textHits) {
    return bSignal.textHits - aSignal.textHits;
  }
  return 0;
}

function compareLexicalBackfillRowQuality(a: LexicalBackfillRow, b: LexicalBackfillRow): number {
  const supersededOrder = Number(Boolean(a.superseded_by)) - Number(Boolean(b.superseded_by));
  if (supersededOrder !== 0) return supersededOrder;

  const archiveOrder = Number(isArchivePath(a.source_path)) - Number(isArchivePath(b.source_path));
  if (archiveOrder !== 0) return archiveOrder;

  const provenanceOrder = provenanceRank(a.provenance_tier) - provenanceRank(b.provenance_tier);
  if (provenanceOrder !== 0) return provenanceOrder;

  return b.updated_at.localeCompare(a.updated_at);
}

function parseKeywordList(rawKeywords: string | null): string[] {
  if (!rawKeywords) return [];

  try {
    const parsed = JSON.parse(rawKeywords);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((keyword) => String(keyword).toLowerCase());
  } catch {
    return [];
  }
}

function isArchivePath(sourcePath: string | null): boolean {
  return sourcePath?.startsWith('archive/') ?? false;
}

function provenanceRank(tier: string | null): number {
  if (tier === 'authoritative') return 0;
  if (tier != null) return 1;
  return 2;
}
