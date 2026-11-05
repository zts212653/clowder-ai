import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { isPathAllowed } from '../utils/path-validator.js';
import { callbackPost } from './callback-tools.js';
import { errorResult } from './file-tools.js';
import { authorizeInvocationTool, resolveInvocationCredentials, withInvocationCredentials } from './invocation-auth.js';

const MAX_BYTES = 10 * 1024 * 1024;
// Darwin's atomic whole-path no-symlink flag; Node does not export this SDK constant.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
function memberImageOpenFlags(): number {
  if (process.platform === 'darwin') return constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_O_NOFOLLOW_ANY;
  if (process.platform === 'linux') return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
  throw new Error('Secure member image reads require macOS or Linux');
}
async function assertOpenedImageAllowed(fd: number): Promise<void> {
  if (process.platform === 'linux' && !isPathAllowed(await realpath(`/proc/self/fd/${fd}`)))
    throw new Error('Access denied: opened image is outside allowed file roots');
}
const defineTool = defineMcpCanonicalFactory('member-image-tools.ts', undefined, {
  resourceFamily: 'artifact-surface',
  authority: 'callback-thread',
});
export const publishImageInputSchema = {
  path: z.string().min(1).max(4096).describe('Absolute PNG path inside the existing allowed workspace/file roots.'),
  publicationKey: z
    .string()
    .min(1)
    .max(128)
    .describe('Stable key for this exact publication. Reuse for retries; a different version needs a new key.'),
  title: z.string().min(1).max(200).optional().describe('Plain display title.'),
  alt: z.string().max(2000).optional().describe('Image description for readers.'),
};

/** Read through one bounded descriptor; reject escapes and changed file identity before reading bytes. */
export async function readMemberImage(path: string): Promise<{ sourcePath: string; bytes: Buffer }> {
  if (!isAbsolute(path)) throw new Error('Image path must be absolute');
  if (!isPathAllowed(path)) throw new Error('Access denied: image is outside allowed file roots');
  const resolved = await realpath(path);
  if (!isPathAllowed(resolved)) throw new Error('Access denied: image is outside allowed file roots');
  const expected = await stat(resolved);
  if (!expected.isFile()) throw new Error('Image must be a regular file');
  if (expected.size > MAX_BYTES) throw new Error('Image file too large (maximum 10 MiB)');
  const file = await open(resolved, memberImageOpenFlags());
  try {
    await assertOpenedImageAllowed(file.fd);
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      !isPathAllowed(resolved) ||
      (await realpath(path)) !== resolved
    )
      throw new Error('Access denied: image path changed before reading');
    if (before.size > MAX_BYTES) throw new Error('Image file too large (maximum 10 MiB)');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    await authorizeInvocationTool('cat_cafe_publish_image');
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat();
    await authorizeInvocationTool('cat_cafe_publish_image');
    if (size > MAX_BYTES) throw new Error('Image file too large (maximum 10 MiB)');
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('Image changed while reading; retry after rendering completes');
    return { sourcePath: resolved, bytes: buffer.subarray(0, size) };
  } finally {
    await file.close();
  }
}

export async function handlePublishImage(input: z.infer<z.ZodObject<typeof publishImageInputSchema>>) {
  // Preserve the full inherited scope: this nested entry must not drop the
  // gateway-bound apiUrl/identity down to bare invocation credentials.
  const credentials = resolveInvocationCredentials();
  if (!credentials.invocationId || !credentials.callbackToken)
    return errorResult('Image publication requires current invocation callback credentials');
  try {
    return await withInvocationCredentials({ ...credentials }, async () => {
      const image = await readMemberImage(input.path);
      return callbackPost('/api/callbacks/publish-image', {
        publicationKey: input.publicationKey,
        sourcePath: image.sourcePath,
        imageBase64: image.bytes.toString('base64'),
        ...(input.title ? { title: input.title } : {}),
        ...(input.alt !== undefined ? { alt: input.alt } : {}),
      });
    });
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : 'Image publication failed');
  }
}

export const memberImageTools = [
  defineTool({
    name: 'cat_cafe_publish_image',
    description:
      'Publish an existing local PNG as a durable image message in your current thread. Use when: you rendered a PNG and need Chat delivery or the existing Task/artifact review chain. NOT for: generating images, remote URLs, another thread, or changing Task/owner state. Output: canonical image URL, persisted messageId, real timestamp revision and attributed member-file provenance. GOTCHA: macOS and Linux only, with existing allowed local file roots; a rich-block buffer is not publication. Retry the same publicationKey and exact payload. Different bytes conflict; after message persistence, changed metadata or a retained withdrawn/deleted message also conflicts. Use a new key for an intended new version. Register only the returned URL as the Task primary artifact, then prepare through the existing artifact-review tool; later versions retain that content lineage.',
    inputSchema: publishImageInputSchema,
    handler: handlePublishImage,
    governance: {
      implementationExport: 'handlePublishImage',
      action: 'publish',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/f317-member-image-publication.md',
      },
    },
  }),
] as const;
