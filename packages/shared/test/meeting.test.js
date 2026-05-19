import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Meeting types', () => {
  describe('MeetingSession', () => {
    it('createMeetingSession produces valid session with required fields', async () => {
      const { createMeetingSession } = await import('../dist/types/meeting.js');
      const session = createMeetingSession({
        threadId: 'thread_abc123',
        participants: [{ id: 'p1', name: 'Alice' }],
      });

      assert.ok(session.meetingId, 'should generate meetingId');
      assert.ok(session.meetingId.startsWith('mtg_'), 'meetingId should start with mtg_');
      assert.equal(session.threadId, 'thread_abc123');
      assert.equal(session.status, 'active');
      assert.equal(session.participants.length, 1);
      assert.equal(session.participants[0].name, 'Alice');
      assert.ok(session.startedAt > 0, 'should have startedAt timestamp');
    });

    it('createMeetingSession rejects empty threadId', async () => {
      const { createMeetingSession } = await import('../dist/types/meeting.js');
      assert.throws(() => createMeetingSession({ threadId: '', participants: [] }), /threadId.*required/i);
    });

    it('two sessions get different meetingIds', async () => {
      const { createMeetingSession } = await import('../dist/types/meeting.js');
      const s1 = createMeetingSession({ threadId: 't1', participants: [] });
      const s2 = createMeetingSession({ threadId: 't2', participants: [] });
      assert.notEqual(s1.meetingId, s2.meetingId);
    });
  });

  describe('MeetingParticipant validation', () => {
    it('validates participant with minimal fields', async () => {
      const { validateParticipant } = await import('../dist/types/meeting.js');
      const p = validateParticipant({ id: 'p1', name: 'Bob' });
      assert.equal(p.id, 'p1');
      assert.equal(p.name, 'Bob');
      assert.equal(p.role, undefined);
    });

    it('accepts optional role and speakerEmbeddingId', async () => {
      const { validateParticipant } = await import('../dist/types/meeting.js');
      const p = validateParticipant({
        id: 'p2',
        name: 'Carol',
        role: 'host',
        speakerEmbeddingId: 'emb_xyz',
      });
      assert.equal(p.role, 'host');
      assert.equal(p.speakerEmbeddingId, 'emb_xyz');
    });

    it('rejects participant with empty name', async () => {
      const { validateParticipant } = await import('../dist/types/meeting.js');
      assert.throws(() => validateParticipant({ id: 'p3', name: '' }), /name.*required/i);
    });

    it('rejects invalid role', async () => {
      const { validateParticipant } = await import('../dist/types/meeting.js');
      assert.throws(() => validateParticipant({ id: 'p4', name: 'Dan', role: 'admin' }), /role/i);
    });
  });

  describe('MeetingSession status transitions', () => {
    it('transitionMeetingStatus active → paused', async () => {
      const { createMeetingSession, transitionMeetingStatus } = await import('../dist/types/meeting.js');
      const session = createMeetingSession({ threadId: 't1', participants: [] });
      const paused = transitionMeetingStatus(session, 'paused');
      assert.equal(paused.status, 'paused');
    });

    it('transitionMeetingStatus active → ended', async () => {
      const { createMeetingSession, transitionMeetingStatus } = await import('../dist/types/meeting.js');
      const session = createMeetingSession({ threadId: 't1', participants: [] });
      const ended = transitionMeetingStatus(session, 'ended');
      assert.equal(ended.status, 'ended');
    });

    it('rejects ended → active (no resurrection)', async () => {
      const { createMeetingSession, transitionMeetingStatus } = await import('../dist/types/meeting.js');
      const session = createMeetingSession({ threadId: 't1', participants: [] });
      const ended = transitionMeetingStatus(session, 'ended');
      assert.throws(() => transitionMeetingStatus(ended, 'active'), /cannot transition.*ended/i);
    });
  });
});
