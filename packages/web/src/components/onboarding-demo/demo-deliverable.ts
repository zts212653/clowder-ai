import type { ShellLanguage } from '../shell/shell-language';
import { demoDeliverableCopy } from './demo-deliverable.shell-copy';

// Only bundled dictionaries enter the script. Task input remains DOM text, never HTML.
export function getDemoDeliverableHtml(language: ShellLanguage = 'zh'): string {
  const initialLanguage = language === 'en' ? 'en' : 'zh';
  const serialize = (copy: typeof demoDeliverableCopy.zh) => ({
    ...copy,
    // The opaque-origin document renders dynamic counts without evaluating code.
    count: copy.count('{done}', '{total}'),
  });
  const dictionaries = JSON.stringify({
    zh: serialize(demoDeliverableCopy.zh),
    en: serialize(demoDeliverableCopy.en),
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${initialLanguage === 'en' ? 'en' : 'zh-CN'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; connect-src 'none'">
  <title data-demo-copy="title"></title>
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
<section id="waiting"><strong data-demo-copy="todo"></strong><span data-demo-copy="waitingOne"></span><br><span data-demo-copy="waitingTwo"></span></section>
<main>
  <div class="eyebrow" data-demo-copy="eyebrow"></div>
  <h1 data-demo-copy="todo"></h1>
  <p id="stage-note" role="status"></p>
  <p class="intro" data-demo-copy="intro"></p>
  <div class="entry" role="group" data-demo-label="addGroup"><input id="new-task" type="text" data-demo-placeholder="placeholder" data-demo-label="newTask" aria-describedby="feedback" maxlength="160" autocomplete="off"><button id="add-task" type="button" data-demo-copy="add"></button></div>
  <p id="feedback" role="status"></p>
  <div class="toolbar" data-demo-label="filterGroup"><button data-filter="all" aria-pressed="true" data-demo-copy="all"></button><button data-filter="open" aria-pressed="false" data-demo-copy="open"></button><button data-filter="done" aria-pressed="false" data-demo-copy="done"></button><span id="count"></span></div>
  <ul id="tasks" data-demo-label="taskList"></ul>
  <p id="empty" hidden></p>
  <div id="review-notes" hidden></div>
  <footer><span><span data-demo-copy="footerOne"></span><br><span data-demo-copy="footerTwo"></span></span><button id="reset" type="button" data-demo-copy="reset"></button></footer>
</main>
<script>
  (() => {
    const dictionaries = ${dictionaries};
    let language = '${initialLanguage}';
    let copy = dictionaries[language];
    let stage = 'waiting';
    let nextId = 4;
    let filter = 'all';
    const initial = () => [
      { id: 1, title: copy.taskOne, copyKey: 'taskOne', done: true },
      { id: 2, title: copy.taskTwo, copyKey: 'taskTwo', done: false },
      { id: 3, title: copy.taskThree, copyKey: 'taskThree', done: false },
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
          showFeedback(task.done ? 'completed' : 'reopened');
          render();
        });
        const title = document.createElement('span'); title.textContent = task.title;
        label.append(check, title); row.append(label); list.append(row);
      }
      const remaining = tasks.filter(task => !task.done).length;
      document.querySelector('#count').textContent = copy.count.replace('{done}', String(tasks.length - remaining)).replace('{total}', String(tasks.length));
      empty.hidden = visible.length > 0 || stage !== 'final';
      empty.textContent = filter === 'open' && remaining === 0 ? copy.allDone : filter === 'done' ? copy.noDone : copy.noTasks;
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
      if (!title) { showFeedback(stage === 'final' ? 'blank' : ''); input.focus(); return; }
      tasks.push({ id: nextId++, title, done: false }); input.value = '';
      showFeedback(filter === 'done' ? 'addedHidden' : 'added');
      render(); input.focus();
    };
    document.querySelector('#add-task').addEventListener('click', addTask);
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addTask(); } });
    document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; showFeedback(''); render(); }));
    document.querySelector('#reset').addEventListener('click', () => { tasks = initial(); nextId = 4; filter = 'all'; input.value = ''; showFeedback('resetDone'); render(); });
    let feedbackKey = '';
    function showFeedback(key) {
      feedbackKey = key;
      feedback.textContent = key ? copy[key] : '';
    }
    const applyCopy = () => {
      document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
      document.querySelectorAll('[data-demo-copy]').forEach(element => { element.textContent = copy[element.dataset.demoCopy]; });
      document.querySelectorAll('[data-demo-label]').forEach(element => { element.setAttribute('aria-label', copy[element.dataset.demoLabel]); });
      input.placeholder = copy.placeholder;
      for (const task of tasks) if (task.copyKey) task.title = copy[task.copyKey];
      showFeedback(feedbackKey);
    };
    window.addEventListener('message', event => {
      const data = event.data;
      if (event.source !== window.parent || !data || data.type !== 'clowder-onboarding-stage' || data.version !== 1 || !Object.hasOwn(copy.stages, data.stage)) return;
      if (data.language === 'zh' || data.language === 'en') {
        language = data.language;
        copy = dictionaries[language];
        applyCopy();
      }
      stage = data.stage;
      document.body.dataset.stage = stage;
      document.querySelector('#stage-note').textContent = copy.stages[stage];
      const interactive = ['initial', 'review', 'final'].includes(stage);
      document.querySelectorAll('input, button').forEach(control => { control.disabled = !interactive; });
      const review = document.querySelector('#review-notes');
      review.hidden = !['review', 'final'].includes(stage);
      review.textContent = stage === 'final' ? copy.reviewFixed : copy.reviewIssues;
      render();
      window.parent.postMessage({ type: 'clowder-onboarding-stage-ready', version: 1, stage }, '*');
    });
    applyCopy();
    render();
    window.parent.postMessage({ type: 'clowder-onboarding-ready', version: 1 }, '*');
  })();
</script>
</body>
</html>
`;
}

export const DEMO_DELIVERABLE_HTML = getDemoDeliverableHtml();
