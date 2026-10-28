import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateProjectPath } from '../../../utils/project-path.js';
import { operationDirectory, readOutputRecord, writeOutputRecord } from './immutable-output-record.js';

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}
interface Reservation {
  readonly root: string;
  readonly target: string;
  readonly parent: FileIdentity;
  readonly audio: FileIdentity;
  readonly receipt: FileIdentity;
}
const inside = (path: string) => path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
const same = (a: FileIdentity, b: FileIdentity) => a.ino === b.ino && a.dev === b.dev;
function flags(create: boolean) {
  const nofollow = process.platform === 'darwin' ? 0x20000000 : process.platform === 'linux' ? constants.O_NOFOLLOW : 0;
  if (!nofollow) throw new Error('unsupported_output_platform');
  return constants.O_RDWR | nofollow | (create ? constants.O_CREAT | constants.O_EXCL : 0);
}

/** Whole-set admission plus recovery on the exact reserved inodes, without overwriting foreign bytes. */
export class ProjectOutputFiles {
  constructor(private readonly root: string) {}
  async reserve(operationId: string, projectRoot: string, path: string): Promise<string> {
    if (isAbsolute(path) || path.includes('\\') || path.split('/').includes('..') || !path.endsWith('.mp3'))
      throw new Error('path_not_allowed');
    const root = await validateProjectPath(projectRoot);
    if (!root) throw new Error('path_not_allowed');
    const target = resolve(root, path);
    if (!inside(relative(root, target)) || target === root) throw new Error('path_not_allowed');
    const recordPath = join(await operationDirectory(this.root, operationId), 'reservation.json');
    const existing = (await readOutputRecord(recordPath)) as Reservation | undefined;
    if (existing) {
      if (existing.root !== root || existing.target !== target) throw new Error('operation_conflict');
      await this.verify(operationId);
      return operationId;
    }
    await this.directory(root, dirname(target), true);
    const pin = await this.pin(dirname(target));
    let receipt: FileHandle | undefined;
    let audio: FileHandle | undefined;
    const writePath = pin ? `/proc/self/fd/${pin.fd}/${basename(target)}` : target;
    try {
      receipt = await open(`${writePath}.provenance.json`, flags(true), 0o600);
      try {
        audio = await open(writePath, flags(true), 0o600);
      } catch (error) {
        await this.discardOwned(`${writePath}.provenance.json`, receipt);
        throw error;
      }
      const record: Reservation = {
        root,
        target,
        parent: await lstat(dirname(target)),
        audio: await audio.stat(),
        receipt: await receipt.stat(),
      };
      // Only persist the identity fields, never serialize platform-specific Stats internals.
      const identity = (stat: FileIdentity) => ({ dev: stat.dev, ino: stat.ino });
      await writeOutputRecord(recordPath, {
        root,
        target,
        parent: identity(record.parent),
        audio: identity(record.audio),
        receipt: identity(record.receipt),
      });
      await audio.sync();
      await receipt.sync();
      const directory = pin ?? (await open(dirname(target), constants.O_RDONLY));
      try {
        await directory.sync();
      } finally {
        if (!pin) await directory.close();
      }
      return operationId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Another invocation of this same operation may be publishing its reservation.
        // Reconcile only this immutable identity; a different operation can never borrow it.
        for (let i = 0; i < 20; i++) {
          const owned = (await readOutputRecord(recordPath)) as Reservation | undefined;
          if (owned) {
            if (owned.root !== root || owned.target !== target) throw new Error('operation_conflict');
            await this.verify(operationId);
            return operationId;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error('target_conflict');
      }
      throw error;
    } finally {
      await Promise.all([audio?.close(), receipt?.close(), pin?.close()]);
    }
  }

  async verify(reservation: string): Promise<void> {
    const record = await this.record(reservation);
    await this.directory(record.root, dirname(record.target), false);
    const parent = await lstat(dirname(record.target));
    const [audio, receipt] = await Promise.all([lstat(record.target), lstat(`${record.target}.provenance.json`)]);
    if (
      !same(record.parent, parent) ||
      !same(record.audio, audio) ||
      !same(record.receipt, receipt) ||
      !audio.isFile() ||
      !receipt.isFile() ||
      audio.nlink !== 1 ||
      receipt.nlink !== 1
    )
      throw new Error('target_changed');
  }

  async deliver(reservation: string, audio: Buffer, receipt: unknown): Promise<void> {
    const record = await this.record(reservation);
    await this.verify(reservation);
    await this.completeFile(record, record.target, record.audio, audio);
    await this.verify(reservation);
    await this.completeFile(
      record,
      `${record.target}.provenance.json`,
      record.receipt,
      Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`),
    );
    await this.verify(reservation);
    const directory = await open(dirname(record.target), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async record(id: string): Promise<Reservation> {
    const value = await readOutputRecord(join(await operationDirectory(this.root, id), 'reservation.json'));
    if (!value || typeof value !== 'object' || !('root' in value) || !('target' in value))
      throw new Error('reservation_unavailable');
    return value as Reservation;
  }
  private async directory(root: string, parent: string, create: boolean): Promise<void> {
    if ((await realpath(root)) !== root) throw new Error('path_not_allowed');
    let current = root;
    for (const part of relative(root, parent).split(sep).filter(Boolean)) {
      current = join(current, part);
      if (create)
        await mkdir(current).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        });
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(relative(root, await realpath(current))))
        throw new Error('path_not_allowed');
    }
  }
  private async pin(parent: string) {
    return process.platform === 'linux'
      ? open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      : undefined;
  }
  private async discardOwned(path: string, file: FileHandle) {
    const current = await lstat(path).catch(() => undefined);
    if (current && same(current, await file.stat()) && current.size === 0) await unlink(path);
  }
  private async completeFile(record: Reservation, path: string, identity: FileIdentity, bytes: Buffer): Promise<void> {
    const directory = await this.pin(dirname(path));
    if (
      directory &&
      (!same(await directory.stat(), record.parent) ||
        (await realpath(`/proc/self/fd/${directory.fd}`)) !== dirname(path))
    ) {
      await directory.close();
      throw new Error('path_not_allowed');
    }
    const file = await open(directory ? `/proc/self/fd/${directory.fd}/${basename(path)}` : path, flags(false)).catch(
      async (error) => {
        await directory?.close();
        throw error;
      },
    );
    try {
      const stat = await file.stat();
      if (!same(stat, identity) || stat.nlink !== 1 || stat.size > bytes.length) throw new Error('target_changed');
      const existing = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(existing, 0, existing.length, 0);
      if (bytesRead !== existing.length || !existing.equals(bytes.subarray(0, existing.length)))
        throw new Error('target_changed');
      let offset = existing.length;
      while (offset < bytes.length) {
        const result = await file.write(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesWritten) throw new Error('delivery_failed');
        offset += result.bytesWritten;
      }
      await file.sync();
    } finally {
      await Promise.all([file.close(), directory?.close()]);
    }
  }
}
