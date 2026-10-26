#!/usr/bin/env node
/**
 * F236 Phase C — PostToolUse anchor hook for cc native Read/Grep/Glob.
 *
 * Protocol:
 * - stdin: JSON { hook_event_name, tool_name, tool_input, tool_response, tool_use_id }
 * - stdout: JSON { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: ... } }
 *   to replace, or nothing for pass-through
 * - exit 0 always (non-zero = cc logs error)
 *
 * Cat-controlled mode: checks mode file at /tmp/cat-cafe-anchor-mode-{invocationId}.
 * Fail-open: no mode file = pass-through (full text).
 * Bounded drill: offset/limit present = always pass-through (escape hatch).
 *
 * Anchor format = locator not synopsis (ADR-031 hard invariant):
 * - File path + total lines + omitted lines + drill pointer
 * - ZERO content from the original file
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';

// ─── Exported for testing ───────────────────────────────────────────────────

/**
 * Resolve mode file path.
 * - Clowder AI managed: /tmp/cat-cafe-anchor-mode-{invocationId}
 * - Interactive fallback: {projectDir}/.f236-anchor-mode
 */
export function resolveModeFilePath(env = process.env) {
  const invocationId = env.CAT_CAFE_INVOCATION_ID;
  if (invocationId) {
    return `/tmp/cat-cafe-anchor-mode-${invocationId}`;
  }
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (projectDir) {
    return `${projectDir}/.f236-anchor-mode`;
  }
  return null;
}

/**
 * Check if anchor mode is active.
 * Fail-open: returns false if mode file absent or content !== 'anchor'.
 */
export function isAnchorModeActive(modeFilePath) {
  if (!modeFilePath) return false;
  try {
    const content = readFileSync(modeFilePath, 'utf-8').trim();
    return content === 'anchor';
  } catch {
    return false; // fail-open
  }
}

/**
 * Check if this is a bounded Read (drill pass-through).
 * Bounded = offset or limit is present and non-null.
 */
export function isBoundedRead(toolInput) {
  return toolInput?.offset != null || toolInput?.limit != null;
}

/**
 * Get total line count for a file.
 * Primary: from tool_response.file.totalLines
 * Fallback: wc -l from disk (handles cc cache anomaly where .file is empty)
 */
export function getTotalLines(toolResponse, filePath) {
  const totalFromResponse = toolResponse?.file?.totalLines;
  if (typeof totalFromResponse === 'number' && totalFromResponse > 0) {
    return totalFromResponse;
  }
  // Fallback: stat from disk
  if (filePath) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      // Account for trailing newline: if last element is '', it's a trailing newline
      return lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    } catch {
      // File might not exist (e.g., virtual path)
      return 0;
    }
  }
  return 0;
}

/**
 * Build anchor content for a Read tool response.
 * Locator format — no original content, just metadata + drill pointer.
 */
export function buildReadAnchor(filePath, totalLines) {
  const drillLimit = Math.min(totalLines, 200);
  return [
    `[F236-ANCHOR] ${filePath} (${totalLines} lines)`,
    `Omitted: ${totalLines} lines of content`,
    `Drill: Read(file_path="${filePath}", offset=1, limit=${drillLimit})`,
  ].join('\n');
}

/**
 * Build shape-matched updatedToolOutput for Read.
 * Preserves the original tool_response shape, only replacing .file.content.
 */
export function buildReadReplacement(toolResponse, anchorContent, totalLines) {
  const file = toolResponse?.file ?? {};
  return {
    updatedToolOutput: {
      type: toolResponse?.type ?? 'text',
      file: {
        filePath: file.filePath ?? '',
        content: anchorContent,
        numLines: file.numLines ?? totalLines,
        startLine: file.startLine ?? 1,
        totalLines: totalLines,
      },
    },
  };
}

/**
 * Parse Grep content to count per-file hits.
 * Grep content format: "filepath:linenum:text\n..." (ripgrep-style)
 */
export function parseGrepHitsPerFile(content, filenames) {
  if (!content || !filenames?.length) {
    return filenames?.map((f) => ({ file: f, hits: 0 })) ?? [];
  }
  const counts = new Map();
  for (const f of filenames) counts.set(f, 0);

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    // Match "filepath:linenum:..." format
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const file = line.slice(0, colonIdx);
      if (counts.has(file)) {
        counts.set(file, counts.get(file) + 1);
      }
    }
  }
  return filenames.map((f) => ({ file: f, hits: counts.get(f) ?? 0 }));
}

/**
 * Build anchor content for a Grep tool response.
 */
