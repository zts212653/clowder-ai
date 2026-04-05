/**
 * Skills route tests
 * GET /api/skills — Clowder AI 共享 Skills 看板数据
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { skillsRoutes } from '../dist/routes/skills.js';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

describe('Skills Route', () => {
  it('returns 401 when no identity header is provided', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));

    await app.close();
  });

  it('GET /api/skills returns skills array and summary', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // Response structure
    assert.ok(Array.isArray(body.skills), 'skills should be an array');
    assert.ok(body.summary, 'should have summary');
    assert.equal(typeof body.summary.total, 'number');
    assert.equal(typeof body.summary.allMounted, 'boolean');
    assert.equal(typeof body.summary.registrationConsistent, 'boolean');

    await app.close();
  });

  it('each skill entry has required fields', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    if (body.skills.length === 0) {
      // No skills found (possible in CI), skip field checks
      await app.close();
      return;
    }

    for (const skill of body.skills) {
      assert.equal(typeof skill.name, 'string', 'name should be string');
      assert.equal(typeof skill.category, 'string', 'category should be string');
      assert.equal(typeof skill.trigger, 'string', 'trigger should be string');
      assert.ok(skill.mounts, 'should have mounts');
      assert.equal(typeof skill.mounts.claude, 'boolean');
      assert.equal(typeof skill.mounts.codex, 'boolean');
      assert.equal(typeof skill.mounts.gemini, 'boolean');
      assert.equal(typeof skill.mounts.kimi, 'boolean');
    }

    await app.close();
  });

  it('skills follow BOOTSTRAP ordering (registered before unregistered)', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    if (body.skills.length === 0) {
      await app.close();
      return;
    }

    // Skills with a category (from BOOTSTRAP) should come before '未分类'
    let seenUnregistered = false;
    for (const skill of body.skills) {
      if (skill.category === '未分类') {
        seenUnregistered = true;
      } else if (seenUnregistered) {
        assert.fail(`Registered skill "${skill.name}" appeared after unregistered skill — ordering violated`);
      }
    }

    await app.close();
  });

  it('summary.total matches skills array length', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    assert.equal(body.summary.total, body.skills.length);

    await app.close();
  });

  it('exposes required MCP dependency status for routed skills', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const browserAutomation = body.skills.find((skill) => skill.name === 'browser-automation');
    const pencilDesign = body.skills.find((skill) => skill.name === 'pencil-design');

    assert.ok(browserAutomation, 'browser-automation should be present in skills board');
    assert.ok(pencilDesign, 'pencil-design should be present in skills board');
    assert.deepEqual(
      browserAutomation.requiresMcp?.map((dep) => dep.id),
      ['playwright', 'claude-in-chrome', 'agent-browser', 'pinchtab'],
      'browser-automation should declare all browser backend dependencies',
    );
    assert.deepEqual(
      pencilDesign.requiresMcp?.map((dep) => dep.id),
      ['pencil'],
      'pencil-design should declare pencil dependency',
    );

    for (const dep of [...browserAutomation.requiresMcp, ...pencilDesign.requiresMcp]) {
      assert.match(dep.status, /^(ready|missing|unresolved)$/);
    }

    await app.close();
  });
});
