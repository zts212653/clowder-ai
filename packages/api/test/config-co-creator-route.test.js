import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { configRoutes } from '../dist/routes/config.js';

const tempDirs = [];
let savedTemplatePath;

function makeTemplate() {
  return {
    version: 2,
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        avatar: '/avatars/opus.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@opus', '@布偶猫'],
        roleDescription: '主架构师',
        defaultVariantId: 'opus-default',
        variants: [
          {
            id: 'opus-default',
            provider: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
        ],
      },
    ],
    roster: {
      opus: {
        family: 'ragdoll',
        roles: ['architect'],
        lead: true,
        available: true,
        evaluation: 'primary',
      },
    },
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    coCreator: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

function createProjectRoot() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'config-owner-route-'));
  tempDirs.push(projectRoot);
  writeFileSync(join(projectRoot, 'cat-template.json'), JSON.stringify(makeTemplate(), null, 2));
  return projectRoot;
}

describe('PATCH /api/config/co-creator', () => {
  let app;

  afterEach(async () => {
    if (savedTemplatePath === undefined) {
      delete process.env.CAT_TEMPLATE_PATH;
    } else {
      process.env.CAT_TEMPLATE_PATH = savedTemplatePath;
    }
    if (app) await app.close();
  });

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists owner identity fields into the runtime catalog and returns updated snapshot', async () => {
    const projectRoot = createProjectRoot();
    savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config/co-creator',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      payload: {
        name: 'Lang',
        aliases: ['共创伙伴', 'Lang'],
        mentionPatterns: ['@co-worker', '@lang'],
        avatar: '/uploads/owner-lang.png',
        color: { primary: '#D49266', secondary: '#FFE4D6' },
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.config.coCreator.name, 'Lang');
    assert.deepEqual(body.config.coCreator.aliases, ['共创伙伴', 'Lang']);
    assert.deepEqual(body.config.coCreator.mentionPatterns, ['@co-worker', '@lang']);
    assert.equal(body.config.coCreator.avatar, '/uploads/owner-lang.png');
    assert.deepEqual(body.config.coCreator.color, { primary: '#D49266', secondary: '#FFE4D6' });
  });

  it('rejects owner mention patterns that overlap cat aliases', async () => {
    const projectRoot = createProjectRoot();
    savedTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = join(projectRoot, 'cat-template.json');

    app = Fastify();
    await app.register(configRoutes, { projectRoot });
    await app.ready();

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config/co-creator',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'codex',
      },
      payload: {
        name: 'Co-worker',
        aliases: ['共创伙伴'],
        mentionPatterns: ['@owner', '@opus'],
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /co-creator mention alias "@opus" conflicts with cat "opus"/);
  });
});
