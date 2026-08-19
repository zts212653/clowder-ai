/**
 * Weixin-MP invoke handlers — platform-specific logic for commands
 * that cannot be expressed as pure REST calls in YAML.
 */
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import type { InvokeContext, InvokeHandler } from '../../domains/limb/PluginLimbAdapter.js';
import { fetchExternalUrlPinned } from '../../utils/url-safety.js';
import { markdownToWxHtml } from './markdown-to-wx-html.js';

const TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_READ_BYTES = 2 * 1024 * 1024; // 2 MB text read limit
let wxConvertedOutputSequence = 0;

function createWxConvertedOutputPath(): string {
  wxConvertedOutputSequence = (wxConvertedOutputSequence + 1) % 1_000_000;
  return join(tmpdir(), `wx-converted-${Date.now()}${process.hrtime.bigint()}${wxConvertedOutputSequence}.html`);
}

/**
 * Validate that a file path resolves to an allowed directory.
 * Prevents path traversal and symlink escapes.
 */
export async function validateFilePath(
  filePath: string,
  allowedRoots: readonly string[],
  label: string,
): Promise<string> {
  const abs = resolve(filePath);
  let resolved: string;
  try {
    resolved = await realpath(abs);
  } catch {
    // File doesn't exist yet (write case) — resolve parent dir
    const parent = resolve(abs, '..');
    const parentReal = await realpath(parent).catch(() => {
      throw new Error(`${label}: parent directory does not exist: ${parent}`);
    });
    resolved = join(parentReal, abs.slice(abs.lastIndexOf('/') + 1));
  }
  const under = allowedRoots.some((root) => resolved.startsWith(root + '/') || resolved === root);
  if (!under) {
    throw new Error(`${label}: path escapes allowed roots: ${resolved}`);
  }
  return resolved;
}

/**
 * Resolve allowed read roots — restricted to tmpdir only.
 * process.cwd() is intentionally excluded: it contains app config, .env,
 * source code, and runtime data that should never be exfiltrable via
 * WeChat upload commands. Content must be placed in tmpdir first.
 */
async function getAllowedReadRoots(): Promise<string[]> {
  return Promise.all([tmpdir()].map((d) => realpath(resolve(d))));
}

/** Resolve allowed write roots — restricted to temp/export directory. */
async function getAllowedWriteRoots(): Promise<string[]> {
  return Promise.all([tmpdir()].map((d) => realpath(resolve(d))));
}
const BASE = 'https://api.weixin.qq.com/cgi-bin';

const EXTENSION_MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

export interface WeixinMpHandlerDeps {
  fetchExternalUrlPinned?: typeof fetchExternalUrlPinned;
  uploadFormData?: typeof uploadFormData;
  /** Read text files (markdown, HTML) — enforces MAX_TEXT_READ_BYTES (2 MB). */
  readLocalFile?: (filePath: string) => Promise<Buffer>;
  /** Read image files — enforces MAX_IMAGE_BYTES (10 MB). */
  readLocalImageFile?: (filePath: string) => Promise<Buffer>;
  jsonPost?: (url: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  writeLocalFile?: (filePath: string, content: string) => Promise<void>;
  /** Override for testing; production uses validateFilePath. */
  validatePath?: typeof validateFilePath;
}

// ─── Utilities ──────────────────────────────────────────────

function deriveImageMeta(contentType: string, baseName = 'image'): { mimeType: string; fileName: string } {
  const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    throw new Error(`Expected image content-type, got: ${contentType}`);
  }
  const subtype = mimeType.slice('image/'.length);
  const ext = subtype === 'jpeg' ? 'jpg' : subtype.split('+', 1)[0];
  const safeExt = /^[a-z0-9]+$/.test(ext) ? ext : 'img';
  return { mimeType, fileName: `${baseName}.${safeExt}` };
}

async function uploadFormData(url: string, blob: Blob, fileName: string): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append('media', blob, fileName);
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Upload request failed: HTTP ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

class WeixinApiError extends Error {
  constructor(
    readonly errcode: number,
    readonly errmsg: string,
  ) {
    super(`WeChat API error: ${errcode} ${errmsg}`);
    this.name = 'WeixinApiError';
  }
}

function checkWeixinResponse(data: Record<string, unknown>): void {
  const errcode = data.errcode;
  if (typeof errcode === 'number' && errcode !== 0) {
    throw new WeixinApiError(errcode, (data.errmsg as string | undefined) ?? '');
  }
}

