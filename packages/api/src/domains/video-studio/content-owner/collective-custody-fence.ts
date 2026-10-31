import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { type CollectiveContentScopeV1, collectiveContentScopeRef } from './collective-scope.js';
import type { ProjectContentOwnerStore } from './store.js';
import type { ContentOperationContextV1 } from './types.js';

const id = z.string().trim().min(1).max(256);
const bindingSchema = z
  .object({ contentRef: id, scopeRef: id, transferId: id, custodyRevision: z.number().int().positive().safe() })
  .strict();
export type CollectiveCustodyFenceBinding = z.infer<typeof bindingSchema>;
const fenceSchema = bindingSchema
  .extend({
    v: z.literal(1),
    state: z.enum(['source_frozen', 'source_retired', 'target_staging', 'active', 'cancelled']),
  })
  .strict();
type Fence = z.infer<typeof fenceSchema>;
type Version = { ownerRevision: number; blobDigest: string };

/** Durable content-owner generation fence; all changes share the canonical content effect mutex. */
export class CollectiveContentCustodyFence {
  constructor(
    private readonly root: string,
    private readonly store: ProjectContentOwnerStore,
  ) {}
  async authorizeEffect(
    contentRef: string,
    scope: CollectiveContentScopeV1 | undefined,
    context: ContentOperationContextV1 | undefined,
    authorize?: () => Promise<void>,
  ) {
    if (!scope) return;
    await authorize?.();
    if (context?.kind !== 'collective-artifact:publish' && context?.kind !== 'collective-artifact:apply')
      throw new Error('Collective custody operation context unavailable');
    await this.assertEffectAvailable(contentRef, collectiveContentScopeRef(scope), context.custodyRevision);
  }
  async read(contentRef: string): Promise<Fence | null> {
    try {
      const fence = fenceSchema.parse(JSON.parse(await readFile(this.path(contentRef), 'utf8')));
      if (fence.contentRef !== contentRef) throw new Error('Collective custody fence identity mismatch');
      return fence;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  async assertEffectAvailable(contentRef: string, scopeRef: string, custodyRevision: number): Promise<void> {
    const fence = await this.read(contentRef);
    if (!fence) {
      if (custodyRevision !== 1) throw new Error('Collective custody generation unavailable');
      return;
    }
    if (fence.state !== 'active' || fence.scopeRef !== scopeRef || fence.custodyRevision !== custodyRevision)
      throw new Error('Collective custody effect unavailable');
  }
  async assertReadable(contentRef: string, scopeRef: string, custodyRevision: number): Promise<boolean> {
    const fence = await this.read(contentRef);
    if (!fence) {
      if (custodyRevision !== 1) throw new Error('Collective custody generation unavailable');
      return false;
    }
    if (
      !['active', 'source_frozen'].includes(fence.state) ||
      fence.scopeRef !== scopeRef ||
      fence.custodyRevision !== custodyRevision
    )
      throw new Error('Collective custody read unavailable');
    return fence.state === 'source_frozen';
  }
  async freezeSource(input: CollectiveCustodyFenceBinding & Version, authorize: () => Promise<void>) {
    const binding = bindingSchema.parse(pickBinding(input));
    return this.store.withContentLock(input.contentRef, async () => {
      await authorize();
      const current = await this.read(input.contentRef);
      if (current?.state === 'source_frozen') {
        assertBinding(current, binding);
        await this.assertVersion(binding, input);
        return;
      }
      await this.assertEffectAvailable(binding.contentRef, binding.scopeRef, binding.custodyRevision);
      await this.assertVersion(binding, input);
      await this.write({ ...binding, v: 1, state: 'source_frozen' });
    });
  }
  async stageTarget(input: CollectiveCustodyFenceBinding, authorize: () => Promise<void>) {
    const binding = bindingSchema.parse(input);
    return this.store.withContentLock(binding.contentRef, async () => {
      await authorize();
      if (await this.store.readState(binding.contentRef)) throw new Error('Collective target content collision');
      const current = await this.read(binding.contentRef);
      if (current?.state === 'target_staging') {
        assertBinding(current, binding);
        return;
      }
      if (current && current.state !== 'cancelled') throw new Error('Collective target generation collision');
      await this.write({ ...binding, v: 1, state: 'target_staging' });
    });
  }
  async finalizeSource(
    input: CollectiveCustodyFenceBinding,
    outcome: 'committed' | 'cancelled',
    authorize: () => Promise<void>,
  ) {
    const binding = bindingSchema.parse(input);
    return this.store.withContentLock(binding.contentRef, async () => {
      await authorize();
      const current = await this.require(binding);
      const next = outcome === 'committed' ? 'source_retired' : 'active';
      if (current.state === next) return;
      if (current.state !== 'source_frozen') throw new Error('Collective source custody outcome changed');
      await this.write({ ...binding, v: 1, state: next });
    });
  }
  async activateTarget(input: CollectiveCustodyFenceBinding & Version, authorize: () => Promise<void>) {
    const binding = bindingSchema.parse(pickBinding(input));
    return this.store.withContentLock(binding.contentRef, async () => {
      await authorize();
      const current = await this.require(binding);
      if (current.state === 'active') return;
      if (current.state !== 'target_staging') throw new Error('Collective target custody outcome changed');
      await this.assertVersion(binding, input);
      await this.write({ ...binding, v: 1, state: 'active' });
    });
  }
  async cancelTarget(input: CollectiveCustodyFenceBinding, authorize: () => Promise<void>) {
    const binding = bindingSchema.parse(input);
    return this.store.withContentLock(binding.contentRef, async () => {
      await authorize();
      const current = await this.require(binding);
      if (!['target_staging', 'cancelled'].includes(current.state) || (await this.store.readState(binding.contentRef)))
        throw new Error('Collective target custody outcome changed');
      await this.write({ ...binding, v: 1, state: 'cancelled' });
    });
  }
  private async assertVersion(binding: CollectiveCustodyFenceBinding, expected: Version) {
    const state = await this.store.readState(binding.contentRef);
    const latest = state?.revisions.at(-1);
    if (
      !state?.collectiveScope ||
      collectiveContentScopeRef(state.collectiveScope) !== binding.scopeRef ||
      latest?.ownerRevision !== expected.ownerRevision ||
      latest.blobDigest !== expected.blobDigest
    )
      throw new Error('Collective custody version changed');
  }
  private async require(binding: CollectiveCustodyFenceBinding) {
    const current = await this.read(binding.contentRef);
    if (!current) throw new Error('Collective custody fence missing');
    assertBinding(current, binding);
    return current;
  }
  private path(contentRef: string) {
    return join(
      this.root,
      '.collective-custody-fences',
      `${createHash('sha256').update(contentRef).digest('hex')}.json`,
    );
  }
  private async write(fence: Fence) {
    const dir = join(this.root, '.collective-custody-fences');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await syncDirectory(this.root);
    const temporary = join(dir, `.fence-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(fence));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path(fence.contentRef));
      await syncDirectory(dir);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
}
function pickBinding(input: CollectiveCustodyFenceBinding): CollectiveCustodyFenceBinding {
  return {
    contentRef: input.contentRef,
    scopeRef: input.scopeRef,
    transferId: input.transferId,
    custodyRevision: input.custodyRevision,
  };
}
function assertBinding(current: Fence, expected: CollectiveCustodyFenceBinding) {
  if (
    current.contentRef !== expected.contentRef ||
    current.scopeRef !== expected.scopeRef ||
    current.transferId !== expected.transferId ||
    current.custodyRevision !== expected.custodyRevision
  )
    throw new Error('Collective custody fence binding mismatch');
}
function isMissing(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
