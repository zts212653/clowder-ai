import { basename, dirname } from 'node:path';
import type { TurnExecutionRecord } from '@cat-cafe/shared';
import { CliRawArchive } from '../../session/CliRawArchive.js';
import {
  type CodexNativeImageOrigin,
  type CodexNativeImageSource,
  codexImageOriginEnvelope,
  codexNativeImageOutputs,
} from './codex-native-image-origin.js';

export interface ProvenCodexImage {
  sourcePath: string;
  codexHome: string;
  origin: CodexNativeImageOrigin;
  nativeSource: CodexNativeImageSource;
}

/** Reads only a canonical child owner's native archive. Gallery metadata cannot nominate an archive path. */
export class CodexNativeImageEvidenceReader {
  private readonly archive: CliRawArchive;
  constructor(archiveDirectory?: string) {
    this.archive = new CliRawArchive(archiveDirectory ? { archiveDir: archiveDirectory } : undefined);
  }

  async read(child: TurnExecutionRecord): Promise<ProvenCodexImage[]> {
    // Generation proof is independent of whole-turn completion. A Host crash must not lose the output;
    // running writers and explicit cancellation remain stop boundaries.
    if (
      child.status === 'running' ||
      child.status === 'canceled' ||
      child.endedAt === undefined ||
      !/^[\w-]+$/.test(child.invocationId)
    )
      return [];
    const envelopes: unknown[] = [];
    const sessions = new Set<string>();
    const first = new Date(child.startedAt);
    first.setHours(0, 0, 0, 0);
    const last = new Date(child.endedAt);
    last.setHours(0, 0, 0, 0);
    for (const date = first; date <= last; date.setDate(date.getDate() + 1)) {
      for await (const line of this.archive.readLines(child.invocationId, date)) {
        let entry: { payload?: { transport?: string; direction?: string; envelope?: Record<string, unknown> } };
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const raw = entry.payload;
        if (raw?.transport !== 'codex_app_server' || !raw.envelope || !raw.direction) continue;
        const projected = codexImageOriginEnvelope(raw.direction, raw.envelope);
        if (!projected) continue;
        envelopes.push(projected);
        const params = raw.envelope.params;
        if (
          raw.direction === 'outbound' &&
          raw.envelope.method === 'turn/start' &&
          params &&
          typeof params === 'object' &&
          'threadId' in params &&
          typeof params.threadId === 'string'
        )
          sessions.add(params.threadId);
      }
    }
    const nativeSource = { invocationId: child.invocationId, envelopes };
    return [...sessions].flatMap((sessionId) =>
      codexNativeImageOutputs(nativeSource, sessionId).flatMap((output) => {
        const directory = dirname(output.sourcePath);
        if (basename(directory) !== sessionId || basename(dirname(directory)) !== 'generated_images') return [];
        return [{ ...output, codexHome: dirname(dirname(directory)), nativeSource }];
      }),
    );
  }
}
