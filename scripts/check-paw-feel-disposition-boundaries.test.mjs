import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzePawFeelDispositionBoundaries } from './check-paw-feel-disposition-boundaries.mjs';

const CANONICAL_PARSER = 'packages/api/src/infrastructure/harness-eval/friction/paw-feel-marker.ts';
const READ_MODEL = 'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/read-model.ts';
const SERVICE = 'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/service.ts';
const EVENT_LOG = 'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/event-log.ts';
const SHARED_CONTRACT = 'packages/shared/src/types/paw-feel-disposition.ts';
const WEB_COMPONENT = 'packages/web/src/components/eval-workspace/PawFeelInboxSection.tsx';

function validFiles() {
  return new Map([
    [CANONICAL_PARSER, String.raw`const MARKER_RE = /\[\u722a\u611f\u5dee[:\uff1a]\s*(.*?)\]/g;`],
    [
      READ_MODEL,
      `
function filterAndSort(projections, query) {
  return projections.filter((projection) => !query.state || projection.state === query.state);
}
async function resolveDegraded() {
  return (await semanticDegraded?.()) ?? false;
}
`,
    ],
    [SERVICE, 'await this.options.eventLog.append(event, expectedSequence);'],
    [EVENT_LOG, 'export class RedisPawFeelDispositionEventLog { async append(event) {} }'],
    [SHARED_CONTRACT, 'export interface PawFeelSourceRef { sourceMessageId: string; markerDigest: string; }'],
    [WEB_COMPONENT, 'export function PawFeelInboxSection() { return <section />; }'],
    ['packages/api/src/index.ts', 'const eventLog = new RedisPawFeelDispositionEventLog(redis);'],
  ]);
}

function messages(violations) {
  return violations.map((violation) => violation.message);
}

describe('F278 paw-feel disposition boundary guard', () => {
  it('accepts one parser, one writer path, source-ref-only storage, and non-gating degradation', () => {
    assert.deepEqual(analyzePawFeelDispositionBoundaries(validFiles()), []);
  });

  it('rejects persisted marker body fields', () => {
    const files = validFiles();
    files.set(SHARED_CONTRACT, 'export interface PawFeelSourceRef { sourceMessageId: string; markerBody: string; }');

    assert.ok(
      messages(analyzePawFeelDispositionBoundaries(files)).some((message) => /marker body field/i.test(message)),
    );
  });

  it('rejects a second paw-feel marker parser', () => {
    const files = validFiles();
    files.set(
      'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/alternate-parser.ts',
      String.raw`const duplicate = /\[\u722a\u611f\u5dee:([^\]]+)\]/g;`,
    );

    assert.ok(messages(analyzePawFeelDispositionBoundaries(files)).some((message) => /second parser/i.test(message)));
  });

  it('rejects direct event-log append calls outside the service and event-log implementation', () => {
    const files = validFiles();
    files.set(
      'packages/api/src/infrastructure/harness-eval/paw-feel-disposition/shortcut.ts',
      'await eventLog.append(event, 0);',
    );

    assert.ok(messages(analyzePawFeelDispositionBoundaries(files)).some((message) => /writer path/i.test(message)));
  });

  it('rejects a second Redis event-log composition root', () => {
    const files = validFiles();
    files.set(
      'packages/api/src/routes/paw-feel-disposition-route.ts',
      'const eventLog = new RedisPawFeelDispositionEventLog(redis);',
    );

    assert.ok(
      messages(analyzePawFeelDispositionBoundaries(files)).some((message) => /composition root/i.test(message)),
    );
  });

  it('rejects semantic or degraded state as a visibility filter', () => {
    const files = validFiles();
    files.set(
      READ_MODEL,
      `
function filterAndSort(projections, query, semanticDegraded) {
  if (semanticDegraded) return [];
  return projections;
}
`,
    );

    assert.ok(messages(analyzePawFeelDispositionBoundaries(files)).some((message) => /visibility gate/i.test(message)));
  });

  it('rejects browser-owned disposition persistence', () => {
    const files = validFiles();
    files.set(WEB_COMPONENT, "localStorage.setItem('paw-feel-dispositions', JSON.stringify(items));");

    assert.ok(
      messages(analyzePawFeelDispositionBoundaries(files)).some((message) => /browser persistence/i.test(message)),
    );
  });
});
