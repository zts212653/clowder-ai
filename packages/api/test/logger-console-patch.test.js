// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

const API_DIR = resolve(import.meta.dirname, '..');
const TEST_LOG_DIR = resolve(API_DIR, '.test-log-dir-185');

function readAllLogs() {
  const files = readdirSync(TEST_LOG_DIR).filter((f) => f.startsWith('api.'));
  return files.map((f) => readFileSync(join(TEST_LOG_DIR, f), 'utf-8')).join('\n');
}

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
  return { stdout: result.stdout, stderr: result.stderr };
}

function resetLogDir() {
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
  mkdirSync(TEST_LOG_DIR, { recursive: true });
}

describe('fix(#185): console→Pino patch', () => {
  before(() => mkdirSync(TEST_LOG_DIR, { recursive: true }));
  after(() => rmSync(TEST_LOG_DIR, { recursive: true, force: true }));

  it('console.log({ token }) is redacted in log file', () => {
    resetLogDir();
    runLoggerScript(`console.log({ token: 'secret-token-xyz' });`);
    const content = readAllLogs();
    assert.ok(content.includes('[REDACTED]'), 'token should be redacted');
    assert.ok(!content.includes('secret-token-xyz'), 'raw token must not appear');
  });

  it('console.info and console.debug write to log file', () => {
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

  it('stderr capture is preserved for process-layer redirection', () => {
    resetLogDir();
    const { stderr } = runLoggerScript(`console.log('stderr-marker-185');`);
    assert.ok(stderr.includes('stderr-marker-185'), 'console.log should write to stderr');
    assert.ok(stderr.includes('[console.log]'), 'stderr should preserve the original console method label');
  });

  it('console.log does not double-write raw stdout alongside pino json', () => {
    resetLogDir();
    const { stdout } = runLoggerScript(`console.log('stdout-once-marker-185');`);
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    assert.equal(lines.length, 1, 'stdout should only contain one structured log line');
    assert.ok(lines[0].includes('"msg":"stdout-once-marker-185"'), 'stdout should keep the pino JSON entry');
    assert.notEqual(lines[0], 'stdout-once-marker-185', 'raw console output should not be duplicated');
  });
});
