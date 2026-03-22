import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * ConnectorMessageFormatter — platform-agnostic message envelope generator.
 *
 * Takes cat reply metadata and produces a unified MessageEnvelope
 * that each adapter converts to its platform format.
 */

// Will import from the module once it exists
// import { ConnectorMessageFormatter, MessageEnvelope } from '../dist/infrastructure/connectors/ConnectorMessageFormatter.js';

describe('ConnectorMessageFormatter', () => {
  // Lazy import so the file can not-exist during the RED phase check
  let ConnectorMessageFormatter;

  it('module can be imported', async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorMessageFormatter.js');
    ConnectorMessageFormatter = mod.ConnectorMessageFormatter;
    assert.ok(ConnectorMessageFormatter, 'ConnectorMessageFormatter should be exported');
  });

  it('formats a basic reply with all envelope fields', async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorMessageFormatter.js');
    const formatter = new mod.ConnectorMessageFormatter();

    const envelope = formatter.format({
      catDisplayName: '布偶猫/宪宪',
      catEmoji: '🐱',
      threadShortId: 'T12',
      threadTitle: '飞书登录bug排查',
      featId: 'F088',
      body: '看了一下回调逻辑，问题出在 OAuth token 过期。',
      deepLinkUrl: 'https://cafe.clowder-ai.com/t/abc123',
      timestamp: new Date('2026-03-10T01:22:00Z'),
    });

    assert.equal(envelope.header, '🐱 布偶猫/宪宪');
    assert.equal(envelope.subtitle, 'T12 飞书登录bug排查 · F088');
    assert.equal(envelope.body, '看了一下回调逻辑，问题出在 OAuth token 过期。');
    assert.ok(envelope.footer.includes('cafe.clowder-ai.com/t/abc123'));
    assert.ok(envelope.footer.includes('01:22'));
  });

  it('omits featId from subtitle when not provided', async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorMessageFormatter.js');
    const formatter = new mod.ConnectorMessageFormatter();

    const envelope = formatter.format({
      catDisplayName: '缅因猫/砚砚',
      catEmoji: '🐱',
      threadShortId: 'T7',
      threadTitle: '周报整理',
      body: '已整理完毕。',
      deepLinkUrl: 'https://cafe.clowder-ai.com/t/def456',
      timestamp: new Date('2026-03-10T02:00:00Z'),
    });

    assert.equal(envelope.subtitle, 'T7 周报整理');
    assert.ok(!envelope.subtitle.includes('·'));
  });

  it('omits threadTitle from subtitle when not provided', async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorMessageFormatter.js');
    const formatter = new mod.ConnectorMessageFormatter();

    const envelope = formatter.format({
      catDisplayName: '布偶猫/宪宪',
      catEmoji: '🐱',
      threadShortId: 'T3',
      body: '收到。',
      deepLinkUrl: 'https://cafe.clowder-ai.com/t/ghi789',
      timestamp: new Date('2026-03-10T03:00:00Z'),
    });

    assert.equal(envelope.subtitle, 'T3');
  });

  it('handles missing deepLinkUrl gracefully', async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorMessageFormatter.js');
    const formatter = new mod.ConnectorMessageFormatter();

    const envelope = formatter.format({
      catDisplayName: '布偶猫/宪宪',
      catEmoji: '🐱',
      threadShortId: 'T1',
      body: 'Hello!',
      timestamp: new Date('2026-03-10T04:00:00Z'),
    });

    // Footer should still have time, but no link
    assert.ok(envelope.footer.includes('04:00'));
    assert.ok(!envelope.footer.includes('http'));
  });

  it('returns a well-typed MessageEnvelope with all 4 fields', async () => {
    const mod = await import('../dist/infrastructure/connectors/ConnectorMessageFormatter.js');
    const formatter = new mod.ConnectorMessageFormatter();

    const envelope = formatter.format({
      catDisplayName: '布偶猫/宪宪',
      catEmoji: '🐱',
      threadShortId: 'T5',
      threadTitle: 'Test',
      body: 'Content',
      deepLinkUrl: 'https://example.com',
      timestamp: new Date('2026-03-10T05:30:00Z'),
    });

    assert.equal(typeof envelope.header, 'string');
    assert.equal(typeof envelope.subtitle, 'string');
    assert.equal(typeof envelope.body, 'string');
    assert.equal(typeof envelope.footer, 'string');
    assert.deepEqual(Object.keys(envelope).sort(), ['body', 'footer', 'header', 'origin', 'subtitle']);
  });
});
