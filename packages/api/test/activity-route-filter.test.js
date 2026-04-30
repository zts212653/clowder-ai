import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldTrackApiActivity } from '../dist/domains/health/activity-route-filter.js';

describe('shouldTrackApiActivity', () => {
  it('tracks ordinary API requests', () => {
    assert.equal(shouldTrackApiActivity('/api/cats'), true);
    assert.equal(shouldTrackApiActivity('/api/messages?threadId=t1'), true);
  });

  it('skips reverse-proxy-safe health probes', () => {
    assert.equal(shouldTrackApiActivity('/api/health'), false);
    assert.equal(shouldTrackApiActivity('/api/health?cacheBust=1'), false);
    assert.equal(shouldTrackApiActivity('/api/ready'), false);
    assert.equal(shouldTrackApiActivity('/api/ready?cacheBust=1'), false);
  });

  it('keeps existing brake and non-API exclusions', () => {
    assert.equal(shouldTrackApiActivity('/api/brake/status'), false);
    assert.equal(shouldTrackApiActivity('/health'), false);
  });
});
