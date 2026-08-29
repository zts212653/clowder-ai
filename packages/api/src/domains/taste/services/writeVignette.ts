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
import type { TasteProposal } from '@cat-cafe/shared';
import {
  type GitTastePublicationOptions,
  isTastePublicationIndeterminateError,
  publishTasteProjection,
  TastePublicationIndeterminateError,
} from './GitTastePublisher.js';
import { FileTasteRepository, type PublishableTasteRepository } from './TasteRepository.js';

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
