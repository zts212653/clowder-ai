import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { CatId } from '@cat-cafe/shared';
import { createModuleLogger } from '../../../../../../../infrastructure/logger.js';
import type { AgentMessage, MessageMetadata } from '../../../../types.js';
import type { AgyStreamJsonTurn } from '../../agy-stream-json-parser.js';
import { publishGeneratedImage } from '../../generated-image-publication.js';
import type { AgyNativeObservedTurn } from './agy-native-stream.js';

const log = createModuleLogger('agy-native-images');
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as const;
type NativeToolCall = AgyStreamJsonTurn['toolCalls'][number];

/** Only completed native generation admits a current-session image to F172. */
export class AgyNativeImagePublisher {
  private readonly since = Date.now();
  private readonly settled = new Map<string, boolean>();

  constructor(
    private readonly catId: CatId,
    private readonly metadata: MessageMetadata,
    private readonly profileHome: string,
    private readonly declaredTools: readonly string[],
    private readonly uploadDir?: string,
  ) {}

  async settle(observed: AgyNativeObservedTurn): Promise<{
    messages: AgentMessage[];
    observed: AgyNativeObservedTurn;
  }> {
    const messages: AgentMessage[] = [];
    let hasImageOutput = false;
    if (this.declaredTools.includes('generate_image')) {
      for (const call of observed.turn.toolCalls) {
        if (call.toolName !== 'generate_image' || call.state !== 'DONE' || call.errorMessage !== null) continue;
        const key = `${observed.sessionId}:${call.stepIndex}`;
        if (!this.settled.has(key)) messages.push(...(await this.settleCall(observed.sessionId, call, key)));
        hasImageOutput ||= this.settled.get(key) === true;
      }
    }
    // Like a completed compaction, a published image is usable output even when
    // result.response is empty. Never erase a denial, protocol or transport error.
    const imageOnlySuccess =
      hasImageOutput &&
      observed.turn.outcome === 'empty' &&
      observed.turn.upstreamStatus === 'SUCCESS' &&
      !observed.transportError &&
      !observed.cancelledBeforeTerminal;
    return {
      messages,
      observed: imageOnlySuccess ? { ...observed, turn: { ...observed.turn, outcome: 'ok' } } : observed,
    };
  }

  private async settleCall(sessionId: string, call: NativeToolCall, key: string): Promise<AgentMessage[]> {
    try {
      const images = await this.publishCall(sessionId, call);
      this.settled.set(key, images.length > 0);
      if (images.length === 0) return [this.warning(key)];
      return images
        .filter((image) => image.isNew)
        .map((image) => ({
          type: 'system_info',
          catId: this.catId,
          metadata: this.metadata,
          timestamp: Date.now(),
          content: JSON.stringify({ type: 'rich_block', block: image.richBlock, provenance: image.provenance }),
        }));
    } catch (error) {
      log.warn({ sessionId, stepIndex: call.stepIndex, error }, 'Native image publication failed');
      this.settled.set(key, false);
      return [this.warning(key)];
    }
  }

  private async publishCall(sessionId: string, call: NativeToolCall) {
    const imageName = call.parameters.ImageName;
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId) ||
      typeof imageName !== 'string' ||
      !imageName.trim() ||
      imageName.length > 200 ||
      /[/\\\0]/.test(imageName) ||
      imageName === '.' ||
      imageName === '..'
    )
      return [];
    const directory = join(this.profileHome, '.gemini/antigravity-cli/brain', sessionId);
    // A native result cannot redirect the reader outside its verified profile.
    if ((await realpath(directory)) !== directory) throw new Error('Native image directory was redirected');
    const escapedName = imageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedName}_(\\d+)\\.(png|jpe?g|webp|gif)$`, 'i');
    const results = [];
    for (const filename of await readdir(directory)) {
      const match = pattern.exec(filename);
      const extension = match?.[2]?.toLowerCase();
      const mimeType = extension ? MIME[extension as keyof typeof MIME] : undefined;
      if (!match || !mimeType || Number(match[1]) < this.since) continue;
      const sourcePath = join(directory, filename);
      const stat = await lstat(sourcePath);
      if (!stat.isFile() || stat.nlink !== 1 || stat.mtimeMs < this.since) continue;
      results.push(
        await publishGeneratedImage({
          sourcePath,
          mimeType,
          publicationKey: `antigravity-native-${sessionId}-${filename}`,
          provider: 'antigravity',
          toolName: 'generate_image',
          uploadDir: this.uploadDir,
          title: 'antigravity:generate_image',
          alt: 'generated image',
        }),
      );
    }
    return results;
  }

  private warning(key: string): AgentMessage {
    const timestamp = Date.now();
    return {
      type: 'system_info',
      catId: this.catId,
      metadata: this.metadata,
      timestamp,
      semanticEvent: {
        v: 1,
        id: `agy-image-publication:${key}`,
        kind: 'warning',
        occurredAt: timestamp,
        provenance: { provider: 'google', carrier: 'native', nativeType: 'generate_image' },
        category: 'warning',
        severity: 'warning',
        message: '图片生成步骤已完成，但自动发布未成功；原图尚未作为聊天图片交付。',
      },
    };
  }
}
