import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runActionOwnerNextJourney } from '../../../test/browser/f322-action-owner-next.mjs';
import { readbackResponse, runNativeReplyNextJourney } from '../../../test/browser/f322-native-reply-next.mjs';
import projected from '../../../test/fixtures/f322-readback.public.json';
import { projectReadbackCapture } from '../../../test/fixtures/f322-readback-public-projection.mjs';

function loadNativeReadback(input?: string) {
  // Browser journeys execute in Node. Vitest's jsdom import.meta.url is an HTTP
  // URL, so verify the file-based loader in its actual native Node environment.
  const modulePath = path.resolve('test/fixtures/f322-readback-public-projection.mjs');
  const script = `import { pathToFileURL } from 'node:url';
    const { loadReadbackCapture } = await import(pathToFileURL(process.argv[2]));
    process.stdout.write(JSON.stringify(loadReadbackCapture(process.argv[3])));`;
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        'readback-loader-probe',
        modulePath,
        ...(input === undefined ? [] : [input]),
      ],
      { encoding: 'utf8' },
    ),
  );
}

describe('public readback capture projection', () => {
  it('is deterministic from its input capture, with no dependency on the private evidence directory', () => {
    // In the private author/reviewer lane this also binds the published bytes to
    // the original capture. The public suite verifies the same closure itself.
    const capture = process.env.F322_PROJECTION_SOURCE
      ? JSON.parse(readFileSync(process.env.F322_PROJECTION_SOURCE, 'utf8'))
      : projected;
    expect(projectReadbackCapture(capture)).toEqual(projected);
    expect(loadNativeReadback()).toEqual(
      process.env.F322_READBACK_ARTIFACT ? loadNativeReadback(process.env.F322_READBACK_ARTIFACT) : projected,
    );
    expect(loadNativeReadback('')).toEqual(projected);
  });

  it('closes the browser fixture imports and preserves the shared session/thread/formal/Draft owner response', () => {
    expect(typeof runNativeReplyNextJourney).toBe('function');
    expect(typeof runActionOwnerNextJourney).toBe('function');
    const trace = loadNativeReadback().traces[0];
    const request = (pathname: string) => ({ url: () => `http://readback.invalid${pathname}` });
    expect(readbackResponse(request('/api/session'), trace, trace.api).body).toEqual({ userId: trace.userId });
    expect(readbackResponse(request(`/api/threads/${trace.threadId}`), trace, trace.api).body).toMatchObject({
      id: trace.threadId,
      createdBy: trace.userId,
    });
    for (const message of [trace.api, trace.draft.api]) {
      expect(readbackResponse(request('/api/messages'), trace, message).body).toEqual({
        messages: [message],
        hasMore: false,
      });
    }
  });

  it('retains event order, content/hash, layout owners and the paired tool reference across all stations', () => {
    expect(projected.provenance.kind).toBe('public_safe_capture_projection');
    for (const trace of projected.traces) {
      expect(trace.live.map((event) => event.type)).toEqual([
        'system_info',
        'text',
        'tool_use',
        'tool_result',
        'text',
        'text',
        'system_info',
        'done',
      ]);
      const final = trace.api.extra.outputLayout;
      expect(final.contentRevision).toEqual({
        length: trace.api.content.length,
        sha256: createHash('sha256').update(trace.api.content).digest('hex'),
      });
      expect(final.owner).toEqual({
        threadId: trace.threadId,
        catId: trace.api.catId,
        turnInvocationId: trace.childId,
      });
      expect(trace.api.extra.stream.invocationId).toBe(trace.childId);
      expect(trace.draft.api.extra.outputLayout).toEqual(final);
      expect(final.order.filter((entry) => entry.kind === 'tool').map((entry) => entry.toolEventId)).toEqual(
        trace.api.toolEvents.map((tool) => tool.id),
      );
      expect(
        trace.live
          .filter((event) => event.type === 'tool_use' || event.type === 'tool_result')
          .map((event) => event.toolEventId),
      ).toEqual(trace.api.toolEvents.map((tool) => tool.id));
      expect(trace.draft.api.toolEvents).toEqual(trace.api.toolEvents);
      const created = JSON.parse(trace.live[0].content ?? '');
      expect(created.invocationId).toBe(trace.childId);
      expect(created.parentInvocationId).toBe(trace.childId);
      expect(created.effectiveStrategy).toBeUndefined();
      expect(trace.userId).toMatch(/^owner-public-readback-/);
      expect(trace.api.timestamp).toBeGreaterThanOrEqual(1700000000000);
      expect(trace.api.timestamp).toBeLessThan(1700000001000);
    }
    expect(JSON.stringify(projected)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('drops unconsumed instance metadata instead of recursively copying the raw capture', () => {
    const capture = structuredClone(projected);
    Object.assign(capture.traces[0], {
      privateOwner: 'private-owner-secret',
      formal: { privateField: 'private-formal-secret' },
    });
    Object.assign(capture.traces[0].api.extra, { privateProvider: 'private-provider-secret' });
    expect(JSON.stringify(projectReadbackCapture(capture))).not.toContain('private-');
  });

  it('refuses arbitrary message content, inconsistent ownership, changed hashes and unknown event sequences', () => {
    const content = structuredClone(projected);
    content.traces[0].api.content = 'private message';
    expect(() => projectReadbackCapture(content)).toThrow(/producer-controlled synthetic body/);
    const owner = structuredClone(projected);
    owner.traces[0].api.extra.outputLayout.owner.turnInvocationId = 'other-owner';
    expect(() => projectReadbackCapture(owner)).toThrow();
    const hash = structuredClone(projected);
    hash.traces[0].api.extra.outputLayout.contentRevision.sha256 = 'changed';
    expect(() => projectReadbackCapture(hash)).toThrow();
    const events = structuredClone(projected);
    events.traces[0].live[0].type = 'unknown';
    expect(() => projectReadbackCapture(events)).toThrow(/projection audit/);
  });
});
