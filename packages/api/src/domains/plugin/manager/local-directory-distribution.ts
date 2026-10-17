import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { PLUGIN_ARCHIVE_BUDGET, preflightPluginArchive } from '../external-runtime/archive-preflight.js';
import type { LocalDirectoryOperation } from './local-directory-operation.js';
import { type LocalDirectorySourceCoordinates, LocalDirectorySourceError } from './local-directory-source.js';

const execFileAsync = promisify(execFile);
const RECEIPT = '.clowder-local-source.json';
const MAX_INSTANCES = 512;

interface Member {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
  readonly digest: string;
}
interface Node {
  readonly id: number;
  readonly source: LocalDirectorySourceCoordinates;
  members: readonly Member[];
  snapshot?: string;
  packDigest?: string;
}
interface Budget {
  files: number;
  bytes: number;
}

export interface LocalDirectoryDistributionOptions {
  readonly packagesRoot: string;
  readonly npmBin?: string;
  readonly tarBin?: string;
}

function invalid(code: string, message: string): never {
  throw new LocalDirectorySourceError(code, message);
}
function hash(bytes: Buffer | string): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}
function pathOf(root: string, member: string): string {
  if (
    !member ||
    isAbsolute(member) ||
    member.includes('\\') ||
    member.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\x00-\x1f\x7f]/.test(member) ||
    Buffer.byteLength(member) > PLUGIN_ARCHIVE_BUDGET.pathBytes ||
    member.split('/').length > PLUGIN_ARCHIVE_BUDGET.pathDepth
  )
    invalid('DEPENDENCY_SOURCE_INVALID', 'invalid publication member path');
  return resolve(root, member);
}
function count(budget: Budget, size: number): void {
  budget.files++;
  budget.bytes += size;
  if (budget.files > PLUGIN_ARCHIVE_BUDGET.regularFiles || budget.bytes > PLUGIN_ARCHIVE_BUDGET.expandedBytes) {
    invalid('DEPENDENCY_PREPARATION_LIMIT', 'prepared publication members exceed Host archive budget');
  }
}

function assertPublishedMain(
  snapshot: string,
  manifest: Record<string, unknown> | undefined,
  members: readonly Member[],
): void {
  // exports takes precedence over legacy main. An empty main does not declare
  // an executable entry (for example, declaration-only dependency packages).
  const main = manifest?.main;
  if (manifest?.exports != null || typeof main !== 'string' || main === '') return;
  const root = realpathSync(snapshot);
  const target = pathOf(root, main.replace(/^\.\//, ''));
  let entry: string;
  try {
    // Node permits extensionless and directory mains; resolve without executing package code.
    entry = createRequire(resolve(root, 'package.json')).resolve(target);
  } catch {
    invalid('DEPENDENCY_SOURCE_INVALID', `built package entrypoint is absent: ${main}`);
  }
  if (!members.some((member) => resolve(root, member.path) === entry)) {
    invalid('DEPENDENCY_SOURCE_INVALID', `built package entrypoint is outside publication members: ${main}`);
  }
}

async function memberBytes(root: string, member: string, lifetime: LocalDirectoryOperation) {
  lifetime.check();
  const path = pathOf(root, member);
  let directory = root;
  // Check every parent, not just O_NOFOLLOW on the final component.
  for (const part of member.split('/').slice(0, -1)) {
    directory = resolve(directory, part);
    const stat = await lifetime.io(() => lstat(directory));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      invalid('DEPENDENCY_SOURCE_INVALID', 'publication parent is not a real directory');
  }
  const handle = await lifetime.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await lifetime.io(() => handle.stat());
    if (!before.isFile() || before.size > PLUGIN_ARCHIVE_BUDGET.singleFileBytes) {
      invalid('DEPENDENCY_PREPARATION_LIMIT', 'publication member is not a bounded regular file');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      lifetime.check();
      const result = await lifetime.io(() => handle.read(bytes, length, bytes.length - length, length));
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await lifetime.io(() => handle.stat());
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.mode !== after.mode
    ) {
      invalid('DEPENDENCY_SOURCE_CHANGED', 'publication member changed while being sealed');
    }
    const value = bytes.subarray(0, length);
    const metadata: Member = { path: member, size: length, mode: before.mode & 0o777, digest: hash(value) };
    return { bytes: value, metadata };
  } finally {
    await handle.close();
  }
}

async function writeMember(
  root: string,
  member: Member,
  bytes: Buffer,
  lifetime: LocalDirectoryOperation,
): Promise<void> {
  const destination = pathOf(root, member.path);
  await lifetime.io(() => mkdir(dirname(destination), { recursive: true, mode: 0o700 }));
  await lifetime.io(() => writeFile(destination, bytes, { flag: 'wx', mode: member.mode }));
  await lifetime.io(() => chmod(destination, member.mode));
  await lifetime.io(() => utimes(destination, 0, 0));
}

function packResult(text: string): { files: { path: string; size: number }[]; filename?: string } {
  const result: unknown = JSON.parse(text);
  if (!Array.isArray(result) || result.length !== 1 || !result[0] || !Array.isArray(result[0].files)) {
    invalid('DEPENDENCY_PACK_FAILED', 'npm pack did not return one publication member list');
  }
  const files: { path: string; size: number }[] = [];
  const names = new Set<string>();
  for (const file of result[0].files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0) {
      invalid('DEPENDENCY_PACK_FAILED', 'npm pack returned invalid member metadata');
    }
    pathOf('/', file.path);
    // Root dependencies are reconstructed from the declared graph. Nested
    // publication fixtures (for example pino's test/eval files) are package bytes.
    if (names.has(file.path) || file.path.split('/')[0] === 'node_modules' || file.path === RECEIPT) {
      invalid('DEPENDENCY_PACK_FAILED', 'publication members contain a duplicate, hidden closure or reserved receipt');
    }
    names.add(file.path);
    files.push({ path: file.path, size: file.size });
    if (files.length > PLUGIN_ARCHIVE_BUDGET.regularFiles)
      invalid('DEPENDENCY_PREPARATION_LIMIT', 'publication member count exceeded');
  }
  if (!names.has('package.json')) invalid('DEPENDENCY_PACK_FAILED', 'publication package.json is missing');
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), filename: result[0].filename };
}

