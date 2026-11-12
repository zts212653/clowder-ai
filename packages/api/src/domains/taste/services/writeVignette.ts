/**
 * F221 Phase B: Vignette writer.
 *
 * On approve: write the taste vignette file + append to index + publish.
 * Public vignettes → docs/taste/vignettes/{slug}.md
 * Sensitive vignettes → private/taste/{slug}.md (gitignored, no git add/commit)
 *
 * Public path: a disposable named branch starts from fresh origin/main. Both
 * vignette + index are committed and pushed together; no primary-main worktree
 * is mutated. The caller only checkpoints/finalizes after the push terminal.
 *
 * Sensitive path: file write only, no git (private/ is gitignored). Failure
 * cleans up the newly created file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TasteProposal } from '@cat-cafe/shared';
import { parse as parseYaml } from 'yaml';
import { parseTasteVignette } from '../../memory/taste/TasteMemoryReader.js';
import {
  type GitTastePublicationOptions,
  isTastePublicationIndeterminateError,
  publishTasteProjection,
  TastePublicationIndeterminateError,
} from './GitTastePublisher.js';
import { FileTasteRepository, type PublishableTasteRepository } from './TasteRepository.js';
import { projectTasteIndex } from './taste-index-projection.js';

export interface WriteVignetteResult {
  slug: string;
  path: string;
}

/** Derive a filesystem-safe slug from dimension + first tag. */
export function deriveSlug(proposal: TasteProposal): string {
  const tag = proposal.tags[0] ?? 'untitled';
  const safeDimension = proposal.dimension.replace(/[^a-z0-9-]/g, '-');
  const safeTag = tag
    .replace(/\s+/g, '-')
    .replace(/[^\w一-鿿-]/g, '')
    .slice(0, 40);
  const suffix = proposal.id.slice(-6);
  return `${safeDimension}-${safeTag}-${suffix}`;
}

/** Resolve the output directory based on privacy. */
function resolveOutputDir(projectRoot: string, privacy: 'public' | 'sensitive'): string {
  return privacy === 'public' ? join(projectRoot, 'docs/taste/vignettes') : join(projectRoot, 'private/taste');
}

/**
 * Format the vignette markdown content.
 *
 * Standard taste vignette format (spec B4): frontmatter with
 * when / quotes / scene / tags, matching the Phase A seed vignettes.
 * Extra metadata (dimension, privacy, catId, proposalId) included
 * for traceability without breaking the standard contract.
 */
