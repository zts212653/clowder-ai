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
}

const TYPE_TO_EXT: Record<string, string> = {
  image: '.jpg',
  audio: '.ogg',
  file: '.bin',
};

/**
 * F240: All connectors register download functions via registerDownloadFn().
 * Per-connector setter methods have been removed — plugins use the unified registry.
 */
export class ConnectorMediaService {
  private readonly downloadFns = new Map<
    string,
    (platformKey: string, type: string, messageId?: string) => Promise<Buffer>
  >();

  constructor(private readonly opts: ConnectorMediaServiceOptions) {}

  /**
   * Register a download function for a connector plugin.
   * Called by the bootstrap during plugin initialization.
   */
  registerDownloadFn(
    connectorId: string,
    fn: (platformKey: string, type: string, messageId?: string) => Promise<Buffer>,
  ): void {
    this.downloadFns.set(connectorId, fn);
  }

  /** Remove a download function (called during connector deactivation). */
  unregisterDownloadFn(connectorId: string): void {
    this.downloadFns.delete(connectorId);
  }

  async download(connectorId: string, attachment: MediaAttachment): Promise<DownloadedMedia> {
    await mkdir(this.opts.mediaDir, { recursive: true });

    const dl = this.downloadFns.get(connectorId);
    if (!dl) {
      throw new Error(`No download function for connector: ${connectorId}`);
    }

    const buffer = await dl(attachment.platformKey, attachment.type, attachment.messageId);

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
