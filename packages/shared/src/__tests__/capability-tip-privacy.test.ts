/**
 * F268 AC-A3 — Privacy Forbidden-Field Tests
 *
 * Structural proof that CapabilityTipUsageEventSchema CANNOT carry:
 * - Tip body text
 * - User messages / prompts
 * - File paths / content
 * - Free-form text of any kind
 *
 * These tests guard the pipeline's privacy contract: even a malicious or
 * buggy client cannot inject content through the validated event schema.
 */

import { describe, expect, it } from 'vitest';
import { CapabilityTipUsageEventSchema } from '../capability-tips.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const validEvent = {
  event: 'capability_tip_exposed' as const,
  tipId: 'magic-word-scaffold',
  context: 'thinking' as const,
  surface: 'pending_bubble' as const,
  outcome: 'shown' as const,
  timestamp: 1721000000000,
};

function parseResult(input: unknown) {
  return CapabilityTipUsageEventSchema.safeParse(input);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('F268 AC-A3: Privacy Forbidden-Field Tests', () => {
  describe('structural guarantee: .strict() rejects unknown fields', () => {
    it('rejects extra field "body" (tip body text)', () => {
      const result = parseResult({
        ...validEvent,
        body: '改完前端想看效果时，猫可以把本地页面打开到 Hub Browser 预览。',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra field "message" (user message)', () => {
      const result = parseResult({
        ...validEvent,
        message: '帮我修一下这个 bug',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra field "prompt" (prompt content)', () => {
      const result = parseResult({
        ...validEvent,
        prompt: 'You are a helpful assistant...',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra field "filePath" (file path)', () => {
      const result = parseResult({
        ...validEvent,
        filePath: '/home/user/cat-cafe/src/secret.ts',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra field "fileContent" (file content)', () => {
      const result = parseResult({
        ...validEvent,
        fileContent: 'const API_KEY = "sk-..."',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra field "draftPrompt" (concierge draft)', () => {
      const result = parseResult({
        ...validEvent,
        draftPrompt: '帮我解释这个 tip，并告诉我什么时候该用',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra field "userInput" (arbitrary user text)', () => {
      const result = parseResult({
        ...validEvent,
        userInput: 'I want to deploy my app to production',
      });
      expect(result.success).toBe(false);
    });

    it('rejects extra field "conversationId"', () => {
      const result = parseResult({
        ...validEvent,
        conversationId: 'thread_abc123',
      });
      expect(result.success).toBe(false);
    });

    it('rejects any additional property regardless of name', () => {
      const result = parseResult({
        ...validEvent,
        __injected_field_xyz: 'arbitrary content',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('field value constraints prevent content injection via valid fields', () => {
    it('tipId accepts valid slug pattern', () => {
      const result = parseResult({
        ...validEvent,
        tipId: 'valid-slug-id',
      });
      expect(result.success).toBe(true);
    });

    it('tipId rejects free text with spaces (privacy: cannot carry content)', () => {
      const result = parseResult({
        ...validEvent,
        tipId: 'Hello this is free text that could carry user content',
      });
      expect(result.success).toBe(false);
    });

    it('tipId rejects strings with special characters', () => {
      const result = parseResult({
        ...validEvent,
        tipId: '/home/user/secret/file.ts',
      });
      expect(result.success).toBe(false);
    });

    it('tipId rejects uppercase (slug = lowercase + digits + hyphens)', () => {
      const result = parseResult({
        ...validEvent,
        tipId: 'Magic-Word-Scaffold',
      });
      expect(result.success).toBe(false);
    });

    it('tipId rejects leading hyphen', () => {
      const result = parseResult({
        ...validEvent,
        tipId: '-starts-with-hyphen',
      });
      expect(result.success).toBe(false);
    });

    // P1-1 RED: slug-shaped string exceeding 64 chars must be rejected
    it('tipId rejects slug-shaped string exceeding max length (64 chars)', () => {
      // 100 lowercase chars — all valid slug characters, but too long
      const longSlug =
        'a-very-long-slug-that-keeps-going-and-going-until-it-exceeds-the-sixty-four-character-maximum-length-limit';
      expect(longSlug.length).toBeGreaterThan(64);
      expect(/^[a-z0-9][a-z0-9-]*$/.test(longSlug)).toBe(true); // valid pattern but too long
      const result = parseResult({
        ...validEvent,
        tipId: longSlug,
      });
      expect(result.success).toBe(false);
    });

    it('event field only accepts 3 known enum values', () => {
      const result = parseResult({
        ...validEvent,
        event: 'user_typed_something_sensitive',
      });
      expect(result.success).toBe(false);
    });

    it('context field only accepts known enum values', () => {
      const result = parseResult({
        ...validEvent,
        context: 'arbitrary_user_state_description',
      });
      expect(result.success).toBe(false);
    });

    it('surface field only accepts known enum values', () => {
      const result = parseResult({
        ...validEvent,
        surface: '/users/secret/path',
      });
      expect(result.success).toBe(false);
    });

    it('actionType field only accepts known enum values', () => {
      const result = parseResult({
        ...validEvent,
        actionType: 'execute_arbitrary_code',
      });
      expect(result.success).toBe(false);
    });

    it('outcome field only accepts known enum values', () => {
      const result = parseResult({
        ...validEvent,
        outcome: 'user said something private',
      });
      expect(result.success).toBe(false);
    });

    it('timestamp must be a non-negative integer (not a string)', () => {
      const result = parseResult({
        ...validEvent,
        timestamp: 'today at 3pm the user was working on...',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('event type completeness (no document-invented event kinds)', () => {
    it('accepts capability_tip_exposed', () => {
      expect(parseResult({ ...validEvent, event: 'capability_tip_exposed' }).success).toBe(true);
    });

    it('accepts capability_tip_action', () => {
      expect(
        parseResult({
          ...validEvent,
          event: 'capability_tip_action',
          actionType: 'open_concierge_draft',
          outcome: 'opened',
        }).success,
      ).toBe(true);
    });

    it('accepts capability_tip_dismissed', () => {
      expect(
        parseResult({
          ...validEvent,
          event: 'capability_tip_dismissed',
          outcome: 'dismissed',
        }).success,
      ).toBe(true);
    });

    it('rejects any other event kind', () => {
      expect(parseResult({ ...validEvent, event: 'capability_tip_clicked' }).success).toBe(false);
      expect(parseResult({ ...validEvent, event: 'capability_tip_hovered' }).success).toBe(false);
      expect(parseResult({ ...validEvent, event: 'user_behavior_tracked' }).success).toBe(false);
    });
  });

  describe('minimum valid event (no optional fields)', () => {
    it('accepts event with only required fields', () => {
      const minimal = {
        event: 'capability_tip_exposed',
        tipId: 'test-tip',
        context: 'thinking',
        surface: 'pending_bubble',
        timestamp: 1721000000000,
      };
      expect(parseResult(minimal).success).toBe(true);
    });

    it('all optional fields are truly optional', () => {
      const withOptionals = {
        event: 'capability_tip_action',
        tipId: 'test-tip',
        context: 'waiting_external',
        surface: 'assistant_stream_bubble',
        actionType: 'open_source',
        outcome: 'opened',
        timestamp: 1721000000000,
      };
      expect(parseResult(withOptionals).success).toBe(true);
    });
  });

  describe('batch envelope privacy (F268 pipeline-level)', () => {
    // These tests verify that the pipeline envelope we'll build cannot
    // carry content either. The envelope only wraps validated events.
    it('a batch of valid events passes when each event is individually valid', () => {
      const events = [
        { ...validEvent, tipId: 'tip-a', timestamp: 1721000000000 },
        { ...validEvent, tipId: 'tip-b', timestamp: 1721000001000 },
        { ...validEvent, tipId: 'tip-c', timestamp: 1721000002000 },
      ];
      for (const e of events) {
        expect(parseResult(e).success).toBe(true);
      }
    });

    it('a single invalid event in a batch is detectable', () => {
      const events = [
        { ...validEvent, tipId: 'tip-a', timestamp: 1721000000000 },
        { ...validEvent, tipId: 'tip-b', timestamp: 1721000001000, secretField: 'leaked' },
      ];
      expect(parseResult(events[0]).success).toBe(true);
      expect(parseResult(events[1]).success).toBe(false);
    });
  });
});
