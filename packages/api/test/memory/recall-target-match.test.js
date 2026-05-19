import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

describe('targetMatch — PG-2 dispatch', () => {
  let targetMatch;

  before(async () => {
    const mod = await import('../../dist/domains/memory/recall-target-match.js');
    targetMatch = mod.targetMatch;
  });

  it('Read matches doc targetRef by sourcePath substring', () => {
    const ref = { kind: 'doc', sourcePath: 'docs/features/F102-memory-adapter-refactor.md' };
    assert.ok(
      targetMatch('Read', { file_path: '/full/path/cat-cafe/docs/features/F102-memory-adapter-refactor.md' }, ref),
    );
  });

  it('Read does not match unrelated doc', () => {
    const ref = { kind: 'doc', sourcePath: 'docs/features/F102-memory-adapter-refactor.md' };
    assert.ok(!targetMatch('Read', { file_path: '/path/to/unrelated.md' }, ref));
  });

  it('Read does not match thread targetRef', () => {
    const ref = { kind: 'thread', threadId: 'thread-abc' };
    assert.ok(!targetMatch('Read', { file_path: '/some/file.md' }, ref));
  });

  it('Grep matches doc targetRef only for targeted grep (path provided)', () => {
    const ref = { kind: 'doc', sourcePath: 'docs/features/F102-memory-adapter-refactor.md' };
    assert.ok(targetMatch('Grep', { path: 'docs/features/F102-memory-adapter-refactor.md', pattern: 'foo' }, ref));
  });

  it('Grep without path does not match (untargeted = fallback)', () => {
    const ref = { kind: 'doc', sourcePath: 'docs/features/F102-memory-adapter-refactor.md' };
    assert.ok(!targetMatch('Grep', { pattern: 'foo' }, ref));
  });

  it('get_thread_context matches thread targetRef', () => {
    const ref = { kind: 'thread', threadId: 'thread-abc' };
    assert.ok(targetMatch('get_thread_context', { threadId: 'thread-abc' }, ref));
  });

  it('get_thread_context does not match wrong threadId', () => {
    const ref = { kind: 'thread', threadId: 'thread-abc' };
    assert.ok(!targetMatch('get_thread_context', { threadId: 'thread-xyz' }, ref));
  });

  it('read_session_events matches session targetRef', () => {
    const ref = { kind: 'session', sessionId: 'sess-123' };
    assert.ok(targetMatch('read_session_events', { sessionId: 'sess-123' }, ref));
  });

  it('read_session_digest matches session targetRef', () => {
    const ref = { kind: 'session', sessionId: 'sess-456' };
    assert.ok(targetMatch('read_session_digest', { sessionId: 'sess-456' }, ref));
  });

  it('read_invocation_detail matches invocation targetRef', () => {
    const ref = { kind: 'invocation', sessionId: 's1', invocationId: 'inv-1' };
    assert.ok(targetMatch('read_invocation_detail', { invocationId: 'inv-1' }, ref));
  });

  it('read_invocation_detail does not match session targetRef', () => {
    const ref = { kind: 'session', sessionId: 's1' };
    assert.ok(!targetMatch('read_invocation_detail', { invocationId: 'inv-1' }, ref));
  });

  it('graph_resolve matches doc by anchor in query', () => {
    const ref = { kind: 'doc', sourcePath: 'docs/features/F200-memory-recall-eval.md' };
    assert.ok(targetMatch('graph_resolve', { query: 'F200-memory-recall-eval.md' }, ref));
  });

  it('unknown method returns false', () => {
    const ref = { kind: 'doc', sourcePath: 'test.md' };
    assert.ok(!targetMatch('SomeUnknownTool', { file_path: 'test.md' }, ref));
  });

  // P1-1 fix: anchor fallback when sourcePath is empty (real-world deriveResultSummary output)
  it('Read matches doc targetRef by anchor fallback when sourcePath is empty', () => {
    const ref = { kind: 'doc', sourcePath: '', anchor: 'F102' };
    assert.ok(targetMatch('Read', { file_path: '/path/cat-cafe/docs/features/F102-memory-adapter.md' }, ref));
  });

  it('Read anchor fallback does not match unrelated file', () => {
    const ref = { kind: 'doc', sourcePath: '', anchor: 'F102' };
    assert.ok(!targetMatch('Read', { file_path: '/path/cat-cafe/docs/features/F200-recall.md' }, ref));
  });

  it('Grep matches doc targetRef by anchor fallback when sourcePath is empty', () => {
    const ref = { kind: 'doc', sourcePath: '', anchor: 'F102' };
    assert.ok(targetMatch('Grep', { path: 'docs/features/F102-memory-adapter.md', pattern: 'foo' }, ref));
  });

  it('graph_resolve matches doc by anchor when sourcePath is empty', () => {
    const ref = { kind: 'doc', sourcePath: '', anchor: 'F102' };
    assert.ok(targetMatch('graph_resolve', { query: 'F102' }, ref));
  });
});
