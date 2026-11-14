import { isNode, isScalar, parseDocument, parse as parseYaml, visit } from 'yaml';

/**
 * Leading YAML frontmatter of a Markdown document: an optional BOM, a `---` line,
 * the YAML text and a closing `---` line. LF and CRLF line endings are equivalent.
 */
const FRONTMATTER_BLOCK_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type MarkdownFrontmatter =
  | { readonly status: 'missing'; readonly body: string }
  | { readonly status: 'invalid'; readonly yaml: string; readonly body: string; readonly message: string }
  | {
      readonly status: 'parsed';
      readonly yaml: string;
      readonly body: string;
      /** The YAML mapping; empty when the header holds no mapping. */
      readonly data: Record<string, unknown>;
    };

/**
 * Recognize and parse a document's frontmatter with standard YAML semantics.
 * Domain schemas — required fields, field types, what a missing or invalid header
 * means — belong to each consumer; this only answers what the header says.
 */
export function readMarkdownFrontmatter(content: string): MarkdownFrontmatter {
  const match = FRONTMATTER_BLOCK_RE.exec(content);
  if (!match) return { status: 'missing', body: content };

  const yaml = match[1] ?? '';
  const body = content.slice(match[0].length);
  try {
    const parsed: unknown = parseYaml(yaml);
    return { status: 'parsed', yaml, body, data: isRecord(parsed) ? parsed : {} };
  } catch (error) {
    return {
      status: 'invalid',
      yaml,
      body,
      message: error instanceof Error ? error.message : 'invalid YAML frontmatter',
    };
  }
}

export interface FrontmatterPair {
  readonly key: string;
  /** The value in the whole document's context (aliases resolved); undefined when it cannot be resolved. */
  readonly value: unknown;
  readonly resolved: boolean;
  /** The key starts a source line: written as a top-level field, even where error recovery nested it. */
  readonly atLineStart: boolean;
}

/**
 * Every `key: value` pair of a header YAML rejects as a whole, read by the same parser with the
 * whole document's context — anchors and aliases, explicit `? key` entries, comments, flow and
 * block lists — at any depth of what the parser recovered. Recovery can nest the fields after a
 * broken line under it, so a consumer that must not lose a field looks at every pair; a strict
 * consumer keeps treating the header as invalid.
 */
export function readFrontmatterPairs(yaml: string): FrontmatterPair[] {
  const doc = parseDocument(yaml);
  const pairs: FrontmatterPair[] = [];
  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') return;
      let value: unknown = null;
      let resolved = true;
      if (isNode(pair.value)) {
        try {
          value = pair.value.toJS(doc);
        } catch {
          value = undefined;
          resolved = false;
        }
      }
      const start = pair.key.range?.[0];
      const atLineStart = start === 0 || (start !== undefined && yaml[start - 1] === '\n');
      pairs.push({ key: pair.key.value, value, resolved, atLineStart });
    },
  });
  return pairs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
