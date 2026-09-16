/* Clowder AI — first-run journey prototype: the state machine.
 *
 * Pure data, no DOM, so the gates can be tested without a browser. Every step of the
 * journey is a state, and every way forward is an action that checks a gate: the demo
 * must actually finish, a login must actually complete, and the journey is only done
 * when the user has sent something and a cat has answered.
 *
 * Loaded as a classic script in the page (window.OnbCore) and as CommonJS in tests.
 */
((root, factory) => {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OnbCore = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const VERSION = 1;

  // What detection could return on a real machine. The prototype cannot see the user's
  // computer, so these are named fixtures the presenter switches between.
  const CLIENTS = {
    claude: { label: 'Claude Code', version: 'v2.1' },
    codex: { label: 'Codex', version: 'v0.44' },
    kimi: { label: 'Kimi Code', version: 'v1.3' },
    gemini: { label: 'Gemini CLI', version: '' },
  };
  const FIXTURES = {
    none: [],
    'one-ready': [['claude', true, 'done']],
    'one-login': [['codex', true, 'none']],
    many: [
      ['claude', true, 'done'],
      ['codex', true, 'none'],
      ['kimi', true, 'done'],
      ['gemini', false, 'none'],
    ],
  };
  // The narrator of the demo becomes the first real member; the others follow in order.
  const CAT_ORDER = ['siamese', 'ragdoll', 'maine'];

  function detect(fixture) {
    const rows = FIXTURES[fixture] || FIXTURES['one-ready'];
    const clients = {};
    const order = [];
    for (const [id, installed, login] of rows) {
      clients[id] = { installed, login, selected: installed && login === 'done' };
      order.push(id);
    }
    return { clients, order };
  }

  function initial(fixture = 'one-ready') {
    return {
      v: VERSION,
      stage: 'intro',
      demo: 'idle',
      fixture,
      ...detect(fixture),
      members: [],
      messages: [],
      firstExchange: 'none',
      variant: 'after',
      tourDone: false,
    };
  }

  const isReady = (c) => Boolean(c?.installed) && c.login === 'done';
  const visibleClients = (s) => s.order.filter((id) => s.clients[id].installed);
  const selectedReady = (s) => s.order.filter((id) => isReady(s.clients[id]) && s.clients[id].selected);
  const canConfirm = (s) => s.stage === 'setup' && selectedReady(s).length > 0;
  const composerLocked = (s) => s.stage === 'chat' && s.variant === 'before' && !s.tourDone;
  // operator 2026-09-16: the entrance tip belongs *after* the real window opens, and should be
  // a reminder rather than a lesson — so it shows on arrival and never blocks the composer.
  const offerTour = (s) => s.variant === 'after' && s.stage === 'chat' && !s.tourDone;

  function withClient(s, id, patch) {
    if (!s.clients[id]) return s;
    return { ...s, clients: { ...s.clients, [id]: { ...s.clients[id], ...patch } } };
  }

  const pending = (s, id) => s.clients[id]?.login === 'pending';
  const loginable = (s, id) => s.clients[id]?.installed && s.clients[id].login === 'none';

  // One handler per action keeps every gate readable on its own line.
  const HANDLERS = {
    start: (s) => (s.stage === 'intro' ? { ...s, stage: 'demo', demo: 'playing' } : s),
    demoDone: (s) => (s.stage === 'demo' ? { ...s, demo: 'done' } : s),
    toSetup: (s) => (s.demo === 'done' && s.stage !== 'setup' && !s.members.length ? { ...s, stage: 'setup' } : s),
    redetect: (s, a) => (s.stage === 'setup' ? { ...s, fixture: a.fixture, ...detect(a.fixture) } : s),
    toggle: (s, a) =>
      s.stage === 'setup' && isReady(s.clients[a.id])
        ? withClient(s, a.id, { selected: !s.clients[a.id].selected })
        : s,
    loginStart: (s, a) => (loginable(s, a.id) ? withClient(s, a.id, { login: 'pending' }) : s),
    loginDone: (s, a) => (pending(s, a.id) ? withClient(s, a.id, { login: 'done', selected: true }) : s),
    loginFailed: (s, a) => (pending(s, a.id) ? withClient(s, a.id, { login: 'none' }) : s),
    variant: (s, a) => (a.value === 'before' || a.value === 'after' ? { ...s, variant: a.value } : s),
    tourDone: (s) => ({ ...s, tourDone: true }),
    confirm: (s) => {
      if (!canConfirm(s)) return s;
      const members = selectedReady(s).map((client, i) => ({ cat: CAT_ORDER[i % CAT_ORDER.length], client }));
      return { ...s, stage: 'handoff', members };
    },
    toChat: (s) => {
      if (s.stage !== 'handoff' || !s.members.length) return s;
      const greeting = s.messages.length ? [] : [{ from: 'cat', cat: s.members[0].cat, kind: 'greeting' }];
      return { ...s, stage: 'chat', messages: [...s.messages, ...greeting] };
    },
    send: (s, a) => {
      const text = typeof a.text === 'string' ? a.text.trim() : '';
      if (s.stage !== 'chat' || composerLocked(s) || !text) return s;
      const firstExchange = s.firstExchange === 'none' ? 'sent' : s.firstExchange;
      return { ...s, firstExchange, messages: [...s.messages, { from: 'user', text }] };
    },
    replied: (s) => {
      if (s.firstExchange === 'none') return s;
      const reply = { from: 'cat', cat: s.members[0].cat, kind: 'reply' };
      return {
        ...s,
        firstExchange: s.firstExchange === 'sent' ? 'done' : s.firstExchange,
        messages: [...s.messages, reply],
      };
    },
  };

  const reduce = (s, a) => (HANDLERS[a.type] ? HANDLERS[a.type](s, a) : s);

  const serialize = (s) => JSON.stringify(s);

  function parse(raw) {
    try {
      const saved = typeof raw === 'string' ? JSON.parse(raw) : null;
      return saved?.v === VERSION && saved.clients ? saved : null;
    } catch {
      return null;
    }
  }

  // Coming back after closing the app: never replay what was finished, never skip what was not.
  function resume(raw) {
    const saved = parse(raw);
    if (!saved) return initial();
    if (saved.demo !== 'done') return { ...initial(saved.fixture), variant: saved.variant || 'after' };
    if (!saved.members?.length) return { ...saved, stage: 'setup' };
    return reduce({ ...saved, stage: 'handoff' }, { type: 'toChat' });
  }

  return {
    CLIENTS,
    FIXTURES,
    CAT_ORDER,
    initial,
    reduce,
    visibleClients,
    selectedReady,
    canConfirm,
    composerLocked,
    offerTour,
    serialize,
    resume,
  };
});
