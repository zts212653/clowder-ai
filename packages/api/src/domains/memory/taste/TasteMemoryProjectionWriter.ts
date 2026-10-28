import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { TasteMemoryOwnerAction } from '@cat-cafe/shared';
import { parseDocument } from 'yaml';
import {
  type GitTastePublicationInput,
  type GitTastePublicationOptions,
  isTastePublicationIndeterminateError,
  publishTasteProjection,
} from '../../taste/services/GitTastePublisher.js';
import { type PublishableTasteRepository, resolveCanonicalTasteRoot } from '../../taste/services/TasteRepository.js';
import { projectTasteIndex } from '../../taste/services/taste-index-projection.js';
import { parseTasteVignette, type TasteDecisionPayload, type TasteMemoryVisibility } from './TasteMemoryReader.js';
import { validTasteSourcePath } from './taste-memory-identity.js';

export class TasteMemoryMutationError extends Error {
  constructor(readonly code: 'not_available' | 'stale_revision' | 'source_unavailable') {
    super(code);
    this.name = 'TasteMemoryMutationError';
  }
}

export interface TasteMemoryProjectionResult {
  sourcePath: string;
  revision: string | null;
  status: 'active' | 'retired' | 'forgotten';
}

type PublishProjection = (
  input: GitTastePublicationInput,
  options?: GitTastePublicationOptions,
) => Promise<{ commitSha: string; alreadyPublished: boolean }>;

export class TasteMemoryProjectionWriter {
  constructor(
    private readonly repository: PublishableTasteRepository,
    private readonly options: {
      publishProjection?: PublishProjection;
      publicationOptions?: GitTastePublicationOptions;
    } = {},
  ) {}

  async readCurrent(sourcePath: string): Promise<{
    revision: string;
    status: 'active' | 'retired';
    payload: TasteDecisionPayload;
  } | null> {
    if (!validTasteSourcePath(sourcePath)) return null;
    if (sourcePath.startsWith('docs/') && this.repository.publishedSnapshot) {
      const snapshot = await this.repository.publishedSnapshot();
      if (snapshot) {
        const content = await snapshot.read(sourcePath);
        const parsed = content === null ? null : parseForSource(content, sourcePath, true);
        return parsed && content !== null
          ? { revision: revisionOf(content), status: parsed.status, payload: parsed.payload }
          : null;
      }
    }
    const root = realpathSync(await resolveCanonicalTasteRoot(this.repository));
    const content = readCanonicalFile(resolve(root, sourcePath));
    if (content === null) return null;
    const parsed = parseForSource(content, sourcePath, true);
    return parsed ? { revision: revisionOf(content), status: parsed.status, payload: parsed.payload } : null;
  }

  async apply(input: {
    ownerUserId: string;
    sourcePath: string;
    command: TasteMemoryOwnerAction;
    knownTargetRevision?: string;
    recordTargetRevision: (revision: string | null) => void;
  }): Promise<TasteMemoryProjectionResult> {
    if (!validTasteSourcePath(input.sourcePath)) throw new TasteMemoryMutationError('not_available');
    return input.sourcePath.startsWith('docs/taste/vignettes/') ? this.applyPublic(input) : this.applyPrivate(input);
  }

  private async applyPublic(input: {
    ownerUserId: string;
    sourcePath: string;
    command: TasteMemoryOwnerAction;
    knownTargetRevision?: string;
    recordTargetRevision: (revision: string | null) => void;
  }): Promise<TasteMemoryProjectionResult> {
    let projected: TasteMemoryProjectionResult | null = null;
    const tombstonePath = tasteTombstonePath(input.sourcePath);
    const files =
      input.command.action === 'hard_forget'
        ? [input.sourcePath, 'docs/taste/index.md', tombstonePath]
        : [input.sourcePath, 'docs/taste/index.md'];
    const publicationInput: GitTastePublicationInput = {
      sourceRoot: this.repository.gitCheckoutRoot(),
      branchSuffix: input.command.requestId,
      commitMessage: `taste(F321): ${input.command.action} ${basename(input.sourcePath)}\n\nWhy: apply an owner-approved, revision-bound Taste lifecycle action without rewriting source conversation history.`,
      filesToCommit: files,
      materialize: (checkoutRoot) => {
        const result = projectInRoot(checkoutRoot, input);
        projected = result.projection;
        return result.changed ? 'changed' : 'already-published';
      },
    };
    await (this.options.publishProjection ?? publishTasteProjection)(publicationInput, this.options.publicationOptions);
    if (!projected) throw new Error('Taste publisher returned without materializing a projection');
    return projected;
  }

