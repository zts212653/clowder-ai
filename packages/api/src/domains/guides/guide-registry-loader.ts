/**
 * F155: Load guide registry from YAML source.
 *
 * Provides a validated set of known guide IDs for server-side validation,
 * and the guide catalog metadata for discovery MCP tools.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export interface GuideRegistryEntry {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  category: string;
  priority: string;
  cross_system: boolean;
  estimated_time: string;
  flow_file: string;
  requires_member_cards?: boolean;
}

interface RegistryFile {
  guides: GuideRegistryEntry[];
}

/** Resolve project root from this file's location */
function findProjectRoot(): string {
  // At runtime: packages/api/dist/domains/guides/guide-registry-loader.js
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '..', '..', '..', '..', '..');
}

let cachedEntries: GuideRegistryEntry[] | null = null;
let cachedIds: Set<string> | null = null;
const GUIDE_TARGET_RE = /^[a-zA-Z0-9._-]+$/;

function ensureLoaded(): void {
  if (cachedEntries) return;
  const root = findProjectRoot();
  const registryPath = resolve(root, 'guides', 'registry.yaml');
  const raw = readFileSync(registryPath, 'utf-8');
  const parsed = YAML.parse(raw) as RegistryFile;
  if (!parsed?.guides || !Array.isArray(parsed.guides)) {
    throw new Error('[F155] Invalid guide registry: missing "guides" array');
  }
  cachedEntries = parsed.guides;
  cachedIds = new Set(parsed.guides.map((g) => g.id));
}

/** Get set of valid guide IDs */
export function getValidGuideIds(): Set<string> {
  ensureLoaded();
  return cachedIds!;
}

/** Get all registry entries (for resolve tool) */
export function getRegistryEntries(): GuideRegistryEntry[] {
  ensureLoaded();
  return cachedEntries!;
}

export function isValidGuideTarget(target: string): boolean {
  return GUIDE_TARGET_RE.test(target);
}

/** Check if a guideId is valid */
export function isValidGuideId(guideId: string): boolean {
  return getValidGuideIds().has(guideId);
}

export interface AvailableGuide {
  id: string;
  name: string;
  description: string;
  category: string;
  priority: string;
  crossSystem: boolean;
  estimatedTime: string;
}

export interface GuideAvailabilityContext {
  memberCardCount?: number;
}

export interface GuideMatch {
  id: string;
  name: string;
  description: string;
  estimatedTime: string;
  score: number;
  totalKeywords: number;
}

export interface GuideResolveContext {
  memberCardCount?: number;
}

/**
 * Match user intent against guide registry keywords.
 * Returns matched guides sorted by score (highest first), or empty array.
 * Used by the explicit guide resolve tool after the cat decides a guided flow
 * is more helpful than a plain-text explanation.
 */
/* ── OrchestrationFlow v2 — runtime flow loader ── */

export interface TipsMetadata {
  /** data-guide-id of a pre-composed card div (type: 'card') */
  target?: string;
  type: 'card' | 'png';
  /** Static image path (type: 'png') */
  src?: string;
  layout?: 'horizontal' | 'vertical';
  alt?: string;
}

export interface OrchestrationStep {
  id: string;
  target: string;
  tips: string;
  advance: 'click' | 'visible' | 'input' | 'confirm';
  page?: string;
  timeoutSec?: number;
  tipsMetadata?: TipsMetadata;
}

export interface OrchestrationFlow {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  steps: OrchestrationStep[];
}

interface RawFlowFile {
  schemaVersion?: number;
  id: string;
  name: string;
  description?: string;
  steps: Array<{
    id: string;
    target: string;
    tips: string;
    advance: string;
    page?: string;
    timeoutSec?: number;
    tipsMetadata?: {
      target?: string;
      type?: string;
      src?: string;
      layout?: string;
      alt?: string;
    };
  }>;
}

const flowCache = new Map<string, OrchestrationFlow>();
const MIN_ASCII_REVERSE_MATCH_LENGTH = 3;
const MIN_NON_ASCII_REVERSE_MATCH_LENGTH = 2;
const SUPPORTED_FLOW_SCHEMA_VERSION = 1;

