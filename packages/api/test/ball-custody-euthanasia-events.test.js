/**
 * F233 Phase C C1a — euthanasia event builders 测试
 *
 * 3 builders（buildBallFrozenEvent / buildBallDegradedEvent / buildBallAbandonedEvent）
 * 形状 + sourceEventId 含 kind（砚砚 R0 修正 regression test：同 ms 跨 kind 三 sourceEventId
 * 必须互不相等，否则 Lua append 会把同 ms 三 kind 互相幂等吞）+ 跨 ms 独立 + payload 一致。
 *
 * 照 Phase B node:test + import dist 模式。plan §A + KD-C1/C2 + 砚砚 KD-C6 R0 review。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildBallAbandonedEvent,
  buildBallDegradedEvent,
  buildBallFrozenEvent,
} from '../dist/domains/ball-custody/ball-custody-events.js';

describe('Phase C euthanasia event builders (KD-C1/C2, 砚砚 R0 修正)', () => {
  const baseInput = {
    subjectKey: 'ball:thread:thr-1',
    why: 'no longer relevant; operator closed it',
    by: 'cvo',
    at: 1_700_000_000_000,
  };

  describe('buildBallFrozenEvent', () => {
    it('shape：kind/classification/payload/subjectKey/at 全字段正确', () => {
      const event = buildBallFrozenEvent(baseInput);
      assert.strictEqual(event.kind, 'ball.frozen');
      assert.strictEqual(event.classification, 'state-changing');
      assert.strictEqual(event.subjectKey, baseInput.subjectKey);
      assert.strictEqual(event.at, baseInput.at);
      assert.deepStrictEqual(event.payload, {
        kind: 'frozen',
        why: baseInput.why,
        by: baseInput.by,
      });
    });

    it('sourceEventId 含 kind：`euthanasia:{subjectKey}:frozen:{at}`', () => {
      const event = buildBallFrozenEvent(baseInput);
      assert.strictEqual(event.sourceEventId, `euthanasia:${baseInput.subjectKey}:frozen:${baseInput.at}`);
    });
  });

  describe('buildBallDegradedEvent', () => {
    it('shape：kind/classification/payload/subjectKey/at 全字段正确', () => {
      const event = buildBallDegradedEvent(baseInput);
      assert.strictEqual(event.kind, 'ball.degraded');
      assert.strictEqual(event.classification, 'state-changing');
      assert.strictEqual(event.subjectKey, baseInput.subjectKey);
      assert.strictEqual(event.at, baseInput.at);
      assert.deepStrictEqual(event.payload, {
        kind: 'degraded',
        why: baseInput.why,
        by: baseInput.by,
      });
    });

    it('sourceEventId 含 kind：`euthanasia:{subjectKey}:degraded:{at}`', () => {
      const event = buildBallDegradedEvent(baseInput);
      assert.strictEqual(event.sourceEventId, `euthanasia:${baseInput.subjectKey}:degraded:${baseInput.at}`);
    });
  });

  describe('buildBallAbandonedEvent', () => {
    it('shape：kind/classification/payload/subjectKey/at 全字段正确', () => {
      const event = buildBallAbandonedEvent(baseInput);
      assert.strictEqual(event.kind, 'ball.abandoned');
      assert.strictEqual(event.classification, 'state-changing');
      assert.strictEqual(event.subjectKey, baseInput.subjectKey);
      assert.strictEqual(event.at, baseInput.at);
      assert.deepStrictEqual(event.payload, {
        kind: 'abandoned',
        why: baseInput.why,
        by: baseInput.by,
      });
    });

    it('sourceEventId 含 kind：`euthanasia:{subjectKey}:abandoned:{at}`', () => {
      const event = buildBallAbandonedEvent(baseInput);
      assert.strictEqual(event.sourceEventId, `euthanasia:${baseInput.subjectKey}:abandoned:${baseInput.at}`);
    });
  });

  describe('sourceEventId R0 regression (砚砚 KD-C6 review 钉死的关键断言)', () => {
    it('同 subjectKey + 同 at + 3 kind → 3 sourceEventId 互不相等（防同 ms 跨 kind 互相幂等吞）', () => {
      const frozen = buildBallFrozenEvent(baseInput);
      const degraded = buildBallDegradedEvent(baseInput);
      const abandoned = buildBallAbandonedEvent(baseInput);

      const ids = new Set([frozen.sourceEventId, degraded.sourceEventId, abandoned.sourceEventId]);
      assert.strictEqual(ids.size, 3, '三 builder 同 (subjectKey, at) 必须生成 3 个独立 sourceEventId');

      // 显式断言每对互不相等，错时信息更清楚
      assert.notStrictEqual(frozen.sourceEventId, degraded.sourceEventId);
      assert.notStrictEqual(frozen.sourceEventId, abandoned.sourceEventId);
      assert.notStrictEqual(degraded.sourceEventId, abandoned.sourceEventId);
    });

    it('同 kind 跨 ms → sourceEventId 独立（事件流时间轴诚实，每次 try-to-kill 都进事件流）', () => {
      const frozenAtT1 = buildBallFrozenEvent({ ...baseInput, at: 1_000 });
      const frozenAtT2 = buildBallFrozenEvent({ ...baseInput, at: 2_000 });
      assert.notStrictEqual(frozenAtT1.sourceEventId, frozenAtT2.sourceEventId);
    });

    it('同 kind 同 ms 同 subjectKey → sourceEventId 完全相等（Lua append 幂等去重该 collapse）', () => {
      const event1 = buildBallFrozenEvent(baseInput);
      const event2 = buildBallFrozenEvent(baseInput);
      assert.strictEqual(event1.sourceEventId, event2.sourceEventId);
      // 整 event 也应该结构相等（同 input → 同 output 纯函数）
      assert.deepStrictEqual(event1, event2);
    });

    it('不同 subjectKey → sourceEventId 独立（不同球独立账本）', () => {
      const threadBall = buildBallFrozenEvent({ ...baseInput, subjectKey: 'ball:thread:thr-1' });
      const taskBall = buildBallFrozenEvent({ ...baseInput, subjectKey: 'ball:task:tsk-1' });
      assert.notStrictEqual(threadBall.sourceEventId, taskBall.sourceEventId);
    });
  });

  describe('subjectKey 派生约束 (KD-1：不引球 ID 新原语)', () => {
    it('subjectKey 完整 passthrough（builder 不重写格式，调用方负责派生 ball:thread:* | ball:task:*）', () => {
      const taskInput = { ...baseInput, subjectKey: 'ball:task:custom-task-id' };
      const event = buildBallFrozenEvent(taskInput);
      assert.strictEqual(event.subjectKey, 'ball:task:custom-task-id');
    });
  });
});
