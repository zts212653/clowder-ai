/* Scenes 1–5: the stage, the scripted demo, and the narrator.
 *
 * Nothing here calls a model. The demo is a fixed script whose only job is to show three
 * things without a single explanatory headline: each cat is a member, a cat can call
 * another one in, and the result gets better because it did. The narrator then says out
 * loud that it was a demonstration.
 *
 * `run.instant` renders a scene's finished state with no animation, so the presenter can
 * jump straight to any scene. */
((root) => {
  const C = root.OnbClock;
  const Cats = root.OnbCats;
  const Chat = root.OnbChat;
  const $ = (id) => document.getElementById(id);

  const PROMPT = '帮我写一段猫咖的欢迎文案，给第一次来的人看';
  const mention = (cat, name) => ({ html: `<span class="mention" data-cat="${cat}">@${name}</span>` });
  const DRAFT = [
    '初稿：\n欢迎来到 Clowder AI！这里的 A2A 协作会让多只猫并行处理你的需求。\n\n',
    mention('maine', '缅因猫'),
    ' 帮我看看，新人读得懂吗？',
  ];
  const REVIEW = ['「A2A 协作」新人看不懂。\n换成大白话：几只猫会互相搭把手。'];
  const FINAL = [
    '改好了：\n欢迎来到 Clowder AI！',
    { html: '<del>这里的 A2A 协作会让多只猫并行处理你的需求。</del>' },
    { html: '<ins>你说一句话，几只猫会互相搭把手，把事情做好。</ins>' },
  ];
  const NARRATION = [
    '你说一个目标，我们自己分工。',
    '需要你拍板的时候，再带着结果回来找你。',
    '刚才是示范。\n接下来看看，你的电脑上能叫来哪些伙伴。',
  ];

  const cats = {};
  const pause = (ms, run) => (run.instant ? Promise.resolve() : C.wait(ms, run));

  function ensureCats() {
    if (cats.ragdoll) return cats;
    for (const id of ['ragdoll', 'maine', 'siamese']) cats[id] = Cats.create($('cats'), id);
    return cats;
  }

  function stageSpots() {
    const w = innerWidth;
    const y = innerHeight * 0.72;
    return { ragdoll: [w / 2 - 170, y], maine: [w / 2, y + 6], siamese: [w / 2 + 170, y] };
  }

  const ENTRY = ['maine', 'ragdoll', 'siamese'];
  const facing = (id) => (id === 'ragdoll' ? -1 : 1);

  function offstage(spots) {
    for (const [i, id] of ENTRY.entries()) {
      Cats.place(cats[id], id === 'ragdoll' ? innerWidth + 120 : -120 - i * 60, spots[id][1], facing(id));
      cats[id].scale = 0.62;
    }
  }

  async function runOnstage(spots, run) {
    await Promise.all(
      ENTRY.map((id, i) => pause(i * 260, run).then(() => Cats.runTo(cats[id], spots[id][0], spots[id][1], run))),
    );
    Cats.meow($('cats'), cats.ragdoll, '喵～', run);
    await pause(500, run);
  }

  /** Scene 1. The cats run in, one meows, then they idle until the user presses start. */
  async function intro(run) {
    ensureCats();
    $('stage').classList.remove('gone');
    $('app').classList.add('hidden');
    $('stageCopy').classList.remove('shown');
    const spots = stageSpots();
    offstage(spots);
    if (run.instant) for (const id of ENTRY) Cats.place(cats[id], spots[id][0], spots[id][1], facing(id));
    else await runOnstage(spots, run);
    $('stageCopy').classList.add('shown');
    for (const id of ENTRY) Cats.idle(cats[id], run);
  }

  /** Where the cats wait during the demo: along the right edge, above the composer. */
  function wings() {
    const ws = document.querySelector('.workspace').getBoundingClientRect();
    const y = $('composer').getBoundingClientRect().top - 6;
    return { ragdoll: [ws.right - 250, y], maine: [ws.right - 160, y], siamese: [ws.right - 70, y] };
  }

  async function enterBubble(cat, row, run) {
    if (run.instant) {
      row.avatar.classList.remove('pending');
      cat.el.style.visibility = 'hidden';
      return;
    }
    const r = row.avatar.getBoundingClientRect();
    await Cats.runTo(cat, r.left + 60, r.top + 60, run, 700);
    await Cats.shrinkInto(cat, row.avatar, run);
  }

  async function say(el, parts, run) {
    if (run.instant) {
      for (const p of parts) {
        if (p.html) el.insertAdjacentHTML('beforeend', p.html);
        else el.append(p);
      }
      return;
    }
    await Chat.stream(el, parts, run);
  }

  /** Scenes 2–4. Returns when the improved result is on screen. */
  async function demo(run, showShell) {
    ensureCats();
    showShell('demo');
    const stage = $('stage');
    stage.classList.add('gone');
    const list = $('messages');
    list.innerHTML = '<span class="demo-tag">示范对话</span>';
    const spots = wings();
    const input = $('input');
    input.disabled = true;
    await Promise.all(
      ['ragdoll', 'maine', 'siamese'].map((id) =>
        run.instant ? Cats.place(cats[id], spots[id][0], spots[id][1]) : Cats.runTo(cats[id], ...spots[id], run),
      ),
    );
    if (run.instant) input.value = '';
    else await Chat.typeInto(input, PROMPT, run);
    await pause(350, run);
    input.value = '';
    Chat.addMessage(list, { from: 'user' }).bubble.textContent = PROMPT;
    await pause(600, run);

    const draft = Chat.addMessage(list, { from: 'cat', cat: 'ragdoll', pending: true });
    await enterBubble(cats.ragdoll, draft, run);
    await say(draft.bubble, DRAFT, run);
    await pause(700, run);

    const review = Chat.addMessage(list, { from: 'cat', cat: 'maine', pending: true });
    await enterBubble(cats.maine, review, run);
    await say(review.bubble, REVIEW, run);
    await pause(700, run);

    const final = Chat.addMessage(list, { from: 'cat', cat: 'ragdoll' });
    await say(final.bubble, FINAL, run);
    list.scrollTop = list.scrollHeight;
  }

  /** Scene 5. The narrator explains, says it was a demo, and hands the next step to the user. */
  async function narrate(run, onNext) {
    ensureCats();
    const cap = $('caption');
    const cat = cats.siamese;
    const spot = wings().siamese;
    Cats.place(cat, spot[0], spot[1]);
    await Cats.changePose(cat, 'think', run).catch(() => {});
    cap.innerHTML = '<div class="line"></div>';
    cap.style.left = `${Math.max(12, spot[0] - 330)}px`;
    cap.style.top = `${spot[1] - 210}px`;
    cap.classList.add('shown');
    const line = cap.querySelector('.line');
    for (const [i, text] of NARRATION.entries()) {
      if (i === NARRATION.length - 1) await Cats.changePose(cat, 'wave', run).catch(() => {});
      line.textContent = '';
      await say(line, [text], run);
      await pause(1100, run);
    }
    const next = document.createElement('button');
    next.className = 'btn-primary';
    next.textContent = '下一步';
    next.id = 'narrateNext';
    next.addEventListener('click', onNext);
    cap.appendChild(next);
  }

  function hideCaption() {
    $('caption').classList.remove('shown');
    $('caption').innerHTML = '';
  }

  root.OnbDemo = { cats, ensureCats, intro, demo, narrate, hideCaption, PROMPT };
})(window);