function normalizeGuideIntent(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function canUseReverseSubstringMatch(query: string): boolean {
  const compact = query.replace(/\s+/g, '');
  if (!compact) return false;
  return /^[a-z0-9._-]+$/i.test(compact)
    ? compact.length >= MIN_ASCII_REVERSE_MATCH_LENGTH
    : compact.length >= MIN_NON_ASCII_REVERSE_MATCH_LENGTH;
}

function normalizeFlowSchemaVersion(guideId: string, schemaVersion?: number): 1 {
  if (schemaVersion == null) {
    return SUPPORTED_FLOW_SCHEMA_VERSION;
  }
  if (schemaVersion !== SUPPORTED_FLOW_SCHEMA_VERSION) {
    throw new Error(`[F155] Unsupported flow schemaVersion "${schemaVersion}" for "${guideId}"`);
  }
  return SUPPORTED_FLOW_SCHEMA_VERSION;
}

/**
 * Load a guide flow YAML at runtime and return OrchestrationFlow.
 * Throws if guide ID is unknown or flow file is invalid.
 */
export function loadGuideFlow(guideId: string): OrchestrationFlow {
  const cached = flowCache.get(guideId);
  if (cached) return cached;

  const entries = getRegistryEntries();
  const entry = entries.find((e) => e.id === guideId);
  if (!entry) throw new Error(`[F155] Unknown guide: ${guideId}`);

  const root = findProjectRoot();
  const flowPath = resolve(root, 'guides', entry.flow_file);
  const raw = readFileSync(flowPath, 'utf-8');
  const parsed = YAML.parse(raw) as RawFlowFile;

  if (parsed?.id !== guideId) {
    throw new Error(
      `[F155] Invalid flow file for "${guideId}": expected id "${guideId}", got "${String(parsed?.id ?? '')}"`,
    );
  }

  if (!parsed?.steps || !Array.isArray(parsed.steps)) {
    throw new Error(`[F155] Invalid flow file for "${guideId}": missing steps`);
  }

  const validAdvance = new Set(['click', 'visible', 'input', 'confirm']);
  const flow: OrchestrationFlow = {
    schemaVersion: normalizeFlowSchemaVersion(guideId, parsed.schemaVersion),
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    steps: parsed.steps.map((s) => {
      if (!validAdvance.has(s.advance)) {
        throw new Error(`[F155] Invalid advance type "${s.advance}" in step "${s.id}"`);
      }
      if (!isValidGuideTarget(s.target)) {
        throw new Error(`[F155] Invalid target "${s.target}" in step "${s.id}"`);
      }
      const step: OrchestrationStep = {
        id: s.id,
        target: s.target,
        tips: s.tips,
        advance: s.advance as OrchestrationStep['advance'],
        ...(s.page && { page: s.page }),
        ...(s.timeoutSec && { timeoutSec: s.timeoutSec }),
      };
      if (s.tipsMetadata?.type === 'card' || s.tipsMetadata?.type === 'png') {
        step.tipsMetadata = {
          type: s.tipsMetadata.type,
          ...(s.tipsMetadata.target && { target: s.tipsMetadata.target }),
          ...(s.tipsMetadata.src && { src: s.tipsMetadata.src }),
          ...(s.tipsMetadata.layout && { layout: s.tipsMetadata.layout as 'horizontal' | 'vertical' }),
          ...(s.tipsMetadata.alt && { alt: s.tipsMetadata.alt }),
        };
      }
      return step;
    }),
  };

  flowCache.set(guideId, flow);
  return flow;
}

function entryIsAvailable(
  entry: GuideRegistryEntry,
  context?: GuideAvailabilityContext | GuideResolveContext,
): boolean {
  if (entry.requires_member_cards && (context?.memberCardCount ?? 0) <= 0) {
    return false;
  }
  return true;
}

export function resolveGuideForIntent(intent: string, context?: GuideResolveContext): GuideMatch[] {
  const entries = getRegistryEntries();
  const query = normalizeGuideIntent(intent);
  if (!query) return [];
  const allowReverseSubstringMatch = canUseReverseSubstringMatch(query);

  return entries
    .filter((entry) => entryIsAvailable(entry, context))
    .map((entry) => {
      const score = entry.keywords.filter((keyword) => {
        const normalizedKeyword = normalizeGuideIntent(keyword);
        return query.includes(normalizedKeyword) || (allowReverseSubstringMatch && normalizedKeyword.includes(query));
      }).length;

      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        estimatedTime: entry.estimated_time,
        score,
        totalKeywords: entry.keywords.length,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.totalKeywords - b.totalKeywords);
}

export function getAvailableGuides(context?: GuideAvailabilityContext): AvailableGuide[] {
  return getRegistryEntries()
    .filter((entry) => entryIsAvailable(entry, context))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      category: entry.category,
      priority: entry.priority,
      crossSystem: entry.cross_system,
      estimatedTime: entry.estimated_time,
    }));
}
