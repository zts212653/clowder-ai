import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { LoadedPerspectivePlan, PerspectivePlan } from './perspective-types.js';

export interface PerspectivePlanLoaderOptions {
  repoRoot: string;
}

const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

const inputSpecSchema = z.object({
  description: z.string().min(1),
  required: z.boolean().optional(),
  default: scalarSchema.optional(),
});

const stepBaseSchema = z.object({
  id: z.string().min(1),
});

const searchEvidenceStepSchema = stepBaseSchema.extend({
  type: z.literal('search_evidence'),
  query: z.string().min(1),
  scope: z.enum(['docs', 'memory', 'threads', 'sessions', 'all']).optional(),
  mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
  depth: z.enum(['summary', 'raw']).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  dimension: z.enum(['project', 'global', 'all', 'library', 'collection']).optional(),
  collections: z.array(z.string().min(1)).optional(),
  explain: z.boolean().optional(),
});

const graphResolveStepSchema = stepBaseSchema.extend({
  type: z.literal('graph_resolve'),
  anchor: z.string().min(1),
});

const openAnchorStepSchema = stepBaseSchema.extend({
  type: z.literal('open_anchor'),
  source: z.literal('previous_step'),
  selector: z.literal('top'),
  maxOpen: z.number().int().min(1).max(10),
});

const perspectivePlanSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  featureIds: z.array(z.string().min(1)).min(1),
  ownerCatId: z.string().min(1),
  intent: z.string().min(1),
  inputs: z.record(inputSpecSchema).optional(),
  defaults: z.record(scalarSchema).optional(),
  steps: z
    .array(z.discriminatedUnion('type', [searchEvidenceStepSchema, graphResolveStepSchema, openAnchorStepSchema]))
    .min(1),
  outputPolicy: z.object({
    storesResults: z.literal(false),
    returnsConclusion: z.literal(false),
    requiresAnchors: z.literal(true),
  }),
});

export class PerspectivePlanLoader {
  private readonly repoRoot: string;
  private readonly perspectiveRoot: string;

  constructor(options: PerspectivePlanLoaderOptions) {
    this.repoRoot = resolve(options.repoRoot);
    this.perspectiveRoot = resolve(this.repoRoot, 'docs', 'perspectives');
  }

  async loadById(id: string): Promise<LoadedPerspectivePlan> {
    if (!id.trim()) {
      throw new Error('Perspective plan id must be non-empty');
    }
    return this.loadByPath(`docs/perspectives/${id}.md`);
  }

  async loadByPath(relativePath: string): Promise<LoadedPerspectivePlan> {
    const { absolutePath, normalizedRelativePath } = await this.resolvePerspectivePath(relativePath);
    const raw = await readFile(absolutePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw, normalizedRelativePath);
    const parsed = parseYaml(frontmatter) as unknown;
    const plan = validatePlan(parsed, normalizedRelativePath);
    const expectedId = expectedPlanIdFromPath(normalizedRelativePath);
    if (plan.id !== expectedId) {
      throw new Error(
        `Invalid Perspective plan ${normalizedRelativePath}: id "${plan.id}" does not match path "${expectedId}"`,
      );
    }
    return {
      plan,
      relativePath: normalizedRelativePath,
      absolutePath,
      body,
    };
  }

  private async resolvePerspectivePath(
    relativePath: string,
  ): Promise<{ absolutePath: string; normalizedRelativePath: string }> {
    if (isAbsolute(relativePath)) {
      throw new Error('Perspective plan path must be relative to docs/perspectives');
    }

    const absolutePath = resolve(this.repoRoot, relativePath);
    const relativeToPerspectiveRoot = relative(this.perspectiveRoot, absolutePath);
    if (relativeToPerspectiveRoot.startsWith('..') || isAbsolute(relativeToPerspectiveRoot)) {
      throw new Error('Perspective plan path must stay under docs/perspectives');
    }
    if (!absolutePath.endsWith('.md')) {
      throw new Error('Perspective plan path must be a markdown file under docs/perspectives');
    }

    const [canonicalPerspectiveRoot, canonicalPath] = await Promise.all([
      realpath(this.perspectiveRoot),
      realpath(absolutePath),
    ]);
    const canonicalRelative = relative(canonicalPerspectiveRoot, canonicalPath);
    if (canonicalRelative.startsWith('..') || isAbsolute(canonicalRelative)) {
      throw new Error('Perspective plan path must stay under docs/perspectives');
    }

    return {
      absolutePath,
      normalizedRelativePath: relative(this.repoRoot, absolutePath).split(sep).join('/'),
    };
  }
}

function parseFrontmatter(raw: string, relativePath: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    throw new Error(`Perspective plan ${relativePath} must start with YAML frontmatter`);
  }
  return {
    frontmatter: match[1] ?? '',
    body: match[2] ?? '',
  };
}

function validatePlan(parsed: unknown, relativePath: string): PerspectivePlan {
  const result = perspectivePlanSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`);
    throw new Error(`Invalid Perspective plan ${relativePath}: ${issues.join('; ')}`);
  }

  const seenStepIds = new Set<string>();
  for (const step of result.data.steps) {
    if (seenStepIds.has(step.id)) {
      throw new Error(`Invalid Perspective plan ${relativePath}: duplicate step id "${step.id}"`);
    }
    seenStepIds.add(step.id);
  }

  return result.data;
}

function expectedPlanIdFromPath(relativePath: string): string {
  const prefix = 'docs/perspectives/';
  const suffix = '.md';
  if (!relativePath.startsWith(prefix) || !relativePath.endsWith(suffix)) {
    throw new Error(`Perspective plan path must be a markdown file under ${prefix}`);
  }
  return relativePath.slice(prefix.length, relativePath.length - suffix.length);
}