/** Call WeChat API with automatic token-expired retry. */
async function withTokenRetry(
  ctx: InvokeContext,
  path: string,
  perform: (url: string) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const buildUrl = async () => {
    const token = await ctx.tokenManager.getAccessToken();
    const sep = path.includes('?') ? '&' : '?';
    return `${BASE}${path}${sep}access_token=${encodeURIComponent(token)}`;
  };
  const call = async () => {
    const data = await perform(await buildUrl());
    checkWeixinResponse(data);
    return data;
  };
  try {
    return await call();
  } catch (err) {
    if (err instanceof WeixinApiError && ctx.tokenManager.isTokenExpiredError(err.errcode)) {
      await ctx.tokenManager.invalidateAccessToken();
      return call();
    }
    throw err;
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/** Resolve image URI — HTTP(S) URL or local file path — into a Blob for WeChat upload. */
async function resolveImageSource(
  uri: string,
  deps: Required<WeixinMpHandlerDeps>,
  baseName = 'image',
): Promise<{ blob: Blob; fileName: string }> {
  if (isHttpUrl(uri)) {
    const imgRes = await deps.fetchExternalUrlPinned(uri, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES });
    const meta = deriveImageMeta(imgRes.contentType, baseName);
    return { blob: new Blob([imgRes.body], { type: meta.mimeType }), fileName: meta.fileName };
  }
  // Use image-specific reader (10 MB limit) instead of text reader (2 MB limit)
  const buffer = await deps.readLocalImageFile(uri);
  const ext = extname(uri).slice(1).toLowerCase();
  const mimeType = EXTENSION_MIME_MAP[ext];
  if (!mimeType) throw new Error(`Unsupported image extension: .${ext}`);
  return {
    blob: new Blob([buffer], { type: mimeType }),
    fileName: `${baseName}.${ext === 'jpeg' ? 'jpg' : ext}`,
  };
}

/** Read text content from either an inline param or a local file path. */
async function resolveTextContent(
  inline: string | undefined,
  filePath: string | undefined,
  readFn: (fp: string) => Promise<Buffer>,
): Promise<string | undefined> {
  if (filePath) return (await readFn(filePath)).toString('utf-8');
  return inline;
}

// ─── Handlers ───────────────────────────────────────────────

export function createWeixinMpHandlers(deps: WeixinMpHandlerDeps = {}): Record<string, InvokeHandler> {
  const validate = deps.validatePath ?? validateFilePath;
  const resolvedDeps: Required<WeixinMpHandlerDeps> = {
    fetchExternalUrlPinned,
    uploadFormData,
    readLocalFile: async (fp: string) => {
      const safe = await validate(fp, await getAllowedReadRoots(), 'readLocalFile');
      const info = await stat(safe);
      if (info.size > MAX_TEXT_READ_BYTES) {
        throw new Error(`readLocalFile: file too large (${info.size} bytes, limit ${MAX_TEXT_READ_BYTES})`);
      }
      return readFile(safe);
    },
    readLocalImageFile: async (fp: string) => {
      const safe = await validate(fp, await getAllowedReadRoots(), 'readLocalImageFile');
      const info = await stat(safe);
      if (info.size > MAX_IMAGE_BYTES) {
        throw new Error(`readLocalImageFile: file too large (${info.size} bytes, limit ${MAX_IMAGE_BYTES})`);
      }
      return readFile(safe);
    },
    jsonPost: async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Request failed: HTTP ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    },
    writeLocalFile: async (fp, content) => {
      const safe = await validate(fp, await getAllowedWriteRoots(), 'writeLocalFile');
      await writeFile(safe, content, 'utf-8');
    },
    validatePath: validate,
    ...deps,
  };

  const convertMarkdown: InvokeHandler = async (params) => {
    const markdown = await resolveTextContent(
      params.markdown as string | undefined,
      params.markdownFilePath as string | undefined,
      resolvedDeps.readLocalFile,
    );
    if (!markdown) return { success: false, error: 'markdown or markdownFilePath is required' };
    const html = markdownToWxHtml(markdown);
    // Always write to controlled temp directory — never derive output from input path
    const outputPath = createWxConvertedOutputPath();
    await resolvedDeps.writeLocalFile(outputPath, html);
    return { success: true, data: { filePath: outputPath } };
  };

  const uploadImage: InvokeHandler = async (params, ctx) => {
    const fileLocation = params.fileLocation as string | undefined;
    if (!fileLocation) return { success: false, error: 'fileLocation is required' };
    const source = await resolveImageSource(fileLocation, resolvedDeps);
    const data = await withTokenRetry(ctx, '/media/uploadimg', (url) =>
      resolvedDeps.uploadFormData(url, source.blob, source.fileName),
    );
    if (!data.url) throw new Error('Upload returned no url');
    return { success: true, data: { url: data.url } };
  };

  const uploadMaterial: InvokeHandler = async (params, ctx) => {
    const fileLocation = params.fileLocation as string | undefined;
    if (!fileLocation) return { success: false, error: 'fileLocation is required' };
    const source = await resolveImageSource(fileLocation, resolvedDeps, 'cover');
    const data = await withTokenRetry(ctx, '/material/add_material?type=image', (url) =>
      resolvedDeps.uploadFormData(url, source.blob, source.fileName),
    );
    if (!data.media_id) throw new Error('Material upload returned no media_id');
    return { success: true, data: { mediaId: data.media_id, url: data.url ?? '' } };
  };

  const createDraft: InvokeHandler = async (params, ctx) => {
    const content = await resolveTextContent(
      params.content as string | undefined,
      params.contentFilePath as string | undefined,
      resolvedDeps.readLocalFile,
    );
    if (!content) return { success: false, error: 'content or contentFilePath is required' };
    const title = params.title as string;
    const thumbMediaId = params.thumbMediaId as string;
    if (!title || !thumbMediaId) {
      return { success: false, error: 'title and thumbMediaId are required' };
    }
    const body = {
      articles: [
        {
          title,
          content,
          thumb_media_id: thumbMediaId,
          show_cover_pic: 1,
          ...(params.author ? { author: params.author } : {}),
          ...(params.digest ? { digest: params.digest } : {}),
        },
      ],
    };
    const data = await withTokenRetry(ctx, '/draft/add', (url) => resolvedDeps.jsonPost(url, body));
    if (!data.media_id) throw new Error('Draft creation returned no media_id');
    return { success: true, data: { mediaId: data.media_id } };
  };

  const updateDraft: InvokeHandler = async (params, ctx) => {
    const mediaId = params.mediaId as string;
    if (!mediaId) return { success: false, error: 'mediaId is required' };
    const content = await resolveTextContent(
      params.content as string | undefined,
      params.contentFilePath as string | undefined,
      resolvedDeps.readLocalFile,
    );
    const articles: Record<string, unknown> = {};
    if (params.title) articles.title = params.title;
    if (content) articles.content = content;
    if (params.thumbMediaId) articles.thumb_media_id = params.thumbMediaId;
    if (params.author) articles.author = params.author;
    if (params.digest) articles.digest = params.digest;
    if (Object.keys(articles).length === 0) {
      return { success: false, error: 'At least one field to update is required' };
    }
    const body = {
      media_id: mediaId,
      index: (params.index as number | undefined) ?? 0,
      articles,
    };
    await withTokenRetry(ctx, '/draft/update', (url) => resolvedDeps.jsonPost(url, body));
    return { success: true, data: { mediaId } };
  };

  const checkStatus: InvokeHandler = async (_params, ctx) => {
    const appId = ctx.pluginConfig.WEIXIN_MP_APP_ID;
    const appSecret = ctx.pluginConfig.WEIXIN_MP_APP_SECRET;
    if (!appId || !appSecret) {
      return { success: true, data: { status: 'not_configured' } };
    }
    try {
      await ctx.tokenManager.getAccessToken();
      return { success: true, data: { status: 'connected' } };
    } catch (e) {
      return {
        success: true,
        data: { status: 'error', message: e instanceof Error ? e.message : String(e) },
      };
    }
  };

  return {
    'weixin-mp:check_status': checkStatus,
    'weixin-mp:convert_markdown': convertMarkdown,
    'weixin-mp:create_draft': createDraft,
    'weixin-mp:update_draft': updateDraft,
    'weixin-mp:upload_image': uploadImage,
    'weixin-mp:upload_material': uploadMaterial,
  };
}

// ─── Handler registry ───────────────────────────────────────

export const weixinMpHandlers: Record<string, InvokeHandler> = createWeixinMpHandlers();
