/**
 * derive-result-summary — F188 Phase F (砚砚 三审 P1-1)
 *
 * Extract per-tool result summary fields from tool_result message content.
 * Used by route-serial / route-parallel tool_result handler to merge
 * result-side data back into the event log via ToolEventLog.updateSummary().
 *
 * MCP tool wrappers (evidence-tools, graph-tools, recent-tools) embed
 * machine-readable result markers in their text output; this parser
 * extracts the structured summary the aggregator needs.
 */

export type ResultSummary = Record<string, unknown>;

/**
 * Parse tool_result content (string OR structured array). Returns the fields
 * relevant to AC-F10 metrics for the given normalized tool name.
 */
export function deriveResultSummary(normalizedToolName: string, content: unknown): ResultSummary {
  const text = extractText(content);
  if (!text) return {};

  switch (normalizedToolName) {
    case 'search_evidence':
      return deriveSearchEvidence(text);
    case 'graph_resolve':
      return deriveGraphResolve(text);
    case 'list_recent':
      return deriveListRecent(text);
    default:
      return {};
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string') {
          return (c as { text: string }).text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

function deriveSearchEvidence(text: string): ResultSummary {
  const summary: ResultSummary = {};
  // "Found N result(s)" or "No results found"
  const found = /Found\s+(\d+)\s+result/i.exec(text);
  const empty = /No results found/i.test(text);
  if (empty) {
    summary.resultCount = 0;
    summary.topScore = null;
  } else if (found?.[1]) {
    summary.resultCount = Number.parseInt(found[1], 10);
  }
  // Phase F nudge marker (composeMemoryNavigationNudge): "🧭 Memory navigation"
  if (text.includes('🧭 Memory navigation')) {
    summary.nudgeEmitted = true;
  } else if (summary.resultCount != null) {
    summary.nudgeEmitted = false;
  }
  // Top confidence — "[high]" / "[mid]" / "[low]" in first result block
  const firstHit = /\[(high|mid|low)\]/.exec(text);
  if (firstHit?.[1]) summary.topConfidence = firstHit[1];

  // F200: extract per-result candidates (anchor + docKind + sourcePath).
  // HW-4 根因②b (砚砚 P1-2): block-scoped so the optional sourcePath/type
  // lines pair to their own anchor instead of a global regex drifting
  // across result blocks when sourcePath is absent on some results.
  const f200Cands: Array<{ anchor: string; rank: number; docKind?: string; sourcePath?: string }> = [];
  const anchorMatches = [...text.matchAll(/^\s+anchor:\s+(\S+)/gm)];
  for (let i = 0; i < anchorMatches.length; i++) {
    const anchor = anchorMatches[i]![1]!;
    const blockStart = anchorMatches[i]!.index ?? 0;
    const blockEnd = i + 1 < anchorMatches.length ? (anchorMatches[i + 1]!.index ?? text.length) : text.length;
    const block = text.slice(blockStart, blockEnd);
    const docKind = /^\s+type:\s+(\S+)/m.exec(block)?.[1];
    const sourcePath = /^\s+sourcePath:\s+(\S+)/m.exec(block)?.[1];
    f200Cands.push({ anchor, rank: f200Cands.length, docKind, ...(sourcePath ? { sourcePath } : {}) });
  }
  if (f200Cands.length > 0) summary._f200Candidates = f200Cands;

  if (/\[redacted\s+—\s+\w+\s+collection\]/i.test(text)) {
    summary._f200HasPrivateHits = true;
  }

  return summary;
}

function deriveGraphResolve(text: string): ResultSummary {
  const summary: ResultSummary = {};
  // Candidate list mode: "Candidates for ... (N matches ..."
  const candidates = /Candidates\s+for\s+.+?\((\d+)\s+match/i.exec(text);
  if (candidates?.[1]) {
    summary.candidateCount = Number.parseInt(candidates[1], 10);
    // Parse ranked anchors: [0] F167 / [1] world:lexander:dragon / [2] docs/decisions/019
    // 砚砚 cloud P2: broaden from `[A-Za-z][\w.-]+` to include `:` and `/` so
    // multi-segment anchors aren't truncated (FM-2 selection linking depends on
    // exact-string match against centerAnchor).
    const ranked: string[] = [];
    const anchorRe = /\[\d+\]\s+([\w.:/-]+)/g;
    let m: RegExpExecArray | null;
    m = anchorRe.exec(text);
    while (m !== null) {
      if (m[1]) ranked.push(m[1]);
      m = anchorRe.exec(text);
    }
    if (ranked.length > 0) summary.rankedCandidateAnchors = ranked;

    // F200: extract candidates with docKind from candidate list
    const f200Cands: Array<{ anchor: string; rank: number; docKind?: string }> = [];
    const candDetailRe = /\[(\d+)\]\s+([\w.:/-]+)\s+—\s+.+\n\s+kind=(\S+)/g;
    let cm: RegExpExecArray | null;
    cm = candDetailRe.exec(text);
    while (cm !== null) {
      f200Cands.push({ anchor: cm[2]!, rank: Number.parseInt(cm[1]!, 10), docKind: cm[3] });
      cm = candDetailRe.exec(text);
    }
    if (f200Cands.length > 0) summary._f200Candidates = f200Cands;
  }
  // Graph subgraph mode: "Graph for \"X\":  N nodes, M edges (depth=D)"
  const graph = /Graph\s+for\s+"([^"]+)":\s+(\d+)\s+nodes,\s+(\d+)\s+edges/i.exec(text);
  if (graph) {
    summary.centerAnchor = graph[1];
    summary.nodeCount = Number.parseInt(graph[2]!, 10);
    summary.edgeCount = Number.parseInt(graph[3]!, 10);
    summary.candidateCount = 1;
    summary.selectedCandidateIndex = 0;
    summary.selectedAnchor = graph[1];
    // F200: center anchor + neighbor anchors from edges as candidates
    const center = graph[1]!;
    const f200Cands: Array<{ anchor: string; rank: number; docKind?: string }> = [{ anchor: center, rank: 0 }];
    // F200: extract traversed edges for Phase C edge weights
    const f200Edges: Array<{ from: string; to: string; relation: string }> = [];
    const edgeRe = /([\w.:/-]+)\s+-\[(\w+)\]->\s+([\w.:/-]+)/g;
    let em: RegExpExecArray | null;
    em = edgeRe.exec(text);
    while (em !== null) {
      f200Edges.push({ from: em[1]!, to: em[3]!, relation: em[2]! });
      em = edgeRe.exec(text);
    }
    if (f200Edges.length > 0) {
      summary._f200Edges = f200Edges;
      const seen = new Set([center]);
      for (const edge of f200Edges) {
        for (const anchor of [edge.from, edge.to]) {
          if (!seen.has(anchor)) {
            seen.add(anchor);
            f200Cands.push({ anchor, rank: f200Cands.length });
          }
        }
      }
    }
    summary._f200Candidates = f200Cands;
  }
  // No-match
  if (/No graph node found/i.test(text)) {
    summary.candidateCount = 0;
  }
  return summary;
}

function deriveListRecent(text: string): ResultSummary {
  const summary: ResultSummary = {};
  // "Recent items (last 7d): N found"
  const m = /Recent\s+items\s+\(last\s+(\S+)\):\s+(\d+)\s+found/i.exec(text);
  if (m?.[1]) summary.since = m[1];
  if (m?.[2]) summary.resultCount = Number.parseInt(m[2], 10);

  // F200: extract candidates from recent items
  const f200Cands: Array<{ anchor: string; rank: number; docKind?: string }> = [];
  const itemRe = /\|\s+([\w.:/-]+)\s+—\s+.+?\((\w+)\)/g;
  let rm: RegExpExecArray | null;
  rm = itemRe.exec(text);
  while (rm !== null) {
    f200Cands.push({ anchor: rm[1]!, rank: f200Cands.length, docKind: rm[2] });
    rm = itemRe.exec(text);
  }
  if (f200Cands.length > 0) summary._f200Candidates = f200Cands;

  return summary;
}
