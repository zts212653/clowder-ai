/**
 * F221 Phase B: Vignette writer.
 *
 * On approve: write the taste vignette file + append to index + git commit.
 * Public vignettes → docs/taste/vignettes/{slug}.md
 * Sensitive vignettes → private/taste/{slug}.md (gitignored, no git add/commit)
 *
 * Public path: git commit is the atomicity boundary — both vignette + index are
 * committed together. On failure, the newly created vignette is deleted and the
 * index is restored to its pre-append state (not deleted!). The caller rollbacks
 * the CAS claim.
 *
 * Sensitive path: file write only, no git (private/ is gitignored). Failure
 * cleans up the newly created file.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { TasteProposal } from '@cat-cafe/shared';
import { FileTasteRepository, type TasteRepository } from './TasteRepository.js';

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

export function formatVignette(proposal: TasteProposal): string {
  const when = new Date(proposal.createdAt).toISOString().slice(0, 10);
  const quotesYaml = `  - "${escapeYamlDoubleQuoted(proposal.quote)}"`;
  // Indent scene continuation lines for YAML block scalar
  const sceneLines = proposal.scene.split('\n');
  const sceneYaml =
    sceneLines.length === 1 ? `>\n  ${sceneLines[0]}` : `>\n${sceneLines.map((l) => `  ${l}`).join('\n')}`;
  const tagsYaml = `[${proposal.tags.map((t) => `"${escapeYamlDoubleQuoted(t)}"`).join(', ')}]`;
  const lines = [
    '---',
    `when: ${when}`,
    'quotes:',
    quotesYaml,
    `scene: ${sceneYaml}`,
    `tags: ${tagsYaml}`,
    `dimension: ${proposal.dimension}`,
    `privacy: ${proposal.privacy}`,
    `catId: ${proposal.catId}`,
    `proposalId: ${proposal.id}`,
    '---',
    '',
  ];
  return lines.join('\n');
}

/**
 * Map taste dimension IDs to index section headers.
 * These must match the `### Section` headers in docs/taste/index.md.
 */
const DIMENSION_TO_SECTION: Record<string, string> = {
  'relationship-stance': '### 关系姿态',
  'cognitive-honesty': '### 认知诚实',
  'architecture-aesthetics': '### 架构审美',
  'visual-quality': '### 视觉品质',
  'authentic-expression': '### 表达真实',
  'system-philosophy': '### 系统哲学',
  'creative-craft': '### 创作手法',
};

function insertEntryIntoSection(originalContent: string, sectionHeader: string, entry: string): string | null {
  const lines = originalContent.split('\n');
  const sectionIdx = lines.findIndex((line) => line.trim() === sectionHeader);
  if (sectionIdx === -1) return null;

  let insertIdx = sectionIdx + 1;
  while (insertIdx < lines.length && lines[insertIdx].trim() === '') insertIdx++;
  while (insertIdx < lines.length && (lines[insertIdx].startsWith('- ') || lines[insertIdx].startsWith('  ')))
    insertIdx++;

  lines.splice(insertIdx, 0, '', ...entry.trimEnd().split('\n'));
  return lines.join('\n');
}

/**
 * Insert a vignette entry under the matching dimension section in the index.
 * Returns the original content for rollback. If no matching section is found,
 * appends before the "如何新增" section as fallback.
 */
export function insertIntoIndex(indexPath: string, slug: string, proposal: TasteProposal): string | null {
  const entry = `- [**${proposal.tags[0] ?? slug}**](vignettes/${slug}.md)\n  - 搜索词：${proposal.tags.join('、')}\n  - 场景：${proposal.scene.slice(0, 80)}\n`;

  if (!existsSync(indexPath)) {
    // No index to insert into — create a minimal one
    const header = `# Taste Index\n\nApproved taste vignettes, organized by dimension.\n\n`;
    writeFileSync(indexPath, header + entry, 'utf8');
    return null; // null = newly created, delete on rollback
  }

  const originalContent = readFileSync(indexPath, 'utf8');

  // Idempotency: skip if this slug already exists in the index (retry after
  // finalize failure where the vignette + index were already committed).
  if (originalContent.includes(`vignettes/${slug}.md`)) {
    return originalContent;
  }

  const sectionHeader = DIMENSION_TO_SECTION[proposal.dimension];

  if (sectionHeader) {
    const updatedContent = insertEntryIntoSection(originalContent, sectionHeader, entry);
    if (updatedContent !== null) {
      writeFileSync(indexPath, updatedContent, 'utf8');
      return originalContent;
    }
  }

  // Fallback: insert before "## 如何新增 vignette" or append to end
  const howToIdx = originalContent.indexOf('## 如何新增');
  if (howToIdx !== -1) {
    const updated = `${originalContent.slice(0, howToIdx) + entry}\n${originalContent.slice(howToIdx)}`;
    writeFileSync(indexPath, updated, 'utf8');
  } else {
    writeFileSync(indexPath, `${originalContent}\n${entry}`, 'utf8');
  }
  return originalContent;
}

function runGit(projectRoot: string, args: string[]): string {
  return execFileSync('git', args, { cwd: projectRoot, stdio: 'pipe' }).toString().trim();
}

