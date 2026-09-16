import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const Core = require('./journey-core.js');

const start = (fixture = 'one-ready') => Core.initial(fixture);
const through = (state, ...actions) => actions.reduce((s, a) => Core.reduce(s, a), state);
const toSetup = (fixture) => through(start(fixture), { type: 'start' }, { type: 'demoDone' }, { type: 'toSetup' });

describe('the journey runs in one direction and each step has a gate', () => {
  it('opens on the intro and only a click starts the demo', () => {
    const s = start();
    assert.equal(s.stage, 'intro');
    assert.equal(through(s, { type: 'toSetup' }).stage, 'intro', 'setup cannot be reached before the demo');
    assert.equal(through(s, { type: 'start' }).stage, 'demo');
  });

  it('keeps the demo honest: setup only after the demo has actually finished', () => {
    const playing = through(start(), { type: 'start' });
    assert.equal(through(playing, { type: 'toSetup' }).stage, 'demo');
    assert.equal(toSetup('one-ready').stage, 'setup');
  });

  it('pre-selects logged-in clients and lets the user continue', () => {
    const s = toSetup('one-ready');
    assert.deepEqual(Core.selectedReady(s), ['claude']);
    assert.equal(Core.canConfirm(s), true);
  });

  it('never counts a click on "log in" as a login', () => {
    let s = toSetup('one-login');
    assert.equal(Core.canConfirm(s), false, 'nothing is ready yet');
    s = through(s, { type: 'loginStart', id: 'codex' });
    assert.equal(s.clients.codex.login, 'pending');
    assert.equal(Core.canConfirm(s), false, 'pending is not logged in');
    s = through(s, { type: 'loginFailed', id: 'codex' });
    assert.equal(s.clients.codex.login, 'none');
    assert.equal(Core.canConfirm(s), false);
    s = through(s, { type: 'loginStart', id: 'codex' }, { type: 'loginDone', id: 'codex' });
    assert.equal(s.clients.codex.login, 'done');
    assert.equal(Core.canConfirm(s), true, 'a finished login becomes selectable and selected');
  });

  it('stops honestly when no client is installed, and resumes from setup after install', () => {
    let s = toSetup('none');
    assert.equal(Core.visibleClients(s).length, 0);
    assert.equal(Core.canConfirm(s), false);
    s = through(s, { type: 'redetect', fixture: 'one-ready' });
    assert.equal(s.stage, 'setup', 'redetect stays on setup instead of replaying the demo');
    assert.equal(Core.canConfirm(s), true);
  });

  it('creates exactly one member per selected logged-in client, narrator first', () => {
    const one = through(toSetup('one-ready'), { type: 'confirm' });
    assert.equal(one.stage, 'handoff');
    assert.deepEqual(
      one.members.map((m) => [m.cat, m.client]),
      [['siamese', 'claude']],
    );
    const many = through(toSetup('many'), { type: 'confirm' });
    assert.deepEqual(
      many.members.map((m) => m.cat),
      ['siamese', 'ragdoll'],
      'only the two logged-in clients become members; the narrator leads',
    );
    const unticked = through(toSetup('many'), { type: 'toggle', id: 'kimi' }, { type: 'confirm' });
    assert.equal(unticked.members.length, 1, 'unticking a client removes its member');
  });

  it('refuses to confirm with nothing selected', () => {
    const s = through(toSetup('one-ready'), { type: 'toggle', id: 'claude' });
    assert.equal(Core.canConfirm(s), false);
    assert.equal(through(s, { type: 'confirm' }).stage, 'setup');
  });

  it('finishes only when the user sends a first real message', () => {
    let s = through(toSetup('one-ready'), { type: 'confirm' }, { type: 'toChat' });
    assert.equal(s.stage, 'chat');
    assert.equal(s.firstExchange, 'none');
    assert.equal(through(s, { type: 'send', text: '   ' }).firstExchange, 'none', 'blank text is not a message');
    s = through(s, { type: 'send', text: 'hello sentinel' });
    assert.equal(s.firstExchange, 'sent');
    assert.equal(s.messages.at(-1).text, 'hello sentinel');
    s = through(s, { type: 'replied' });
    assert.equal(s.firstExchange, 'done');
  });
});

describe('scene 8 variants change only when the entrance tour happens', () => {
  const chat = (variant) =>
    through(toSetup('one-ready'), { type: 'variant', value: variant }, { type: 'confirm' }, { type: 'toChat' });

  it('variant "before" locks the composer until the tour is done', () => {
    const s = chat('before');
    assert.equal(Core.composerLocked(s), true);
    assert.equal(Core.composerLocked(through(s, { type: 'tourDone' })), false);
  });

  it('variant "after" leaves the composer open and reminds as soon as the real window opens', () => {
    const s = chat('after');
    assert.equal(Core.composerLocked(s), false);
    assert.equal(Core.offerTour(s), true, 'the reminder is there from the moment the user arrives');
    assert.equal(Core.offerTour(through(s, { type: 'tourDone' })), false, 'and goes away once seen');
    const spoke = through(s, { type: 'send', text: 'hi' }, { type: 'replied' });
    assert.equal(Core.composerLocked(spoke), false, 'speaking is never gated on the reminder');
  });
});

describe('leaving and coming back resumes at the unfinished step', () => {
  it('replays the demo only if it was never finished', () => {
    const mid = through(start(), { type: 'start' });
    assert.equal(Core.resume(Core.serialize(mid)).stage, 'intro');
  });

  it('returns to setup with a pending login still pending', () => {
    const s = through(toSetup('one-login'), { type: 'loginStart', id: 'codex' });
    const back = Core.resume(Core.serialize(s));
    assert.equal(back.stage, 'setup');
    assert.equal(back.clients.codex.login, 'pending');
  });

  it('returns to chat with the first message kept', () => {
    const s = through(toSetup('one-ready'), { type: 'confirm' }, { type: 'toChat' }, { type: 'send', text: 'keep me' });
    const back = Core.resume(Core.serialize(s));
    assert.equal(back.stage, 'chat');
    assert.equal(back.messages.at(-1).text, 'keep me');
  });

  it('treats an interrupted handoff as done, since members already exist', () => {
    const s = through(toSetup('one-ready'), { type: 'confirm' });
    assert.equal(Core.resume(Core.serialize(s)).stage, 'chat');
  });

  it('survives garbage in storage', () => {
    assert.equal(Core.resume('not json').stage, 'intro');
    assert.equal(Core.resume(null).stage, 'intro');
  });
});
