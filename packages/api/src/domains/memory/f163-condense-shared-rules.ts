/**
 * F163 Phase B (AC-B4): Shared-rules condensation analysis.
 * Parses markdown sections, identifies clusters via TF-IDF similarity,
 * and reports potential line-count reduction with source markers.
 *
 * This module is analysis-only — it produces proposals, not auto-applies.
 */

import { cosineSimilarity, inverseDocFrequency, termFrequency, tfidfVector, tokenize } from './f163-text-similarity.js';

export interface RuleSection {
  heading: string;
  content: string;
  lineCount: number;
}

export interface RuleCluster {
  sections: string[];
  similarity: number;
  suggestedMergedHeading: string;
}

export interface CondensationResult {
  clusters: RuleCluster[];
  originalLineCount: number;
  proposedLineCount: number;
  reductionPercent: number;
  sections: RuleSection[];
}

interface CondenseOptions {
  threshold?: number;
}

// ── Section parser ───────────────────────────────────────────────────

function parseSections(content: string): RuleSection[] {
  const lines = content.split('\n');
  const sections: RuleSection[] = [];
  let current: RuleSection | null = null;

  for (const line of lines) {
    if (/^#{2,3}\s/.test(line)) {
      if (current) sections.push(current);
      current = { heading: line.replace(/^#+\s*/, '').trim(), content: '', lineCount: 0 };
    } else if (current) {
      current.content += line + '\n';
      if (line.trim()) current.lineCount++;
    }
  }
  if (current) sections.push(current);
  return sections;
}

// ── Single-linkage clustering ────────────────────────────────────────

function cluster(similarities: { i: number; j: number; sim: number }[], n: number, threshold: number): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (const { i, j, sim } of similarities) {
    if (sim >= threshold) union(i, j);
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const arr = groups.get(root) ?? [];
    arr.push(i);
    groups.set(root, arr);
  }
  return [...groups.values()].filter((c) => c.length >= 2);
}

// ── Main analysis function ───────────────────────────────────────────

export function analyzeSharedRules(content: string, options?: CondenseOptions): CondensationResult {
  const threshold = options?.threshold ?? 0.3;
  const sections = parseSections(content);
  const originalLineCount = content.split('\n').length;

  if (sections.length < 2) {
    return {
      clusters: [],
      originalLineCount,
      proposedLineCount: originalLineCount,
      reductionPercent: 0,
      sections,
    };
  }

  // Build TF-IDF vectors
  const tfMaps = sections.map((s) => termFrequency(tokenize(`${s.heading} ${s.content}`)));
  const idf = inverseDocFrequency(tfMaps);
  const vectors = tfMaps.map((tf) => tfidfVector(tf, idf));

  // Pairwise similarities
  const pairs: { i: number; j: number; sim: number }[] = [];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim >= threshold) pairs.push({ i, j, sim });
    }
  }

  const clusters = cluster(pairs, sections.length, threshold);

  const ruleClusters: RuleCluster[] = clusters.map((indices) => {
    const sectionHeadings = indices.map((i) => sections[i].heading);
    const clusterPairs = pairs.filter((p) => indices.includes(p.i) && indices.includes(p.j));
    const avgSim =
      clusterPairs.length > 0 ? clusterPairs.reduce((sum, p) => sum + p.sim, 0) / clusterPairs.length : threshold;
    const longest = sectionHeadings.reduce((a, b) => (a.length >= b.length ? a : b));
    return {
      sections: sectionHeadings,
      similarity: avgSim,
      suggestedMergedHeading: longest,
    };
  });

  // Estimate reduction: each cluster of N sections → 1 merged section
  // Conservative estimate: merged section = max lines among cluster members
  const clusteredIndices = new Set(clusters.flat());
  let savedLines = 0;
  for (const indices of clusters) {
    const lineCounts = indices.map((i) => sections[i].lineCount);
    const totalLines = lineCounts.reduce((a, b) => a + b, 0);
    const mergedLines = Math.max(...lineCounts);
    savedLines += totalLines - mergedLines;
  }

  const proposedLineCount = originalLineCount - savedLines;
  const reductionPercent = originalLineCount > 0 ? (savedLines / originalLineCount) * 100 : 0;

  return {
    clusters: ruleClusters,
    originalLineCount,
    proposedLineCount,
    reductionPercent,
    sections,
  };
}
