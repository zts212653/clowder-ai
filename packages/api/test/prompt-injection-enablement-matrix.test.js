// F257 Console 判据⑥ — Enablement matrix API contract tests.
// Verifies that manifest and content endpoints expose a two-plane matrix
// (localOverlay × runtimeOverride) derived from safetyTier, allowLocalOverride,
// disableable and actual storage state, so the Console shows consistent CTA
// states and blocked reasons.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { promptInjectionRoutes } from '../dist/routes/prompt-injection.js';
import { promptInjectionManifestRoutes } from '../dist/routes/prompt-injection-manifest.js';

const OWNER = 'test-owner';
async function buildManifestApp(sessionUserId = OWNER) {
  const app = Fastify();
  if (sessionUserId) {
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = sessionUserId;
      done();
    });
  }
  await app.register(promptInjectionManifestRoutes);
  await app.ready();
  return app;
}

async function buildContentApp(sessionUserId = OWNER) {
  const app = Fastify();
  if (sessionUserId) {
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = sessionUserId;
      done();
    });
  }
  await app.register(promptInjectionRoutes);
  await app.ready();
  return app;
}

function assertActionPermissions(segmentId, plane, actions) {
  for (const action of actions) {
    assert.ok(Object.hasOwn(plane, action), `segment ${segmentId} missing action ${action}`);
    const permission = plane[action];
    assert.ok(Object.hasOwn(permission, 'allowed'));
    assert.ok(Object.hasOwn(permission, 'reason'));
    assert.ok(Object.hasOwn(permission, 'reasonCode'));
    if (permission.allowed) {
      assert.equal(permission.reason, null);
      assert.equal(permission.reasonCode, null);
    } else {
      assert.ok(permission.reason, `segment ${segmentId} action ${action} blocked without reason`);
      assert.ok(permission.reasonCode, `segment ${segmentId} action ${action} blocked without reasonCode`);
    }
  }
}

