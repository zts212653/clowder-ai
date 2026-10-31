// Exact persisted html_widget payload from message
// 0001787367291487-000061-6b966fd9#rich:ai-agent-priority-convergence-20260821-v1.
// Keep this as a full message-flow regression fixture: the production blank-card
// failure only appeared with the real 14KB document, while the small layout
// fixtures continued to pass.
export const LIVE_MESSAGE_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root {
    --ink:#172033;
    --muted:#667085;
    --paper:#fbfaf7;
    --panel:#ffffff;
    --line:#e8e1d7;
    --coral:#df755f;
    --coral-soft:#fff0eb;
    --mint:#348b78;
    --mint-soft:#e8f6f1;
    --gold:#b78524;
    --gold-soft:#fff6dc;
    --navy:#1e2c47;
    --shadow:0 16px 42px rgba(30,44,71,.10);
  }
  * { box-sizing:border-box; }
  html,body { margin:0; min-height:100%; background:var(--paper); color:var(--ink); }
  body {
    font-family: ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    line-height:1.6;
  }
  .page { max-width:1180px; margin:0 auto; padding:30px; }
  .hero {
    position:relative; overflow:hidden; padding:34px;
    color:white; border-radius:28px;
    background:
      radial-gradient(circle at 87% 18%, rgba(255,255,255,.16) 0 8%, transparent 9%),
      radial-gradient(circle at 93% 46%, rgba(255,255,255,.09) 0 13%, transparent 14%),
      linear-gradient(135deg,#19243b 0%,#263b5f 66%,#315b67 100%);
    box-shadow:var(--shadow);
  }
  .hero:after {
    content:""; position:absolute; width:260px; height:260px; right:-70px; bottom:-150px;
    border:40px solid rgba(255,255,255,.08); border-radius:50%;
  }
  .eyebrow { letter-spacing:.16em; text-transform:uppercase; font-size:12px; font-weight:800; opacity:.72; }
  h1 { margin:10px 0 8px; max-width:820px; font-size:clamp(28px,4vw,48px); line-height:1.17; letter-spacing:-.035em; }
  .hero p { max-width:780px; margin:0; color:rgba(255,255,255,.78); font-size:16px; }
  .north-star {
    position:relative; z-index:1; display:flex; align-items:center; gap:14px;
    margin-top:24px; padding:15px 18px; border:1px solid rgba(255,255,255,.18);
    border-radius:17px; background:rgba(255,255,255,.09); backdrop-filter:blur(8px);
  }
  .star { display:grid; place-items:center; flex:0 0 42px; height:42px; border-radius:13px; background:#f4ba53; color:#26324a; font-size:22px; }
  .north-star strong { display:block; font-size:17px; }
  .north-star span { display:block; font-size:13px; color:rgba(255,255,255,.68); }

  .summary-grid { display:grid; grid-template-columns:1.15fr 1fr 1fr; gap:14px; margin:18px 0; }
  .summary {
    min-height:124px; padding:19px; border:1px solid var(--line); border-radius:20px; background:var(--panel);
    box-shadow:0 8px 25px rgba(30,44,71,.05);
  }
  .summary.primary { border-color:#e8a08f; background:linear-gradient(145deg,#fffaf8,#fff0eb); }
  .label { display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:800; letter-spacing:.08em; color:var(--muted); }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--coral); }
  .summary h2 { margin:8px 0 4px; font-size:19px; line-height:1.25; }
  .summary p { margin:0; color:var(--muted); font-size:13px; }

  .tabs {
    display:flex; gap:8px; padding:6px; border:1px solid var(--line); border-radius:16px; background:#f0ece5;
    width:max-content; max-width:100%; margin:24px 0 14px;
  }
  .tab {
    border:0; border-radius:11px; padding:10px 16px; background:transparent; color:#667085;
    font:inherit; font-weight:750; cursor:pointer;
  }
  .tab.active { color:white; background:var(--navy); box-shadow:0 5px 12px rgba(30,44,71,.22); }
  .panel { display:none; }
  .panel.active { display:block; animation:rise .25s ease; }
  @keyframes rise { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }

  .section { padding:24px; border:1px solid var(--line); border-radius:22px; background:var(--panel); box-shadow:0 8px 28px rgba(30,44,71,.05); }
  .section + .section { margin-top:14px; }
  .section-head { display:flex; justify-content:space-between; gap:20px; align-items:flex-end; margin-bottom:17px; }
  .section h3 { margin:0; font-size:22px; letter-spacing:-.02em; }
  .section-head p { margin:0; color:var(--muted); font-size:13px; }

  .flow { display:grid; grid-template-columns:repeat(8,minmax(92px,1fr)); gap:8px; }
  .step {
    position:relative; min-height:106px; padding:13px 11px; border-radius:15px;
    background:#f6f7f9; border:1px solid #e7eaf0;
  }
  .step:after {
    content:"›"; position:absolute; right:-8px; top:34px; z-index:2; color:#9ca3af; font-size:22px; font-weight:900;
  }
  .step:last-child:after { display:none; }
  .step em { display:block; font-style:normal; font-size:11px; color:var(--muted); }
  .step strong { display:block; margin-top:7px; font-size:14px; line-height:1.25; }
  .step:nth-child(1),.step:nth-child(2) { background:var(--coral-soft); border-color:#f2c6bb; }
  .step:nth-child(3),.step:nth-child(4) { background:#eef3fb; border-color:#cbd8ec; }
  .step:nth-child(5),.step:nth-child(6) { background:var(--mint-soft); border-color:#b8dfd5; }
  .step:nth-child(7),.step:nth-child(8) { background:var(--gold-soft); border-color:#ead69c; }

  .proof-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:11px; }
  .proof { padding:17px; border-left:4px solid var(--mint); border-radius:12px; background:#f8faf9; }
  .proof strong { display:block; margin-bottom:4px; font-size:14px; }
  .proof span { color:var(--muted); font-size:12px; }

  .guard {
    display:grid; grid-template-columns:auto 1fr; gap:15px; align-items:start;
    padding:19px; background:#18243a; color:white; border-radius:18px;
  }
  .guard .icon { font-size:24px; }
  .guard strong { display:block; margin-bottom:5px; }
  .guard p { margin:0; color:rgba(255,255,255,.69); font-size:13px; }

  .timeline { position:relative; margin-left:8px; padding-left:27px; }
  .timeline:before { content:""; position:absolute; left:7px; top:8px; bottom:8px; width:2px; background:#dbe1e9; }
  .day { position:relative; display:grid; grid-template-columns:138px 1fr; gap:15px; padding:0 0 22px; }
  .day:last-child { padding-bottom:0; }
  .day:before {
    content:""; position:absolute; left:-26px; top:7px; width:13px; height:13px; border:3px solid white;
    border-radius:50%; background:var(--coral); box-shadow:0 0 0 2px #e9b2a5;
  }
  .date { font-weight:850; color:var(--navy); }
  .day-card { padding:15px 17px; background:#f7f8fa; border:1px solid #e6e9ef; border-radius:15px; }
  .day-card strong { display:block; margin-bottom:3px; }
  .day-card span { color:var(--muted); font-size:13px; }
  .verdict { margin-top:18px; padding:18px; text-align:center; border:1px dashed #d4b664; border-radius:17px; background:var(--gold-soft); }
  .verdict strong { display:block; color:#745817; }

  .park-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:11px; }
  .park { padding:16px; border:1px solid var(--line); border-radius:15px; background:#fcfbf9; }
  .park b { display:block; font-size:14px; margin-bottom:4px; }
  .park span { font-size:12px; color:var(--muted); }
  .return { display:inline-block; margin-top:9px; padding:4px 8px; border-radius:999px; background:#f0ece4; color:#695f50; font-size:11px; font-weight:700; }

  .filter {
    margin-top:14px; padding:22px; border-radius:22px; color:white;
    background:linear-gradient(135deg,#325c66,#2a8574);
  }
  .filter h3 { margin:0 0 12px; font-size:20px; }
  .questions { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
  .question { padding:14px; border:1px solid rgba(255,255,255,.18); border-radius:14px; background:rgba(255,255,255,.09); }
  .question b { display:block; font-size:12px; opacity:.7; margin-bottom:4px; }
  .question span { font-weight:750; font-size:14px; }
  .foot { margin-top:13px; color:rgba(255,255,255,.72); font-size:12px; }

  @media (max-width:900px) {
    .page { padding:16px; }
    .summary-grid,.proof-grid { grid-template-columns:1fr 1fr; }
    .flow { grid-template-columns:repeat(4,1fr); }
    .step:nth-child(4):after { display:none; }
    .park-grid,.questions { grid-template-columns:1fr 1fr; }
  }
  @media (max-width:600px) {
    .hero { padding:25px 21px; }
    .summary-grid,.proof-grid,.park-grid,.questions { grid-template-columns:1fr; }
    .flow { grid-template-columns:1fr 1fr; }
    .step:nth-child(even):after { display:none; }
    .day { grid-template-columns:1fr; gap:5px; }
    .tabs { width:100%; }
    .tab { flex:1; padding:9px 7px; }
  }
</style>
</head>
<body>
<main class="page">
  <section class="hero">
    <div class="eyebrow">AI Agent 工作收敛 · 2026.08.21</div>
    <h1>不从三百件事开始，<br>从一段真实闭环开始。</h1>
    <p>你现在缺的不是更长的待办，而是一条能同时解释产品、技术、公司协同与开源故事的主线。</p>
    <div class="north-star">
      <div class="star">✦</div>
      <div>
        <strong>唯一主线：一个 Channel 里的一个 Evolution Case</strong>
        <span>两名真实参与者 + 各自 Agent · 只验证一段完整旅程</span>
      </div>
    </div>
  </section>

  <section class="summary-grid">
    <article class="summary primary">
      <div class="label"><span class="dot"></span>现在只做</div>
      <h2>Channel × Evolution Case</h2>
      <p>让多人协作入口与自进化证据闭环，在同一个真实任务里相遇。</p>
    </article>
    <article class="summary">
      <div class="label"><span class="dot" style="background:#b78524"></span>下周必须兑现</div>
      <h2>一份叙事母包</h2>
      <p>高原会议、刘赫伟同步、贡献者访谈、README 与首篇文章全部从它裁剪。</p>
    </article>
    <article class="summary">
      <div class="label"><span class="dot" style="background:#98a2b3"></span>明确暂缓</div>
      <h2>不提前造总系统</h2>
      <p>Roadmap、多人记忆、主动性、Dynamic UI、三产品集成、大学合作先不抢主线。</p>
    </article>
  </section>

  <nav class="tabs" aria-label="内容切换">
    <button class="tab active" data-target="mainline">唯一主线</button>
    <button class="tab" data-target="week">七天顺序</button>
    <button class="tab" data-target="parking">暂缓清单</button>
  </nav>

  <section id="mainline" class="panel active">
    <article class="section">
      <div class="section-head">
        <div><div class="label">ONE VERTICAL SLICE</div><h3>一次真实 Evolution Case</h3></div>
        <p>只允许一个有界改变；离线；人工批准；可回放</p>
      </div>
      <div class="flow">
        <div class="step"><em>01 · 共同输入</em><strong>目标与业务场景</strong></div>
        <div class="step"><em>02 · 定义尺子</em><strong>确认 Rubric</strong></div>
        <div class="step"><em>03 · 真实执行</em><strong>固定环境运行</strong></div>
        <div class="step"><em>04 · 汇合证据</em><strong>轨迹 + 环境</strong></div>
        <div class="step"><em>05 · 解释问题</em><strong>证据化归因</strong></div>
        <div class="step"><em>06 · 只改一层</em><strong>Skill / Prompt</strong></div>
        <div class="step"><em>07 · 同条件验证</em><strong>重跑对比</strong></div>
        <div class="step"><em>08 · 做出决策</em><strong>Keep / Tune / Sunset</strong></div>
      </div>
    </article>

    <article class="section">
      <div class="section-head">
        <div><div class="label">WHY THIS ONE</div><h3>它一次消掉四种分裂</h3></div>
      </div>
      <div class="proof-grid">
        <div class="proof"><strong>产品</strong><span>Channel 先证明“能住进去”，不再被 Roadmap 拖住。</span></div>
        <div class="proof"><strong>技术</strong><span>Rubric、trajectory、environment、归因终于闭成一条链。</span></div>
        <div class="proof"><strong>公司</strong><span>AgentArts / AutoHarness 获得一个可解释的 reference journey。</span></div>
        <div class="proof"><strong>开源</strong><span>README、视频、文章与贡献者都围绕同一真实证据说话。</span></div>
      </div>
    </article>

    <article class="section">
      <div class="guard">
        <div class="icon">🧭</div>
        <div>
          <strong>边界：不是把 Channel 和自进化两个大项目一起做</strong>
          <p>Channel 只提供共同现场；Case 只证明一次改变。F299 只投影轨迹，F300 不进关键路径，插件线只消费稳定接口。</p>
        </div>
      </div>
    </article>
  </section>

  <section id="week" class="panel">
    <article class="section">
      <div class="section-head">
        <div><div class="label">STARTING SEQUENCE</div><h3>七天只发生四次状态迁移</h3></div>
      </div>
      <div class="timeline">
        <div class="day">
          <div class="date">8 月 21 日</div>
          <div class="day-card"><strong>先装进两个容器</strong><span>A：方向备忘录；B：外部叙事母包。今天不新开 Feature，不做三百项 census。</span></div>
        </div>
        <div class="day">
          <div class="date">8 月 22–23 日</div>
          <div class="day-card"><strong>锁一个 Case，不造平台</strong><span>选任务、参与者、Rubric、环境、允许改变的一层和重跑方式；输出一页 Case contract。</span></div>
        </div>
        <div class="day">
          <div class="date">8 月 24 日</div>
          <div class="day-card"><strong>用同一母包对齐外部合作</strong><span>高原会议、刘赫伟同步；现场新请求只进候选池，不立即扩成新产品线。</span></div>
        </div>
        <div class="day">
          <div class="date">8 月 25–28 日</div>
          <div class="day-card"><strong>跑通一次离线闭环</strong><span>真实协作 → 证据 → 单步改变 → 重跑 → keep/tune/sunset；记录真正暴露的缺口。</span></div>
        </div>
      </div>
      <div class="verdict">
        <strong>周末唯一判断题</strong>
        能否用同一段真实旅程解释：发生了什么、为什么要改、改后是否真的更好？
      </div>
    </article>
  </section>

  <section id="parking" class="panel">
    <article class="section">
      <div class="section-head">
        <div><div class="label">NOT NOW ≠ NEVER</div><h3>真实，但不是起点</h3></div>
        <p>每件事都有明确的“回来条件”</p>
      </div>
      <div class="park-grid">
        <div class="park"><b>三百 Feature census</b><span>先别把方向问题变成清点工程。</span><i class="return">Case 后做有界治理</i></div>
        <div class="park"><b>Roadmap 继续抛光</b><span>不是 Channel dogfood 的前置。</span><i class="return">出现真实多线瓶颈后</i></div>
        <div class="park"><b>多人记忆总设计</b><span>没有真实旅程时边界多靠想象。</span><i class="return">共享/私有/撤权需求出现后</i></div>
        <div class="park"><b>Agent 主动性</b><span>会显著增加行为与授权变量。</span><i class="return">单步离线闭环稳定后</i></div>
        <div class="park"><b>插件 / Dynamic UI</b><span>沿浪哥现有责任线推进。</span><i class="return">Case 需要稳定接口时</i></div>
        <div class="park"><b>三款云产品集成</b><span>不能变成三个产品开发团队。</span><i class="return">AgentArts reference 成立后</i></div>
        <div class="park"><b>仓库拆分与组织迁移</b><span>是治理动作，不直接证明用户价值。</span><i class="return">实际阻断外部贡献后</i></div>
        <div class="park"><b>校企合作研究计划</b><span>现在的问题陈述仍太宽。</span><i class="return">暴露内部解不了的问题后</i></div>
        <div class="park"><b>在线自治进化</b><span>先别让系统自己改尺子、改自己、再判自己赢。</span><i class="return">离线归因可信后</i></div>
      </div>
    </article>
  </section>

  <aside class="filter">
    <h3>脑子再次塞满时，只问三句话</h3>
    <div class="questions">
      <div class="question"><b>01</b><span>它直接帮助首个 Evolution Case 吗？</span></div>
      <div class="question"><b>02</b><span>它是下周有明确截止日期的外部承诺吗？</span></div>
      <div class="question"><b>03</b><span>两者都不是？那就放进暂缓区。</span></div>
    </div>
    <div class="foot">起点不是“把所有事安排好”，而是让下一条证据链开始流动。</div>
  </aside>
</main>
<script>
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const panels = Array.from(document.querySelectorAll('.panel'));
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      tabs.forEach(function(item) { item.classList.remove('active'); });
      panels.forEach(function(panel) { panel.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById(tab.dataset.target).classList.add('active');
    });
  });
</script>
</body>
</html>`;