export function buildGrepAnchor(toolInput, toolResponse) {
  const pattern = toolInput?.pattern ?? '?';
  const numFiles = toolResponse?.numFiles ?? 0;
  const numLines = toolResponse?.numLines ?? 0;
  const filenames = toolResponse?.filenames ?? [];
  const hitsPerFile = parseGrepHitsPerFile(toolResponse?.content, filenames);

  const lines = [`[F236-ANCHOR] Grep: ${numFiles} files, ${numLines} matching lines`, `Pattern: "${pattern}"`];
  for (const { file, hits } of hitsPerFile) {
    lines.push(`  ${file} (${hits} hits)`);
  }
  if (filenames.length > 0) {
    lines.push(`Drill: Grep(pattern="${pattern}", path="${filenames[0]}") or Read(file_path="${filenames[0]}")`);
  }
  return lines.join('\n');
}

/**
 * Build shape-matched updatedToolOutput for Grep.
 */
export function buildGrepReplacement(toolResponse, anchorContent) {
  return {
    updatedToolOutput: {
      mode: toolResponse?.mode ?? 'content',
      numFiles: toolResponse?.numFiles ?? 0,
      filenames: toolResponse?.filenames ?? [],
      content: anchorContent,
      numLines: toolResponse?.numLines ?? 0,
    },
  };
}

/**
 * Build anchor content for a Glob tool response.
 * Glob typically returns a file list — anchor summarizes the count + drill.
 */
export function buildGlobAnchor(toolInput, toolResponse) {
  const pattern = toolInput?.pattern ?? '*';
  // Glob response shape: { filenames: string[], numFiles: number }
  const filenames = toolResponse?.filenames ?? [];
  const numFiles = toolResponse?.numFiles ?? filenames.length;

  const lines = [`[F236-ANCHOR] Glob: ${numFiles} files matched`, `Pattern: "${pattern}"`];
  // Show up to 10 files
  const shown = filenames.slice(0, 10);
  for (const f of shown) {
    lines.push(`  ${f}`);
  }
  if (filenames.length > 10) {
    lines.push(`  ... and ${filenames.length - 10} more`);
  }
  if (filenames.length > 0) {
    lines.push(`Drill: Read(file_path="${filenames[0]}")`);
  }
  return lines.join('\n');
}

/**
 * Build shape-matched updatedToolOutput for Glob.
 * Cloud review P2 fix: truncate filenames to match anchor display (max 10).
 * Full filenames list can contain hundreds of paths for repo-wide globs,
 * defeating anchor-mode context savings. numFiles preserves the total count.
 */
export function buildGlobReplacement(toolResponse, anchorContent) {
  const allFilenames = toolResponse?.filenames ?? [];
  return {
    updatedToolOutput: {
      filenames: allFilenames.slice(0, 10),
      numFiles: toolResponse?.numFiles ?? allFilenames.length,
      content: anchorContent,
    },
  };
}

/**
 * Resolve eval event file path (invocation-keyed, same pattern as mode file).
 * Returns null if no invocation ID available.
 */
export function resolveEvalFilePath(env = process.env) {
  const invocationId = env.CAT_CAFE_INVOCATION_ID;
  if (invocationId) return `/tmp/cat-cafe-anchor-eval-${invocationId}.jsonl`;
  // Interactive fallback: project-dir-keyed
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (projectDir) return `${projectDir}/.f236-anchor-eval.jsonl`;
  return null;
}

// ─── Stale detection (per-file mtime tracking) ─────────────────────────────

/**
 * Resolve file state tracking path (per-invocation).
 * Tracks mtime of anchored files so drill reads can detect stale content.
 */
export function resolveStateFilePath(env = process.env) {
  const invocationId = env.CAT_CAFE_INVOCATION_ID;
  if (invocationId) return `/tmp/cat-cafe-anchor-filestate-${invocationId}.json`;
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (projectDir) return `${projectDir}/.f236-anchor-filestate.json`;
  return null;
}

/**
 * Record file mtime at anchor time for later stale detection.
 * Best-effort — never fails the hook.
 * @param {object} env Process env
 * @param {string[]} filePaths File paths to record (capped at 20)
 */
export function recordFileState(env, filePaths) {
  try {
    const stateFilePath = resolveStateFilePath(env);
    if (!stateFilePath) return;

    let state = {};
    try {
      state = JSON.parse(readFileSync(stateFilePath, 'utf-8'));
    } catch {
      // No existing state file — start fresh
    }

    const toRecord = filePaths.slice(0, 20);
    for (const fp of toRecord) {
      try {
        const s = statSync(fp);
        state[fp] = { mtimeMs: s.mtimeMs };
      } catch {
        // Virtual/nonexistent file — skip
      }
    }

    writeFileSync(stateFilePath, JSON.stringify(state));
  } catch {
    // Best-effort — never break the hook
  }
}