/** Escape a string for use inside a YAML double-quoted scalar. */
function escapeYamlDoubleQuoted(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

/**
 * Approval recovery compares a retried vignette byte for byte with the already published one, so the
 * released form is kept for every proposal it wrote publishable: accepted by the reader and, when
 * public, without a line-end blank. Any other proposal gets the quoted form, used only when it is
 * publishable too and reads back exactly; otherwise approval refuses rather than write a vignette the
 * reader rejects or the commit guard blocks.
 */
export function formatVignette(proposal: TasteProposal): string {
  const released = formatVignetteLines(
    proposal,
    (text) => `"${escapeYamlDoubleQuoted(text)}"`,
    (scene) => {
      const sceneLines = scene.split('\n');
      return sceneLines.length === 1 ? `>\n  ${sceneLines[0]}` : `>\n${sceneLines.map((l) => `  ${l}`).join('\n')}`;
    },
  );
  // Only public vignettes are committed, so only they must pass the commit guard's line-end check.
  const sensitive = proposal.privacy === 'sensitive';
  const publishable = (content: string) =>
    !(!sensitive && hasLineEndBlank(content)) &&
    parseTasteVignette(content, sensitive ? 'private' : 'public', false) !== null;
  // A newly bound owner decision covers the displayed field strings, including their line breaks.
  // Unbound historical writer calls retain their released byte format for exact recovery.
  if (publishable(released) && (!proposal.decisionDigest || readsBackExactly(released, proposal))) return released;
  const quoted = formatVignetteLines(proposal, yamlQuoted, yamlQuoted);
  if (publishable(quoted) && readsBackExactly(quoted, proposal)) return quoted;
  throw new Error(`Taste vignette for proposal ${proposal.id} cannot be written readable`);
}

function formatVignetteLines(
  proposal: TasteProposal,
  quote: (text: string) => string,
  scene: (text: string) => string,
): string {
  return [
    '---',
    `when: ${new Date(proposal.createdAt).toISOString().slice(0, 10)}`,
    'quotes:',
    `  - ${quote(proposal.quote)}`,
    ...(proposal.takeaway ? [`takeaway: ${quote(proposal.takeaway)}`] : []),
    `scene: ${scene(proposal.scene)}`,
    `tags: [${proposal.tags.map(quote).join(', ')}]`,
    `dimension: ${proposal.dimension}`,
    `privacy: ${proposal.privacy}`,
    `catId: ${proposal.catId}`,
    `proposalId: ${proposal.id}`,
    '---',
    '',
  ].join('\n');
}

/**
 * A one-line YAML double-quoted scalar. Everything other than printable YAML content is escaped:
 * line breaks, controls, DEL, C1, NEL, U+2028/U+2029, BOM and lone surrogates.
 */
function yamlQuoted(text: string): string {
  let body = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || character === '\\') body += `\\${character}`;
    else if (isPlainYamlContent(code)) body += character;
    else if (code <= 0xffff) body += `\\u${code.toString(16).padStart(4, '0')}`;
    else body += `\\U${code.toString(16).padStart(8, '0')}`;
  }
  return `"${body}"`;
}

function isPlainYamlContent(code: number): boolean {
  if (code >= 0x20 && code <= 0x7e) return true;
  if (code === 0x2028 || code === 0x2029) return false;
  return (code >= 0xa0 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd && code !== 0xfeff) || code >= 0x10000;
}

function hasLineEndBlank(content: string): boolean {
  return content.split('\n').some((line) => /[ \t\r\v\f]$/.test(line));
}

/** The frontmatter, read as the Taste reader reads it, holds exactly the proposal's text. */
function readsBackExactly(content: string, proposal: TasteProposal): boolean {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (frontmatter === undefined) return false;
  try {
    const parsed = parseYaml(frontmatter, { maxAliasCount: 0 });
    return isDeepStrictEqual(
      { quotes: parsed?.quotes, takeaway: parsed?.takeaway, scene: parsed?.scene, tags: parsed?.tags },
      {
        quotes: [proposal.quote],
        takeaway: proposal.takeaway || undefined,
        scene: proposal.scene,
        tags: proposal.tags,
      },
    );
  } catch {
    return false;
  }
}

/**
 * Insert a vignette entry under the matching dimension section in the index.
 * Returns the original content for rollback. If no matching section is found,
 * appends before the "如何新增" section as fallback.
 */
export function insertIntoIndex(indexPath: string, slug: string, proposal: TasteProposal): string | null {
  const originalContent = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;

  // Idempotency: skip if this slug already exists in the index (retry after
  // finalize failure where the vignette + index were already committed).
  if (originalContent?.includes(`vignettes/${slug}.md`)) {
    return originalContent;
  }
  writeFileSync(
    indexPath,
    projectTasteIndex(originalContent, `docs/taste/vignettes/${slug}.md`, {
      when: new Date(proposal.createdAt).toISOString().slice(0, 10),
      quotes: [proposal.quote],
      ...(proposal.takeaway ? { takeaway: proposal.takeaway } : {}),
      scene: proposal.scene,
      tags: proposal.tags,
      dimension: proposal.dimension,
      catId: proposal.catId,
      proposalId: proposal.id,
    }),
    'utf8',
  );
  return originalContent;
}

function readExistingFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function materializePublicProjection(
  checkoutRoot: string,
  proposal: TasteProposal,
  slug: string,
  relPath: string,
  content: string,
): 'changed' | 'already-published' {
  const vignettePath = join(checkoutRoot, relPath);
  const indexPath = join(checkoutRoot, 'docs/taste/index.md');
  const existingVignette = readExistingFile(vignettePath);
  const existingIndex = readExistingFile(indexPath);
  let indexed = false;
  if (existingIndex !== null) indexed = existingIndex.includes(`vignettes/${slug}.md`);

  if (existingVignette === content && indexed) return 'already-published';
  // Upgrading an already approving claim binds today's owner confirmation but must still recognize
  // bytes the old writer pushed before losing its checkpoint. This is readback only: absent files
  // below always receive the newly confirmed exact format, and new claims cannot use this allowance.
  if (
    proposal.legacyPublicationRecovery &&
    existingVignette !== null &&
    indexed &&
    existingVignette === formatVignette({ ...proposal, decisionDigest: undefined })
  )
    return 'already-published';
  const conflictMessage = `Taste publication conflict for proposal ${proposal.id}; refusing partial or mismatched projection`;
  if (existingVignette !== null) throw new Error(conflictMessage);
  if (indexed) throw new Error(conflictMessage);

  mkdirSync(dirname(indexPath), { recursive: true });
  mkdirSync(dirname(vignettePath), { recursive: true });
  writeFileSync(vignettePath, content, 'utf8');
  insertIntoIndex(indexPath, slug, proposal);
  return 'changed';
}

async function writePublicVignette(
  repository: PublishableTasteRepository,
  proposal: TasteProposal,
  slug: string,
  relPath: string,
  content: string,
  options: GitTastePublicationOptions,
): Promise<void> {
  const filesToCommit = [relPath, 'docs/taste/index.md'];
  const commitMessage = `taste(F221): add vignette ${slug} [${proposal.dimension}]`;
  try {
    await publishTasteProjection(
      {
        sourceRoot: repository.gitCheckoutRoot(),
        branchSuffix: proposal.id,
        commitMessage,
        filesToCommit,
        materialize: (checkoutRoot) => materializePublicProjection(checkoutRoot, proposal, slug, relPath, content),
      },
      options,
    );
  } catch (error) {
    if (isTastePublicationIndeterminateError(error)) {
      throw new TastePublicationIndeterminateError(`Vignette write failed: ${error.message}`);
    }
    throw new Error(`Vignette write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Write a vignette file + update index + git commit.
 *
 * Returns { slug, path } on success. Throws on failure (caller must rollback CAS).
 * The `path` is relative to projectRoot for storage in the proposal record.
 */
export function createVignetteWriter(
  repositoryOrProjectRoot: PublishableTasteRepository | string,
  options: GitTastePublicationOptions = {},
): (proposal: TasteProposal) => Promise<WriteVignetteResult> {
  const repository =
    typeof repositoryOrProjectRoot === 'string'
      ? new FileTasteRepository(repositoryOrProjectRoot)
      : repositoryOrProjectRoot;
  return async (proposal: TasteProposal): Promise<WriteVignetteResult> => {
    // A blank scene publishes a vignette that the reader rejects as empty.
    if (!proposal.scene.trim()) throw new Error('Taste scene is blank');
    const slug = deriveSlug(proposal);
    const content = formatVignette(proposal);

    // Sensitive vignettes: private/ is gitignored — file write only, no git
    if (proposal.privacy === 'sensitive') {
      const persistentRoot = repository.canonicalRoot();
      const outDir = resolveOutputDir(persistentRoot, proposal.privacy);
      const vignettePath = join(outDir, `${slug}.md`);
      const relPath = relative(persistentRoot, vignettePath);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(vignettePath, content, 'utf8');
      return { slug, path: relPath };
    }

    const relPath = `docs/taste/vignettes/${slug}.md`;
    await writePublicVignette(repository, proposal, slug, relPath, content, options);

    return { slug, path: relPath };
  };
}
