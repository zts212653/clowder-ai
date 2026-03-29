import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface MediaAttachment {
  type: 'image' | 'file' | 'audio';
  platformKey: string;
  fileName?: string;
  duration?: number;
  /** Feishu requires the original message_id to download message resources. */
  messageId?: string;
}

export interface DownloadedMedia {
  localUrl: string;
  absPath: string;
  mimeType: string;
  originalFileName?: string;
}

export interface ConnectorMediaServiceOptions {
  mediaDir: string;
  feishuDownloadFn?: (key: string, type: string, messageId?: string) => Promise<Buffer>;
  telegramDownloadFn?: (fileId: string) => Promise<Buffer>;
  dingtalkDownloadFn?: (downloadCode: string) => Promise<Buffer>;
  weixinDownloadFn?: (platformKey: string) => Promise<Buffer>;
  wecomBotDownloadFn?: (url: string, aesKey?: string) => Promise<Buffer>;
  wecomAgentDownloadFn?: (mediaId: string) => Promise<Buffer>;
}

const TYPE_TO_EXT: Record<string, string> = {
  image: '.jpg',
  audio: '.ogg',
  file: '.bin',
};

export class ConnectorMediaService {
  private feishuDl: ConnectorMediaServiceOptions['feishuDownloadFn'];
  private telegramDl: ConnectorMediaServiceOptions['telegramDownloadFn'];
  private dingtalkDl: ConnectorMediaServiceOptions['dingtalkDownloadFn'];
  private weixinDl: ConnectorMediaServiceOptions['weixinDownloadFn'];
  private wecomBotDl: ConnectorMediaServiceOptions['wecomBotDownloadFn'];
  private wecomAgentDl: ConnectorMediaServiceOptions['wecomAgentDownloadFn'];

  constructor(private readonly opts: ConnectorMediaServiceOptions) {
    this.feishuDl = opts.feishuDownloadFn;
    this.telegramDl = opts.telegramDownloadFn;
    this.dingtalkDl = opts.dingtalkDownloadFn;
    this.weixinDl = opts.weixinDownloadFn;
    this.wecomBotDl = opts.wecomBotDownloadFn;
    this.wecomAgentDl = opts.wecomAgentDownloadFn;
  }

  setFeishuDownloadFn(fn: (key: string, type: string, messageId?: string) => Promise<Buffer>): void {
    this.feishuDl = fn;
  }

  setTelegramDownloadFn(fn: (fileId: string) => Promise<Buffer>): void {
    this.telegramDl = fn;
  }

  setDingtalkDownloadFn(fn: (downloadCode: string) => Promise<Buffer>): void {
    this.dingtalkDl = fn;
  }

  setWeixinDownloadFn(fn: (platformKey: string) => Promise<Buffer>): void {
    this.weixinDl = fn;
  }

  setWeComBotDownloadFn(fn: (url: string, aesKey?: string) => Promise<Buffer>): void {
    this.wecomBotDl = fn;
  }

  setWeComAgentDownloadFn(fn: (mediaId: string) => Promise<Buffer>): void {
    this.wecomAgentDl = fn;
  }

  async download(connectorId: string, attachment: MediaAttachment): Promise<DownloadedMedia> {
    await mkdir(this.opts.mediaDir, { recursive: true });

    let buffer: Buffer;
    if (connectorId === 'feishu' && this.feishuDl) {
      buffer = await this.feishuDl(attachment.platformKey, attachment.type, attachment.messageId);
    } else if (connectorId === 'telegram' && this.telegramDl) {
      buffer = await this.telegramDl(attachment.platformKey);
    } else if (connectorId === 'dingtalk' && this.dingtalkDl) {
      buffer = await this.dingtalkDl(attachment.platformKey);
    } else if (connectorId === 'weixin' && this.weixinDl) {
      buffer = await this.weixinDl(attachment.platformKey);
    } else if (connectorId === 'wecom-bot' && this.wecomBotDl) {
      const [url, aesKey] = attachment.platformKey.split('|aeskey=');
      buffer = await this.wecomBotDl(url, aesKey);
    } else if (connectorId === 'wecom-agent' && this.wecomAgentDl) {
      buffer = await this.wecomAgentDl(attachment.platformKey);
    } else {
      throw new Error(`No download function for connector: ${connectorId}`);
    }

    let ext: string;
    if (attachment.fileName) {
      ext = path.extname(attachment.fileName) || TYPE_TO_EXT[attachment.type] || '.bin';
    } else {
      ext = TYPE_TO_EXT[attachment.type] || '.bin';
    }

    const filename = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
    const absPath = path.resolve(path.join(this.opts.mediaDir, filename));

    await writeFile(absPath, buffer);

    return {
      localUrl: `/api/connector-media/${filename}`,
      absPath,
      mimeType: extToMime(ext),
      ...(attachment.fileName ? { originalFileName: attachment.fileName } : {}),
    };
  }
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.pdf': 'application/pdf',
    '.bin': 'application/octet-stream',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}
