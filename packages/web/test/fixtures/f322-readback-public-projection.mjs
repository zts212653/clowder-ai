import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PROCESS = '检查 **日志** 🐾。';
const ANSWER = `${PROCESS}\n\n保留 **答案段** 🐾。\n\n第二段完整回答。`;
const CONTENT = `${ANSWER}\n\n[Sol/gpt-6.1-sol🐾]`;
const EPOCH = 1700000000000;
const EVENT_TYPES = ['system_info', 'text', 'tool_use', 'tool_result', 'text', 'text', 'system_info', 'done'];

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function projectSystemInfo(info, eventIndex, { sourceChildId, childId, identity, timestamp }) {
  assert.equal(info.invocationId, sourceChildId);
  assert.equal(info.type, eventIndex === 0 ? 'invocation_created' : 'invocation_metrics');
  if (eventIndex === 0) {
    assert.equal(info.executionKind, 'ordinary');
    assert.equal(info.kind, undefined);
    assert.equal(info.durationMs, undefined);
  } else {
    assert.equal(info.kind, 'invocation_complete');
    assert.equal(info.executionKind, undefined);
    assert.ok(Number.isSafeInteger(info.durationMs) && info.durationMs >= 0);
  }
  const safe = pick(info, ['type', 'kind', 'executionKind', 'durationMs']);
  safe.invocationId = childId;
  if (info.parentInvocationId !== undefined) safe.parentInvocationId = identity(info.parentInvocationId);
  if (info.startedAt !== undefined) safe.startedAt = timestamp(info.startedAt);
  // This declared public enum is consumed by both ingress handlers. The
  // unrelated effectiveStrategy/revision snapshot belongs to the instance.
  if (info.freshnessCarrierCapability) {
    assert.deepEqual(info.freshnessCarrierCapability, {
      provider: 'other',
      carrier: 'other',
      deliverySemantics: 'undeclared',
    });
    safe.freshnessCarrierCapability = info.freshnessCarrierCapability;
  }
  return JSON.stringify(safe);
}

function projectLiveEvent(event, eventIndex, context) {
  const { identity, timestamp, extra } = context;
  assert.equal(event.catId, 'codex');
  if (event.toolName !== undefined) assert.equal(event.toolName, 'read');
  if (event.toolUseId !== undefined) assert.equal(event.toolUseId, 'readback-pair');
  if (event.origin !== undefined) assert.equal(event.origin, 'stream');
  if (event.textMode !== undefined) assert.equal(event.textMode, 'replace');
  const result = {
    ...pick(event, ['type', 'catId', 'origin', 'textMode', 'toolName', 'toolUseId']),
    timestamp: timestamp(event.timestamp),
  };
  for (const key of ['invocationId', 'turnInvocationId', 'toolEventId', 'toolExecutionRef']) {
    if (event[key] !== undefined) result[key] = identity(event[key]);
  }
  if (event.type === 'system_info') {
    result.content = projectSystemInfo(JSON.parse(event.content), eventIndex, context);
  } else if (event.content !== undefined) {
    assert.equal(event.content, { 1: PROCESS, 3: 'ok', 4: ANSWER, 5: CONTENT, 7: CONTENT }[eventIndex]);
    result.content = event.content;
  }
  if (event.extra?.outputLayout) result.extra = extra(event.extra, event.content ?? CONTENT);
  return result;
}

