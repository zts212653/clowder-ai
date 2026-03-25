/**
 * TencentSkillHubService — 腾讯 SkillHub (skillhub.tencent.com → lightmake.site) API 封装
 *
 * 搜索: GET /api/skills?page=1&pageSize=20&search=...
 * 热门: GET /api/skills/top
 * 下载: GET /api/v1/download?slug=xxx → ZIP → 提取 SKILL.md
 */

import JSZip from 'jszip';

const API_BASE = 'https://lightmake.site';

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── Tencent raw types ───

interface TencentSkill {
  slug: string;
  name: string;
  description: string;
  description_zh?: string;
  category?: string;
  ownerName?: string;
  stars?: number;
  downloads?: number;
  installs?: number;
  homepage?: string;
  tags?: string[] | null;
  version?: string;
}

// ─── Unified types (match skillshub.wtf shape) ───

export interface SkillHubSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
  repo: {
    id: string;
    starCount: number;
    downloadCount: number;
    githubOwner: string;
    githubRepoName: string;
  };
  owner: {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
  };
}

export interface SkillHubSearchResponse {
  data: SkillHubSkill[];
  total: number;
  page: number;
  hasMore: boolean;
}

export interface SkillHubResolveEntry {
  skill: SkillHubSkill;
  score: number;
  confidence: number;
  fetchUrl: string;
}

export interface SkillHubResolveResponse {
  data: SkillHubResolveEntry[];
  query: string;
  tokens: string[];
  matched: number;
  threshold: number;
  ambiguity: string;
}

// ─── Normalize Tencent skill to unified shape ───

function normalizeSkill(t: TencentSkill): SkillHubSkill {
  return {
    id: t.slug,
    slug: t.slug,
    name: t.name,
    description: t.description_zh || t.description || '',
    tags: t.tags ?? [],
    createdAt: '',
    repo: {
      id: t.slug,
      starCount: t.stars ?? 0,
      downloadCount: t.downloads ?? 0,
      githubOwner: t.ownerName ?? '',
      githubRepoName: t.slug,
    },
    owner: {
      id: t.ownerName ?? '',
      username: t.ownerName ?? '',
      displayName: t.ownerName ?? '',
      avatarUrl: '',
    },
  };
}

// ─── API calls ───

async function tencentApiGet<T>(path: string, cacheKey?: string): Promise<T> {
  if (cacheKey) {
    const cached = getCached<T>(cacheKey);
    if (cached) return cached;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tencent SkillHub error ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { code: number; data?: T; message?: string };
  if (body.code !== 0) {
    throw new Error(`Tencent SkillHub API error: ${body.message ?? 'unknown'}`);
  }
  const data = body.data as T;
  if (cacheKey) setCache(cacheKey, data);
  return data;
}

// ─── Public API (same signature as original SkillHubService) ───

export async function searchSkills(
  query: string,
  options?: { tags?: string; sort?: string; page?: number; limit?: number },
): Promise<SkillHubSearchResponse> {
  const page = options?.page ?? 1;
  const limit = options?.limit ?? 20;

  const result = await tencentApiGet<{ skills: TencentSkill[]; total: number }>(
    `/api/skills?page=${page}&pageSize=${limit}&keyword=${encodeURIComponent(query)}`,
    `tencent:search:${query}:${page}:${limit}`,
  );

  return {
    data: (result.skills ?? []).map(normalizeSkill),
    total: result.total ?? 0,
    page,
    hasMore: page * limit < (result.total ?? 0),
  };
}

export async function trendingSkills(): Promise<SkillHubSearchResponse> {
  const result = await tencentApiGet<{ skills: TencentSkill[] }>('/api/skills/top', 'tencent:top');

  return {
    data: (result.skills ?? []).map(normalizeSkill),
    total: result.skills?.length ?? 0,
    page: 1,
    hasMore: false,
  };
}

export async function resolveSkills(task: string, limit = 3): Promise<SkillHubResolveResponse> {
  // Tencent doesn't have a resolve endpoint, fallback to search
  const searchResult = await searchSkills(task, { limit });
  return {
    data: searchResult.data.map((s) => ({
      skill: s,
      score: 0.5,
      confidence: 0.5,
      fetchUrl: '',
    })),
    query: task,
    tokens: task.split(/\s+/),
    matched: searchResult.total,
    threshold: 0.7,
    ambiguity: 'unknown',
  };
}

/** 下载并解压 ZIP 中的所有文件，返回 filename → Buffer 映射 */
export async function fetchSkillAllFiles(owner: string, repo: string, skill: string): Promise<Map<string, Buffer>> {
  const slug = skill || repo || owner;
  const cacheKey = `tencent:allfiles:${slug}`;
  const cached = getCached<Map<string, Buffer>>(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${API_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`Tencent skill download failed: ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const zip = await JSZip.loadAsync(buffer);
  const files = new Map<string, Buffer>();

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    // Skip hidden files and macOS metadata
    if (path.startsWith('__MACOSX/') || path.startsWith('.')) continue;
    const content = await entry.async('nodebuffer');
    files.set(path, content);
  }

  if (!files.has('SKILL.md')) {
    throw new Error('ZIP does not contain SKILL.md');
  }

  setCache(cacheKey, files);
  return files;
}

/** 下载并提取 SKILL.md 内容（用于预览） */
export async function fetchSkillContent(owner: string, repo: string, skill: string): Promise<string> {
  const files = await fetchSkillAllFiles(owner, repo, skill);
  return files.get('SKILL.md')!.toString('utf-8');
}
