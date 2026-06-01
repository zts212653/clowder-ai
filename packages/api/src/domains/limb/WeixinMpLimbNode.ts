import type { ILimbNode, LimbCapability, LimbInvokeResult, LimbNodeStatus } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { markdownToWxHtml } from '../weixin-mp/markdown-to-wx-html.js';
import { WeixinMpClient } from '../weixin-mp/weixin-mp-client.js';
import { WeixinMpTokenManager } from '../weixin-mp/weixin-mp-token.js';

export interface WeixinMpLimbConfig {
  capabilities: LimbCapability[];
  redis?: RedisClient;
  pluginConfig: Record<string, string>;
}

const WEIXIN_INLINE_IMAGE_HOSTS = new Set(['mmbiz.qpic.cn']);

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function isWeixinInlineImageUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    return WEIXIN_INLINE_IMAGE_HOSTS.has(hostname) || hostname.endsWith('.mmbiz.qpic.cn');
  } catch {
    return false;
  }
}

function removeFencedCodeBlocks(markdown: string): string {
  const lines = markdown.split('\n');
  const visibleLines: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) visibleLines.push(line);
  }

  return visibleLines.join('\n');
}

function findExternalInlineImageUrls(markdown: string): string[] {
  const markdownLinkPattern = /!\[[^\]]*\]\(([^)]+)\)/g;
  const urls = new Set<string>();
  const visibleMarkdown = removeFencedCodeBlocks(markdown);
  let match: RegExpExecArray | null;

  while ((match = markdownLinkPattern.exec(visibleMarkdown)) !== null) {
    const url = match[1]?.trim();
    if (!url || !isHttpUrl(url) || isWeixinInlineImageUrl(url)) continue;
    urls.add(url);
  }

  return [...urls];
}

export class WeixinMpLimbNode implements ILimbNode {
  readonly nodeId = 'weixin-mp';
  readonly displayName = '微信公众号';
  readonly platform = 'weixin';
  readonly capabilities: LimbCapability[];

  private readonly tokenMgr: WeixinMpTokenManager;
  private readonly client: WeixinMpClient;
  private readonly pluginConfig: Record<string, string>;

  constructor(config: WeixinMpLimbConfig) {
    this.capabilities = config.capabilities;
    this.pluginConfig = config.pluginConfig;
    this.tokenMgr = new WeixinMpTokenManager(config.redis, this.pluginConfig);
    this.client = new WeixinMpClient(this.tokenMgr);
  }

  async register(): Promise<void> {}

  async deregister(): Promise<void> {}

  async invoke(command: string, params: Record<string, unknown>): Promise<LimbInvokeResult> {
    try {
      switch (command) {
        case 'weixin_mp.check_status':
          return await this.checkStatusCmd();
        case 'weixin_mp.publish_article':
          return await this.publishArticle(params);
        case 'weixin_mp.upload_image':
          return await this.uploadImage(params);
        case 'weixin_mp.list_drafts':
          return await this.listDrafts(params);
        case 'weixin_mp.publish_status':
          return await this.getPublishStatus(params);
        default:
          return { success: false, error: `Unknown command: ${command}` };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async healthCheck(): Promise<LimbNodeStatus> {
    const configured = !!(this.pluginConfig['WEIXIN_MP_APP_ID'] && this.pluginConfig['WEIXIN_MP_APP_SECRET']);
    if (!configured) return 'offline';
    try {
      await this.tokenMgr.getAccessToken();
      return 'online';
    } catch {
      return 'degraded';
    }
  }

  private async checkStatusCmd(): Promise<LimbInvokeResult> {
    const configured = !!(this.pluginConfig['WEIXIN_MP_APP_ID'] && this.pluginConfig['WEIXIN_MP_APP_SECRET']);
    if (!configured) {
      return { success: true, data: { status: 'not_configured' } };
    }
    try {
      await this.tokenMgr.getAccessToken();
      return { success: true, data: { status: 'connected' } };
    } catch (e) {
      return { success: true, data: { status: 'error', message: e instanceof Error ? e.message : String(e) } };
    }
  }

  private async publishArticle(params: Record<string, unknown>): Promise<LimbInvokeResult> {
    const title = params['title'] as string | undefined;
    const markdown = params['markdown'] as string | undefined;
    if (!title || !markdown) {
      return { success: false, error: 'title and markdown are required' };
    }

    const author = params['author'] as string | undefined;
    const digest = params['digest'] as string | undefined;
    const coverImageUrl = params['coverImageUrl'] as string | undefined;
    let thumbMediaId = params['thumbMediaId'] as string | undefined;
    const publish = params['publish'] === true;

    const externalInlineImageUrls = findExternalInlineImageUrls(markdown);
    if (externalInlineImageUrls.length > 0) {
      return {
        success: false,
        error: [
          'Article body contains external inline image URLs that WeChat may filter.',
          'Upload inline images with weixin_mp.upload_image first and replace them with returned WeChat CDN URLs.',
          `External image URLs: ${externalInlineImageUrls.slice(0, 3).join(', ')}`,
        ].join(' '),
      };
    }

    const htmlContent = markdownToWxHtml(markdown);

    if (!thumbMediaId && coverImageUrl) {
      const material = await this.client.addMaterial(coverImageUrl);
      thumbMediaId = material.mediaId;
    }
    if (!thumbMediaId) {
      return { success: false, error: 'Either thumbMediaId or coverImageUrl is required for the cover image' };
    }

    const draftMediaId = await this.client.createDraft([
      { title, content: htmlContent, author, digest, thumb_media_id: thumbMediaId, show_cover_pic: 1 },
    ]);
    const result: Record<string, unknown> = { draftMediaId };

    if (publish) {
      const publishId = await this.client.publishDraft(draftMediaId);
      result['publishId'] = publishId;
    }

    return { success: true, data: result };
  }

  private async uploadImage(params: Record<string, unknown>): Promise<LimbInvokeResult> {
    const imageUrl = params['imageUrl'] as string | undefined;
    if (!imageUrl) {
      return { success: false, error: 'imageUrl is required' };
    }
    const url = await this.client.uploadArticleImage(imageUrl);
    return { success: true, data: { url } };
  }

  private async listDrafts(params: Record<string, unknown>): Promise<LimbInvokeResult> {
    const offset = (params['offset'] as number | undefined) ?? 0;
    const count = (params['count'] as number | undefined) ?? 10;
    const data = await this.client.listDrafts(offset, count);
    return { success: true, data };
  }

  private async getPublishStatus(params: Record<string, unknown>): Promise<LimbInvokeResult> {
    const publishId = params['publishId'] as string | undefined;
    if (!publishId) {
      return { success: false, error: 'publishId is required' };
    }
    const data = await this.client.getPublishStatus(publishId);
    return { success: true, data };
  }
}
