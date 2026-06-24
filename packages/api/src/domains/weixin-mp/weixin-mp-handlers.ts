/**
 * Weixin-MP invoke handlers — platform-specific logic for commands
 * that cannot be expressed as pure REST calls in YAML.
 */
import type { LimbInvokeResult } from '@cat-cafe/shared';
import { fetchExternalUrlPinned } from '../../utils/url-safety.js';
import type { InvokeContext, InvokeHandler } from '../limb/PluginLimbAdapter.js';
import { markdownToWxHtml } from './markdown-to-wx-html.js';

const TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BASE = 'https://api.weixin.qq.com/cgi-bin';

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
  const data = (await res.json()) as Record<string, unknown>;
  if (data['errcode'] && (data['errcode'] as number) !== 0) {
    throw new Error(`Upload failed: ${data['errcode']} ${data['errmsg'] ?? ''}`);
  }
  return data;
}

// ─── Handlers ───────────────────────────────────────────────

const convertMarkdown: InvokeHandler = async (params) => {
  const markdown = params['markdown'] as string | undefined;
  if (!markdown) return { success: false, error: 'markdown is required' };
  const html = markdownToWxHtml(markdown);
  return { success: true, data: { html } };
};

const uploadImage: InvokeHandler = async (params, ctx) => {
  const imageUrl = params['imageUrl'] as string | undefined;
  if (!imageUrl) return { success: false, error: 'imageUrl is required' };

  const imgRes = await fetchExternalUrlPinned(imageUrl, {
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_IMAGE_BYTES,
  });
  const meta = deriveImageMeta(imgRes.contentType);
  const blob = new Blob([imgRes.body], { type: meta.mimeType });
  const token = await ctx.tokenManager.getAccessToken();
  const data = await uploadFormData(`${BASE}/media/uploadimg?access_token=${token}`, blob, meta.fileName);

  if (!data['url']) throw new Error('Upload returned no url');
  return { success: true, data: { url: data['url'] } };
};

const uploadMaterial: InvokeHandler = async (params, ctx) => {
  const imageUrl = params['imageUrl'] as string | undefined;
  if (!imageUrl) return { success: false, error: 'imageUrl is required' };

  const imgRes = await fetchExternalUrlPinned(imageUrl, {
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_IMAGE_BYTES,
  });
  const meta = deriveImageMeta(imgRes.contentType, 'cover');
  const blob = new Blob([imgRes.body], { type: meta.mimeType });
  const token = await ctx.tokenManager.getAccessToken();
  const data = await uploadFormData(
    `${BASE}/material/add_material?access_token=${token}&type=image`,
    blob,
    meta.fileName,
  );

  if (!data['media_id']) throw new Error('Material upload returned no media_id');
  return {
    success: true,
    data: { mediaId: data['media_id'], url: data['url'] ?? '' },
  };
};

const checkStatus: InvokeHandler = async (_params, ctx) => {
  const appId = ctx.pluginConfig['WEIXIN_MP_APP_ID'];
  const appSecret = ctx.pluginConfig['WEIXIN_MP_APP_SECRET'];
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

// ─── Handler registry ───────────────────────────────────────

export const weixinMpHandlers: Record<string, InvokeHandler> = {
  'weixin-mp:check_status': checkStatus,
  'weixin-mp:convert_markdown': convertMarkdown,
  'weixin-mp:upload_image': uploadImage,
  'weixin-mp:upload_material': uploadMaterial,
};