  private async applyPrivate(input: {
    ownerUserId: string;
    sourcePath: string;
    command: TasteMemoryOwnerAction;
    knownTargetRevision?: string;
    recordTargetRevision: (revision: string | null) => void;
  }): Promise<TasteMemoryProjectionResult> {
    const root = await resolveCanonicalTasteRoot(this.repository);
    const result = projectInRoot(root, input);
    return result.projection;
  }
}

export { isTastePublicationIndeterminateError };

function projectInRoot(
  root: string,
  input: {
    ownerUserId: string;
    sourcePath: string;
    command: TasteMemoryOwnerAction;
    knownTargetRevision?: string;
    recordTargetRevision: (revision: string | null) => void;
  },
): { changed: boolean; projection: TasteMemoryProjectionResult } {
  const canonicalRoot = realpathSync(root);
  const target = resolve(canonicalRoot, input.sourcePath);
  const tombstonePath = resolve(canonicalRoot, tasteTombstonePath(input.sourcePath));
  const exactTombstone = tasteTombstone(input.ownerUserId, input.sourcePath, input.command);
  if (input.command.action === 'hard_forget') {
    input.recordTargetRevision(null);
    return projectHardForget(canonicalRoot, target, tombstonePath, exactTombstone, input);
  }
  const current = readCanonicalFile(target);
  if (current === null) throw new TasteMemoryMutationError('not_available');
  const currentRevision = revisionOf(current);
  if (input.knownTargetRevision && currentRevision === input.knownTargetRevision) {
    const parsed = parseForSource(current, input.sourcePath, true);
    if (!parsed) throw new TasteMemoryMutationError('source_unavailable');
    input.recordTargetRevision(currentRevision);
    const indexChanged = projectIndexFile(
      canonicalRoot,
      input.sourcePath,
      parsed.status === 'active' ? parsed.payload : null,
    );
    return {
      changed: indexChanged,
      projection: { sourcePath: input.sourcePath, revision: currentRevision, status: parsed.status },
    };
  }
  if (currentRevision !== input.command.expectedRevision) throw new TasteMemoryMutationError('stale_revision');
  const parsed = parseForSource(current, input.sourcePath, true);
  if (!parsed || parsed.status !== 'active') throw new TasteMemoryMutationError('not_available');
  const next = mutateTasteContent(current, input.command);
  const nextParsed = parseForSource(next, input.sourcePath, true);
  if (!nextParsed) throw new TasteMemoryMutationError('source_unavailable');
  const nextRevision = revisionOf(next);
  input.recordTargetRevision(nextRevision);
  const fileChanged = next !== current;
  if (fileChanged) atomicWrite(target, next);
  const indexChanged = projectIndexFile(
    canonicalRoot,
    input.sourcePath,
    nextParsed.status === 'active' ? nextParsed.payload : null,
  );
  return {
    changed: fileChanged || indexChanged,
    projection: { sourcePath: input.sourcePath, revision: nextRevision, status: nextParsed.status },
  };
}