/** A consumer projection of a bounded real Redis/API capture, never the original archive. */
export function projectReadbackCapture(capture) {
  assert.equal(capture.v, 1);
  assert.equal(capture.redisPort, 6398);
  assert.deepEqual(
    capture.traces.map((trace) => trace.route),
    ['serial', 'parallel'],
  );
  const firstTimestamp = Math.min(...capture.traces.map((trace) => trace.api.timestamp));
  assert.ok(Number.isSafeInteger(firstTimestamp) && firstTimestamp >= 1000000000000);
  const timestamp = (value) => {
    assert.ok(Number.isSafeInteger(value) && value >= 0, 'invalid observed timestamp');
    assert.ok(
      value >= firstTimestamp || [2, 3, 6].includes(value),
      'changed clock carrier requires a projection audit',
    );
    return value >= firstTimestamp ? EPOCH + value - firstTimestamp : value;
  };
  const traces = capture.traces.map((trace, index) => {
    assert.equal(trace.api.catId, 'codex');
    assert.equal(trace.api.content, CONTENT, 'only the producer-controlled synthetic body may be published');
    assert.deepEqual(
      trace.live.map((event) => event.type),
      EVENT_TYPES,
      'changed capture requires a projection audit',
    );
    const threadId = `public-readback-${trace.route}`;
    const childId = `child-public-readback-${trace.route}`;
    const apiId = `${String(timestamp(trace.api.timestamp)).padStart(16, '0')}-${String(index).padStart(6, '0')}-00000000`;
    const tools = trace.api.toolEvents;
    assert.deepEqual(
      tools.map((tool) => tool.type),
      ['tool_use', 'tool_result'],
    );
    assert.notEqual(tools[0].id, tools[1].id);
    const ids = new Map([
      [trace.threadId, threadId],
      [trace.childId, childId],
      [trace.api.id, apiId],
      [`draft-${trace.childId}`, `draft-${childId}`],
      ...tools.map((tool) => [tool.id, `${tool.type}-public-readback-${trace.route}`]),
    ]);
    const identity = (value) => {
      assert.ok(ids.has(value), 'unrecognized capture identity');
      return ids.get(value);
    };
    function layout(value, content) {
      assert.equal(value.v, 1);
      assert.deepEqual(value.owner, { threadId: trace.threadId, catId: 'codex', turnInvocationId: trace.childId });
      assert.deepEqual(value.contentRevision, {
        length: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
      const projected = {
        ...pick(value, ['v', 'contentRevision', 'status', 'reason']),
        owner: { threadId, catId: 'codex', turnInvocationId: childId },
      };
      if (value.status === 'unavailable') {
        assert.equal(content, PROCESS);
        assert.equal(value.reason, 'no_final');
        return projected;
      }
      assert.equal(value.status, 'available');
      assert.equal(value.reason, undefined);
      assert.ok(content === ANSWER || content === CONTENT);
      assert.deepEqual(
        value.runs.map((run) => run.channel),
        ['commentary', 'final'],
      );
      projected.runs = value.runs.map((run, runIndex) => {
        assert.deepEqual(run.identity, {
          provider: 'codex',
          runtimeSessionId: 'native-readback',
          turnId: 'native-turn',
          nativeId: ['process', 'answer'][runIndex],
        });
        assert.deepEqual(pick(run, ['id', 'channel', 'complete', 'start', 'end', 'gluePrefixLength']), {
          id: `run-${runIndex}`,
          channel: ['commentary', 'final'][runIndex],
          complete: true,
          start: [0, PROCESS.length][runIndex],
          end: [PROCESS.length, ANSWER.length][runIndex],
          gluePrefixLength: [0, 2][runIndex],
        });
        return {
          ...pick(run, ['id', 'channel', 'complete', 'start', 'end', 'gluePrefixLength']),
          identity: run.identity,
        };
      });
      assert.deepEqual(value.order, [
        { kind: 'run', runId: 'run-0' },
        ...tools.map((tool) => ({ kind: 'tool', toolEventId: tool.id, executionRef: trace.childId })),
        { kind: 'run', runId: 'run-1' },
      ]);
      projected.order = value.order.map((entry) =>
        entry.kind === 'tool'
          ? { kind: 'tool', toolEventId: identity(entry.toolEventId), executionRef: identity(entry.executionRef) }
          : pick(entry, ['kind', 'runId']),
      );
      if (value.hostTail) {
        assert.deepEqual(value.hostTail, {
          kind: 'cat_signature',
          producer: 'codex_stream_finalizer',
          basis: 'runtime_canonical',
          start: ANSWER.length,
          end: CONTENT.length,
          gluePrefixLength: 2,
        });
        projected.hostTail = value.hostTail;
      }
      assert.equal(Boolean(value.hostTail), content === CONTENT);
      return projected;
    }
    function extra(value, content) {
      const result = {};
      if (value.outputLayout) result.outputLayout = layout(value.outputLayout, content);
      if (value.stream) {
        result.stream = Object.fromEntries(
          ['invocationId', 'turnInvocationId']
            .filter((key) => value.stream[key] !== undefined)
            .map((key) => [key, identity(value.stream[key])]),
        );
        if (value.stream.parallelBatchId !== undefined)
          result.stream.parallelBatchId = `batch-public-readback-${trace.route}`;
      }
      return result;
    }
    function tool(value) {
      assert.equal(value.executionRef, trace.childId);
      assert.equal(value.toolUseId, 'readback-pair');
      assert.equal(value.label, value.type === 'tool_use' ? 'codex → read' : 'codex ← result');
      if (value.detail !== undefined) assert.equal(value.detail, 'ok');
      if (value.toolName !== undefined) assert.equal(value.toolName, 'read');
      const timing = Object.fromEntries(
        ['startTimeMs', 'endTimeMs']
          .filter((key) => value[key] !== undefined)
          .map((key) => [key, timestamp(value[key])]),
      );
      return {
        ...pick(value, ['type', 'label', 'detail', 'toolUseId', 'toolName']),
        ...timing,
        id: identity(value.id),
        executionRef: childId,
        timestamp: timestamp(value.timestamp),
      };
    }
    function message(value) {
      assert.equal(value.type, 'assistant');
      assert.equal(value.catId, 'codex');
      if (value.from !== undefined) assert.deepEqual(value.from, { kind: 'agent', catId: 'codex' });
      assert.equal(value.content, CONTENT);
      assert.equal(value.origin, 'stream');
      if (value.isDraft !== undefined) assert.equal(value.isDraft, true);
      return {
        ...pick(value, ['type', 'catId', 'content', 'origin', 'isDraft']),
        from: { kind: 'agent', catId: 'codex' },
        id: identity(value.id),
        timestamp: timestamp(value.timestamp),
        extra: extra(value.extra, value.content),
        toolEvents: value.toolEvents.map(tool),
      };
    }
    const live = trace.live.map((event, eventIndex) =>
      projectLiveEvent(event, eventIndex, { sourceChildId: trace.childId, childId, identity, timestamp, extra }),
    );
    return {
      route: trace.route,
      userId: `owner-public-readback-${trace.route}`,
      threadId,
      childId,
      live,
      api: message(trace.api),
      draft: { api: message(trace.draft.api) },
    };
  });
  return {
    v: 1,
    redisPort: 6398,
    provenance: {
      kind: 'public_safe_capture_projection',
      version: 1,
      producer: 'packages/api/test/f322-reply-output-readback.journey.mjs',
      transformations: [
        'consumer field allowlist',
        'consistent identity aliases',
        'wall clock translation',
        'MessageFrom projection of legacy agent rows',
      ],
      originalArchive: 'retained privately; this projection is not the original capture',
    },
    traces,
  };
}

/** A fresh actual capture remains an explicit override for every consumer. */
export function loadReadbackCapture(input = process.env.F322_READBACK_ARTIFACT) {
  return JSON.parse(readFileSync(input || new URL('./f322-readback.public.json', import.meta.url), 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, output] = process.argv.slice(2);
  assert.ok(
    input && output,
    'Usage: node f322-readback-public-projection.mjs <bounded-capture.json> <public-projection.json>',
  );
  writeFileSync(output, `${JSON.stringify(projectReadbackCapture(loadReadbackCapture(input)), null, 2)}\n`);
}
