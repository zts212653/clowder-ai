/**
 * F129 PackStore — Local Pack Storage
 * Manages installed packs on disk at .cat-cafe/packs/<name>/
 *
 * AC-A4: cafe pack add
 * AC-A5: cafe pack list / remove
 */

import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PackManifest, PackOnDisk } from '@cat-cafe/shared';
import { PackManifestSchema } from '@cat-cafe/shared';
import { parse } from 'yaml';

export class PackStore {
  constructor(private readonly baseDir: string) {}

  /** Ensure base directory exists */
  private async ensureDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private packDir(name: string): string {
    return join(this.baseDir, name);
  }

  /** Install a validated pack from source directory */
  async install(name: string, sourceDir: string): Promise<void> {
    await this.ensureDir();
    const dest = this.packDir(name);
    // Remove existing (upgrade path)
    await rm(dest, { recursive: true, force: true });
    await cp(sourceDir, dest, { recursive: true });
  }

  /** Remove an installed pack */
  async remove(name: string): Promise<boolean> {
    const dir = this.packDir(name);
    try {
      await stat(dir);
      await rm(dir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** List all installed pack manifests */
  async list(): Promise<PackManifest[]> {
    await this.ensureDir();
    const entries = await readdir(this.baseDir, { withFileTypes: true });
    const manifests: PackManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pack = await this.get(entry.name);
      if (pack) manifests.push(pack.manifest);
    }
    return manifests;
  }

  /** Get a single pack by name */
  async get(name: string): Promise<PackOnDisk | null> {
    const dir = this.packDir(name);
    const manifestPath = join(dir, 'pack.yaml');
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const parsed = parse(raw) as unknown;
      const result = PackManifestSchema.safeParse(parsed);
      if (!result.success) return null;
      return { manifest: result.data, rootDir: dir };
    } catch {
      return null;
    }
  }

  /** Check if a pack is installed */
  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== null;
  }
}
