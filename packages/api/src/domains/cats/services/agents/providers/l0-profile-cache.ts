import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface L0CacheGeneration {
  global: number;
  cat: number;
}

function computeProfileContentSignature(profileDir: string): string | null {
  if (!existsSync(profileDir)) return 'missing';
  const entries: string[] = [];
  const capsulePath = resolve(profileDir, 'landy-capsule.md');
  try {
    entries.push(`landy-capsule.md\t${createHash('sha256').update(readFileSync(capsulePath)).digest('hex')}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    entries.push('landy-capsule.md\tmissing');
  }

  const relationshipDir = resolve(profileDir, 'relationship');
  if (!existsSync(relationshipDir)) entries.push('relationship\tmissing');
  else if (!collectContentHashes(relationshipDir, 'relationship', entries)) return null;
  return entries.join('\n');
}

function readSortedDirents(dirPath: string): Array<{ name: string; isDirectory(): boolean }> | null {
  try {
    return (readdirSync(dirPath, { withFileTypes: true }) as Array<{ name: string; isDirectory(): boolean }>).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

function readContentHash(path: string): string | null | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
  }
}

function collectContentHashes(dirPath: string, relativeDir: string, entries: string[]): boolean {
  const dirents = readSortedDirents(dirPath);
  if (dirents === null) return false;
  for (const dirent of dirents) {
    const childPath = resolve(dirPath, dirent.name);
    const relativePath = `${relativeDir}/${dirent.name}`;
    if (dirent.isDirectory()) {
      if (!collectContentHashes(childPath, relativePath, entries)) return false;
      continue;
    }
    const digest = readContentHash(childPath);
    if (digest === null) return false;
    if (digest) entries.push(`${relativePath}\t${digest}`);
  }
  return true;
}

export class L0ProfileCache {
  private readonly results = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly generations = new Map<string, number>();
  private readonly profileSignatures = new Map<string, string>();
  private globalGeneration = 0;

  key(userId: string, catId: string): string {
    return `${userId}\0${catId}`;
  }

  get(cacheKey: string): string | undefined {
    return this.results.get(cacheKey);
  }

  set(cacheKey: string, value: string, profileSignature: string): void {
    this.profileSignatures.set(cacheKey, profileSignature);
    this.results.set(cacheKey, value);
  }

  getInflight(cacheKey: string): Promise<string> | undefined {
    return this.inflight.get(cacheKey);
  }

  setInflight(cacheKey: string, promise: Promise<string>): void {
    this.inflight.set(cacheKey, promise);
  }

  deleteInflight(cacheKey: string, promise: Promise<string>): void {
    if (this.inflight.get(cacheKey) === promise) this.inflight.delete(cacheKey);
  }

  size(): number {
    return this.results.size;
  }

  refreshProfileSignature(cacheKey: string, profileDir: string): string | null {
    const nextSignature = computeProfileContentSignature(profileDir);
    if (nextSignature === null) {
      this.clearKey(cacheKey);
      return null;
    }
    const previousSignature = this.profileSignatures.get(cacheKey);
    if (previousSignature !== undefined && previousSignature !== nextSignature) this.clearKey(cacheKey);
    this.profileSignatures.set(cacheKey, nextSignature);
    return nextSignature;
  }

  profileSignatureIsCurrent(profileDir: string, signature: string): boolean {
    return computeProfileContentSignature(profileDir) === signature;
  }

  generation(cacheKey: string): L0CacheGeneration {
    return { global: this.globalGeneration, cat: this.generations.get(cacheKey) ?? 0 };
  }

  generationIsCurrent(cacheKey: string, generation: L0CacheGeneration): boolean {
    const current = this.generation(cacheKey);
    return current.global === generation.global && current.cat === generation.cat;
  }

  clear(catId?: string, userId?: string): void {
    if (catId && userId) {
      this.clearKey(this.key(userId, catId));
      return;
    }
    if (catId) {
      for (const key of this.allKeys()) {
        if (key.endsWith(`\0${catId}`)) this.deleteKey(key);
      }
      this.bumpGlobalGeneration();
      return;
    }
    this.results.clear();
    this.inflight.clear();
    this.profileSignatures.clear();
    this.bumpGlobalGeneration();
  }

  private allKeys(): Set<string> {
    return new Set([...this.results.keys(), ...this.inflight.keys(), ...this.profileSignatures.keys()]);
  }

  private clearKey(cacheKey: string): void {
    this.deleteKey(cacheKey);
    this.generations.set(cacheKey, (this.generations.get(cacheKey) ?? 0) + 1);
  }

  private deleteKey(cacheKey: string): void {
    this.results.delete(cacheKey);
    this.inflight.delete(cacheKey);
    this.profileSignatures.delete(cacheKey);
  }

  private bumpGlobalGeneration(): void {
    this.globalGeneration += 1;
    this.generations.clear();
  }
}