/** Resolve the complete locked graph before invoking a packer or writing inventory. */
async function sourceGraph(root: LocalDirectorySourceCoordinates): Promise<Map<string, Node>> {
  const lifetime = root.operation;
  const nodes = new Map<string, Node>();
  const pending = [root];
  const queued = new Set([root.root]);
  for (let cursor = 0; cursor < pending.length; cursor++) {
    lifetime.step();
    const source = pending[cursor];
    if (!source || nodes.has(source.root)) continue;
    if (nodes.size >= MAX_INSTANCES) invalid('DEPENDENCY_PREPARATION_LIMIT', 'source package count exceeded');
    if (!source.manifest) invalid('DEPENDENCY_SOURCE_INVALID', 'runtime package.json is missing');
    if (source.manifest.bundledDependencies || source.manifest.bundleDependencies) {
      invalid('DEPENDENCY_SPEC_UNSUPPORTED', 'bundled dependencies require an explicit attested topology');
    }
    nodes.set(source.root, { id: nodes.size, source, members: [] });
    for (const edge of source.dependencies) {
      lifetime.step();
      const dependency = await source.dependencySource(edge);
      if (!queued.has(dependency.root)) {
        queued.add(dependency.root);
        pending.push(dependency);
      }
    }
  }
  return nodes;
}

