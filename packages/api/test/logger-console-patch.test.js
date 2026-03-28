// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Regression tests for fix(#185): console.* → Pino redaction + coverage.
 *
 * Spawns a child process that imports the logger with a temp LOG_DIR,
 * exercises console methods, then asserts on the rolled log file.
 */

const API_DIR = resolve(import.meta.dirname, '..');
const TEST_LOG_DIR = resolve(API_DIR, '.test-log-dir-185');

/** Read all rolled log files in the test dir and return concatenated content. */
function readAllLogs() {
  const files = readdirSync(TEST_LOG_DIR).filter((f) => f.startsWith('api.'));
  return files.map((f) => readFileSync(join(TEST_LOG_DIR, f), 'utf-8')).join('\n');
}

/** Spawn child process that imports logger, runs snippet, waits for flush. */
function runLoggerScript(snippet) {
  const script = `
    process.env.LOG_DIR = ${JSON.stringify(TEST_LOG_DIR)};
    process.env.LOG_LEVEL = 'debug';
    const mod = await import('./dist/infrastructure/logger.js');
    ${snippet}
    await new Promise(r => setTimeout(r, 1500));
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', script], {
    cwd: API_DIR,
    timeout: 10000,
    encoding: 'utf-8',
  });
  if (result.status !== 0) throw new Error(`Script failed: ${result.stderr}`);
  return { stderr: result.stderr };
}

function resetLogDir() {
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });
}

describe('fix(#185): console→Pino patch', () => {
  before(() => mkdirSync(TEST_LOG_DIR, { recursive: true }));
  after(() => rmSync(TEST_LOG_DIR, { recursive: true, force: true }));

  it('console.log({ token }) is redacted in log file (P1 security)', () => {
    resetLogDir();
    runLoggerScript(`console.log({ token: 'secret-token-xyz' });`);
    const content = readAllLogs();
    assert.ok(content.includes('[REDACTED]'), 'token should be redacted');
    assert.ok(!content.includes('secret-token-xyz'), 'raw token must not appear');
  });

  it('console.info and console.debug write to log file (P1 coverage)', () => {
    resetLogDir();
    runLoggerScript(`
      console.info('info-marker-185');
      console.debug('debug-marker-185');
    `);
    const content = readAllLogs();
    assert.ok(content.includes('info-marker-185'), 'console.info should appear in log file');
    assert.ok(content.includes('debug-marker-185'), 'console.debug should appear in log file');
  });

  it('LOG_DIR env var controls log file location', () => {
    resetLogDir();
    runLoggerScript(`mod.logger.info('logdir-marker-185');`);
    const content = readAllLogs();
    assert.ok(content.includes('logdir-marker-185'), 'log should be written to LOG_DIR path');
  });

  it('mixed args: objects get redacted, strings become msg', () => {
    resetLogDir();
    runLoggerScript(`console.log('User action:', { apiKey: 'sk-secret-key' });`);
    const content = readAllLogs();
    assert.ok(content.includes('[REDACTED]'), 'apiKey should be redacted');
    assert.ok(!content.includes('sk-secret-key'), 'raw apiKey must not appear');
    assert.ok(content.includes('User action:'), 'string part should appear as msg');
  });

  it('P2: stderr capture preserved for 2>> redirection', () => {
    resetLogDir();
    const { stderr } = runLoggerScript(`console.log('stderr-marker-185');`);
    assert.ok(stderr.includes('stderr-marker-185'), 'console.log should write to stderr');
    assert.ok(stderr.includes('[console.info]'), 'stderr should have [console.level] prefix');
  });

  it('P2: printf-style formatting preserved in log msg', () => {
    resetLogDir();
    runLoggerScript(`console.log('id=%d name=%s', 42, 'foo');`);
    const content = readAllLogs();
    assert.ok(content.includes('id=42 name=foo'), 'printf placeholders should be interpolated');
    assert.ok(!content.includes('%d'), '%d should not remain uninterpolated');
  });

  it('P2: array containing sensitive object is redacted', () => {
    resetLogDir();
    runLoggerScript(`console.log([{ token: 'array-secret-token' }]);`);
    const content = readAllLogs();
    assert.ok(content.includes('[REDACTED]'), 'token in array should be redacted');
    assert.ok(!content.includes('array-secret-token'), 'raw token in array must not appear');
  });

  it('P1: nested objects have sensitive keys redacted at any depth', () => {
    resetLogDir();
    runLoggerScript(`console.log({ context: { token: 'nested-secret' } });`);
    const content = readAllLogs();
    assert.ok(content.includes('[REDACTED]'), 'nested token should be redacted');
    assert.ok(!content.includes('nested-secret'), 'raw nested token must not appear');
  });

  it('P1: bracket-path keys (x-api-key, set-cookie) are redacted', () => {
    resetLogDir();
    runLoggerScript(`console.log({ headers: { 'x-api-key': 'key-abc', 'set-cookie': 'sess=xyz' } });`);
    const content = readAllLogs();
    assert.ok(!content.includes('key-abc'), 'x-api-key value must not appear');
    assert.ok(!content.includes('sess=xyz'), 'set-cookie value must not appear');
  });

  it('P1: circular objects do not crash', () => {
    resetLogDir();
    runLoggerScript(`const obj = { name: 'test' }; obj.self = obj; console.log(obj);`);
    const content = readAllLogs();
    assert.ok(content.includes('Circular'), 'circular ref should be replaced');
    assert.ok(content.includes('test'), 'non-circular fields should appear');
  });

  it('P2: printf + object mix preserves interpolation', () => {
    resetLogDir();
    runLoggerScript(`console.log('count=%d', 42, { token: 'mix-secret' });`);
    const content = readAllLogs();
    assert.ok(content.includes('count=42'), 'printf should be interpolated');
    assert.ok(!content.includes('mix-secret'), 'token must be redacted');
    assert.ok(!content.includes('%d'), '%d should not remain');
  });
});
