// Fixed, self-contained content. Never interpolate user data into this document.
export const DEMO_DELIVERABLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; connect-src 'none'">
  <title>今天待办 · 演示成果</title>
  <style>
    :root { color-scheme:light dark; --bg:#f4f1ea;--card:#fffdf9;--ink:#302c28;--muted:#756e66;--line:#e8e1d7;--accent:#a65420;--soft:#f6e8d8;--success:#27714e; }
    @media(prefers-color-scheme:dark){:root{--bg:#1d1b19;--card:#282521;--ink:#f3eee6;--muted:#b6ada0;--line:#454039;--accent:#edab77;--soft:#493326;--success:#83ceab;}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px}
    main{max-width:630px;margin:12px auto;padding:18px;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 35px #00000008}
    .eyebrow{color:var(--accent);font-size:11px;letter-spacing:.1em}h1{margin:5px 0;font-size:26px;letter-spacing:-1px}.intro{color:var(--muted);line-height:1.6;margin:0 0 12px;font-size:12px}
     .entry{display:flex;gap:8px}input[type=text]{min-width:0;flex:1;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:12px;padding:12px;font:inherit}
    button{cursor:pointer;font:inherit;border:0;border-radius:10px;padding:10px 14px;background:var(--soft);color:var(--accent)} .entry button{background:var(--accent);color:var(--card);font-weight:600}
    button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}#feedback{min-height:21px;margin:7px 0 14px;font-size:12px;color:var(--accent)}
    .toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--line);padding-bottom:12px}.toolbar button{background:transparent;color:var(--muted);padding:7px 10px;font-size:12px}.toolbar button[aria-pressed=true]{background:var(--soft);color:var(--accent)}#count{margin-left:auto;font-size:12px;color:var(--muted)}
    ul{list-style:none;padding:0;margin:0}li{border-bottom:1px solid var(--line)}label.task{display:flex;align-items:center;gap:12px;padding:17px 2px;cursor:pointer;line-height:1.5}input[type=checkbox]{height:19px;width:19px;flex-shrink:0;accent-color:var(--success)}.done span{text-decoration:line-through;color:var(--muted)}
    #empty{text-align:center;padding:28px 8px;color:var(--success);line-height:1.8}footer{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-top:22px;color:var(--muted);font-size:11px;line-height:1.6}footer button{font-size:11px;padding:6px 9px;flex-shrink:0}
    @media(max-width:500px){main{margin:10px;padding:18px;border-radius:16px}h1{font-size:26px}.intro{font-size:13px;margin-bottom:16px}#count{width:100%;margin:4px 0 0}footer{align-items:flex-start}}
    #waiting{display:none;padding:55px 26px;text-align:center;color:var(--muted);line-height:1.8}#waiting strong{display:block;font-size:22px;color:var(--ink);margin-bottom:12px}
    body[data-stage=waiting] #waiting{display:block}body[data-stage=waiting] main{display:none}
    body[data-stage=design] main,body[data-stage=architecture] main{box-shadow:none;border:2px dashed var(--line);border-radius:4px}
    body[data-stage=design] .entry,body[data-stage=design] .toolbar,body[data-stage=design] #tasks,body[data-stage=architecture] .entry,body[data-stage=architecture] .toolbar,body[data-stage=architecture] #tasks{filter:grayscale(1);opacity:.6}
    #stage-note{font-size:12px;line-height:1.6;color:var(--accent);margin:0 0 8px}#review-notes{border:1px solid var(--accent);background:var(--soft);border-radius:12px;padding:10px;font-size:12px;line-height:1.7;margin:12px 0}#review-notes[hidden]{display:none}
  </style>
</head>
<body data-stage="waiting">
<section id="waiting"><strong>今天待办</strong>团队接单后，设计草图会出现在这里。<br>同一个页面将逐步成为可以操作的成果。</section>
<main>
  <div class="eyebrow">留一点时间，做好今天的小事</div>
  <h1>今天待办</h1>
  <p id="stage-note" role="status"></p>
  <p class="intro">从一件小事开始，给每个完成的瞬间打个勾。</p>
  <div class="entry" role="group" aria-label="添加任务"><input id="new-task" type="text" placeholder="写下你想完成的一件事" aria-label="新任务" aria-describedby="feedback" maxlength="160" autocomplete="off"><button id="add-task" type="button">添加</button></div>
  <p id="feedback" role="status"></p>
  <div class="toolbar" aria-label="筛选任务"><button data-filter="all" aria-pressed="true">全部</button><button data-filter="open" aria-pressed="false">未完成</button><button data-filter="done" aria-pressed="false">已完成</button><span id="count"></span></div>
  <ul id="tasks" aria-label="任务列表"></ul>
  <p id="empty" hidden></p>
  <div id="review-notes" hidden></div>
  <footer><span>演示成果 · 由设计、开发和互审共同完善<br>这里的操作仅用于体验，关闭或重新打开后会重置。</span><button id="reset" type="button">重置示例</button></footer>
</main>
<script>
  (() => {
    let stage = 'waiting';
    let nextId = 4;
    let filter = 'all';
    const initial = () => [
      { id: 1, title: '看看三位伙伴如何协作', done: true },
      { id: 2, title: '试着添加一件自己的小事', done: false },
      { id: 3, title: '创建自己的猫猫团队', done: false },
    ];
    let tasks = initial();
    const list = document.querySelector('#tasks');
    const input = document.querySelector('#new-task');
    const feedback = document.querySelector('#feedback');
    const empty = document.querySelector('#empty');
    const render = () => {
      const focused = document.activeElement;
      const previousIndex = [...list.querySelectorAll('input')].indexOf(focused);
      const focusedId = previousIndex >= 0 ? focused.dataset.taskId : null;
      list.replaceChildren();
      const visible = tasks.filter(task => filter === 'all' || (filter === 'done' ? task.done : !task.done));
      for (const task of visible) {
        const row = document.createElement('li');
        const label = document.createElement('label');
        label.className = \`task\${task.done ? ' done' : ''}\`;
        const check = document.createElement('input');
        check.type = 'checkbox'; check.checked = task.done; check.dataset.taskId = String(task.id);
        check.disabled = ['waiting', 'design', 'architecture'].includes(stage);
        check.addEventListener('change', () => {
          task.done = check.checked;
          feedback.textContent = task.done ? '又完成了一件小事。' : '任务已恢复为未完成。';
          render();
        });
        const title = document.createElement('span'); title.textContent = task.title;
        label.append(check, title); row.append(label); list.append(row);
      }
      const remaining = tasks.filter(task => !task.done).length;
      document.querySelector('#count').textContent = \`\${tasks.length - remaining} / \${tasks.length} 已完成\`;
      empty.hidden = visible.length > 0 || stage !== 'final';
      empty.textContent = filter === 'open' && remaining === 0 ? '今天的任务都完成了，做得很好！' : filter === 'done' ? '还没有已完成的任务，从一件小事开始吧。' : '还没有任务，写下今天的第一件小事吧。';
      document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
      if (focusedId !== null) {
        const remaining = [...list.querySelectorAll('input:not(:disabled)')];
        const sameTask = remaining.find(item => item.dataset.taskId === focusedId);
        if (sameTask) sameTask.focus();
        else if (remaining.length) remaining[Math.min(previousIndex, remaining.length - 1)].focus();
        else document.querySelector('[data-filter="' + filter + '"]').focus();
      }
    };
    const addTask = () => {
      const title = input.value.trim();
      if (!title) { feedback.textContent = stage === 'final' ? '先写下一件小事，再点击添加。' : ''; input.focus(); return; }
      tasks.push({ id: nextId++, title, done: false }); input.value = '';
      feedback.textContent = filter === 'done' ? '已添加新任务。切换到“全部”或“未完成”即可查看。' : '新任务已添加。';
      render(); input.focus();
    };
    document.querySelector('#add-task').addEventListener('click', addTask);
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addTask(); } });
    document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; feedback.textContent = ''; render(); }));
    document.querySelector('#reset').addEventListener('click', () => { tasks = initial(); nextId = 4; filter = 'all'; input.value = ''; feedback.textContent = '示例已重置。'; render(); });
    const notes = {
      waiting: '', design: '设计草图 · 先确定添加、勾选和筛选的位置',
      architecture: '方案整合 · 无需登录，独立任务 ID，保留筛选条件',
      initial: '初版实现 · 可以操作，正在交给架构师审查',
      review: '互审中 · 两个边界细节正在修正', final: '修正版 · 添加、完成、筛选与边界提示均已就绪',
    };
    window.addEventListener('message', event => {
      const data = event.data;
      if (event.source !== window.parent || !data || data.type !== 'clowder-onboarding-stage' || data.version !== 1 || !Object.hasOwn(notes, data.stage)) return;
      stage = data.stage;
      document.body.dataset.stage = stage;
      document.querySelector('#stage-note').textContent = notes[stage];
      const interactive = ['initial', 'review', 'final'].includes(stage);
      document.querySelectorAll('input, button').forEach(control => { control.disabled = !interactive; });
      const review = document.querySelector('#review-notes');
      review.hidden = !['review', 'final'].includes(stage);
      review.textContent = stage === 'final' ? '✓ 已修正：全部完成时给出鼓励提示；空白输入时提示补充。' : '待修正：① 全部完成后列表空白　② 空白输入没有反馈';
      render();
      window.parent.postMessage({ type: 'clowder-onboarding-stage-ready', version: 1, stage }, '*');
    });
    render();
    window.parent.postMessage({ type: 'clowder-onboarding-ready', version: 1 }, '*');
  })();
</script>
</body>
</html>
`;
