import { generateId } from './ids.js';

export type MeetingStatus = 'active' | 'paused' | 'ended';
export type ParticipantRole = 'host' | 'participant';

export interface MeetingParticipant {
  id: string;
  name: string;
  role?: ParticipantRole;
  speakerEmbeddingId?: string;
}

export interface MeetingSession {
  meetingId: string;
  threadId: string;
  startedAt: number;
  participants: MeetingParticipant[];
  status: MeetingStatus;
}

const VALID_ROLES: ReadonlySet<string> = new Set(['host', 'participant']);

const VALID_TRANSITIONS: Record<MeetingStatus, ReadonlySet<MeetingStatus>> = {
  active: new Set(['paused', 'ended']),
  paused: new Set(['active', 'ended']),
  ended: new Set(),
};

export function validateParticipant(input: {
  id: string;
  name: string;
  role?: string;
  speakerEmbeddingId?: string;
}): MeetingParticipant {
  if (!input.id) throw new Error('Participant id is required');
  if (!input.name) throw new Error('Participant name is required');
  if (input.role !== undefined && !VALID_ROLES.has(input.role)) {
    throw new Error(`Invalid role "${input.role}"; must be host or participant`);
  }
  return {
    id: input.id,
    name: input.name,
    role: input.role as ParticipantRole | undefined,
    speakerEmbeddingId: input.speakerEmbeddingId,
  };
}

export function createMeetingSession(input: {
  threadId: string;
  participants: Array<{ id: string; name: string; role?: string; speakerEmbeddingId?: string }>;
}): MeetingSession {
  if (!input.threadId) throw new Error('threadId is required');
  return {
    meetingId: generateId('mtg'),
    threadId: input.threadId,
    startedAt: Date.now(),
    participants: input.participants.map(validateParticipant),
    status: 'active',
  };
}

export function transitionMeetingStatus(session: MeetingSession, target: MeetingStatus): MeetingSession {
  const allowed = VALID_TRANSITIONS[session.status];
  if (!allowed.has(target)) {
    throw new Error(`Cannot transition from "${session.status}" to "${target}"; ended sessions cannot be restarted`);
  }
  return { ...session, status: target };
}
