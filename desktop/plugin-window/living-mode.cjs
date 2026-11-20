const { followPrimaryWorkArea, pushToBody } = require('./body-window.cjs');
const { validBallSize } = require('./pet-placement.cjs');

/** F336 Phase C: whether the living cat is the companion's body, and what the body is told.
 * - The body opens only when all of these hold: the launch carries the verified body page (the API
 *   sends one only for an archive whose admitted contract line has livingBody, after checking the
 *   page's integrity with the surface), and the owner's saved skin, read from the Host's own settings
 *   and state replies, is xianxian-living. The page never decides. Choosing another skin swaps the
 *   body out after a scene flush; neither direction is a hide, a close or a media revocation.
 * - The panel draws what is on screen, not what was saved: until the body is on screen (loading,
 *   failed, an atlas that never loaded, or no verified page) its state and settings replies carry the
 *   ball it draws, xianxian-codex, as
 *   the API does for a line without livingBody. alpha.38 hides the ball for xianxian-living, so
 *   passing the saved value through left no cat at all (PR #7292 R1 P1-3). The saved choice is never
 *   rewritten; the Host's own observation reads the raw value.
 * - A body that failed to open is retried when the skin choice changes, or when the owner chooses
 *   the living cat again in the panel (it shows the ball then, so that is the owner asking again).
 *   That choice also replaces a body that loaded but never drew (a failed atlas: alpha.38 does not
 *   retry it); a drawn body and ordinary reads are left alone (PR #7292 R1, codex61-sol P2).
 * - body-area {width, height, standHeight} goes to the body when it opens, when the primary work area
 *   changes and when ballSize changes; body-preferences {behaviorEnabled} when it opens and whenever
 *   it changes. Both carry what the body window cannot read itself. On candidate.3 behaviorEnabled
 *   is the owner's 自主活动 setting exactly as settings.read returns it (the published schema), so an
 *   open panel does not change it; the panel stays where it opened instead (pet-window.cjs). Holding
 *   him still while a panel is open waits for a candidate that defines the field as the Host's
 *   current permission (PR #7292 R1 P2).
 * - Swaps run one at a time, in the order they were asked for. */
const LIVING_SKIN = 'xianxian-living';
const BALL_SKIN = 'xianxian-codex';
const DEFAULT_BALL_SIZE = 72;
/** How tall the cat stands (CSS px) at this ballSize: 150 px at the default 72, within the contract's 60–480. */
const standHeight = (ballSize) => Math.max(60, Math.min(480, Math.round((150 * ballSize) / DEFAULT_BALL_SIZE)));

