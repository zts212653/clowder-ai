/**
 * Weixin-MP invoke handlers — platform-specific logic for commands
 * that cannot be expressed as pure REST calls in YAML.
 */
import type { InvokeContext, InvokeHandler } from '../../domains/limb/PluginLimbAdapter.js';
import { fetchExternalUrlPinned } from '../../utils/url-safety.js';
import { markdownToWxHtml } from './markdown-to-wx-html.js';

const TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BASE = 'https://api.weixin.qq.com/cgi-bin';

interface WeixinMpHandlerDeps {
  fetchExternalUrlPinned?: typeof fetchExternalUrlPinned;
  uploadFormData?: typeof uploadFormData;
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
  return (await res.json()) as Record<string, unknown>;
}

class WeixinUploadError extends Error {
  constructor(
    readonly errcode: number,
    readonly errmsg: string,
  ) {
    super(`Upload failed: ${errcode} ${errmsg}`);
    this.name = 'WeixinUploadError';
  }
}

function checkUploadResponse(data: Record<string, unknown>): void {
  const errcode = data.errcode;
  if (typeof errcode === 'number' && errcode !== 0) {
    throw new WeixinUploadError(errcode, (data.errmsg as string | undefined) ?? '');
  }
}

async function uploadWithTokenRetry(
  ctx: InvokeContext,
  deps: Required<WeixinMpHandlerDeps>,
  path: string,
  blob: Blob,
  fileName: string,
): Promise<Record<string, unknown>> {
  const perform = async () => {
    const token = await ctx.tokenManager.getAccessToken();
    const sep = path.includes('?') ? '&' : '?';
    const data = await deps.uploadFormData(`${BASE}${path}${sep}access_token=${token}`, blob, fileName);
    checkUploadResponse(data);
    return data;
  };

  try {
    return await perform();
  } catch (err) {
    if (err instanceof WeixinUploadError && ctx.tokenManager.isTokenExpiredError(err.errcode)) {
      await ctx.tokenManager.invalidateAccessToken();
      return perform();
    }
    throw err;
  }
}

// ─── Handlers ───────────────────────────────────────────────

export function createWeixinMpHandlers(deps: WeixinMpHandlerDeps = {}): Record<string, InvokeHandler> {
  const resolvedDeps: Required<WeixinMpHandlerDeps> = {
    fetchExternalUrlPinned,
    uploadFormData,
    ...deps,
  };

  const convertMarkdown: InvokeHandler = async (params) => {
    const markdown = params.markdown as string | undefined;
    if (!markdown) return { success: false, error: 'markdown is required' };
    const html = markdownToWxHtml(markdown);
    return { success: true, data: { html } };
  };

  const uploadImage: InvokeHandler = async (params, ctx) => {
    const imageUrl = params.imageUrl as string | undefined;
    if (!imageUrl) return { success: false, error: 'imageUrl is required' };

    const imgRes = await resolvedDeps.fetchExternalUrlPinned(imageUrl, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_IMAGE_BYTES,
    });
    const meta = deriveImageMeta(imgRes.contentType);
    const blob = new Blob([imgRes.body], { type: meta.mimeType });
    const data = await uploadWithTokenRetry(ctx, resolvedDeps, '/media/uploadimg', blob, meta.fileName);

    if (!data.url) throw new Error('Upload returned no url');
    return { success: true, data: { url: data.url } };
  };

  const uploadMaterial: InvokeHandler = async (params, ctx) => {
    const imageUrl = params.imageUrl as string | undefined;
    if (!imageUrl) return { success: false, error: 'imageUrl is required' };

    const imgRes = await resolvedDeps.fetchExternalUrlPinned(imageUrl, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_IMAGE_BYTES,
    });
    const meta = deriveImageMeta(imgRes.contentType, 'cover');
    const blob = new Blob([imgRes.body], { type: meta.mimeType });
    const data = await uploadWithTokenRetry(
      ctx,
      resolvedDeps,
      '/material/add_material?type=image',
      blob,
      meta.fileName,
    );

    if (!data.media_id) throw new Error('Material upload returned no media_id');
    return {
      success: true,
      data: { mediaId: data.media_id, url: data.url ?? '' },
    };
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
    'weixin-mp:upload_image': uploadImage,
    'weixin-mp:upload_material': uploadMaterial,
  };
}

// ─── Handler registry ───────────────────────────────────────

export const weixinMpHandlers: Record<string, InvokeHandler> = createWeixinMpHandlers();
