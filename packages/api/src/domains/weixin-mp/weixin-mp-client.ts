import { fetchExternalUrlPinned } from './url-safety.js';
import type { WeixinMpTokenManager } from './weixin-mp-token.js';

const BASE = 'https://api.weixin.qq.com/cgi-bin';
const TIMEOUT = 30_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TOKEN_AUTH_ERROR_CODES = new Set([40001, 40014, 42001]);

interface WxApiResponse {
  readonly errcode?: number;
  readonly errmsg?: string;
}

interface UploadImgResponse extends WxApiResponse {
  readonly url?: string;
}

interface AddMaterialResponse extends WxApiResponse {
  readonly media_id?: string;
  readonly url?: string;
}

interface DraftAddResponse extends WxApiResponse {
  readonly media_id?: string;
}

interface PublishResponse extends WxApiResponse {
  readonly publish_id?: string;
}

interface PublishStatusResponse extends WxApiResponse {
  readonly publish_id?: string;
  readonly publish_status?: number;
  readonly article_id?: string;
  readonly article_detail?: {
    readonly count?: number;
    readonly item?: ReadonlyArray<{ readonly article_url?: string }>;
  };
}

export interface DraftItem {
  readonly media_id: string;
  readonly content: {
    readonly news_item: ReadonlyArray<{
      readonly title: string;
      readonly author: string;
      readonly thumb_media_id: string;
      readonly url: string;
      readonly update_time: number;
    }>;
  };
  readonly update_time: number;
}

interface DraftListResponse extends WxApiResponse {
  readonly total_count?: number;
  readonly item_count?: number;
  readonly item?: readonly DraftItem[];
}

class WeixinMpApiError extends Error {
  constructor(
    readonly errcode: number,
    readonly errmsg = '',
    prefix = 'WeChat API error',
  ) {
    super(`${prefix}: ${errcode} ${errmsg}`);
    this.name = 'WeixinMpApiError';
  }
}

export interface ArticleInput {
  readonly title: string;
  readonly content: string;
  readonly author?: string;
  readonly thumb_media_id: string;
  readonly show_cover_pic: 0 | 1;
  readonly digest?: string;
}

export function deriveImageUploadMetadata(
  contentType: string,
  baseName = 'image',
): { readonly mimeType: string; readonly fileName: string } {
  const mimeType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!mimeType.startsWith('image/')) {
    throw new Error(`Expected image content-type, got: ${contentType}`);
  }

  const subtype = mimeType.slice('image/'.length);
  const normalizedSubtype = subtype === 'jpeg' ? 'jpg' : subtype.split('+', 1)[0];
  const extension = /^[a-z0-9]+$/.test(normalizedSubtype) ? normalizedSubtype : 'img';
  return { mimeType, fileName: `${baseName}.${extension}` };
}

async function readWxApiResponse<T extends WxApiResponse>(res: Response, errorPrefix?: string): Promise<T> {
  const data = (await res.json()) as T;
  if (data.errcode && data.errcode !== 0) {
    throw new WeixinMpApiError(data.errcode, data.errmsg ?? '', errorPrefix);
  }
  return data;
}

async function wxPost<T extends WxApiResponse>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  return readWxApiResponse<T>(res);
}

function isTokenAuthError(error: unknown): boolean {
  return error instanceof WeixinMpApiError && TOKEN_AUTH_ERROR_CODES.has(error.errcode);
}

export class WeixinMpClient {
  constructor(private readonly tokenMgr: WeixinMpTokenManager) {}

  private async withAccessTokenRetry<T>(request: (token: string) => Promise<T>): Promise<T> {
    const token = await this.tokenMgr.getAccessToken();
    try {
      return await request(token);
    } catch (error) {
      if (!isTokenAuthError(error)) throw error;
      await this.tokenMgr.invalidateAccessToken();
      const refreshedToken = await this.tokenMgr.getAccessToken();
      return request(refreshedToken);
    }
  }

  private wxPostWithToken<T extends WxApiResponse>(path: string, body: unknown): Promise<T> {
    return this.withAccessTokenRetry((token) => wxPost<T>(`${BASE}/${path}?access_token=${token}`, body));
  }

  async uploadArticleImage(imageUrl: string): Promise<string> {
    const imgRes = await fetchExternalUrlPinned(imageUrl, { timeoutMs: TIMEOUT, maxBytes: MAX_IMAGE_BYTES });
    const contentType = imgRes.contentType;
    const metadata = deriveImageUploadMetadata(contentType);
    const blob = new Blob([imgRes.body], { type: metadata.mimeType });

    const data = await this.withAccessTokenRetry(async (token) => {
      const form = new FormData();
      form.append('media', blob, metadata.fileName);

      const res = await fetch(`${BASE}/media/uploadimg?access_token=${token}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TIMEOUT),
      });
      return readWxApiResponse<UploadImgResponse>(res, 'Upload failed');
    });
    if (!data.url) throw new Error(`Upload failed: ${data.errcode ?? 'no url'} ${data.errmsg ?? ''}`);
    return data.url;
  }

  async addMaterial(imageUrl: string): Promise<{ mediaId: string; url: string }> {
    const imgRes = await fetchExternalUrlPinned(imageUrl, { timeoutMs: TIMEOUT, maxBytes: MAX_IMAGE_BYTES });
    const contentType = imgRes.contentType;
    const metadata = deriveImageUploadMetadata(contentType, 'cover');
    const blob = new Blob([imgRes.body], { type: metadata.mimeType });

    const data = await this.withAccessTokenRetry(async (token) => {
      const form = new FormData();
      form.append('media', blob, metadata.fileName);

      const res = await fetch(`${BASE}/material/add_material?access_token=${token}&type=image`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TIMEOUT),
      });
      return readWxApiResponse<AddMaterialResponse>(res, 'Material upload failed');
    });
    if (!data.media_id) throw new Error(`Material upload failed: ${data.errcode ?? 'no id'} ${data.errmsg ?? ''}`);
    return { mediaId: data.media_id, url: data.url ?? '' };
  }

  async createDraft(articles: readonly ArticleInput[]): Promise<string> {
    const data = await this.wxPostWithToken<DraftAddResponse>('draft/add', { articles });
    if (!data.media_id) throw new Error('Draft creation failed: no media_id returned');
    return data.media_id;
  }

  async publishDraft(mediaId: string): Promise<string> {
    const data = await this.wxPostWithToken<PublishResponse>('freepublish/submit', {
      media_id: mediaId,
    });
    if (!data.publish_id) throw new Error('Publish failed: no publish_id returned');
    return data.publish_id;
  }

  async getPublishStatus(publishId: string): Promise<PublishStatusResponse> {
    return this.wxPostWithToken<PublishStatusResponse>('freepublish/get', {
      publish_id: publishId,
    });
  }

  async listDrafts(offset = 0, count = 10): Promise<DraftListResponse> {
    return this.wxPostWithToken<DraftListResponse>('draft/batchget', {
      offset,
      count,
      no_content: 1,
    });
  }
}