function readExistingFile(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function restoreFile(path: string, previousContent: string | null): void {
  try {
    if (previousContent === null) unlinkSync(path);
    else writeFileSync(path, previousContent, 'utf8');
  } catch {
    // best-effort rollback
  }
}

function assertCanonicalBranch(persistentRoot: string): void {
  const currentBranch = runGit(persistentRoot, ['branch', '--show-current']);
  if (currentBranch !== 'main') {
    throw new Error(
      `Vignette writer refuses to commit on branch "${currentBranch}" — only "main" is allowed. ` +
        `projectRoot="${persistentRoot}" resolved to a non-canonical checkout.`,
    );
  }
}

function isDurablyCommitted(
  persistentRoot: string,
  filesToCommit: string[],
  savedVignetteContent: string | null,
  savedIndexContent: string | null,
  content: string,
  slug: string,
): boolean {
  if (savedVignetteContent !== content || !savedIndexContent?.includes(`vignettes/${slug}.md`)) return false;
  return runGit(persistentRoot, ['status', '--porcelain', '--', ...filesToCommit]) === '';
}

function assertOutputPathsClean(persistentRoot: string, filesToCommit: string[]): void {
  const status = runGit(persistentRoot, ['status', '--porcelain', '--', ...filesToCommit]);
  if (status) {
    throw new Error(`Vignette writer refuses to write over dirty output path(s):\n${status}`);
  }
}

function rollbackPublicWrite(
  persistentRoot: string,
  filesToCommit: string[],
  vignettePath: string,
  savedVignetteContent: string | null,
  indexPath: string,
  savedIndexContent: string | null,
): void {
  try {
    runGit(persistentRoot, ['reset', 'HEAD', '--', ...filesToCommit]);
  } catch {
    // best-effort: git reset may fail if HEAD does not exist
  }
  restoreFile(vignettePath, savedVignetteContent);
  restoreFile(indexPath, savedIndexContent);
}

function writePublicVignette(
  persistentRoot: string,
  proposal: TasteProposal,
  slug: string,
  vignettePath: string,
  relPath: string,
  content: string,
): void {
  assertCanonicalBranch(persistentRoot);
  const indexPath = join(persistentRoot, 'docs/taste/index.md');
  const savedVignetteContent = readExistingFile(vignettePath);
  const savedIndexContent = readExistingFile(indexPath);
  const filesToCommit = [relPath, relative(persistentRoot, indexPath)];

  // A prior attempt may have committed both files and then failed while
  // finalizing the proposal store. A clean, exact match is durable success.
  if (isDurablyCommitted(persistentRoot, filesToCommit, savedVignetteContent, savedIndexContent, content, slug)) {
    return;
  }

  // These paths are the writer's atomic output set. Refuse before any
  // filesystem mutation rather than absorbing or resetting another actor's
  // staged/unstaged edits in either path.
  assertOutputPathsClean(persistentRoot, filesToCommit);

  try {
    mkdirSync(dirname(indexPath), { recursive: true });
    mkdirSync(dirname(vignettePath), { recursive: true });
    writeFileSync(vignettePath, content, 'utf8');
    insertIntoIndex(indexPath, slug, proposal);
    runGit(persistentRoot, ['add', '--', ...filesToCommit]);
    const commitMsg = `taste(F221): add vignette ${slug} [${proposal.dimension}]`;
    runGit(persistentRoot, ['commit', '--only', '-m', commitMsg, '--', ...filesToCommit]);
  } catch (err) {
    rollbackPublicWrite(
      persistentRoot,
      filesToCommit,
      vignettePath,
      savedVignetteContent,
      indexPath,
      savedIndexContent,
    );
    throw new Error(`Vignette write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write a vignette file + update index + git commit.
 *
 * Returns { slug, path } on success. Throws on failure (caller must rollback CAS).
 * The `path` is relative to projectRoot for storage in the proposal record.
 */
export function createVignetteWriter(
  repositoryOrProjectRoot: TasteRepository | string,
): (proposal: TasteProposal) => Promise<WriteVignetteResult> {
  const repository =
    typeof repositoryOrProjectRoot === 'string'
      ? new FileTasteRepository(repositoryOrProjectRoot)
      : repositoryOrProjectRoot;
  return async (proposal: TasteProposal): Promise<WriteVignetteResult> => {
    const persistentRoot = repository.canonicalRoot();
    const slug = deriveSlug(proposal);
    const outDir = resolveOutputDir(persistentRoot, proposal.privacy);
    const vignettePath = join(outDir, `${slug}.md`);
    const relPath = relative(persistentRoot, vignettePath);

    // Write vignette file
    const content = formatVignette(proposal);

    // Sensitive vignettes: private/ is gitignored — file write only, no git
    if (proposal.privacy === 'sensitive') {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(vignettePath, content, 'utf8');
      return { slug, path: relPath };
    }

    // Public writes keep the main-only branch guard on the resolved persistent
    // target. The disposable runtime checkout is never a persistence surface.
    writePublicVignette(persistentRoot, proposal, slug, vignettePath, relPath, content);

    return { slug, path: relPath };
  };
}
