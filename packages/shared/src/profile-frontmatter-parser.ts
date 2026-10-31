import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export type DescriptionSource = 'human' | 'model' | 'imported';
export type DiagnosticLevel = 'error' | 'warn';

export interface ProfileEntry {
  path: string;
  title_h1: string | null;
  description: string | null;
  description_source: DescriptionSource | null;
  description_author: string | null;
  description_updated_at: string | null;
  description_generated_by?: string;
  description_generated_at?: string;
  description_confirmed_by?: string;
  topics: string[];
  feature_ids: string[];
  doc_kind: string | null;
  raw_frontmatter: Record<string, unknown>;
  skill_compat_profile: boolean;
}

export interface ParseDiagnostic {
  path: string;
  level: DiagnosticLevel;
  code: string;
  message: string;
}

export interface LoadProfileEntriesResult {
  entries: ProfileEntry[];
  diagnostics: ParseDiagnostic[];
}

const MODEL_PROVENANCE_FIELDS = [
  'description_generated_by',
  'description_generated_at',
  'description_confirmed_by',
] as const;

interface FrontmatterParts {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function loadProfileEntries(paths: string[]): LoadProfileEntriesResult {
  const entries: ProfileEntry[] = [];
  const diagnostics: ParseDiagnostic[] = [];

  for (const path of paths) {
    let content = '';
    try {
      content = readFileSync(path, 'utf8');
    } catch (error) {
      diagnostics.push({
        path,
        level: 'error',
        code: 'f243/file-unreadable',
        message: error instanceof Error ? error.message : 'file unreadable',
      });
      continue;
    }

    const parsed = parseFrontmatter(content, path);
    diagnostics.push(...parsed.diagnostics);

    const entry = buildEntry(path, parsed.parts.frontmatter, parsed.parts.body);
    entries.push(entry);
    diagnostics.push(...validateEntry(entry));
  }

  return { entries, diagnostics };
}

function parseFrontmatter(content: string, path: string): { parts: FrontmatterParts; diagnostics: ParseDiagnostic[] } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return {
      parts: { frontmatter: {}, body: content },
      diagnostics: [
        {
          path,
          level: 'error',
          code: 'f243/missing-frontmatter',
          message: 'missing YAML frontmatter',
        },
      ],
    };
  }

  try {
    const parsed = parseYaml(match[1] ?? '') as unknown;
    return {
      parts: {
        frontmatter: isRecord(parsed) ? parsed : {},
        body: content.slice(match[0].length),
      },
      diagnostics: [],
    };
  } catch (error) {
    return {
      parts: { frontmatter: {}, body: content.slice(match[0].length) },
      diagnostics: [
        {
          path,
          level: 'error',
          code: 'f243/invalid-frontmatter',
          message: error instanceof Error ? error.message : 'invalid YAML frontmatter',
        },
      ],
    };
  }
}

function buildEntry(path: string, frontmatter: Record<string, unknown>, body: string): ProfileEntry {
  const source = stringField(frontmatter.description_source);
  return {
    path,
    title_h1: extractTitle(body),
    description: stringField(frontmatter.description),
    description_source: isDescriptionSource(source) ? source : null,
    description_author: stringField(frontmatter.description_author),
    description_updated_at: stringField(frontmatter.description_updated_at),
    description_generated_by: stringField(frontmatter.description_generated_by) ?? undefined,
    description_generated_at: stringField(frontmatter.description_generated_at) ?? undefined,
    description_confirmed_by: stringField(frontmatter.description_confirmed_by) ?? undefined,
    topics: stringArrayField(frontmatter.topics),
    feature_ids: stringArrayField(frontmatter.feature_ids),
    doc_kind: stringField(frontmatter.doc_kind),
    raw_frontmatter: frontmatter,
    skill_compat_profile: isSkillPath(path),
  };
}

function validateEntry(entry: ProfileEntry): ParseDiagnostic[] {
  const diagnostics: ParseDiagnostic[] = [];
  if (entry.skill_compat_profile) {
    validateSkillProfile(entry, diagnostics);
    return diagnostics;
  }

  validateRequiredProfileFields(entry, diagnostics);
  validateDescriptionShape(entry, diagnostics);
  validateSourceProvenance(entry, diagnostics);

  return diagnostics;
}

function validateSkillProfile(entry: ProfileEntry, diagnostics: ParseDiagnostic[]): void {
  if (!stringField(entry.raw_frontmatter.name)) {
    diagnostics.push(error(entry.path, 'f243/missing-skill-name', 'SKILL.md profile requires name'));
  }
  validateDescriptionShape(entry, diagnostics);
  if (hasOwn(entry.raw_frontmatter, 'description_source')) {
    validateDescriptionSourceField(entry, diagnostics);
  }
  validateProvidedDescriptionUpdatedAt(entry, diagnostics);
  if (entry.description_source) {
    validateSourceProvenance(entry, diagnostics);
  }
}

