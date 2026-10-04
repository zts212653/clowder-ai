import { constants } from 'node:fs';
import { type FileHandle, open, realpath } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { probeImmutableMedia } from '../video-studio/content-owner/published-media-probe.js';
import { isRenderedMarkdownPath, resolveWorkspaceRenderedQuote } from './workspace-content-rendered-quote.js';
import {
  MAX_WORKSPACE_COLLABORATION_BYTES,
  type OpenWorkspaceMediaV1,
  type WorkspaceContentDescriptionV1,
  type WorkspaceContentLocatorV1,
  type WorkspaceContentPrincipalV1,
  WorkspaceContentSourceError,
  type WorkspaceMediaDescriptionV1,
  type WorkspaceTextQuoteBatchRequestV1,
  type WorkspaceTextQuoteBatchResultV1,
  type WorkspaceTextQuoteResolutionV1,
} from './workspace-content-source-contract.js';
import {
  canonicalizeWorkspaceContentLocator,
  classifyWorkspaceContentMime,
  decodeWorkspaceText,
  digestWorkspaceFile,
  hasSameWorkspaceFileState,
  openedWorkspaceContentMatchesCanonicalLocator,
  supportedWorkspaceMediaMime,
  validateWorkspaceContentLocator,
  validateWorkspaceQuote,
  workspaceContentRef,
  workspaceTextDigest,
} from './workspace-content-source-utils.js';
import { resolveWorkspaceTextQuote, resolveWorkspaceTextQuoteBatch } from './workspace-content-text-resolver.js';
import { guessMime } from './workspace-file-read.js';
import { WorkspaceSecurityError } from './workspace-security.js';

export {
  MAX_WORKSPACE_COLLABORATION_BYTES,
  type OpenWorkspaceMediaV1,
  type WorkspaceContentDescriptionV1,
  type WorkspaceContentLocatorV1,
  type WorkspaceContentPrincipalV1,
  WorkspaceContentSourceError,
  type WorkspaceMediaDescriptionV1,
  type WorkspaceTextAnchorV1,
  type WorkspaceTextQuoteBatchRequestV1,
  type WorkspaceTextQuoteBatchResolutionV1,
  type WorkspaceTextQuoteBatchResultV1,
  type WorkspaceTextQuoteResolutionV1,
} from './workspace-content-source-contract.js';

interface StableFileRead {
  readonly root: string;
  readonly locator: WorkspaceContentLocatorV1;
  readonly mime: string;
  readonly byteLength: number;
  readonly digest: `sha256:${string}`;
  readonly bytes?: Buffer;
}

export interface WorkspaceContentRootResolution {
  /** Durable owner identity, not a UI worktree label or caller-provided alias. */
  readonly canonicalWorktreeId: string;
  readonly root: string;
}

/**
 * F063's narrow source-owner port for revision-bound F309 collaboration.
 * It mints source identity and reads only through registered workspace roots;
 * callers never supply an owner id, absolute path, or precomputed revision.
 */
export class WorkspaceContentSourceService {
  constructor(
    private readonly options: {
      readonly ownerUserId: string;
      readonly resolveWorktreeRoot: (worktreeId: string) => Promise<WorkspaceContentRootResolution>;
      readonly maxBytes?: number;
    },
  ) {}

  async describe(input: {
    readonly principal: WorkspaceContentPrincipalV1;
    readonly locator: WorkspaceContentLocatorV1;
  }): Promise<WorkspaceContentDescriptionV1> {
    return this.describeRead(await this.readStable(input, false));
  }

  /** Internal F063 mutation authority; the consumer must separately prove the human acceptance. */
  async authorizeWriteTarget(input: {
    readonly principal: WorkspaceContentPrincipalV1;
    readonly locator: WorkspaceContentLocatorV1;
  }) {
    this.assertPrincipal(input.principal);
    const resolved = await this.resolveLocator(input.locator);
    const handle = await open(resolved.path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (
        !(await handle.stat()).isFile() ||
        !(await openedWorkspaceContentMatchesCanonicalLocator(resolved.root, resolved.path, resolved.locator, handle))
      )
        throw new WorkspaceContentSourceError('access_denied');
    } finally {
      await handle.close();
    }
    return resolved;
  }

  async readText(input: {
    readonly principal: WorkspaceContentPrincipalV1;
    readonly locator: WorkspaceContentLocatorV1;
    readonly expectedRevision: string;
  }): Promise<WorkspaceContentDescriptionV1 & { readonly text: string }> {
    const read = await this.readStable(input, true);
    const description = this.describeRead(read);
    if (description.revision !== input.expectedRevision) throw new WorkspaceContentSourceError('revision_changed');
    if (description.kind !== 'text') throw new WorkspaceContentSourceError('unsupported_text');
    return { ...description, text: decodeWorkspaceText(read.bytes) };
  }

