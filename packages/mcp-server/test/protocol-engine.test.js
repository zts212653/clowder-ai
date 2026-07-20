/**
 * Protocol engine unit tests — template rendering, JSONPath, auth, YAML loading
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  extractJsonPath,
  extractString,
  getAuthStrategy,
  loadProtocolsFromDir,
  loadProtocolTemplate,
  ProtocolTemplateSchema,
  renderBody,
  renderTemplate,
  scrubCredentials,
} from '../dist/protocol-engine/index.js';

// ── Template rendering ──

describe('renderTemplate', () => {
  it('substitutes simple variables', () => {
    assert.equal(renderTemplate('Hello {{name}}!', { name: 'World' }), 'Hello World!');
  });

  it('applies default filter for missing variable', () => {
    assert.equal(renderTemplate('model={{model | default:cogvideox-flash}}', {}), 'model=cogvideox-flash');
  });

  it('uses actual value over default when present', () => {
    assert.equal(renderTemplate('model={{model | default:cogvideox-flash}}', { model: 'kling-v2' }), 'model=kling-v2');
  });

  it('applies base64 filter', () => {
    const result = renderTemplate('data={{content | base64}}', { content: 'hello' });
    assert.equal(result, `data=${Buffer.from('hello').toString('base64')}`);
  });

  it('replaces missing variable with empty string', () => {
    assert.equal(renderTemplate('key={{missing}}', {}), 'key=');
  });

  it('handles multiple variables in one string', () => {
    assert.equal(renderTemplate('{{a}}/{{b}}/{{c}}', { a: 'x', b: 'y', c: 'z' }), 'x/y/z');
  });
});

describe('renderBody', () => {
  it('recursively renders object values', () => {
    const body = { model: '{{model}}', prompt: '{{prompt}}' };
    const result = renderBody(body, { model: 'test', prompt: 'hello' });
    assert.deepEqual(result, { model: 'test', prompt: 'hello' });
  });

  it('renders arrays', () => {
    const body = ['{{a}}', '{{b}}'];
    assert.deepEqual(renderBody(body, { a: '1', b: '2' }), ['1', '2']);
  });

  it('handles nested objects', () => {
    const body = { outer: { inner: '{{val}}' } };
    assert.deepEqual(renderBody(body, { val: 'deep' }), { outer: { inner: 'deep' } });
  });

  it('passes through non-string primitives', () => {
    assert.equal(renderBody(42, {}), 42);
    assert.equal(renderBody(null, {}), null);
    assert.equal(renderBody(true, {}), true);
  });
});

// ── JSONPath extraction ──

describe('extractJsonPath', () => {
  const data = {
    id: 'task-123',
    data: {
      task_id: 'abc',
      task_status: 'succeed',
      task_result: {
        videos: [{ url: 'https://cdn.example.com/v.mp4', duration: '5s' }],
      },
    },
    candidates: [{ content: { parts: [{ text: 'analysis result' }] } }],
    video_result: [{ url: 'https://cdn.example.com/cog.mp4', cover_image_url: 'https://cdn.example.com/cover.jpg' }],
  };

  it('extracts top-level field', () => {
    assert.equal(extractJsonPath(data, '$.id'), 'task-123');
  });

  it('extracts nested field', () => {
    assert.equal(extractJsonPath(data, '$.data.task_id'), 'abc');
  });

  it('extracts deeply nested field', () => {
    assert.equal(extractJsonPath(data, '$.data.task_result.videos[0].url'), 'https://cdn.example.com/v.mp4');
  });

  it('extracts Gemini-style response', () => {
    assert.equal(extractJsonPath(data, '$.candidates[0].content.parts[0].text'), 'analysis result');
  });

  it('extracts CogVideoX-style response', () => {
    assert.equal(extractJsonPath(data, '$.video_result[0].url'), 'https://cdn.example.com/cog.mp4');
  });

  it('returns undefined for missing path', () => {
    assert.equal(extractJsonPath(data, '$.nonexistent.field'), undefined);
  });

  it('returns undefined for invalid root', () => {
    assert.equal(extractJsonPath(null, '$.foo'), undefined);
  });
});

describe('extractString', () => {
  it('converts number to string', () => {
    assert.equal(extractString({ code: 10000 }, '$.code'), '10000');
  });
});

// ── Auth strategies ──

describe('auth strategies', () => {
  it('apikey produces Bearer header', () => {
    const strategy = getAuthStrategy('apikey');
    const result = strategy.sign({ apiKey: 'sk-test' }, { method: 'POST', url: 'https://api.example.com' });
    assert.equal(result.headers?.['Authorization'], 'Bearer sk-test');
  });

  it('query-param produces query params', () => {
    const strategy = getAuthStrategy('query-param');
    const result = strategy.sign({ apiKey: 'qk-test' }, { method: 'POST', url: 'https://api.example.com' });
    assert.equal(result.queryParams?.['key'], 'qk-test');
  });

  it('jwt-hs256 produces a valid JWT structure', () => {
    const strategy = getAuthStrategy('jwt-hs256');
    const result = strategy.sign(
      { accessKey: 'ak-test', secretKey: 'sk-test' },
      { method: 'POST', url: 'https://api.example.com' },
    );
    const token = result.headers?.['Authorization']?.replace('Bearer ', '');
    assert.ok(token);
    const parts = token.split('.');
    assert.equal(parts.length, 3, 'JWT should have 3 parts');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    assert.equal(header.alg, 'HS256');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.equal(payload.iss, 'ak-test');
    assert.ok(payload.exp > payload.iat);
  });

  it('hmac-sha256-v4 produces Authorization header', () => {
    const strategy = getAuthStrategy('hmac-sha256-v4');
    const result = strategy.sign(
      { accessKey: 'ak', secretKey: 'sk', region: 'cn-north-1', service: 'cv' },
      { method: 'POST', url: 'https://visual.volcengineapi.com/', body: '{}' },
    );
    assert.ok(result.headers?.['Authorization']?.startsWith('HMAC-SHA256'));
    assert.ok(result.headers?.['X-Date']);
    assert.ok(result.headers?.['X-Content-Sha256']);
  });

  it('throws on unknown auth type', () => {
    assert.throws(() => getAuthStrategy('unknown'), /Unknown auth type/);
  });
});

// ── Protocol template schema validation ──

describe('ProtocolTemplateSchema', () => {
  it('validates a minimal async template', () => {
    const template = {
      name: 'test',
      version: 1,
      mode: 'async',
      capabilities: {
        text2video: {
          submit: {
            method: 'POST',
            path: '/api/v1/generate',
            body: { prompt: '{{prompt}}' },
            response: { taskId: '$.id' },
          },
          poll: {
            method: 'GET',
            path: '/api/v1/status/{{taskId}}',
            response: {
              status: '$.status',
              statusMap: { succeeded: ['done'], failed: ['error'] },
              resultUrl: '$.result_url',
            },
          },
        },
      },
    };
    const result = ProtocolTemplateSchema.parse(template);
    assert.equal(result.name, 'test');
    assert.equal(result.mode, 'async');
  });

  it('validates a minimal sync template', () => {
    const template = {
      name: 'test-sync',
      version: 1,
      mode: 'sync',
      capabilities: {
        analyze: {
          request: {
            method: 'POST',
            path: '/api/v1/analyze',
            body: { prompt: '{{prompt}}' },
            response: { result: '$.result' },
          },
        },
      },
    };
    const result = ProtocolTemplateSchema.parse(template);
    assert.equal(result.mode, 'sync');
  });

  it('rejects template without name', () => {
    assert.throws(() => ProtocolTemplateSchema.parse({ version: 1, mode: 'async', capabilities: {} }));
  });

  it('rejects invalid mode', () => {
    assert.throws(() => ProtocolTemplateSchema.parse({ name: 'x', version: 1, mode: 'streaming', capabilities: {} }));
  });
});

// ── YAML loader ──

describe('loadProtocolTemplate', () => {
  it('loads and validates a YAML protocol file', () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'proto-test-'));
    const yamlContent = [
      'name: test-proto',
      'version: 1',
      'mode: async',
      'capabilities:',
      '  text2video:',
      '    submit:',
      '      method: POST',
      '      path: /api/generate',
      '      response:',
      '        taskId: $.id',
      '    poll:',
      '      method: GET',
      '      path: /api/status/{{taskId}}',
      '      response:',
      '        status: $.status',
      '        statusMap:',
      '          succeeded: [done]',
      '        resultUrl: $.url',
    ].join('\n');
    const filePath = join(tmpDir, 'test.yaml');
    writeFileSync(filePath, yamlContent);

    const template = loadProtocolTemplate(filePath);
    assert.equal(template.name, 'test-proto');
    assert.equal(template.mode, 'async');
    assert.ok(template.capabilities['text2video']);
  });
});

describe('loadProtocolsFromDir', () => {
  it('loads all YAML files from directory', () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'proto-dir-test-'));
    writeFileSync(
      join(tmpDir, 'a.yaml'),
      'name: proto-a\nversion: 1\nmode: async\ncapabilities:\n  gen:\n    submit:\n      method: POST\n      path: /a\n      response:\n        taskId: $.id\n    poll:\n      method: GET\n      path: /a/{{taskId}}\n      response:\n        status: $.s\n        resultUrl: $.u',
    );
    writeFileSync(
      join(tmpDir, 'b.yml'),
      'name: proto-b\nversion: 1\nmode: sync\ncapabilities:\n  analyze:\n    request:\n      method: POST\n      path: /b\n      response:\n        result: $.r',
    );

    const templates = loadProtocolsFromDir(tmpDir);
    assert.equal(templates.size, 2);
    assert.ok(templates.has('proto-a'));
    assert.ok(templates.has('proto-b'));
  });

  it('returns empty map for nonexistent dir', () => {
    const templates = loadProtocolsFromDir('/nonexistent/path');
    assert.equal(templates.size, 0);
  });
});

// ── Real protocol template validation ──

describe('real protocol templates', () => {
  const protocolsDir = join(import.meta.dirname, '../../api/src/plugins');

  it('video-gen protocols all validate and have baseUrl', () => {
    const dir = join(protocolsDir, 'video-gen/protocols');
    const templates = loadProtocolsFromDir(dir);
    assert.ok(templates.size >= 3, `Expected ≥3 video-gen protocols, got ${templates.size}`);
    for (const [name, t] of templates) {
      assert.equal(t.mode, 'async', `${name} should be async`);
      assert.ok(t.capabilities['text2video'], `${name} should have text2video`);
      assert.ok(t.baseUrl, `${name} should have a default baseUrl`);
    }
  });

  it('video-gen poll configs have interval and maxAttempts', () => {
    const dir = join(protocolsDir, 'video-gen/protocols');
    const templates = loadProtocolsFromDir(dir);
    for (const [name, t] of templates) {
      const cap = t.capabilities['text2video'];
      const poll = cap?.poll ?? (cap?.inherit ? t.capabilities[cap.inherit]?.poll : undefined);
      assert.ok(poll, `${name} text2video should resolve a poll definition`);
      assert.ok(poll.interval >= 1000, `${name} poll.interval should be ≥1000ms, got ${poll.interval}`);
      assert.ok(poll.maxAttempts >= 1, `${name} poll.maxAttempts should be ≥1, got ${poll.maxAttempts}`);
    }
  });

  it('video-analysis protocols all validate and have baseUrl', () => {
    const dir = join(protocolsDir, 'video-analysis/protocols');
    const templates = loadProtocolsFromDir(dir);
    assert.ok(templates.size >= 2, `Expected ≥2 video-analysis protocols, got ${templates.size}`);
    for (const [name, t] of templates) {
      assert.equal(t.mode, 'sync', `${name} should be sync`);
      assert.ok(
        t.capabilities['analyze'] || t.capabilities['analyze_url'],
        `${name} should have an analyze capability`,
      );
      assert.ok(t.baseUrl, `${name} should have a default baseUrl`);
    }
  });
});

// ── Credential scrubbing ──

describe('scrubCredentials', () => {
  it('replaces credential value in text', () => {
    const text = 'Error: invalid key sk-secret-abc-123 in request';
    const creds = { apiKey: 'sk-secret-abc-123' };
    assert.equal(scrubCredentials(text, creds), 'Error: invalid key *** in request');
  });

  it('replaces multiple credential values', () => {
    const text = 'ak=myAccessKey, sk=mySecretKey';
    const creds = { accessKey: 'myAccessKey', secretKey: 'mySecretKey' };
    const result = scrubCredentials(text, creds);
    assert.equal(result, 'ak=***, sk=***');
  });

  it('skips short credential values (< 4 chars)', () => {
    const text = 'code=abc in response';
    const creds = { apiKey: 'abc' };
    assert.equal(scrubCredentials(text, creds), 'code=abc in response');
  });

  it('returns text unchanged when no credentials match', () => {
    const text = 'normal error message';
    const creds = { apiKey: 'sk-something-else' };
    assert.equal(scrubCredentials(text, creds), 'normal error message');
  });

  it('handles empty credentials record', () => {
    const text = 'some text';
    assert.equal(scrubCredentials(text, {}), 'some text');
  });

  it('handles credential appearing multiple times', () => {
    const text = 'sk-test echoed: sk-test';
    const creds = { apiKey: 'sk-test' };
    assert.equal(scrubCredentials(text, creds), '*** echoed: ***');
  });

  it('excludes _-prefixed metadata keys from scrubbing', () => {
    const url = 'https://cdn.example/video.mp4?api_key=public-label';
    const creds = { apiKey: 'real-secret-key', _authParamName: 'api_key' };
    const result = scrubCredentials(url, creds);
    assert.equal(result, 'https://cdn.example/video.mp4?api_key=public-label');
    assert.ok(!result.includes('***'), 'metadata value should not be scrubbed');
  });

  it('replaces longest credential first to avoid partial residue', () => {
    const text = 'key=sk-long-secret-key and sk-long-secret-key-extended';
    const creds = { short: 'sk-long-secret-key', long: 'sk-long-secret-key-extended' };
    const result = scrubCredentials(text, creds);
    assert.equal(result, 'key=*** and ***');
  });
});

describe('buildSecretsList', () => {
  it('includes auth-derived artifacts in secrets list', async () => {
    const { buildSecretsList } = await import('../dist/protocol-engine/index.js');
    const creds = { apiKey: 'sk-test-key' };
    const artifacts = ['Bearer sk-test-key', 'eyJhbGciOiJIUzI1NiJ9.payload.sig'];
    const secrets = buildSecretsList(creds, artifacts);
    assert.ok(secrets.includes('sk-test-key'));
    assert.ok(secrets.includes('Bearer sk-test-key'));
    assert.ok(secrets.includes('eyJhbGciOiJIUzI1NiJ9.payload.sig'));
    // Longest first
    assert.ok(secrets.indexOf('eyJhbGciOiJIUzI1NiJ9.payload.sig') < secrets.indexOf('sk-test-key'));
  });

  it('deduplicates overlapping values', async () => {
    const { buildSecretsList } = await import('../dist/protocol-engine/index.js');
    const creds = { apiKey: 'sk-test' };
    const artifacts = ['sk-test', 'Bearer sk-test'];
    const secrets = buildSecretsList(creds, artifacts);
    const skCount = secrets.filter((s) => s === 'sk-test').length;
    assert.equal(skCount, 1, 'Should not duplicate');
  });
});

// ── Protocol tools (deriveMimeType, buildProviderFromEnv) ──

import { buildCredentialsFromEnv, buildProviderFromEnv } from '../dist/tools/protocol-tools.js';

describe('buildProviderFromEnv', () => {
  const origEnv = { ...process.env };
  const cleanup = () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('TEST_PFX_')) delete process.env[k];
    }
  };

  it('returns null when PROVIDER not set', () => {
    cleanup();
    assert.equal(buildProviderFromEnv('TEST_PFX'), null);
  });

  it('uses env BASE_URL when set', () => {
    cleanup();
    process.env['TEST_PFX_PROVIDER'] = 'zhipu';
    process.env['TEST_PFX_BASE_URL'] = 'https://custom.example.com';
    const provider = buildProviderFromEnv('TEST_PFX', 'https://default.example.com');
    assert.equal(provider?.baseUrl, 'https://custom.example.com');
    cleanup();
  });

  it('falls back to templateBaseUrl when env BASE_URL not set', () => {
    cleanup();
    process.env['TEST_PFX_PROVIDER'] = 'zhipu';
    const provider = buildProviderFromEnv('TEST_PFX', 'https://default.example.com');
    assert.equal(provider?.baseUrl, 'https://default.example.com');
    cleanup();
  });

  it('uses empty string when neither env nor template baseUrl available', () => {
    cleanup();
    process.env['TEST_PFX_PROVIDER'] = 'zhipu';
    const provider = buildProviderFromEnv('TEST_PFX');
    assert.equal(provider?.baseUrl, '');
    cleanup();
  });

  it('uses env AUTH_TYPE over template auth', () => {
    cleanup();
    process.env['TEST_PFX_PROVIDER'] = 'gemini';
    process.env['TEST_PFX_AUTH_TYPE'] = 'jwt-hs256';
    const provider = buildProviderFromEnv('TEST_PFX', undefined, 'query-param');
    assert.equal(provider?.authType, 'jwt-hs256');
    cleanup();
  });

  it('falls back to templateAuthType when env AUTH_TYPE not set', () => {
    cleanup();
    process.env['TEST_PFX_PROVIDER'] = 'gemini';
    const provider = buildProviderFromEnv('TEST_PFX', undefined, 'query-param');
    assert.equal(provider?.authType, 'query-param');
    cleanup();
  });

  it('defaults to apikey when no auth type specified', () => {
    cleanup();
    process.env['TEST_PFX_PROVIDER'] = 'test';
    const provider = buildProviderFromEnv('TEST_PFX');
    assert.equal(provider?.authType, 'apikey');
    cleanup();
  });
});

describe('ProtocolTemplateSchema with baseUrl', () => {
  it('accepts template with baseUrl', () => {
    const template = {
      name: 'test',
      version: 1,
      mode: 'async',
      baseUrl: 'https://api.example.com',
      capabilities: {
        gen: {
          submit: { method: 'POST', path: '/gen', response: { taskId: '$.id' } },
          poll: { method: 'GET', path: '/status/{{taskId}}', response: { status: '$.s', resultUrl: '$.u' } },
        },
      },
    };
    const result = ProtocolTemplateSchema.parse(template);
    assert.equal(result.baseUrl, 'https://api.example.com');
  });

  it('accepts template without baseUrl', () => {
    const template = {
      name: 'test',
      version: 1,
      mode: 'async',
      capabilities: {
        gen: {
          submit: { method: 'POST', path: '/gen', response: { taskId: '$.id' } },
          poll: { method: 'GET', path: '/status/{{taskId}}', response: { status: '$.s', resultUrl: '$.u' } },
        },
      },
    };
    const result = ProtocolTemplateSchema.parse(template);
    assert.equal(result.baseUrl, undefined);
  });

  it('rejects invalid baseUrl', () => {
    assert.throws(
      () =>
        ProtocolTemplateSchema.parse({
          name: 'test',
          version: 1,
          mode: 'async',
          baseUrl: 'not-a-url',
          capabilities: {},
        }),
      /Invalid url/,
    );
  });
});