/**
 * Check if a file has changed since it was anchored.
 * @returns {{ stale: boolean }} or null if no recorded state.
 */
export function checkFileStale(env, filePath) {
  try {
    const stateFilePath = resolveStateFilePath(env);
    if (!stateFilePath) return null;

    const state = JSON.parse(readFileSync(stateFilePath, 'utf-8'));
    const recorded = state[filePath];
    if (!recorded || typeof recorded.mtimeMs !== 'number') return null;

    const currentStat = statSync(filePath);
    return { stale: currentStat.mtimeMs !== recorded.mtimeMs };
  } catch {
    return null; // Can't check — fail open
  }
}

// ─── Eval event recording ───────────────────────────────────────────────────

/**
 * Append a preview eval event to the invocation-keyed jsonl file.
 * Best-effort — eval recording must never break anchoring.
 *
 * R2 fix: emits Track-2 compatible fields (itemIds, modeResolved, modeSource,
 * catId) so the Phase E consumer can ingest without further hook changes.
 * modeResolved is always 'anchor' (pass-through exits before reaching eval).
 * modeSource is always 'explicit' (cat called set_read_mode('anchor')).
 * catId comes from CAT_CAFE_CAT_ID env var (set in managed sessions).
 */
export function appendEvalEvent(env, { tool, originalChars, returnedChars, itemIds }) {
  try {
    const evalPath = resolveEvalFilePath(env);
    if (!evalPath) return;
    const event = JSON.stringify({
      tool: `cc-${tool.toLowerCase()}`,
      itemIds,
      originalChars,
      returnedChars,
      modeResolved: 'anchor',
      modeSource: 'explicit',
      catId: env.CAT_CAFE_CAT_ID || undefined,
      ts: Date.now(),
    });
    appendFileSync(evalPath, `${event}\n`);
  } catch {
    // Eval recording is best-effort — never fail the hook
  }
}

/**
 * Append a drill eval event to the invocation-keyed jsonl file.
 * Emitted when anchor mode is active but the Read is bounded (offset/limit),
 * meaning the cat is following up on a locator with a targeted drill.
 * Best-effort — same contract as appendEvalEvent.
 */
export function appendDrillEvalEvent(env, { tool, fullDrillChars, itemId, stale }) {
  try {
    const evalPath = resolveEvalFilePath(env);
    if (!evalPath) return;
    const event = JSON.stringify({
      kind: 'drill',
      tool: `cc-${tool.toLowerCase()}`,
      itemId,
      fullDrillChars,
      ...(stale ? { stale: true } : {}),
      catId: env.CAT_CAFE_CAT_ID || undefined,
      ts: Date.now(),
    });
    appendFileSync(evalPath, `${event}\n`);
  } catch {
    // Eval recording is best-effort — never fail the hook
  }
}

/**
 * Wrap an internal replacement result in the cc PostToolUse hook output envelope.
 * cc requires: { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: ... } }
 * Cloud review P1 fix: bare { updatedToolOutput: ... } is NOT consumed by cc.
 */
export function wrapForPostToolUse(internalResult) {
  if (!internalResult?.updatedToolOutput) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: internalResult.updatedToolOutput,
    },
  };
}

/**
 * Main hook logic. Returns JSON string to stdout, or null for pass-through.
 */