  async describeMedia(input: {
    readonly principal: WorkspaceContentPrincipalV1;
    readonly locator: WorkspaceContentLocatorV1;
  }): Promise<WorkspaceMediaDescriptionV1> {
    const read = await this.readStable(input, true);
    const description = this.describeRead(read);
    const mime = supportedWorkspaceMediaMime(description);
    const media = await probeImmutableMedia(read.bytes, mime).catch(() => {
      throw new WorkspaceContentSourceError('unsupported_media');
    });
    return { ...description, kind: 'media', mime, media };
  }

  /** F063 closes the mutable descriptor before returning an immutable no-store stream. */
  async openMedia(input: {
    readonly principal: WorkspaceContentPrincipalV1;
    readonly locator: WorkspaceContentLocatorV1;
    readonly expectedRevision: string;
  }): Promise<OpenWorkspaceMediaV1> {
    this.assertPrincipal(input.principal);
    const resolved = await this.resolveLocator(input.locator);
    let handle: FileHandle;
    try {
      handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceContentSourceError('not_found');
      throw new WorkspaceContentSourceError('access_denied');
    }
    try {
      const before = await handle.stat();
      const stillCanonical = await openedWorkspaceContentMatchesCanonicalLocator(
        resolved.root,
        resolved.path,
        resolved.locator,
        handle,
      ).catch(() => false);
      if (!stillCanonical) {
        throw new WorkspaceContentSourceError('revision_changed');
      }
      const maximum = this.options.maxBytes ?? MAX_WORKSPACE_COLLABORATION_BYTES;
      if (!before.isFile()) throw new WorkspaceContentSourceError('access_denied');
      if (before.size < 0 || before.size > maximum) throw new WorkspaceContentSourceError('too_large');
      const checked = await digestWorkspaceFile(handle, before.size, true);
      const after = await handle.stat();
      if (!hasSameWorkspaceFileState(before, after) || checked.byteLength !== before.size)
        throw new WorkspaceContentSourceError('revision_changed');
      const description = this.describeRead({
        root: resolved.root,
        locator: resolved.locator,
        mime: guessMime(resolved.locator.path),
        byteLength: checked.byteLength,
        digest: checked.digest,
      });
      if (description.revision !== input.expectedRevision) throw new WorkspaceContentSourceError('revision_changed');
      const mime = supportedWorkspaceMediaMime(description);
      const snapshot = requireWorkspaceContentBytes(checked.bytes);
      const media = await probeImmutableMedia(snapshot, mime).catch(() => {
        throw new WorkspaceContentSourceError('unsupported_media');
      });
      return { ...description, kind: 'media', mime, media, stream: Readable.from([snapshot]) };
    } finally {
      await handle.close();
    }
  }

  /**
   * Resolve every persisted text anchor from one authorized, stable F063 read.
   * Its descriptor is the only current-source revision a caller may project for that view.
   */
  async resolveTextQuotes(input: {
    readonly principal: WorkspaceContentPrincipalV1;
    readonly locator: WorkspaceContentLocatorV1;
    readonly anchors: readonly WorkspaceTextQuoteBatchRequestV1[];
  }): Promise<WorkspaceTextQuoteBatchResultV1> {
    if (input.anchors.length > 500) throw new WorkspaceContentSourceError('access_denied');
    const read = input.anchors.length > 0 ? await this.readStable(input, true) : await this.readStable(input, false);
    const source = this.describeRead(read);
    if (source.kind !== 'text') throw new WorkspaceContentSourceError('unsupported_text');
    const text = input.anchors.length > 0 ? decodeWorkspaceText(requireWorkspaceContentBytes(read.bytes)) : '';
    return {
      source,
      resolutions: resolveWorkspaceTextQuoteBatch({ text, sourceRevision: source.revision, anchors: input.anchors }),
    };
  }

  /** Rendered DOM offsets never cross this boundary; repeated raw text fails closed. */
  async resolveTextQuote(input: {
    readonly principal: WorkspaceContentPrincipalV1;
    readonly locator: WorkspaceContentLocatorV1;
    readonly expectedRevision: string;
    readonly quote: string;
    readonly expectedQuoteDigest?: string;
    readonly expectedContextDigest?: string;
    /** Current-source remap may evaluate a stale anchor but never writes it. */
    readonly allowRevisionDrift?: boolean;
  }): Promise<WorkspaceTextQuoteResolutionV1 & { readonly sourceRevision: `sha256:${string}` }> {
    const read = await this.readStable(input, true);
    const source = { ...this.describeRead(read), text: decodeWorkspaceText(read.bytes) };
    if (source.revision !== input.expectedRevision && !input.allowRevisionDrift)
      throw new WorkspaceContentSourceError('revision_changed');
    if (source.kind !== 'text') throw new WorkspaceContentSourceError('unsupported_text');
    const quote = validateWorkspaceQuote(input.quote);
    if (input.expectedQuoteDigest && input.expectedQuoteDigest !== workspaceTextDigest(quote))
      throw new WorkspaceContentSourceError('access_denied');
    const resolution = resolveWorkspaceTextQuote({
      text: source.text,
      quote,
      expectedContextDigest: input.expectedContextDigest,
    });
    return { ...resolution, sourceRevision: source.revision };
  }

