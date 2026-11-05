import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { prepareReleaseSource } from '../scripts/f321-release-source.mjs';

test('both frozen release fixtures are consumable packages; original Task still authorizes only the first', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'f321-release-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  mkdirSync(project);
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=F321 fixture', '-c', 'user.email=fixture@localhost', ...args], {
      cwd: project,
      encoding: 'utf8',
    }).trim();
  git('init', '--quiet');
  const messages = [];
  const env = {
    root,
    project,
    git,
    consumerThreadId: 'consumer',
    sourceThreadId: 'source',
    tasks: new TaskStore(),
    append(content) {
      const message = { id: `message-${messages.length}`, content };
      messages.push(message);
      return message;
    },
  };
  const release = prepareReleaseSource(env);
  assert.equal(JSON.parse(readFileSync(join(project, 'packages/reader/package.json'))).version, '0.0.1-f321');
  assert.match(env.tasks.get(release.task.id).why, /@0\.0\.0-f321/);
  assert.match(messages[0].content, /@0\.0\.0-f321/);
  for (const candidate of release.candidates) {
    const consumer = join(root, `consumer-${candidate.version}`);
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    execFileSync(
      'npm',
      ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(project, candidate.tarball)],
      {
        cwd: consumer,
        encoding: 'utf8',
        env: { ...process.env, NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_CACHE: join(root, 'cache') },
      },
    );
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "import {read} from '@cat-cafe-fixture/reader';console.log(read('ready'))"],
      { cwd: consumer, encoding: 'utf8' },
    );
    assert.equal(output.trim(), 'ready');
    assert.equal(candidate.receipt.uploaded, false);
  }
});