export function processHookEvent(event, env = process.env) {
  const { tool_name, tool_input, tool_response } = event;

  // Only handle Read/Grep/Glob
  if (tool_name !== 'Read' && tool_name !== 'Grep' && tool_name !== 'Glob') {
    return null;
  }

  // Bounded drill pass-through (Read with offset/limit).
  // When anchor mode is active, this is a targeted drill following a locator —
  // emit drill telemetry and check for stale content before passing through.
  if (tool_name === 'Read' && isBoundedRead(tool_input)) {
    const modeFilePath = resolveModeFilePath(env);
    if (isAnchorModeActive(modeFilePath)) {
      const filePath = tool_response?.file?.filePath ?? tool_input?.file_path ?? '';
      const originalContent = tool_response?.file?.content ?? '';
      const staleCheck = checkFileStale(env, filePath);
      const isStale = staleCheck?.stale === true;

      // Stale file: prepend warning header so the cat knows line numbers may have shifted.
      // Content is still passed through — the warning is additive, not blocking.
      if (isStale) {
        const warning = '⚠️ [F236-STALE] File modified since anchor. Line numbers may have shifted.';
        const deliveredContent = `${warning}\n${originalContent}`;
        const file = tool_response?.file ?? {};

        // Emit drill telemetry with DELIVERED content length (includes warning header).
        // gpt52 R1 P2: fullDrillChars contract = "total chars served in the full drill response."
        appendDrillEvalEvent(env, {
          tool: 'Read',
          fullDrillChars: deliveredContent.length,
          itemId: `file:${filePath}`,
          stale: true,
        });
        return wrapForPostToolUse({
          updatedToolOutput: {
            type: tool_response?.type ?? 'text',
            file: {
              filePath: file.filePath ?? filePath,
              content: deliveredContent,
              numLines: file.numLines,
              startLine: file.startLine,
              totalLines: file.totalLines,
            },
          },
        });
      }

      // Non-stale: emit drill telemetry with original content length, pass-through.
      appendDrillEvalEvent(env, {
        tool: 'Read',
        fullDrillChars: originalContent.length,
        itemId: `file:${filePath}`,
      });
    }
    return null;
  }

  // Check anchor mode
  const modeFilePath = resolveModeFilePath(env);
  if (!isAnchorModeActive(modeFilePath)) {
    return null; // fail-open
  }

  // ─── Anchor based on tool type ──────────────────────────────────────────

  if (tool_name === 'Read') {
    const filePath = tool_response?.file?.filePath ?? tool_input?.file_path ?? '';
    const totalLines = getTotalLines(tool_response, filePath);
    const anchorContent = buildReadAnchor(filePath, totalLines);
    let originalChars = (tool_response?.file?.content ?? '').length;
    // R2 P2 fix: cc cache anomaly returns empty .file.content → originalChars = 0.
    // Fall back to disk file size (bytes ≈ chars for typical source code).
    if (originalChars === 0 && filePath) {
      try {
        originalChars = statSync(filePath).size;
      } catch {
        /* best-effort */
      }
    }
    const result = buildReadReplacement(tool_response, anchorContent, totalLines);
    const returnedChars = anchorContent.length;
    appendEvalEvent(env, { tool: 'Read', originalChars, returnedChars, itemIds: [`file:${filePath}`] });
    recordFileState(env, [filePath]);
    return wrapForPostToolUse(result);
  }

  if (tool_name === 'Grep') {
    const filenames = tool_response?.filenames ?? [];
    const anchorContent = buildGrepAnchor(tool_input, tool_response);
    const originalChars = (tool_response?.content ?? '').length;
    const result = buildGrepReplacement(tool_response, anchorContent);
    const returnedChars = anchorContent.length;
    // R3 P1-2 fix: file-level itemIds (not pattern-level) for Track-2 drill attribution
    appendEvalEvent(env, { tool: 'Grep', originalChars, returnedChars, itemIds: filenames.map((f) => `file:${f}`) });
    recordFileState(env, filenames);
    return wrapForPostToolUse(result);
  }

  if (tool_name === 'Glob') {
    // P2 fix: Glob shape not spike-validated (feature doc AC-C0c: "pending: Glob shape").
    // Require filenames array for minimum shape confidence; pass through if shape differs.
    if (!Array.isArray(tool_response?.filenames)) {
      return null; // fail-open: unrecognized Glob shape
    }
    const filenames = tool_response.filenames;
    const anchorContent = buildGlobAnchor(tool_input, tool_response);
    const originalChars = JSON.stringify(filenames).length;
    const result = buildGlobReplacement(tool_response, anchorContent);
    const returnedChars = anchorContent.length;
    // R3 P1-2 fix: file-level itemIds (not pattern-level) for Track-2 drill attribution
    appendEvalEvent(env, { tool: 'Glob', originalChars, returnedChars, itemIds: filenames.map((f) => `file:${f}`) });
    recordFileState(env, filenames);
    return wrapForPostToolUse(result);
  }

  return null;
}

// ─── CLI entry point ────────────────────────────────────────────────────────

async function main() {
  try {
    // Read stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8').trim();
    if (!input) process.exit(0);

    const event = JSON.parse(input);
    const result = processHookEvent(event);

    if (result) {
      process.stdout.write(JSON.stringify(result));
    }
  } catch {
    // Always exit 0 — non-zero makes cc log an error
  }
  process.exit(0);
}

// Only run main when executed directly (not imported for testing)
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''))) {
  main();
}
