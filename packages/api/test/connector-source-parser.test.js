// @ts-check

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  parseConnectorSourceField,
  safeParseConnectorSource,
  safeParseExtra,
  safeParsePluginMessage,
} from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';

function historicalPluginMessage() {
  return {
    instanceId: 'pi-github',
    revision: 1,
    provenance: { origin: { kind: 'plugin', instanceId: 'pi-github' }, epistemicStatus: 'observation' },
    elements: [{ elementId: 'el-1', kind: 'text', payload: { text: 'historical body' } }],
    appendOps: [],
    presentation: {
      connector: 'github-operations',
      label: 'GitHub',
      icon: 'github',
      url: 'https://github.com/owner/repo/issues/42',
    },
  };
}

describe('safeParseConnectorSource (F97)', () => {
  it('projects known connector fields from historical storage without reviving unknown metadata', () => {
    const raw = JSON.stringify({
      connector: 'github-review',
      label: 'GitHub Review',
      icon: '🔔',
      url: 'https://github.com/org/repo/pull/42',
    });
    const result = safeParseConnectorSource(raw);
    assert.deepEqual(result, {
      connector: 'github-review',
      label: 'GitHub Review',
      icon: '🔔',
    });
    assert.strictEqual(Object.hasOwn(result, 'url'), false);
  });

  it('returns undefined for undefined input', () => {
    assert.strictEqual(safeParseConnectorSource(undefined), undefined);
  });

  it('returns undefined for empty string', () => {
    assert.strictEqual(safeParseConnectorSource(''), undefined);
  });

  it('returns undefined for invalid JSON', () => {
    assert.strictEqual(safeParseConnectorSource('not json'), undefined);
  });

  it('returns undefined when missing required fields', () => {
    // Missing icon
    const raw = JSON.stringify({ connector: 'github-review', label: 'GitHub Review' });
    assert.strictEqual(safeParseConnectorSource(raw), undefined);
  });

  it('returns undefined for non-string fields', () => {
    const raw = JSON.stringify({ connector: 123, label: 'GitHub Review', icon: '🔔' });
    assert.strictEqual(safeParseConnectorSource(raw), undefined);
  });

  it('returns undefined for null input value', () => {
    const raw = JSON.stringify(null);
    assert.strictEqual(safeParseConnectorSource(raw), undefined);
  });

  it('returns undefined for array input', () => {
    const raw = JSON.stringify(['github-review']);
    assert.strictEqual(safeParseConnectorSource(raw), undefined);
  });

  it('parses a current source when optional fields are absent', () => {
    const raw = JSON.stringify({
      connector: 'github-review',
      label: 'GitHub Review',
      icon: '🔔',
    });
    const result = safeParseConnectorSource(raw);
    assert.ok(result);
    assert.strictEqual(Object.hasOwn(result, 'url'), false);
  });
});

describe('parseConnectorSourceField', () => {
  it('distinguishes an absent field from malformed persisted provenance', () => {
    assert.deepEqual(parseConnectorSourceField(undefined), { kind: 'absent' });
    assert.deepEqual(parseConnectorSourceField(''), { kind: 'invalid' });
    assert.deepEqual(parseConnectorSourceField('{'), { kind: 'invalid' });
    assert.deepEqual(parseConnectorSourceField(JSON.stringify({ connector: 'github-wait' })), {
      kind: 'invalid',
    });
  });

  it('returns validated connector provenance without normalization', () => {
    const source = { connector: 'github-wait', label: 'GitHub wait', icon: 'github' };
    assert.deepEqual(parseConnectorSourceField(JSON.stringify(source)), { kind: 'valid', source });
  });
});

describe('historical plugin presentation hydration', () => {
  const expectedPresentation = {
    connector: 'github-operations',
    label: 'GitHub',
    icon: 'github',
  };

  it('projects the independent pluginMessage field to the current presentation contract', () => {
    const parsed = safeParsePluginMessage(JSON.stringify(historicalPluginMessage()));
    assert.deepEqual(parsed?.presentation, expectedPresentation);
    assert.strictEqual(Object.hasOwn(parsed.presentation, 'url'), false);
  });

  it('projects the pre-F288 embedded pluginMessage through the same contract', () => {
    const parsed = safeParseExtra(JSON.stringify({ pluginMessage: historicalPluginMessage() }));
    assert.deepEqual(parsed?.pluginMessage?.presentation, expectedPresentation);
    assert.strictEqual(Object.hasOwn(parsed.pluginMessage.presentation, 'url'), false);
  });
});