/** Prepare owned bytes; it does not start the plugin, install deps or run build scripts. */
export async function prepareLocalDirectoryDistribution(
  source: LocalDirectorySourceCoordinates,
  options: LocalDirectoryDistributionOptions,
): Promise<Buffer> {
  const lifetime = source.operation;
  const signal = lifetime.signal;
  lifetime.check();
  // Entire supported graph must pass the cheap gate before invoking npm.
  const nodes = await sourceGraph(source);
  await source.assertCurrent();
  await lifetime.io(() => mkdir(options.packagesRoot, { recursive: true, mode: 0o700 }));
  lifetime.step();
  const operation = await mkdtemp(resolve(options.packagesRoot, '.directory-prepare-'));
  let candidate: Buffer;
  try {
    lifetime.check();
    for (const directory of ['home', 'tmp', 'cache', 'packs'])
      await lifetime.io(() => mkdir(resolve(operation, directory), { mode: 0o700 }));
    const npmConfig = resolve(operation, 'npmrc');
    const globalConfig = resolve(operation, 'global-npmrc');
    await lifetime.io(() => writeFile(npmConfig, '', { flag: 'wx', mode: 0o600 }));
    await lifetime.io(() => writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 }));
    const env = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: resolve(operation, 'home'),
      TMPDIR: `${resolve(operation, 'tmp')}${sep}`,
      LC_ALL: 'C',
      COPYFILE_DISABLE: '1',
    };
    const run = (bin: string, args: string[]) =>
      lifetime.io(() =>
        execFileAsync(bin, args, {
          cwd: operation,
          env,
          signal,
          timeout: PLUGIN_ARCHIVE_BUDGET.deadlineMs,
          maxBuffer: 8 * 1024 * 1024,
        }),
      );
    const npm = options.npmBin?.trim() || 'npm';
    const npmArgs = [
      '--ignore-scripts',
      '--offline',
      '--workspaces=false',
      '--audit=false',
      '--fund=false',
      '--update-notifier=false',
      `--userconfig=${npmConfig}`,
      `--globalconfig=${globalConfig}`,
      `--cache=${resolve(operation, 'cache')}`,
    ];
    const selectionBudget: Budget = { files: 0, bytes: 0 };
    // Admission source defines content provenance. Lock SRI remains coordinate
    // metadata; every physical package is sealed as owner-local publication bytes.
    await source.assertCurrent();
    const npmVersion = (await run(npm, ['--version', ...npmArgs])).stdout.trim();
    for (const node of nodes.values()) {
      const selected = packResult(
        (await run(npm, ['pack', '--dry-run', '--json', ...npmArgs, node.source.root])).stdout,
      );
      const snapshot = resolve(operation, `node-${node.id}`);
      const packDirectory = resolve(operation, 'packs', String(node.id));
      await lifetime.io(() => mkdir(snapshot, { mode: 0o700 }));
      await lifetime.io(() => mkdir(packDirectory, { mode: 0o700 }));
      const members: Member[] = [];
      for (const file of selected.files) {
        const sealed = await memberBytes(node.source.root, file.path, lifetime);
        if (sealed.metadata.size !== file.size) invalid('DEPENDENCY_SOURCE_CHANGED', 'publication selection changed');
        count(selectionBudget, sealed.metadata.size);
        await writeMember(snapshot, sealed.metadata, sealed.bytes, lifetime);
        members.push(sealed.metadata);
      }
      // Pack only the private snapshot. Replacing or editing the source during
      // npm execution can no longer change the bytes given to the packer.
      const packed = packResult(
        (await run(npm, ['pack', '--json', ...npmArgs, `--pack-destination=${packDirectory}`, snapshot])).stdout,
      );
      if (JSON.stringify(packed.files) !== JSON.stringify(selected.files)) {
        invalid('DEPENDENCY_SOURCE_CHANGED', 'sealed publication member selection differs');
      }
      if (!packed.filename || packed.filename.includes('/') || packed.filename.includes('\\')) {
        invalid('DEPENDENCY_PACK_FAILED', 'npm returned an invalid archive filename');
      }
      const archive = resolve(packDirectory, packed.filename);
      await preflightPluginArchive(archive, signal);
      const stat = await lifetime.io(() => lstat(archive));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PLUGIN_ARCHIVE_BUDGET.compressedBytes) {
        invalid('DEPENDENCY_PACK_FAILED', 'npm archive is not a bounded regular file');
      }
      node.members = members;
      node.snapshot = snapshot;
      node.packDigest = hash(await lifetime.io(() => readFile(archive)));
      assertPublishedMain(snapshot, node.source.manifest, members);
    }

    const preparedRoot = resolve(operation, 'package');
    const mounted = new Map<string, string>([[preparedRoot, source.root]]);
    const outputBudget: Budget = { files: 0, bytes: 0 };
    const pending = [preparedRoot];
    function ancestorTarget(destination: string, name: string): string | undefined {
      let cursor = destination;
      while (cursor === preparedRoot || cursor.startsWith(`${preparedRoot}${sep}`)) {
        lifetime.step();
        const candidate = resolve(cursor, 'node_modules', name);
        if (mounted.has(candidate)) return candidate;
        cursor = dirname(cursor);
      }
      return undefined;
    }
    // Reserve all siblings before descending, so a peer never depends on the
    // enumeration order of root.dependencies. Cycles reuse an identical ancestor.
    for (let cursor = 0; cursor < pending.length; cursor++) {
      lifetime.step();
      const destination = pending[cursor]!;
      const node = nodes.get(mounted.get(destination)!)!;
      for (const edge of node.source.dependencies.filter((edge) => !edge.peer)) {
        const ancestor = ancestorTarget(destination, edge.name);
        if (ancestor && mounted.get(ancestor) === edge.root) continue;
        const target = resolve(destination, 'node_modules', edge.name);
        if (mounted.has(target)) invalid('DEPENDENCY_LOCK_MISMATCH', 'conflicting installed resolution');
        if (mounted.size >= MAX_INSTANCES)
          invalid('DEPENDENCY_PREPARATION_LIMIT', 'installed package instance count exceeded');
        mounted.set(target, edge.root);
        pending.push(target);
      }
    }
    for (const [destination, root] of mounted) {
      const node = nodes.get(root)!;
      for (const edge of node.source.dependencies) {
        const target = ancestorTarget(destination, edge.name);
        if (!target || mounted.get(target) !== edge.root)
          invalid(
            edge.peer ? 'PEER_DEPENDENCY_UNRESOLVED' : 'DEPENDENCY_LOCK_MISMATCH',
            'relocated dependency resolution differs from the attested graph',
          );
      }
      // Absence is part of the source graph too. Hoisting another consumer's
      // package into an ancestor must not enable an optional dependency here.
      for (const edge of node.source.absentDependencies) {
        if (ancestorTarget(destination, edge.name))
          invalid(
            'DEPENDENCY_LOCK_MISMATCH',
            'relocated optional dependency is present but absent from the attested graph',
          );
      }
      await lifetime.io(() => mkdir(destination, { recursive: true, mode: 0o700 }));
      for (const member of node.members) {
        count(outputBudget, member.size);
        const sealed = await memberBytes(node.snapshot!, member.path, lifetime);
        if (JSON.stringify(sealed.metadata) !== JSON.stringify(member))
          invalid('DEPENDENCY_SOURCE_CHANGED', 'private publication snapshot changed');
        await writeMember(destination, member, sealed.bytes, lifetime);
      }
      assertPublishedMain(destination, node.source.manifest, node.members);
    }

    // Re-read source bytes and metadata after all pack work. No subsequent
    // runtime path refers back to the selected workspace.
    for (const node of nodes.values()) {
      for (const member of node.members) {
        const current = await memberBytes(node.source.root, member.path, lifetime);
        if (JSON.stringify(current.metadata) !== JSON.stringify(member))
          invalid('DEPENDENCY_SOURCE_CHANGED', 'source publication content changed');
      }
      const finalSelection = packResult(
        (await run(npm, ['pack', '--dry-run', '--json', ...npmArgs, node.source.root])).stdout,
      );
      if (
        JSON.stringify(finalSelection.files) !== JSON.stringify(node.members.map(({ path, size }) => ({ path, size })))
      ) {
        invalid('DEPENDENCY_SOURCE_CHANGED', 'source publication policy changed');
      }
    }
    await source.assertCurrent();
    const receipt = {
      version: 2,
      provenance: 'owner-local',
      contentProvenance: 'owner-local',
      npmVersion,
      platform: process.platform,
      arch: process.arch,
      nodes: [...nodes.values()].map((node) => ({
        id: node.id,
        name: node.source.manifest?.name,
        version: node.source.manifest?.version,
        lockDigest: node.source.lockDigest,
        lockCoordinate: node.source.lockCoordinate,
        contentProvenance: 'owner-local',
        lockIntegrity: node.source.lockIntegrity,
        absentDependencies: node.source.absentDependencies,
        packDigest: node.packDigest,
        members: node.members,
        edges: node.source.dependencies.map((edge) => ({
          name: edge.name,
          requested: edge.requested,
          coordinate: edge.lockCoordinate,
          peer: edge.peer,
          target: nodes.get(edge.root)!.id,
        })),
      })),
      topology: [...mounted].map(([path, root]) => ({
        path: relative(preparedRoot, path).split(sep).join('/') || '.',
        node: nodes.get(root)!.id,
      })),
    };
    const receiptBytes = Buffer.from(
      `${JSON.stringify({ ...receipt, sourceGraphDigest: hash(JSON.stringify(receipt)) })}\n`,
    );
    count(outputBudget, receiptBytes.length);
    await writeMember(
      preparedRoot,
      { path: RECEIPT, size: receiptBytes.length, mode: 0o600, digest: hash(receiptBytes) },
      receiptBytes,
      lifetime,
    );
    async function normalizeDirectories(path: string): Promise<void> {
      for (const entry of await lifetime.entries(path))
        if (entry.isDirectory()) await normalizeDirectories(resolve(path, entry.name));
      await lifetime.io(() => utimes(path, 0, 0));
    }
    await normalizeDirectories(preparedRoot);
    const archive = resolve(operation, 'candidate.tgz');
    await run(options.tarBin?.trim() || 'tar', ['-czf', archive, '-C', operation, 'package']);
    await preflightPluginArchive(archive, signal);
    lifetime.check();
    candidate = await lifetime.io(() => readFile(archive));
  } finally {
    await rm(operation, { recursive: true, force: true });
  }
  lifetime.check();
  return candidate;
}