function validateRequiredProfileFields(entry: ProfileEntry, diagnostics: ParseDiagnostic[]): void {
  if (!entry.description) {
    diagnostics.push(error(entry.path, 'f243/missing-description', 'missing description'));
  }
  validateDescriptionSourceField(entry, diagnostics);
  if (!entry.description_author) {
    diagnostics.push(error(entry.path, 'f243/missing-description-author', 'missing description_author'));
  }
  if (!entry.description_updated_at) {
    diagnostics.push(error(entry.path, 'f243/missing-description-updated-at', 'missing description_updated_at'));
  } else {
    validateDescriptionUpdatedAt(entry, diagnostics);
  }
}

function validateDescriptionSourceField(entry: ProfileEntry, diagnostics: ParseDiagnostic[]): void {
  if (entry.description_source) return;

  const rawSource = stringField(entry.raw_frontmatter.description_source);
  diagnostics.push(
    error(
      entry.path,
      rawSource ? 'f243/invalid-description-source' : 'f243/missing-description-source',
      rawSource ? `invalid description_source: ${rawSource}` : 'missing description_source',
    ),
  );
}

function validateSourceProvenance(entry: ProfileEntry, diagnostics: ParseDiagnostic[]): void {
  if (entry.description_source === 'imported') {
    diagnostics.push(
      error(
        entry.path,
        'f243/imported-reserved-until-defined',
        'description_source=imported is reserved for a future import path',
      ),
    );
  }

  if (entry.description_source === 'model') {
    for (const field of MODEL_PROVENANCE_FIELDS) {
      if (!entry[field]) {
        diagnostics.push(error(entry.path, 'f243/model-provenance-missing', `missing ${field} for model description`));
      }
    }
    if (entry.description_generated_at && !isIsoDate(entry.description_generated_at)) {
      diagnostics.push(
        error(entry.path, 'f243/invalid-description-generated-at', 'description_generated_at must be ISO 8601'),
      );
    }
  }
}

function validateProvidedDescriptionUpdatedAt(entry: ProfileEntry, diagnostics: ParseDiagnostic[]): void {
  if (!hasOwn(entry.raw_frontmatter, 'description_updated_at') || !entry.description_updated_at) return;
  validateDescriptionUpdatedAt(entry, diagnostics);
}

function validateDescriptionUpdatedAt(entry: ProfileEntry, diagnostics: ParseDiagnostic[]): void {
  if (entry.description_updated_at && !isIsoDate(entry.description_updated_at)) {
    diagnostics.push(
      error(entry.path, 'f243/invalid-description-updated-at', 'description_updated_at must be ISO 8601'),
    );
  }
}

function validateDescriptionShape(entry: ProfileEntry, diagnostics: ParseDiagnostic[]): void {
  if (!entry.description) {
    if (entry.skill_compat_profile) {
      diagnostics.push(error(entry.path, 'f243/missing-description', 'missing description'));
    }
    return;
  }
  if (Array.from(entry.description).length > 160) {
    diagnostics.push(error(entry.path, 'f243/description-too-long', 'description must be <= 160 Unicode characters'));
  }
  if (/^(todo|tbd|placeholder|xxx|\(?待补\)?|\(?无简介\)?)$/i.test(entry.description.trim())) {
    diagnostics.push(error(entry.path, 'f243/placeholder-description', 'description must not be a placeholder'));
  }
  if (/\r|\n/.test(entry.description)) {
    diagnostics.push(error(entry.path, 'f243/description-multiline', 'description must be a single line'));
  }
}

function error(path: string, code: string, message: string): ParseDiagnostic {
  return { path, level: 'error', code, message };
}

function extractTitle(body: string): string | null {
  const line = body.split(/\r?\n/).find((candidate) => /^#\s+/.test(candidate));
  return line ? line.replace(/^#\s+/, '').trim() : null;
}

function stringField(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function stringArrayField(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((item) => stringField(item)).filter((item): item is string => Boolean(item));
  const single = stringField(value);
  return single ? [single] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isDescriptionSource(value: string | null): value is DescriptionSource {
  return value === 'human' || value === 'model' || value === 'imported';
}

function isSkillPath(path: string): boolean {
  return path.split('\\').join('/').includes('/cat-cafe-skills/') && path.endsWith('/SKILL.md');
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}
