import type { WeixinMpTokenManager } from './weixin-mp-token.js';

const BASE = 'https://api.weixin.qq.com/cgi-bin';
const TIMEOUT = 30_000;

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

export interface ArticleInput {
  readonly title: string;
  readonly content: string;
  readonly author?: string;
  readonly thumb_media_id: string;
  readonly digest?: string;
}

async function wxPost<T extends WxApiResponse>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const data = (await res.json()) as T;
  if (data.errcode && data.errcode !== 0) {
    throw new Error(`WeChat API error: ${data.errcode} ${data.errmsg ?? ''}`);
  }
  return data;
}

export class WeixinMpClient {
  constructor(private readonly tokenMgr: WeixinMpTokenManager) {}

  async uploadArticleImage(imageUrl: string): Promise<string> {
    const token = await this.tokenMgr.getAccessToken();
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(TIMEOUT) });
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const ext = imageUrl.match(/\.(jpe?g|png|gif|bmp)$/i)?.[1]?.toLowerCase() ?? 'png';
    const blob = new Blob([buf], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });

    const form = new FormData();
    form.append('media', blob, `image.${ext}`);

    const res = await fetch(`${BASE}/media/uploadimg?access_token=${token}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const data = (await res.json()) as UploadImgResponse;
    if (!data.url) throw new Error(`Upload failed: ${data.errcode ?? 'no url'} ${data.errmsg ?? ''}`);
    return data.url;
  }

  async addMaterial(imageUrl: string): Promise<{ mediaId: string; url: string }> {
    const token = await this.tokenMgr.getAccessToken();
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(TIMEOUT) });
    const blob = await imgRes.blob();

    const form = new FormData();
    form.append('media', blob, 'cover.png');

    const res = await fetch(`${BASE}/material/add_material?access_token=${token}&type=image`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const data = (await res.json()) as AddMaterialResponse;
    if (!data.media_id) throw new Error(`Material upload failed: ${data.errcode ?? 'no id'} ${data.errmsg ?? ''}`);
    return { mediaId: data.media_id, url: data.url ?? '' };
  }

  async createDraft(articles: readonly ArticleInput[]): Promise<string> {
    const token = await this.tokenMgr.getAccessToken();
    const data = await wxPost<DraftAddResponse>(`${BASE}/draft/add?access_token=${token}`, { articles });
    if (!data.media_id) throw new Error('Draft creation failed: no media_id returned');
    return data.media_id;
  }

  async publishDraft(mediaId: string): Promise<string> {
    const token = await this.tokenMgr.getAccessToken();
    const data = await wxPost<PublishResponse>(`${BASE}/freepublish/submit?access_token=${token}`, {
      media_id: mediaId,
    });
    if (!data.publish_id) throw new Error('Publish failed: no publish_id returned');
    return data.publish_id;
  }

  async getPublishStatus(publishId: string): Promise<PublishStatusResponse> {
    const token = await this.tokenMgr.getAccessToken();
    return wxPost<PublishStatusResponse>(`${BASE}/freepublish/get?access_token=${token}`, {
      publish_id: publishId,
    });
  }

  async listDrafts(offset = 0, count = 10): Promise<DraftListResponse> {
    const token = await this.tokenMgr.getAccessToken();
    return wxPost<DraftListResponse>(`${BASE}/draft/batchget?access_token=${token}`, {
      offset,
      count,
      no_content: 1,
    });
  }
}
