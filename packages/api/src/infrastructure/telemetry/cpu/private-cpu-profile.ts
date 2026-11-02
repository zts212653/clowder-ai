import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath } from 'node:fs/promises';
import type { Profiler } from 'node:inspector';
import { basename, join } from 'node:path';
import { PROCESS_PROFILE_LIMITS } from './process-cpu-profile.js';

const MAX_BYTES = 64 * 1024 * 1024;

/** Opt-in original only, never a log attachment. Refuse unsafe storage instead of broadening access. */
export async function savePrivateCpuProfile(dataDir: string, profile: Profiler.Profile) {
  if (
    profile.nodes.length > PROCESS_PROFILE_LIMITS.nodes ||
    (profile.samples?.length ?? 0) > PROCESS_PROFILE_LIMITS.samples ||
    profile.nodes.reduce((n, node) => n + (node.children?.length ?? 0), 0) > PROCESS_PROFILE_LIMITS.edges
  ) {
    return { status: 'omitted', reason: 'profile_budget' } as const;
  }
  const raw = JSON.stringify(profile);
  const bytes = Buffer.byteLength(raw);
  if (bytes > MAX_BYTES) return { status: 'omitted', reason: 'byte_budget' } as const;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const base = join(await realpath(dataDir), 'private-cpu-profiles');
  try {
    await mkdir(base, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(base);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.mode & 0o077 ||
    (process.getuid && metadata.uid !== process.getuid())
  )
    throw new Error('private_cpu_directory_invalid');
  const directory = await mkdtemp(join(base, `capture-${process.pid}-`));
  const file = await open(
    join(directory, 'process.cpuprofile'),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(raw);
    await file.sync();
  } finally {
    await file.close();
  }
  return {
    status: 'saved',
    captureId: basename(directory),
    bytes,
    sha256: createHash('sha256').update(raw).digest('hex'),
  } as const;
}