function projectHardForget(
  root: string,
  target: string,
  tombstonePath: string,
  exactTombstone: string,
  input: { ownerUserId: string; sourcePath: string; command: TasteMemoryOwnerAction },
): { changed: boolean; projection: TasteMemoryProjectionResult } {
  const current = readCanonicalFile(target);
  const existingTombstone = readCanonicalFile(tombstonePath);
  if (current === null) {
    // Accept only the two emitted serializations, retaining every owner/request/
    // revision field and leaving existing compact tombstones byte-for-byte intact.
    if (
      existingTombstone !== exactTombstone &&
      existingTombstone !== tasteTombstone(input.ownerUserId, input.sourcePath, input.command, 0)
    )
      throw new TasteMemoryMutationError('not_available');
    const indexChanged = projectIndexFile(root, input.sourcePath, null);
    return {
      changed: indexChanged,
      projection: { sourcePath: input.sourcePath, revision: null, status: 'forgotten' },
    };
  }
  if (revisionOf(current) !== input.command.expectedRevision) throw new TasteMemoryMutationError('stale_revision');
  const parsed = parseForSource(current, input.sourcePath, true);
  if (!parsed) throw new TasteMemoryMutationError('source_unavailable');
  atomicWrite(tombstonePath, exactTombstone);
  rmSync(target);
  projectIndexFile(root, input.sourcePath, null);
  return { changed: true, projection: { sourcePath: input.sourcePath, revision: null, status: 'forgotten' } };
}

function mutateTasteContent(
  content: string,
  command: Exclude<TasteMemoryOwnerAction, { action: 'hard_forget' }>,
): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/.exec(content);
  if (!match) throw new TasteMemoryMutationError('source_unavailable');
  const document = parseDocument(match[1]);
  if (document.errors.length > 0) throw new TasteMemoryMutationError('source_unavailable');
  applyTasteCommand(document, command);
  return `---\n${document.toString().trimEnd()}\n---${match[2]}`;
}

function applyTasteCommand(
  document: ReturnType<typeof parseDocument>,
  command: Exclude<TasteMemoryOwnerAction, { action: 'hard_forget' }>,
): void {
  if (command.action === 'confirm_takeaway') {
    document.set('takeaway', command.takeaway);
    return;
  }
  if (command.action === 'retire') {
    document.set('status', 'retired');
    return;
  }
  applyTasteCorrectionPatch(document, command.patch);
}

function applyTasteCorrectionPatch(
  document: ReturnType<typeof parseDocument>,
  patch: Extract<TasteMemoryOwnerAction, { action: 'correct' }>['patch'],
): void {
  if (patch.takeaway === null) document.delete('takeaway');
  else if (patch.takeaway !== undefined) document.set('takeaway', patch.takeaway);
  if (patch.quotes !== undefined) document.set('quotes', patch.quotes);
  if (patch.scene !== undefined) document.set('scene', patch.scene);
  if (patch.tags !== undefined) document.set('tags', patch.tags);
  if (patch.dimension !== undefined) document.set('dimension', patch.dimension);
}

function projectIndexFile(root: string, sourcePath: string, payload: TasteDecisionPayload | null): boolean {
  if (!sourcePath.startsWith('docs/taste/vignettes/')) return false;
  const indexPath = join(root, 'docs/taste/index.md');
  const current = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
  const next = projectTasteIndex(current, sourcePath, payload);
  if (current === next) return false;
  atomicWrite(indexPath, next);
  return true;
}

function parseForSource(content: string, sourcePath: string, includeRetired: boolean) {
  const visibility: TasteMemoryVisibility = sourcePath.startsWith('private/') ? 'private' : 'public';
  return parseTasteVignette(content, visibility, includeRetired);
}

function readCanonicalFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new TasteMemoryMutationError('source_unavailable');
  }
  return readFileSync(path, 'utf8');
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function revisionOf(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function tasteTombstonePath(sourcePath: string): string {
  const digest = createHash('sha256').update(sourcePath).digest('hex');
  return sourcePath.startsWith('private/')
    ? `private/taste/.tombstones/${digest}.json`
    : `docs/taste/tombstones/${digest}.json`;
}

function tasteTombstone(
  ownerUserId: string,
  sourcePath: string,
  command: TasteMemoryOwnerAction,
  indent: 0 | 2 = 2,
): string {
  return `${JSON.stringify(
    {
      v: 1,
      kind: 'taste-memory-forget-tombstone',
      ownerDigest: createHash('sha256').update(ownerUserId).digest('hex'),
      sourcePath,
      requestId: command.requestId,
      expectedRevision: command.expectedRevision,
    },
    null,
    indent,
  )}\n`;
}