  /** A rendered-page selection against the fresh source at exactly this revision (resolveWorkspaceRenderedQuote). */
  async resolveRenderedTextSelection(
    input: Parameters<WorkspaceContentSourceService['readText']>[0] & { readonly quote: string },
  ): Promise<WorkspaceTextQuoteResolutionV1 & { readonly sourceRevision: `sha256:${string}` }> {
    const { text, revision } = await this.readText(input);
    const markdown = isRenderedMarkdownPath(input.locator.path);
    const quote = validateWorkspaceQuote(input.quote);
    return { ...resolveWorkspaceRenderedQuote({ text, quote, markdown }), sourceRevision: revision };
  }

  private async readStable(
    input: { readonly principal: WorkspaceContentPrincipalV1; readonly locator: WorkspaceContentLocatorV1 },
    collectBytes: true,
  ): Promise<StableFileRead & { readonly bytes: Buffer }>;
  private async readStable(
    input: { readonly principal: WorkspaceContentPrincipalV1; readonly locator: WorkspaceContentLocatorV1 },
    collectBytes: false,
  ): Promise<StableFileRead>;
  private async readStable(
    input: { readonly principal: WorkspaceContentPrincipalV1; readonly locator: WorkspaceContentLocatorV1 },
    collectBytes: boolean,
  ): Promise<StableFileRead> {
    this.assertPrincipal(input.principal);
    const resolved = await this.resolveLocator(input.locator);
    let handle: FileHandle;
    try {
      handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceContentSourceError('not_found');
      throw new WorkspaceContentSourceError('access_denied');
    }
    try {
      const before = await handle.stat();
      const stillCanonical = await openedWorkspaceContentMatchesCanonicalLocator(
        resolved.root,
        resolved.path,
        resolved.locator,
        handle,
      ).catch(() => false);
      if (!stillCanonical) {
        throw new WorkspaceContentSourceError('revision_changed');
      }
      const maximum = this.options.maxBytes ?? MAX_WORKSPACE_COLLABORATION_BYTES;
      if (!before.isFile()) throw new WorkspaceContentSourceError('access_denied');
      if (before.size < 0 || before.size > maximum) throw new WorkspaceContentSourceError('too_large');
      const result = await digestWorkspaceFile(handle, before.size, collectBytes);
      const after = await handle.stat();
      if (!hasSameWorkspaceFileState(before, after) || result.byteLength !== before.size)
        throw new WorkspaceContentSourceError('revision_changed');
      const bytes = collectBytes ? requireWorkspaceContentBytes(result.bytes) : undefined;
      return {
        root: resolved.root,
        locator: resolved.locator,
        mime: guessMime(resolved.locator.path),
        byteLength: result.byteLength,
        digest: result.digest,
        ...(bytes ? { bytes } : {}),
      };
    } finally {
      await handle.close();
    }
  }

  private describeRead(read: StableFileRead): WorkspaceContentDescriptionV1 {
    return {
      contentRef: workspaceContentRef(this.options.ownerUserId, read.root, read.locator.path),
      revision: read.digest,
      locator: { ...read.locator },
      mime: read.mime,
      byteLength: read.byteLength,
      kind: classifyWorkspaceContentMime(read.mime),
    };
  }

  private assertPrincipal(principal: WorkspaceContentPrincipalV1): void {
    if (principal.userId !== this.options.ownerUserId) throw new WorkspaceContentSourceError('access_denied');
  }

  private async resolveLocator(locatorInput: WorkspaceContentLocatorV1): Promise<{
    readonly root: string;
    readonly path: string;
    readonly locator: WorkspaceContentLocatorV1;
  }> {
    const locator = validateWorkspaceContentLocator(locatorInput);
    let rootResolution: WorkspaceContentRootResolution;
    try {
      rootResolution = await this.options.resolveWorktreeRoot(locator.worktreeId);
    } catch (error) {
      if (error instanceof WorkspaceContentSourceError) throw error;
      throw new WorkspaceContentSourceError('not_found');
    }
    const canonicalLocator = validateWorkspaceContentLocator({
      worktreeId: rootResolution.canonicalWorktreeId,
      path: locator.path,
    });
    const canonicalRoot = await realpath(rootResolution.root).catch(() => {
      throw new WorkspaceContentSourceError('not_found');
    });
    try {
      const resolved = await canonicalizeWorkspaceContentLocator(canonicalRoot, canonicalLocator);
      return { root: canonicalRoot, path: resolved.path, locator: resolved.locator };
    } catch (error) {
      if (error instanceof WorkspaceSecurityError)
        throw new WorkspaceContentSourceError(error.code === 'NOT_FOUND' ? 'not_found' : 'access_denied');
      if (error instanceof WorkspaceContentSourceError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceContentSourceError('not_found');
      throw new WorkspaceContentSourceError('access_denied');
    }
  }
}

function requireWorkspaceContentBytes(bytes: Buffer | undefined): Buffer {
  if (!bytes) throw new WorkspaceContentSourceError('revision_changed');
  return bytes;
}
