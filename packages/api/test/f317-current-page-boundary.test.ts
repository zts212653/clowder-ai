import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCdpPageChoice } from '../src/domains/concierge/action/CdpPageBrowserTask.js';
import {
  currentControlVisible,
  permittedCurrentControl,
} from '../src/domains/concierge/action/jev/CurrentPageControlTask.js';
import {
  currentPageConfigSchema,
  selectableOwnerPage,
} from '../src/domains/concierge/action/jev/OwnerCurrentPageBrowser.js';
import { validApproval } from '../src/domains/concierge/live/host/page-action/live-page-action-authority-contract.js';

test('current-page configuration keeps a named loopback browser and explicit projection consent; page payloads never reconfigure it', () => {
  const base = {
    mode: 'owner-selected',
    profileId: 'owner-browser',
    browserURL: 'http://127.0.0.1:5272/',
    allowJevProjection: true,
  };
  assert.equal(currentPageConfigSchema.safeParse(base).success, true);
  for (const browserURL of [
    'http://127.0.0.1:6399/',
    'http://localhost:5272/',
    'https://example.test/',
    'http://127.0.0.1:5272/other',
  ])
    assert.equal(currentPageConfigSchema.safeParse({ ...base, browserURL }).success, false);
  assert.equal(currentPageConfigSchema.safeParse({ ...base, allowJevProjection: false }).success, false);
  assert.equal(currentPageConfigSchema.safeParse({ ...base, pageUrl: 'https://example.test/' }).success, false);
  for (const url of [
    'file:///etc/passwd',
    'chrome://settings',
    'javascript:alert(1)',
    'https://user:pass@example.test/',
    'http://127.0.0.1:6399/',
  ])
    assert.equal(selectableOwnerPage(url), false);
  assert.equal(selectableOwnerPage('https://example.test/current?q=owner'), true);
});

test('the action primitive cannot bypass pointer eligibility; a control descendant remains clickable', (t) => {
  const keys = ['document', 'innerWidth', 'innerHeight', 'getComputedStyle'];
  const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() =>
    keys.forEach((key, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }),
  );
  let clicks = 0,
    pointerEvents = 'none';
  const descendant = {};
  const element = {
    tagName: 'BUTTON',
    textContent: 'Save',
    outerHTML: '<button>Save</button>',
    parentElement: null,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: -10, right: 90, top: 10, bottom: 50, width: 100, height: 40 }),
    getClientRects: () => ({ length: 1 }),
    matches: () => false,
    contains: (node: object) => node === descendant,
    click: () => clicks++,
    dispatchEvent: () => true,
  };
  let hit: object | null = null;
  Object.assign(globalThis, {
    innerWidth: 1000,
    innerHeight: 700,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', pointerEvents }),
    document: {
      elementFromPoint: (x: number, y: number) => {
        assert.equal(x, 45, 'pointer center uses only the visible intersection');
        assert.equal(y, 30);
        return hit;
      },
    },
  });
  const choice = { kind: 'act' as const, targetId: 'control-0', operation: 'click' as const };
  assert.equal(currentControlVisible(element), false);
  assert.equal(permittedCurrentControl(element, 'click'), false);
  assert.equal(applyCdpPageChoice(element, choice), 'stale');
  pointerEvents = 'auto';
  hit = {}; // unrelated overlay
  assert.equal(permittedCurrentControl(element, 'click'), false);
  assert.equal(applyCdpPageChoice(element, choice), 'stale');
  hit = null;
  assert.equal(applyCdpPageChoice(element, choice), 'stale');
  assert.equal(clicks, 0);
  hit = descendant;
  assert.equal(applyCdpPageChoice(element, choice), 'applied');
  assert.equal(clicks, 1);
});

test('unpredicted click effect remains an exact one-time grant; missing fill readback, expired permission and unrelated origin remain denied', () => {
  const approval = {
    approvalId: 'preview',
    permissionScope: 'current-page-selection',
    expiresAtMs: Date.now() + 1000,
    origin: 'https://example.test',
    url: 'https://example.test/current',
    targetId: 'control-0',
    operation: 'click' as const,
  };
  assert.equal(validApproval(approval, Date.now()), true);
  assert.equal(validApproval({ ...approval, operation: 'fill', value: 'literal' }, Date.now()), false);
  assert.equal(validApproval({ ...approval, expiresAtMs: 1 }, Date.now()), false);
  assert.equal(validApproval({ ...approval, origin: 'https://other.test' }, Date.now()), false);
  assert.equal(validApproval({ ...approval, expectedReadback: '' }, Date.now()), false);
});
