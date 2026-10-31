import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import type { TasteDimension } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';
import { resolveCanonicalTasteRoot, type TasteRepository } from '../../taste/services/TasteRepository.js';
import type { TasteMemoryLifecycleStore } from './TasteMemoryLifecycleStore.js';

export const MAX_TASTE_DECISION_PAYLOAD_CHARS = 16_384;
export const TASTE_MEMORY_READER_CONTRACT_REF = 'packages/api/src/domains/memory/taste/TasteMemoryReader.ts';

const MAX_WHEN_CHARS = 64;
const MAX_QUOTE_CHARS = 2_000;
const MAX_SCENE_CHARS = 8_000;
const MAX_TAG_CHARS = 160;
const MAX_METADATA_CHARS = 240;
const MAX_QUOTES = 16;
const MAX_TAGS = 24;

const TASTE_DIMENSIONS = new Set<TasteDimension>([
  'relationship-stance',
  'cognitive-honesty',
  'architecture-aesthetics',
  'visual-quality',
  'authentic-expression',
  'system-philosophy',
  'creative-craft',
]);

const PUBLIC_TASTE_PREFIX = 'docs/taste/vignettes/';
const PRIVATE_TASTE_PREFIX = 'private/taste/';
const TASTE_FILENAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]*\.md$/u;

export type TasteMemoryVisibility = 'public' | 'private';

export interface TasteDecisionPayload {
  when: string;
  quotes: string[];
  takeaway?: string;
  scene: string;
  tags: string[];
  dimension?: TasteDimension;
  catId?: string;
  proposalId?: string;
}

export interface TasteMemoryReadRequest {
  ownerUserId: string;
  sourcePath: string;
  revision?: string;
  includeRetired?: boolean;
}

export interface TasteMemoryReadResult {
  ownerUserId: string;
  visibility: TasteMemoryVisibility;
  sourcePath: string;
  revision: string;
  status: 'active' | 'retired';
  payload: TasteDecisionPayload;
}

export function parseApprovedTasteVignette(
  content: string,
  visibility: TasteMemoryVisibility,
): TasteDecisionPayload | null {
  const parsed = parseTasteVignette(content, visibility, false);
  return parsed?.status === 'active' ? parsed.payload : null;
}

export function parseTasteVignette(
  content: string,
  visibility: TasteMemoryVisibility,
  includeRetired: boolean,
): { payload: TasteDecisionPayload; status: 'active' | 'retired' } | null {
  const parsed = parseTasteFrontmatter(content);
  if (!parsed || !matchesVisibility(parsed, visibility)) return null;
  const status = tasteStatus(parsed);
  if (!status || (status === 'retired' && !includeRetired)) return null;
  const core = parseTasteCore(parsed);
  const metadata = parseTasteMetadata(parsed);
  if (!core || !metadata) return null;

  const payload: TasteDecisionPayload = {
    ...core,
    ...metadata,
  };
  return JSON.stringify(payload).length <= MAX_TASTE_DECISION_PAYLOAD_CHARS ? { payload, status } : null;
}

export function buildTasteDecisionPassage(payload: TasteDecisionPayload): string {
  const lines = [
    'Taste decision vignette',
    `When: ${payload.when}`,
    ...(payload.takeaway ? [`Takeaway hypothesis: ${payload.takeaway}`] : []),
    ...(payload.dimension ? [`Dimension: ${payload.dimension}`] : []),
    `Tags: ${payload.tags.join(', ')}`,
    ...(payload.catId ? [`Cat: ${payload.catId}`] : []),
    ...(payload.proposalId ? [`Proposal: ${payload.proposalId}`] : []),
    'Quotes:',
    ...payload.quotes.map((quote) => `- ${quote}`),
    'Scene:',
    payload.scene,
  ];
  return lines.join('\n');
}

export class TasteMemoryReader {
  constructor(
    private readonly repository: TasteRepository,
    private readonly ownerUserId: string,
    private readonly options: {
      lifecycle?: Pick<TasteMemoryLifecycleStore, 'isReadable'>;
    } = {},
  ) {
    if (!ownerUserId.trim()) throw new Error('TasteMemoryReader requires an ownerUserId');
  }

