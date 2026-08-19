import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CommunityProjector } from '../dist/domains/community/community-projector.js';

class MemoryEventLog {
  events = [];

  async append(event) {
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }

  async read(subjectKey) {
    return this.events.filter((event) => event.subjectKey === subjectKey).map((event) => structuredClone(event));
  }

  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

class BarrierObjectStore {
  values = new Map();
  blockNextSave = false;
  saveEntered = Promise.resolve();
  releaseSave = () => {};

  armSaveBarrier() {
    this.blockNextSave = true;
    this.saveEntered = new Promise((resolve) => {
      this.signalSaveEntered = resolve;
    });
    this.saveRelease = new Promise((resolve) => {
      this.releaseSave = resolve;
    });
  }

  async get(subjectKey) {
    const value = this.values.get(subjectKey);
    return value ? structuredClone(value) : null;
  }

  async save(projection) {
    if (this.blockNextSave) {
      this.blockNextSave = false;
      this.signalSaveEntered();
      await this.saveRelease;
    }
    this.values.set(projection.subjectKey, structuredClone(projection));
  }

  async listSubjectKeys() {
    return [...this.values.keys()];
  }

  async delete(subjectKey) {
    this.values.delete(subjectKey);
  }
}

const subjectKey = 'issue:owner/repo#42';

describe('CommunityProjector subject admission', () => {
  it('does not let a recovery rebuild overwrite a concurrent collector apply', async () => {
    const eventLog = new MemoryEventLog();
    const objectStore = new BarrierObjectStore();
    const projector = new CommunityProjector(eventLog, objectStore);
    const opened = {
      sourceEventId: 'opened-1',
      subjectKey,
      kind: 'issue.opened',
      classification: 'state-changing',
      payload: {},
      at: 1,
    };
    const commented = {
      sourceEventId: 'comment-2',
      subjectKey,
      kind: 'issue.commented',
      classification: 'informational',
      payload: { body: 'new durable fact' },
      at: 2,
    };

    await eventLog.append(opened);
    await projector.apply(opened);

    objectStore.armSaveBarrier();
    const rebuild = projector.rebuild(subjectKey);
    await objectStore.saveEntered;

    await eventLog.append(commented);
    const apply = projector.apply(commented);
    await new Promise((resolve) => setImmediate(resolve));

    objectStore.releaseSave();
    await Promise.all([rebuild, apply]);

    assert.equal((await eventLog.read(subjectKey)).length, 2);
    assert.deepEqual(await objectStore.get(subjectKey), {
      repo: 'owner/repo',
      type: 'issue',
      number: 42,
      subjectKey,
      state: 'new',
      ownerThreadId: null,
      ownerRole: null,
      nextOwner: 'none',
      lastExternalActivityAt: 2,
      lastPublicCommentAt: null,
      linkedIssues: [],
      linkedPrs: [],
      closureWaiver: null,
      issueFixEvidence: null,
      externalReview: null,
      appliedEventCount: 1,
      lastRejectedEvent: null,
      deliveryCursor: null,
      createdAt: 1,
      updatedAt: 2,
    });
  });
});