describe('prompt-injection enablement matrix (判据⑥)', () => {
  before(() => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER;
  });

  it('manifest exposes enablementMatrix for every segment', async () => {
    const app = await buildManifestApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.segments));
    assert.ok(body.segments.length > 0);
    for (const segment of body.segments) {
      assert.ok(segment.enablementMatrix, `segment ${segment.id} missing enablementMatrix`);
      const m = segment.enablementMatrix;
      assert.equal(m.segmentId, segment.id);
      assert.equal(m.safetyTier, segment.safetyTier);
      assert.equal(m.allowLocalOverride, segment.allowLocalOverride);
      assert.equal(m.disableable, segment.disableable);

      // Two-plane contract
      assert.ok(m.localOverlay, `segment ${segment.id} missing localOverlay`);
      assert.ok(m.runtimeOverride, `segment ${segment.id} missing runtimeOverride`);
      assert.ok(m.localOverlay.actions);
      assert.ok(m.runtimeOverride.actions);

      assertActionPermissions(segment.id, m.localOverlay.actions, ['edit', 'restoreBackup', 'reset']);
      assertActionPermissions(segment.id, m.runtimeOverride.actions, [
        'disable',
        'enable',
        'rollback',
        'activateVersion',
        'createVersion',
      ]);
    }
    await app.close();
  });

  // Judged per safety tier rather than "every formal template is editable": a formal
  // template may mount owner data (S14), and HookPipeline returns a contentOverride
  // verbatim without rendering variables, so an activated edit would replace the real
  // profile with the literal placeholder. Both tiers are asserted generically, and both
  // branches are proven non-empty so neither loop can pass vacuously.
  it('honors each formal template segment safety tier', async () => {
    const app = await buildManifestApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    const formalSegments = res.json().segments.filter((segment) => segment.sourceType === 'template');
    assert.ok(formalSegments.length > 0);
    const editable = formalSegments.filter((segment) => segment.safetyTier === 'editable');
    const readOnly = formalSegments.filter((segment) => segment.safetyTier === 'readonly');
    assert.ok(editable.length > 0, 'formal templates include editable governance copy');
    assert.ok(readOnly.length > 0, 'formal templates include a readonly owner-data mount');

    for (const segment of editable) {
      assert.equal(
        segment.enablementMatrix.runtimeOverride.actions.createVersion.allowed,
        true,
        `editable segment ${segment.id} must permit a governed version creation`,
      );
    }

    for (const segment of readOnly) {
      const runtime = segment.enablementMatrix.runtimeOverride.actions;
      for (const action of ['createVersion', 'activateVersion', 'disable']) {
        assert.equal(runtime[action].allowed, false, `readonly segment ${segment.id} must reject ${action}`);
      }
      assert.equal(
        segment.enablementMatrix.localOverlay.actions.edit.allowed,
        false,
        `readonly segment ${segment.id} must reject a content edit`,
      );
    }

    // The readonly branch must actually cover the owner-profile mount.
    assert.ok(
      readOnly.some((segment) => segment.id === 'S14'),
      'S14 mounts the owner profile and must be readonly',
    );
    await app.close();
  });

  it('formal segment is runtime editable while disable stays independently constrained', async () => {
    const app = await buildManifestApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    const { segments } = res.json();
    const s1 = segments.find((s) => s.id === 'S1');
    assert.ok(s1);
    assert.equal(s1.safetyTier, 'editable');
    assert.equal(s1.allowLocalOverride, true);
    const edit = s1.enablementMatrix.localOverlay.actions.edit;
    assert.equal(edit.allowed, false);
    assert.equal(edit.reasonCode, 'versioned-editor-required');
    const disable = s1.enablementMatrix.runtimeOverride.actions.disable;
    assert.equal(disable.allowed, false);
    assert.equal(disable.reasonCode, 'not-disableable');
    await app.close();
  });

  it('editable + disableable segment allows editing and runtime disable independently', async () => {
    const app = await buildManifestApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    const { segments } = res.json();
    const d10 = segments.find((s) => s.id === 'D10');
    assert.ok(d10);
    assert.equal(d10.safetyTier, 'editable');
    assert.equal(d10.allowLocalOverride, true);
    assert.equal(d10.disableable, true);
    assert.equal(d10.enablementMatrix.localOverlay.actions.edit.allowed, false);
    assert.equal(d10.enablementMatrix.localOverlay.actions.edit.reasonCode, 'versioned-editor-required');
    assert.equal(d10.enablementMatrix.runtimeOverride.actions.disable.allowed, true);
    await app.close();
  });

  it('content endpoint exposes enablementMatrix', async () => {
    const app = await buildContentApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/segment/S6/content' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.enablementMatrix);
    assert.equal(body.enablementMatrix.segmentId, 'S6');
    assert.ok(body.enablementMatrix.localOverlay.actions.edit);
    assert.ok(body.enablementMatrix.runtimeOverride.actions.disable);
    assert.equal(body.enablementMatrix.runtimeOverride.actions.createVersion.allowed, true);
    await app.close();
  });

  it('content endpoint exposes version creation while legacy local writes stay retired', async () => {
    const app = await buildContentApp();
    const c1 = await app.inject({ method: 'GET', url: '/api/prompt-injection/segment/C1/content' });
    assert.equal(c1.statusCode, 200);
    const c1Body = c1.json();
    assert.equal(c1Body.enablementMatrix.safetyTier, 'editable');
    assert.equal(c1Body.enablementMatrix.localOverlay.actions.edit.allowed, false);
    assert.equal(c1Body.enablementMatrix.localOverlay.actions.edit.reasonCode, 'versioned-editor-required');
    assert.equal(c1Body.enablementMatrix.runtimeOverride.actions.createVersion.allowed, true);

    const d1 = await app.inject({ method: 'GET', url: '/api/prompt-injection/segment/D1/content' });
    assert.equal(d1.statusCode, 200);
    const d1Body = d1.json();
    assert.equal(d1Body.enablementMatrix.safetyTier, 'editable');
    assert.equal(d1Body.enablementMatrix.localOverlay.actions.edit.allowed, false);
    assert.equal(d1Body.enablementMatrix.localOverlay.actions.edit.reasonCode, 'versioned-editor-required');
    assert.equal(d1Body.enablementMatrix.runtimeOverride.actions.createVersion.allowed, true);
    await app.close();
  });

  it('401 when unauthenticated', async () => {
    const app = await buildManifestApp(null);
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});