function createLivingMode({ bodyUrl, presentation, createBodyWindow, group, petWindow, scene, screen, log }) {
  let wanted = false;
  let failed = false;
  let current; // {win, generation, unfollow, behaviorEnabled}: the body on screen and what it was told
  let ballSize = DEFAULT_BALL_SIZE;
  let behaviorEnabled;
  let closed = false;
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const area = (win) => {
    const { width, height } = win.getBounds();
    return { kind: 'body-area', width, height, standHeight: standHeight(ballSize) };
  };
  function tellPreferences() {
    if (!current || typeof behaviorEnabled !== 'boolean' || current.behaviorEnabled === behaviorEnabled) return;
    current.behaviorEnabled = behaviorEnabled;
    pushToBody(current.win, { kind: 'body-preferences', behaviorEnabled });
  }
  /** Swap a new body in; a body already on screen hands over its scene first and is replaced.
   * A retry (`unlessDrawn`) is dropped if the body it would replace drew while it loaded. */
  async function swapIn({ unlessDrawn = false } = {}) {
    if (!bodyUrl) throw new Error('No verified living body');
    if (closed || group.closed) throw new Error('Window closed');
    const win = await createBodyWindow({ url: bodyUrl, presentation });
    // the body a retry would replace may draw while this one loads or while its scene is flushed
    const keepOld = () => unlessDrawn && petWindow.bodyDrawn();
    try {
      if (!keepOld()) await scene.flush('swap');
      if (keepOld()) {
        win.destroy();
        return current.generation;
      }
      const generation = group.attachBody(win, bodyUrl);
      petWindow.attachBody(win, generation);
      scene.attach(generation, () => pushToBody(win, { kind: 'scene-flush' }));
      current?.unfollow();
      const unfollow = followPrimaryWorkArea({ screen, win, standHeight: () => standHeight(ballSize) });
      current = { win, generation, unfollow, behaviorEnabled: undefined };
      pushToBody(win, area(win));
      tellPreferences();
      return generation;
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }
  /** Swap the body out: back to the ball inside the panel, after the scene flush. */
  async function swapOut() {
    petWindow.concealBody(); // the ball is back with the reply that asked for it: never two cats
    await scene.flush('swap');
    if (wanted) return; // chosen again during the flush: he stays (the next living reply shows him)
    current?.unfollow();
    current = undefined;
    petWindow.detachBody();
    group.detachBody({ internal: true });
    scene.detach();
  }
  /** Bring the body in line with the observed choice; one failed open waits for the next choice. */
  async function follow() {
    if (closed) return;
    if (!wanted && current) return swapOut();
    if (!wanted || current || failed) return;
    try {
      await swapIn();
    } catch {
      failed = true;
      if (!closed) log('the living body did not open; the ball stays until the skin is chosen again');
    }
  }
  return {
    get attached() {
      return current !== undefined;
    },
    attach: () => enqueue(swapIn),
    detach: () => enqueue(swapOut),
    /** Skin and behaviorEnabled from a trusted settings or state reply the Host routed to the panel. */
    observe({ skin, behaviorEnabled: enabled }) {
      if (closed) return;
      if (typeof enabled === 'boolean' && enabled !== behaviorEnabled) {
        behaviorEnabled = enabled;
        tellPreferences();
      }
      if (!bodyUrl || typeof skin !== 'string') return;
      const next = skin === LIVING_SKIN;
      if (next !== wanted) failed = false;
      wanted = next;
      void enqueue(follow);
    },
    /** The reply the panel gets: the living skin only while his body is on screen. */
    drawn(reply) {
      const skin =
        reply?.kind === 'state'
          ? reply.skin
          : reply?.kind === 'settings' && reply.status === 'available'
            ? reply.values?.skin
            : undefined;
      if (typeof skin !== 'string') return reply;
      // What is shown, whatever this reply's age: the cat once the newest choice (`wanted`, newest-begun
      // reply only) is him and his body has drawn; else the ball, the cat it draws for xianxian-living.
      const shown = wanted && current && petWindow.bodyDrawn() ? LIVING_SKIN : skin === LIVING_SKIN ? BALL_SKIN : skin;
      // the panel and the body change together, in this step: never two cats, never none (F317)
      if (shown === LIVING_SKIN) petWindow.handOver();
      else petWindow.concealBody(); // not queued behind a retry still loading (#7292 post-merge P1)
      if (shown === skin) return reply;
      return reply.kind === 'state'
        ? { ...reply, skin: shown }
        : { ...reply, values: { ...reply.values, skin: shown } };
    },
    /** The owner chose a skin in the panel; choosing the living cat retries a body that failed to
     * open or never drew. */
    choose(skin) {
      if (closed || skin !== LIVING_SKIN) return;
      failed = false;
      void enqueue(() => {
        if (!wanted || !current || petWindow.bodyDrawn()) return follow();
        return swapIn({ unlessDrawn: true }).catch(() => {
          if (!closed) log('the living body did not open again; the ball stays');
        });
      });
    },
    /** The ballSize of a trusted settings reply; the pet window applies the same bounds. */
    setBallSize(size) {
      if (closed || !validBallSize(size) || size === ballSize) return;
      ballSize = size;
      if (current) pushToBody(current.win, area(current.win));
    },
    /** The whole cat closed; the scene writer outlives the windows. */
    close() {
      closed = true;
      current?.unfollow();
      current = undefined;
    },
  };
}

module.exports = { createLivingMode, standHeight, LIVING_SKIN };
