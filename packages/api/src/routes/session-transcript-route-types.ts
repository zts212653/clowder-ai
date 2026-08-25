import type { FastifyPluginOptions } from 'fastify';
import type { FileProfileRepository } from '../domains/cats/services/profile/ProfileRepository.js';
import type { TranscriptReader } from '../domains/cats/services/session/TranscriptReader.js';
import type { TranscriptWriter } from '../domains/cats/services/session/TranscriptWriter.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import type { MemoryCueSourceReader } from '../domains/memory/cue/MemoryCueSourceReader.js';

export interface SessionTranscriptRouteOptions extends FastifyPluginOptions {
  sessionChainStore: ISessionChainStore;
  invocationRecordStore: Pick<IInvocationRecordStore, 'get'>;
  threadStore: IThreadStore;
  transcriptReader: TranscriptReader;
  transcriptWriter?: TranscriptWriter;
  messageStore?: Pick<IMessageStore, 'getById'>;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
  profileRepository?: Pick<FileProfileRepository, 'readCapsule' | 'scope' | 'readPrimer'>;
  memoryCueSourceReader?: MemoryCueSourceReader;
}

export interface ReadableSession {
  id: string;
  threadId: string;
  catId: string;
  cliSessionId?: string;
  seq: number;
  status: string;
}