  async read(request: TasteMemoryReadRequest): Promise<TasteMemoryReadResult | null> {
    if (request.ownerUserId !== this.ownerUserId) return null;
    const visibility = classifyTasteSourcePath(request.sourcePath);
    if (!visibility) return null;
    try {
      if (visibility === 'public' && this.repository.publishedSnapshot) {
        const snapshot = await this.repository.publishedSnapshot();
        if (snapshot) {
          const content = await snapshot.read(request.sourcePath);
          return content === null ? null : this.project(request, visibility, content);
        }
      }
      const root = await realpath(await resolveCanonicalTasteRoot(this.repository));
      const candidate = resolve(root, request.sourcePath);
      const canonicalFile = await realpath(candidate);
      if (canonicalFile !== candidate) return null;
      const rootRelativePath = relative(root, canonicalFile);
      if (!rootRelativePath || rootRelativePath.startsWith('..') || isAbsolute(rootRelativePath)) return null;
      const handle = await open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      let content: string;
      try {
        const opened = await handle.stat();
        const current = await lstat(canonicalFile);
        if (!opened.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) return null;
        if ((await realpath(canonicalFile)) !== canonicalFile) return null;
        content = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      return this.project(request, visibility, content);
    } catch {
      return null;
    }
  }

  private project(request: TasteMemoryReadRequest, visibility: TasteMemoryVisibility, content: string) {
    const revision = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (request.revision !== undefined && request.revision !== revision) return null;
    const parsed = parseTasteVignette(content, visibility, request.includeRetired === true);
    if (
      parsed &&
      this.options.lifecycle &&
      !this.options.lifecycle.isReadable(
        this.ownerUserId,
        request.sourcePath,
        revision,
        request.includeRetired === true,
      )
    ) {
      return null;
    }
    return parsed
      ? {
          ownerUserId: this.ownerUserId,
          visibility,
          sourcePath: request.sourcePath,
          revision,
          status: parsed.status,
          payload: parsed.payload,
        }
      : null;
  }
}

function classifyTasteSourcePath(sourcePath: string): TasteMemoryVisibility | null {
  if (!sourcePath || isAbsolute(sourcePath) || sourcePath.includes('\\')) return null;
  if (posix.normalize(sourcePath) !== sourcePath) return null;
  const prefix = sourcePath.startsWith(PUBLIC_TASTE_PREFIX)
    ? PUBLIC_TASTE_PREFIX
    : sourcePath.startsWith(PRIVATE_TASTE_PREFIX)
      ? PRIVATE_TASTE_PREFIX
      : null;
  if (!prefix) return null;
  const filename = sourcePath.slice(prefix.length);
  if (
    !filename ||
    filename.includes('/') ||
    filename === '.' ||
    filename === '..' ||
    !TASTE_FILENAME_RE.test(filename)
  ) {
    return null;
  }
  return prefix === PUBLIC_TASTE_PREFIX ? 'public' : 'private';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTasteFrontmatter(content: string): Record<string, unknown> | null {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter) return null;
  try {
    const parsed: unknown = parseYaml(frontmatter, { maxAliasCount: 0 });
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function tasteStatus(parsed: Record<string, unknown>): 'active' | 'retired' | null {
  if (parsed.status === undefined || parsed.status === 'approved') return 'active';
  return parsed.status === 'retired' ? 'retired' : null;
}

function matchesVisibility(parsed: Record<string, unknown>, visibility: TasteMemoryVisibility): boolean {
  const privacy = optionalBoundedString(parsed.privacy, MAX_METADATA_CHARS);
  if (parsed.privacy !== undefined && privacy === undefined) return false;
  return visibility === 'public' ? privacy === undefined || privacy === 'public' : privacy === 'sensitive';
}

function parseTasteCore(
  parsed: Record<string, unknown>,
): Pick<TasteDecisionPayload, 'when' | 'quotes' | 'scene' | 'tags' | 'takeaway'> | null {
  const when = requiredBoundedString(parsed.when, MAX_WHEN_CHARS);
  const quotes = boundedStringArray(parsed.quotes, MAX_QUOTES, MAX_QUOTE_CHARS, true);
  const scene = requiredBoundedString(parsed.scene, MAX_SCENE_CHARS);
  const takeaway = optionalBoundedString(parsed.takeaway, 500);
  if (parsed.takeaway !== undefined && takeaway === undefined) return null;
  const tags = boundedStringArray(parsed.tags, MAX_TAGS, MAX_TAG_CHARS, false);
  return when && quotes !== null && scene && tags !== null
    ? { when, quotes, scene, tags, ...(takeaway ? { takeaway } : {}) }
    : null;
}

function parseTasteMetadata(
  parsed: Record<string, unknown>,
): Pick<TasteDecisionPayload, 'dimension' | 'catId' | 'proposalId'> | null {
  const rawDimension = optionalBoundedString(parsed.dimension, MAX_METADATA_CHARS);
  const dimension =
    rawDimension && TASTE_DIMENSIONS.has(rawDimension as TasteDimension) ? (rawDimension as TasteDimension) : undefined;
  const catId = optionalBoundedString(parsed.catId, MAX_METADATA_CHARS);
  const proposalId = optionalBoundedString(parsed.proposalId, MAX_METADATA_CHARS);
  if (parsed.dimension !== undefined && dimension === undefined) return null;
  if (parsed.catId !== undefined && catId === undefined) return null;
  if (parsed.proposalId !== undefined && proposalId === undefined) return null;
  return {
    ...(dimension ? { dimension } : {}),
    ...(catId ? { catId } : {}),
    ...(proposalId ? { proposalId } : {}),
  };
}

function requiredBoundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxChars ? normalized : null;
}

function optionalBoundedString(value: unknown, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredBoundedString(value, maxChars) ?? undefined;
}

function boundedStringArray(value: unknown, maxItems: number, maxChars: number, allowEmpty: boolean): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) return null;
  const normalized = value.map((item) => requiredBoundedString(item, maxChars));
  return normalized.every((item): item is string => item !== null) ? normalized : null;
}
