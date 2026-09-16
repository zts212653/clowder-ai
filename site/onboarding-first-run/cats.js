/* The three cats: sprites from the character canon, positioned by their feet.
 *
 * Canon rows are 192×208 cells with the ground contact at y=197 and the cat facing left.
 * Idle behaviour borrows the roadmap plate's rule that only adjacent poses may follow each
 * other, so a lying cat never snaps upright. A pose change hides under a brief squash so two
 * drawings are never visible at once.
 *
 * Running uses the single canon `run` pose with a hop; a real run cycle still has to be
 * drawn before implementation (noted in #1466). */
((root) => {
  const C = root.OnbClock;
  const CELL_W = 192;
  const CELL_H = 208;
  const BASE = 197;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const META = {
    ragdoll: { name: '布偶猫', color: '#9b7ebd', head: [72, 62] },
    maine: { name: '缅因猫', color: '#5b8c5a', head: [73, 59] },
    siamese: { name: '暹罗猫', color: '#5b9bd5', head: [72, 69] },
  };
  const IDLE_NEXT = {
    sit: ['groom', 'look-up', 'tail-up', 'loaf', 'yawn'],
    loaf: ['sit'],
    yawn: ['stretch'],
    stretch: ['sit'],
    groom: ['sit'],
    'look-up': ['sit'],
    'tail-up': ['sit'],
  };
  const IDLE_SPAN = {
    sit: [1.4, 3],
    loaf: [2.5, 4.5],
    yawn: [0.9, 1.2],
    stretch: [1.2, 1.8],
    groom: [1.8, 3],
    'look-up': [1.2, 2.4],
    'tail-up': [1.2, 2.4],
  };
  const AVATAR_SCALE = 0.52;

  const sprite = (id, pose) => `assets/cats/${id}-${pose}-row.png`;

  function create(layer, id, scale = 0.62) {
    const el = document.createElement('div');
    el.className = 'cat';
    el.dataset.cat = id;
    layer.appendChild(el);
    const cat = { id, el, x: -300, y: 0, hop: 0, scale, facing: -1, pose: 'sit', squash: 1, alpha: 1, frame: 0 };
    setPose(cat, 'sit');
    render(cat);
    return cat;
  }

  function setPose(cat, pose) {
    cat.pose = pose;
    cat.el.style.backgroundImage = `url("${sprite(cat.id, pose)}")`;
    cat.el.dataset.pose = pose;
    render(cat);
  }

  function render(cat) {
    const s = cat.scale;
    const w = CELL_W * s;
    const h = CELL_H * s;
    const frames = cat.pose === 'walk' ? 4 : 1;
    cat.el.style.width = `${w}px`;
    cat.el.style.height = `${h}px`;
    cat.el.style.backgroundSize = `${w * frames}px ${h}px`;
    cat.el.style.backgroundPosition = `${-w * (cat.frame % frames)}px 0`;
    cat.el.style.opacity = String(cat.alpha);
    const flip = cat.facing > 0 ? -1 : 1;
    cat.el.style.transform = `translate(${cat.x - w / 2}px, ${cat.y - BASE * s + cat.hop}px) scale(${flip}, ${cat.squash})`;
  }

  async function changePose(cat, pose, run) {
    if (cat.pose === pose) return;
    if (REDUCED) return setPose(cat, pose);
    await C.tween(90, run, (k) => {
      cat.squash = 1 - 0.04 * k;
      render(cat);
    });
    setPose(cat, pose);
    await C.tween(90, run, (k) => {
      cat.squash = 0.96 + 0.04 * k;
      render(cat);
    });
  }

  /** Run to (x, y) at a steady pace, then sit. Returns when the cat has arrived. */
  async function runTo(cat, x, y, run, pace = 560) {
    const dx = x - cat.x;
    const dy = y - cat.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) return;
    if (Math.abs(dx) > 1) cat.facing = dx > 0 ? 1 : -1;
    if (REDUCED) {
      cat.x = x;
      cat.y = y;
      return changePose(cat, 'sit', run);
    }
    setPose(cat, 'run');
    const x0 = cat.x;
    const y0 = cat.y;
    const stride = 150 * cat.scale;
    await C.tween((dist / pace) * 1000, run, (k) => {
      cat.x = x0 + dx * k;
      cat.y = y0 + dy * k;
      cat.hop = -Math.abs(Math.sin((dist * k * Math.PI) / stride)) * 16 * cat.scale;
      render(cat);
    });
    cat.hop = 0;
    await changePose(cat, 'sit', run);
  }

  /** Wander through adjacent idle poses until the run is cancelled. */
  async function idle(cat, run) {
    try {
      for (;;) {
        const next = IDLE_NEXT[cat.pose] || ['sit'];
        const pose = next[Math.floor(Math.random() * next.length)];
        await changePose(cat, pose, run);
        const [lo, hi] = IDLE_SPAN[pose] || [1.5, 3];
        await C.wait((lo + Math.random() * (hi - lo)) * 1000, run);
      }
    } catch (e) {
      if (!C.isCancel(e)) throw e;
    }
  }

  /** Shrink the cat so its face lands in an avatar circle, then hand over to the avatar. */
  async function shrinkInto(cat, avatarEl, run) {
    await changePose(cat, 'sit', run);
    const r = avatarEl.getBoundingClientRect();
    const [hx, hy] = META[cat.id].head;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    cat.facing = -1;
    const s0 = cat.scale;
    const x0 = cat.x;
    const y0 = cat.y;
    const x1 = cx - (hx - CELL_W / 2) * AVATAR_SCALE;
    const y1 = cy - (hy - BASE) * AVATAR_SCALE;
    await C.tween(REDUCED ? 1 : 420, run, (k) => {
      const e = k * k * (3 - 2 * k);
      cat.scale = s0 + (AVATAR_SCALE - s0) * e;
      cat.x = x0 + (x1 - x0) * e;
      cat.y = y0 + (y1 - y0) * e;
      cat.alpha = k > 0.75 ? 1 - (k - 0.75) * 4 : 1;
      render(cat);
    });
    avatarEl.classList.remove('pending');
    cat.el.style.visibility = 'hidden';
  }

  /** Put a canon face into an avatar circle, cropped from the same sitting drawing. */
  function paintAvatar(el, id) {
    const [hx, hy] = META[id].head;
    const s = AVATAR_SCALE;
    el.style.backgroundImage = `url("${sprite(id, 'sit')}")`;
    el.style.backgroundSize = `${CELL_W * s}px ${CELL_H * s}px`;
    el.style.backgroundPosition = `${16 - hx * s}px ${16 - hy * s}px`;
    el.style.setProperty('--ring', META[id].color);
  }

  function place(cat, x, y, facing = -1) {
    cat.x = x;
    cat.y = y;
    cat.facing = facing;
    cat.alpha = 1;
    cat.el.style.visibility = 'visible';
    render(cat);
  }

  function meow(layer, cat, text = '喵～', run) {
    const tag = document.createElement('div');
    tag.className = 'meow';
    tag.textContent = text;
    tag.style.left = `${cat.x - 18}px`;
    tag.style.top = `${cat.y - CELL_H * cat.scale - 6}px`;
    layer.appendChild(tag);
    requestAnimationFrame(() => tag.classList.add('shown'));
    return C.wait(900, run)
      .catch(() => {})
      .finally(() => tag.remove());
  }

  root.OnbCats = {
    META,
    create,
    setPose,
    changePose,
    runTo,
    idle,
    shrinkInto,
    paintAvatar,
    place,
    render,
    meow,
    REDUCED,
  };
})(window);
