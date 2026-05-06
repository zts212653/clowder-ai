import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

const C = {
  ink: '#263238',
  muted: '#667085',
  paper: '#fffaf0',
  paper2: '#f8efe0',
  purple: '#7c3aed',
  purpleSoft: '#ede7ff',
  blue: '#2563eb',
  blueSoft: '#dbeafe',
  green: '#16a34a',
  greenSoft: '#dcfce7',
  orange: '#f97316',
  orangeSoft: '#ffedd5',
  red: '#dc2626',
  redSoft: '#fee2e2',
  teal: '#0f766e',
  tealSoft: '#ccfbf1',
  line: '#344054',
  white: '#ffffff',
};

const font = `"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Arial Unicode MS", sans-serif`;

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function svgShell(width, height, body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#8a6f45" flood-opacity="0.14"/>
    </filter>
    <filter id="soft">
      <feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="2" seed="12" result="noise"/>
      <feColorMatrix in="noise" type="saturate" values="0"/>
      <feBlend in="SourceGraphic" mode="multiply"/>
    </filter>
    <marker id="arrow" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
      <path d="M 1 1 L 11 6 L 1 11 z" fill="${C.line}"/>
    </marker>
    <marker id="arrowRed" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="12" markerHeight="12" orient="auto-start-reverse">
      <path d="M 1 1 L 11 6 L 1 11 z" fill="${C.red}"/>
    </marker>
    <style><![CDATA[
      text { font-family: ${font}; letter-spacing: 0; }
      .title { font-weight: 800; fill: ${C.ink}; }
      .subtitle { fill: ${C.muted}; }
      .label { font-weight: 700; fill: ${C.ink}; }
      .small { fill: ${C.muted}; }
      .mono { font-family: "SFMono-Regular", "Menlo", "Consolas", monospace; }
    ]]></style>
  </defs>
  <rect width="100%" height="100%" fill="${C.paper}"/>
  <path d="M0,70 C420,10 760,95 1120,42 C1440,-4 1660,42 2100,16 L2100,0 L0,0 Z" fill="${C.paper2}" opacity="0.8"/>
  ${body}
</svg>`;
}

function lines(items, x, y, opts = {}) {
  const { size = 28, weight = 500, fill = C.ink, leading = 1.34, anchor = 'start', cls = '', opacity = 1 } = opts;
  const spans = items
    .map((item, idx) => {
      const text = typeof item === 'string' ? item : item.text;
      const tFill = typeof item === 'string' ? fill : item.fill || fill;
      const tWeight = typeof item === 'string' ? weight : item.weight || weight;
      const tSize = typeof item === 'string' ? size : item.size || size;
      return `<tspan x="${x}" dy="${idx === 0 ? 0 : tSize * leading}" fill="${tFill}" font-weight="${tWeight}" font-size="${tSize}">${esc(text)}</tspan>`;
    })
    .join('');
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" opacity="${opacity}" class="${cls}">${spans}</text>`;
}

function box(x, y, w, h, opts = {}) {
  const {
    fill = C.white,
    stroke = C.line,
    sw = 3,
    r = 26,
    dash = '',
    opacity = 1,
    shadow = true,
    label,
    labelColor = stroke,
  } = opts;
  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="${dash}" opacity="${opacity}" filter="${shadow ? 'url(#shadow)' : ''}"/>
    ${label ? `<rect x="${x + 24}" y="${y - 22}" width="${Math.max(140, label.length * 28)}" height="44" rx="22" fill="${labelColor}" opacity="0.96"/><text x="${x + 42}" y="${y + 8}" font-size="25" font-weight="800" fill="white">${esc(label)}</text>` : ''}
  `;
}

function pill(x, y, text, fill, stroke = fill, opts = {}) {
  const w = opts.w || Math.max(120, text.length * (opts.size || 24) + 34);
  const h = opts.h || 44;
  const size = opts.size || 24;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
  <text x="${x + w / 2}" y="${y + h / 2 + size * 0.34}" text-anchor="middle" font-size="${size}" font-weight="700" fill="${opts.textFill || C.ink}">${esc(text)}</text>`;
}

function arrow(x1, y1, x2, y2, opts = {}) {
  const color = opts.color || C.line;
  const dash = opts.dash ? `stroke-dasharray="${opts.dash}"` : '';
  const marker = opts.red ? 'arrowRed' : 'arrow';
  return `<path d="M ${x1} ${y1} C ${opts.cx1 ?? (x1 + x2) / 2} ${opts.cy1 ?? y1}, ${opts.cx2 ?? (x1 + x2) / 2} ${opts.cy2 ?? y2}, ${x2} ${y2}" fill="none" stroke="${color}" stroke-width="${opts.sw || 5}" ${dash} stroke-linecap="round" marker-end="url(#${marker})"/>`;
}

function simpleArrow(x1, y1, x2, y2, opts = {}) {
  const color = opts.color || C.line;
  const marker = opts.red ? 'arrowRed' : 'arrow';
  const dash = opts.dash ? `stroke-dasharray="${opts.dash}"` : '';
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${opts.sw || 5}" ${dash} stroke-linecap="round" marker-end="url(#${marker})"/>`;
}

function cat(x, y, scale, color, name, role, opts = {}) {
  const s = scale;
  const face = opts.face || '#fff7ed';
  const eye = opts.eye || C.ink;
  const mane = opts.mane
    ? `<path d="M ${x - 60 * s} ${y + 10 * s} C ${x - 95 * s} ${y + 60 * s}, ${x - 38 * s} ${y + 95 * s}, ${x} ${y + 78 * s} C ${x + 38 * s} ${y + 96 * s}, ${x + 95 * s} ${y + 60 * s}, ${x + 60 * s} ${y + 10 * s}" fill="${opts.mane}" stroke="${C.line}" stroke-width="${3 * s}"/>`
    : '';
  return `
  <g>
    ${mane}
    <path d="M ${x - 54 * s} ${y - 36 * s} L ${x - 22 * s} ${y - 74 * s} L ${x - 6 * s} ${y - 32 * s}" fill="${face}" stroke="${C.line}" stroke-width="${3 * s}"/>
    <path d="M ${x + 54 * s} ${y - 36 * s} L ${x + 22 * s} ${y - 74 * s} L ${x + 6 * s} ${y - 32 * s}" fill="${face}" stroke="${C.line}" stroke-width="${3 * s}"/>
    <ellipse cx="${x}" cy="${y}" rx="${64 * s}" ry="${55 * s}" fill="${face}" stroke="${C.line}" stroke-width="${3 * s}"/>
    <circle cx="${x - 22 * s}" cy="${y - 8 * s}" r="${6 * s}" fill="${eye}"/>
    <circle cx="${x + 22 * s}" cy="${y - 8 * s}" r="${6 * s}" fill="${eye}"/>
    <path d="M ${x - 8 * s} ${y + 10 * s} Q ${x} ${y + 18 * s} ${x + 8 * s} ${y + 10 * s}" fill="none" stroke="${C.line}" stroke-width="${3 * s}" stroke-linecap="round"/>
    <path d="M ${x - 13 * s} ${y + 18 * s} Q ${x} ${y + 28 * s} ${x + 13 * s} ${y + 18 * s}" fill="none" stroke="${C.line}" stroke-width="${2.5 * s}" stroke-linecap="round"/>
    <path d="M ${x - 48 * s} ${y + 8 * s} L ${x - 85 * s} ${y}" stroke="${C.line}" stroke-width="${2 * s}" stroke-linecap="round"/>
    <path d="M ${x - 48 * s} ${y + 18 * s} L ${x - 84 * s} ${y + 24 * s}" stroke="${C.line}" stroke-width="${2 * s}" stroke-linecap="round"/>
    <path d="M ${x + 48 * s} ${y + 8 * s} L ${x + 85 * s} ${y}" stroke="${C.line}" stroke-width="${2 * s}" stroke-linecap="round"/>
    <path d="M ${x + 48 * s} ${y + 18 * s} L ${x + 84 * s} ${y + 24 * s}" stroke="${C.line}" stroke-width="${2 * s}" stroke-linecap="round"/>
    <rect x="${x - 78 * s}" y="${y + 70 * s}" width="${156 * s}" height="${58 * s}" rx="${22 * s}" fill="${color}" opacity="0.96"/>
    <text x="${x}" y="${y + 98 * s}" text-anchor="middle" font-size="${24 * s}" font-weight="800" fill="white">${esc(name)}</text>
    <text x="${x}" y="${y + 124 * s}" text-anchor="middle" font-size="${18 * s}" font-weight="600" fill="white" opacity="0.92">${esc(role)}</text>
  </g>`;
}

function human(x, y, scale) {
  const s = scale;
  return `
  <g>
    <circle cx="${x}" cy="${y - 48 * s}" r="${30 * s}" fill="#f3d7bd" stroke="${C.line}" stroke-width="${3 * s}"/>
    <path d="M ${x - 50 * s} ${y + 26 * s} Q ${x} ${y - 20 * s} ${x + 50 * s} ${y + 26 * s} L ${x + 34 * s} ${y + 94 * s} L ${x - 34 * s} ${y + 94 * s} Z" fill="#334155" stroke="${C.line}" stroke-width="${3 * s}"/>
    <path d="M ${x + 42 * s} ${y + 2 * s} C ${x + 84 * s} ${y - 18 * s}, ${x + 110 * s} ${y - 26 * s}, ${x + 142 * s} ${y - 35 * s}" fill="none" stroke="${C.line}" stroke-width="${6 * s}" stroke-linecap="round"/>
    <circle cx="${x + 150 * s}" cy="${y - 37 * s}" r="${8 * s}" fill="${C.line}"/>
    <text x="${x}" y="${y + 140 * s}" text-anchor="middle" font-size="${26 * s}" font-weight="800" fill="${C.ink}">铲屎官 / CVO</text>
  </g>`;
}

function yarn(x, y, r, color = C.purple) {
  return `
  <g>
    <circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="0.88" stroke="${C.line}" stroke-width="3"/>
    <path d="M ${x - r * 0.7} ${y - r * 0.3} C ${x - r * 0.15} ${y - r * 0.9}, ${x + r * 0.45} ${y - r * 0.7}, ${x + r * 0.76} ${y - r * 0.1}" fill="none" stroke="white" stroke-width="${r * 0.12}" opacity="0.86"/>
    <path d="M ${x - r * 0.8} ${y + r * 0.25} C ${x - r * 0.1} ${y - r * 0.1}, ${x + r * 0.3} ${y + r * 0.4}, ${x + r * 0.85} ${y + r * 0.1}" fill="none" stroke="white" stroke-width="${r * 0.11}" opacity="0.86"/>
    <path d="M ${x - r * 0.15} ${y - r * 0.85} C ${x - r * 0.35} ${y - r * 0.05}, ${x + r * 0.15} ${y + r * 0.35}, ${x - r * 0.15} ${y + r * 0.86}" fill="none" stroke="white" stroke-width="${r * 0.1}" opacity="0.86"/>
  </g>`;
}

function bookStack(x, y, scale = 1) {
  const s = scale;
  return `
  <g>
    <rect x="${x}" y="${y}" width="${120 * s}" height="${28 * s}" rx="${6 * s}" fill="${C.greenSoft}" stroke="${C.green}" stroke-width="${3 * s}"/>
    <rect x="${x + 18 * s}" y="${y - 32 * s}" width="${126 * s}" height="${28 * s}" rx="${6 * s}" fill="${C.blueSoft}" stroke="${C.blue}" stroke-width="${3 * s}"/>
    <rect x="${x - 8 * s}" y="${y - 64 * s}" width="${116 * s}" height="${28 * s}" rx="${6 * s}" fill="${C.orangeSoft}" stroke="${C.orange}" stroke-width="${3 * s}"/>
    <text x="${x + 72 * s}" y="${y + 58 * s}" text-anchor="middle" font-size="${22 * s}" font-weight="700" fill="${C.ink}">docs / evidence</text>
  </g>`;
}

function sectionTitle(title, subtitle, width) {
  return `
  ${lines([title], width / 2, 70, { size: 48, weight: 850, anchor: 'middle', cls: 'title' })}
  ${subtitle ? lines([subtitle], width / 2, 112, { size: 24, weight: 600, fill: C.muted, anchor: 'middle' }) : ''}`;
}

function heroDiagram() {
  const w = 1800;
  const h = 1200;
  const body = `
  ${sectionTitle('Cat Cafe 产品全景：不同引擎看同一件事', 'AI 团队不是岗位分工表；跨厂商多样性是结构性质量来源', w)}

  ${box(78, 145, 1644, 285, { fill: '#fff7ed', stroke: C.orange, label: '方向层 / CVO 共创', labelColor: C.orange })}
  <rect x="155" y="260" width="420" height="90" rx="42" fill="#fed7aa" stroke="${C.line}" stroke-width="4"/>
  <rect x="125" y="316" width="485" height="45" rx="22" fill="#fdba74" stroke="${C.line}" stroke-width="3"/>
  ${human(360, 270, 0.82)}
  ${box(720, 205, 700, 170, { fill: C.white, stroke: C.orange, r: 20, shadow: false })}
  ${lines(['愿景', 'SOP', '教训'], 830, 265, { size: 34, weight: 850, fill: C.orange })}
  ${lines(['铲屎官定义方向与边界', '猫猫自治执行，必要时 push back'], 1015, 252, { size: 26, weight: 650, fill: C.ink })}
  <circle cx="1538" cy="270" r="62" fill="${C.redSoft}" stroke="${C.red}" stroke-width="6"/>
  <circle cx="1538" cy="270" r="36" fill="${C.red}" opacity="0.9"/>
  ${lines(['Magic Words', '紧急拉闸'], 1538, 365, { size: 24, weight: 800, fill: C.red, anchor: 'middle' })}
  ${lines(['↕ 深度贴贴：共创，不是逐步审批'], 900, 465, { size: 30, weight: 800, fill: C.purple, anchor: 'middle' })}

  ${box(78, 505, 1644, 335, { fill: '#f5f3ff', stroke: C.purple, label: '执行层 / 三个引擎', labelColor: C.purple })}
  ${box(155, 575, 395, 200, { fill: C.white, stroke: C.purple, r: 24 })}
  ${box(702, 575, 395, 200, { fill: C.white, stroke: C.purple, r: 24 })}
  ${box(1249, 575, 395, 200, { fill: C.white, stroke: C.purple, r: 24 })}
  ${cat(355, 615, 0.9, C.purple, 'Ragdoll', '布偶/Claude', { face: '#f8fafc', eye: '#334155' })}
  ${cat(900, 615, 0.9, C.blue, 'Maine Coon', '缅因/GPT', { face: '#fef3c7', mane: '#d6a45f' })}
  ${cat(1445, 615, 0.9, C.teal, 'Siamese', '暹罗/Gemini', { face: '#e0f2fe', eye: '#0f172a' })}
  ${lines(['IDE + 蓝图'], 355, 808, { size: 25, weight: 800, anchor: 'middle', fill: C.muted })}
  ${lines(['放大镜 + checklist'], 900, 808, { size: 25, weight: 800, anchor: 'middle', fill: C.muted })}
  ${lines(['画板 + 调色盘'], 1445, 808, { size: 25, weight: 800, anchor: 'middle', fill: C.muted })}
  ${simpleArrow(540, 695, 705, 695, { color: C.purple, sw: 6 })}
  ${simpleArrow(1095, 695, 1250, 695, { color: C.purple, sw: 6 })}
  ${yarn(626, 695, 34)}
  ${yarn(1175, 695, 34)}
  ${lines(['毛线球 = 球权，任何猫都能接'], 900, 560, { size: 24, weight: 800, anchor: 'middle', fill: C.purple })}
  ${lines(['工位物品只暗示观察习惯，不是岗位边界'], 900, 834, { size: 24, weight: 850, anchor: 'middle', fill: C.purple })}

  ${box(78, 895, 1644, 235, { fill: '#ecfdf5', stroke: C.green, label: '共享基础设施', labelColor: C.green })}
  ${bookStack(205, 1020, 1.15)}
  ${box(520, 955, 340, 120, { fill: C.white, stroke: C.green, r: 22, shadow: false })}
  ${lines(['SOP 轨道', 'feat → review → merge'], 690, 1008, { size: 26, weight: 800, anchor: 'middle', fill: C.green })}
  ${box(930, 955, 340, 120, { fill: C.white, stroke: C.blue, r: 22, shadow: false })}
  ${lines(['监控仪表盘', '谁在跑 / 谁在等'], 1100, 1008, { size: 26, weight: 800, anchor: 'middle', fill: C.blue })}
  ${box(1335, 955, 290, 120, { fill: C.white, stroke: C.orange, r: 22, shadow: false })}
  ${lines(['外部触达', '飞书 · 企微 · TG'], 1480, 1008, { size: 26, weight: 800, anchor: 'middle', fill: C.orange })}
  ${lines(['valid_as_of: 2026-05-05 / CN first'], 1688, 1160, { size: 20, weight: 700, fill: C.muted, anchor: 'end' })}
  `;
  return svgShell(w, h, body);
}

function sourceRows(rows, x, y) {
  return rows
    .map((row, idx) => {
      const cy = y + idx * 28;
      return `
      <rect x="${x}" y="${cy - 18}" width="52" height="24" rx="12" fill="${row.fill}" stroke="${row.stroke}" stroke-width="2"/>
      <text x="${x + 26}" y="${cy}" text-anchor="middle" font-size="14" font-weight="900" fill="${row.stroke}">${esc(row.tag)}</text>
      <text x="${x + 66}" y="${cy}" font-size="16" font-weight="650" fill="${C.ink}">${esc(row.text)}</text>
    `;
    })
    .join('');
}

function componentBox(x, y, w, h, index, title, items, color, anchorText, sources = []) {
  return `
  ${box(x, y, w, h, { fill: C.white, stroke: color, r: 24 })}
  ${pill(x + 22, y + 20, `${index}. ${title}`, `${color}22`, color, { size: 24, textFill: color, w: w - 44 })}
  ${lines(items, x + 34, y + 92, { size: 23, weight: 650, fill: C.ink, leading: 1.25 })}
  ${sources.length ? `<line x1="${x + 30}" y1="${y + h - 126}" x2="${x + w - 30}" y2="${y + h - 126}" stroke="${color}" stroke-width="2" opacity="0.24"/>` : ''}
  ${sources.length ? lines(['外部概念锚点'], x + 34, y + h - 96, { size: 17, weight: 850, fill: color }) : ''}
  ${sources.length ? sourceRows(sources, x + 34, y + h - 64) : ''}
  ${anchorText ? lines([anchorText], x + w - 34, y + h - 24, { size: 17, weight: 700, fill: C.muted, anchor: 'end' }) : ''}
  `;
}

function harnessMapDiagram() {
  const w = 2200;
  const h = 1650;
  const OAI = { tag: 'OAI', fill: '#e0f2fe', stroke: C.blue };
  const ANT = { tag: 'ANT', fill: '#f5f3ff', stroke: C.purple };
  const FOW = { tag: 'FOW', fill: '#ffedd5', stroke: C.orange };
  const body = `
  ${sectionTitle('Cat Cafe Harness Engineering：六大件 + 第七类', '行业六大构件我们全有落地；多猫协作还需要协作语义与球权治理', w)}
  ${pill(720, 132, 'Agent Quality = Model Capability × Environment Fit', C.purpleSoft, C.purple, { w: 760, size: 26, textFill: C.purple })}

  ${componentBox(
    80,
    220,
    630,
    345,
    1,
    'Durable State',
    ['docs/ 真相源', 'evidence.sqlite 编译层', 'Session Chain / Thread', 'Task / Workflow / InvocationQueue'],
    C.green,
    '→ 图5 Shared State',
    [
      { ...OAI, text: 'docs / plans / worktree SOR' },
      { ...ANT, text: 'structured handoff / session log' },
      { ...FOW, text: 'context engineering / harnessability' },
    ],
  )}
  ${componentBox(
    785,
    220,
    630,
    345,
    2,
    'Plans & Decomposition',
    [
      'feat-lifecycle → Design Gate',
      'writing-plans → Phase 拆分',
      'AC 对 evidence · Close Gate 三选一',
      '不许留 follow-up 尾巴',
    ],
    C.orange,
    '→ SOP / Gates',
    [
      { ...OAI, text: 'execution plans as artifacts' },
      { ...ANT, text: 'planner / feature decomposition' },
      { ...FOW, text: 'guides: specs / plans / rules' },
    ],
  )}
  ${componentBox(
    1490,
    220,
    630,
    345,
    3,
    'Feedback Loops',
    [
      'Computational: lint / test / gate / CI',
      'Inferential: 跨族 review / 愿景守护',
      'Human Runtime: Magic Words 拉闸',
      'CVO 漏斗决策',
    ],
    C.red,
    '→ 图3 verdict',
    [
      { ...OAI, text: 'agent reviews / CI / traces' },
      { ...ANT, text: 'evaluator / QA loop / trace reading' },
      { ...FOW, text: 'sensors: computational + inferential' },
    ],
  )}

  ${componentBox(
    80,
    630,
    630,
    365,
    4,
    'Legibility',
    [
      'search_evidence（增强 grep）',
      'Hub 明厨亮灶',
      'InvocationTracker：谁在跑 / 谁在等',
      'confidence / authority / sourceType',
      '看不见等于不存在',
    ],
    C.blue,
    '→ 图5 API / Hub',
    [
      { ...OAI, text: 'UI / logs / metrics / repo visible' },
      { ...ANT, text: 'structured artifacts for next agent' },
      { ...FOW, text: 'ambient affordances / harnessability' },
    ],
  )}
  ${componentBox(
    785,
    630,
    630,
    365,
    5,
    'Tool Mediation',
    [
      'MCP + Skill 认知路标',
      'SystemPromptBuilder',
      '入口硬 gate (F086)',
      'Dynamic Injection',
      '猫砂盆放在猫已经去的地方',
    ],
    C.purple,
    '→ L1/L3 Tooling',
    [
      { ...OAI, text: 'dev tools / gh / scripts / skills' },
      { ...ANT, text: 'harness routes tools; sandbox hands' },
      { ...FOW, text: 'computational controls / codemods' },
    ],
  )}
  ${componentBox(
    1490,
    630,
    630,
    365,
    6,
    'Entropy Control',
    [
      'F163 知识生命周期',
      'Build to Delete 判别式',
      'skeleton / explanation / probe',
      'ADR-031（Sunset 纪律）',
      '代码熵 + harness 自身熵',
    ],
    C.teal,
    '→ 图4 双飞轮',
    [
      { ...OAI, text: 'doc gardening / cleanup tasks' },
      { ...ANT, text: 're-review scaffold after upgrades' },
      { ...FOW, text: 'steering loop / keep quality left' },
    ],
  )}

  ${box(180, 1090, 1840, 370, { fill: '#fff7ed', stroke: C.orange, r: 30, label: '7. Collaboration Semantics', labelColor: C.orange })}
  ${lines(['六大件之外，Cat Cafe 独有'], 1100, 1150, { size: 35, weight: 900, fill: C.orange, anchor: 'middle' })}
  ${lines(
    [
      '@ 路由 · targetCats · hold_ball · 接 / 退 / 升三选一',
      '统一执行平面：InvocationQueue 接住所有 handoff',
      '跨厂商多样性：Claude × GPT × Gemini = 结构性纠错',
      'CVO 终裁：愿景层拍板，执行层自治',
      '核心定律：状态迁移必须由现实动作产生',
    ],
    280,
    1225,
    { size: 32, weight: 760, fill: C.ink, leading: 1.25 },
  )}
  ${cat(1690, 1238, 0.78, C.purple, '多猫', '协作协议', { face: '#fef3c7', mane: '#e7b76b' })}
  ${yarn(1565, 1310, 42, C.orange)}
  ${simpleArrow(1470, 1310, 1525, 1310, { color: C.orange })}
  ${simpleArrow(1605, 1310, 1662, 1310, { color: C.orange })}

  ${box(300, 1520, 1600, 82, { fill: '#fffbeb', stroke: '#d97706', r: 24, shadow: false })}
  ${lines(['六大件 = 中文社区综合归纳；OAI / ANT / FOW 是外部概念锚点，不是官方一一对应分类。详见 concept-map-2026-05-05.md。'], 1100, 1572, { size: 24, weight: 750, fill: '#92400e', anchor: 'middle' })}
  `;
  return svgShell(w, h, body);
}

function timelineLane(y, label, color) {
  return `
    ${pill(74, y - 32, label, `${color}22`, color, { w: 150, size: 24, textFill: color })}
    <line x1="260" y1="${y}" x2="1680" y2="${y}" stroke="${color}" stroke-width="5" stroke-linecap="round" opacity="0.5"/>
  `;
}

function eventDot(x, y, color, title, detail, opts = {}) {
  return `
    <circle cx="${x}" cy="${y}" r="20" fill="${color}" stroke="${C.line}" stroke-width="3"/>
    ${yarn(x, y - 48, opts.yarn ? 24 : 0, color)}
    ${lines([title], x, y + 54, { size: 24, weight: 850, fill: color, anchor: 'middle' })}
    ${detail ? lines(Array.isArray(detail) ? detail : [detail], x, y + 86, { size: 19, weight: 650, fill: C.muted, anchor: 'middle', leading: 1.18 }) : ''}
  `;
}

function a2aDiagram() {
  const w = 2000;
  const h = 1350;
  const body = `
  ${sectionTitle('A2A 协作球权流转：状态迁移必须由现实动作产生', '正常流看现实动作；反例看没有 tool call 的纯文本乒乓', w)}

  ${box(70, 160, 1810, 610, { fill: '#f8fafc', stroke: C.blue, r: 30, label: '正常流：接球 → 执行 → 交棒', labelColor: C.blue })}
  ${timelineLane(260, '铲屎官', C.orange)}
  ${timelineLane(390, 'Ragdoll', C.purple)}
  ${timelineLane(520, 'Maine Coon', C.blue)}
  ${timelineLane(650, 'Shared', C.green)}
  ${eventDot(330, 260, C.orange, '愿景输入', ['做 F183', 'Magic Words 可拉闸'])}
  ${simpleArrow(330, 285, 420, 360, { color: C.orange, sw: 4 })}
  ${eventDot(470, 390, C.purple, '接球', ['开始执行', '现实动作 ✓'], { yarn: true })}
  ${eventDot(760, 390, C.purple, '写完', ['git commit', '现实动作 ✓'])}
  ${eventDot(1060, 390, C.purple, '交棒', ['targetCats', '结构化路由 ✓'], { yarn: true })}
  ${simpleArrow(1060, 416, 1160, 492, { color: C.purple, sw: 4 })}
  ${eventDot(1210, 520, C.blue, 'review', ['读代码 / 跑测试', '现实动作 ✓'], { yarn: true })}
  ${eventDot(1490, 520, C.blue, 'verdict', ['pass + 交回', '现实动作 ✓'])}
  ${simpleArrow(1490, 545, 1600, 405, { color: C.blue, sw: 4 })}
  ${eventDot(1630, 390, C.purple, 'merge', ['合入 / 归档', '现实动作 ✓'])}
  <line x1="280" y1="650" x2="1720" y2="650" stroke="${C.green}" stroke-width="12" opacity="0.18"/>
  ${lines(['thread · task · docs · evidence · InvocationQueue：所有猫读写同一份，不靠消息口口相传'], 1000, 690, { size: 25, weight: 800, fill: C.green, anchor: 'middle' })}

  ${box(1410, 206, 400, 170, { fill: C.redSoft, stroke: C.red, r: 22, shadow: false, dash: '10 8' })}
  ${lines(['旁路：hold_ball', '仅用于 CLI 退出 / 等外部条件', 'wake 后续接；不是正常接球动作'], 1610, 255, { size: 22, weight: 800, fill: C.red, anchor: 'middle', leading: 1.2 })}

  ${box(70, 830, 1810, 390, { fill: '#fff7ed', stroke: C.red, r: 30, label: '反例：乒乓球死循环', labelColor: C.red })}
  ${pill(150, 920, '猫 A', C.purpleSoft, C.purple, { w: 130, textFill: C.purple })}
  ${pill(150, 1038, '猫 B', C.blueSoft, C.blue, { w: 130, textFill: C.blue })}
  <line x1="320" y1="940" x2="1200" y2="940" stroke="${C.purple}" stroke-width="4" opacity="0.35"/>
  <line x1="320" y1="1058" x2="1200" y2="1058" stroke="${C.blue}" stroke-width="4" opacity="0.35"/>
  ${simpleArrow(370, 940, 565, 1058, { color: C.red, dash: '10 8', red: true })}
  ${simpleArrow(600, 1058, 795, 940, { color: C.red, dash: '10 8', red: true })}
  ${simpleArrow(830, 940, 1025, 1058, { color: C.red, dash: '10 8', red: true })}
  ${simpleArrow(1060, 1058, 1215, 940, { color: C.red, dash: '10 8', red: true })}
  ${lines(['@猫B'], 485, 902, { size: 23, weight: 850, fill: C.red, anchor: 'middle' })}
  ${lines(['@猫A'], 700, 1120, { size: 23, weight: 850, fill: C.red, anchor: 'middle' })}
  ${lines(['@猫B'], 945, 902, { size: 23, weight: 850, fill: C.red, anchor: 'middle' })}
  ${lines(['@猫A'], 1140, 1120, { size: 23, weight: 850, fill: C.red, anchor: 'middle' })}
  ${lines(['纯文字声明', '没有 tool call', '没有 commit / verdict', '不产生状态迁移'], 1375, 925, { size: 28, weight: 850, fill: C.red, leading: 1.24 })}
  <circle cx="1665" cy="1015" r="82" fill="${C.red}" opacity="0.92"/>
  <path d="M 1620 970 L 1710 1060 M 1710 970 L 1620 1060" stroke="white" stroke-width="18" stroke-linecap="round"/>
  ${lines(['ping-pong', 'breaker 熔断'], 1665, 1124, { size: 24, weight: 900, fill: C.red, anchor: 'middle' })}

  ${box(360, 1245, 1280, 70, { fill: C.redSoft, stroke: C.red, r: 22, shadow: false })}
  ${lines(['红色虚线 = 纯文本，不算状态迁移；✓ = tool call / git commit / review verdict / MCP call'], 1000, 1290, { size: 24, weight: 800, fill: C.red, anchor: 'middle' })}
  `;
  return svgShell(w, h, body);
}

function node(cx, cy, text, color, w = 190) {
  const label = Array.isArray(text) ? text : [text];
  return `
    <rect x="${cx - w / 2}" y="${cy - 34}" width="${w}" height="68" rx="24" fill="white" stroke="${color}" stroke-width="3" filter="url(#shadow)"/>
    ${lines(label, cx, cy - (label.length > 1 ? 6 : -8), { size: 19, weight: 800, fill: color, anchor: 'middle', leading: 1.05 })}
  `;
}

function flywheel(cx, cy, r, color, title, steps) {
  const nodes = steps.map((step, i) => {
    const a = -Math.PI / 2 + (i / steps.length) * Math.PI * 2;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, text: step };
  });
  const arrows = nodes
    .map((n, i) => {
      const m = nodes[(i + 1) % nodes.length];
      return simpleArrow(n.x + (m.x > n.x ? 70 : -70), n.y, m.x + (m.x > n.x ? -70 : 70), m.y, { color, sw: 3 });
    })
    .join('');
  return `
    <circle cx="${cx}" cy="${cy}" r="${r + 78}" fill="${color}12" stroke="${color}" stroke-width="5" stroke-dasharray="14 10"/>
    ${arrows}
    ${nodes.map((n) => node(n.x, n.y, n.text, color)).join('')}
    <circle cx="${cx}" cy="${cy}" r="118" fill="white" stroke="${color}" stroke-width="5" filter="url(#shadow)"/>
    ${lines(Array.isArray(title) ? title : [title], cx, cy - 12, { size: 27, weight: 900, fill: color, anchor: 'middle', leading: 1.12 })}
  `;
}

function numberedStep(x, y, w, n, title, impl, color) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="88" rx="22" fill="white" stroke="${color}" stroke-width="3" filter="url(#shadow)"/>
    <circle cx="${x + 44}" cy="${y + 44}" r="25" fill="${color}" opacity="0.95"/>
    <text x="${x + 44}" y="${y + 53}" text-anchor="middle" font-size="24" font-weight="900" fill="white">${n}</text>
    ${lines([title], x + 86, y + 36, { size: 24, weight: 880, fill: C.ink })}
    ${lines([impl], x + 86, y + 66, { size: 18, weight: 700, fill: C.muted })}
  `;
}

function downArrow(x, y, color) {
  return simpleArrow(x, y, x, y + 28, { color, sw: 4 });
}

function stepPanel(x, y, w, color, title, subtitle, problem, steps, effect) {
  const stepY = y + 190;
  const gap = 104;
  return `
    ${box(x, y, w, 1080, { fill: `${color}12`, stroke: color, r: 34, label: title, labelColor: color })}
    ${lines([subtitle], x + w / 2, y + 72, { size: 31, weight: 900, fill: color, anchor: 'middle' })}
    ${box(x + 34, y + 104, w - 68, 62, { fill: 'white', stroke: color, r: 20, shadow: false })}
    ${lines([problem], x + w / 2, y + 145, { size: 21, weight: 780, fill: C.ink, anchor: 'middle' })}
    ${steps.map((step, idx) => numberedStep(x + 44, stepY + idx * gap, w - 88, idx + 1, step.title, step.impl, color)).join('')}
    ${steps
      .slice(0, -1)
      .map((_, idx) => downArrow(x + w / 2, stepY + 88 + idx * gap + 7, color))
      .join('')}
    ${box(x + 34, y + 870, w - 68, 160, { fill: 'white', stroke: color, r: 24, shadow: false })}
    ${pill(x + 58, y + 852, '飞轮效应', `${color}22`, color, { w: 150, size: 22, textFill: color })}
    ${lines(effect, x + 64, y + 925, { size: 23, weight: 820, fill: color, leading: 1.25 })}
  `;
}

function dualFlywheelDiagram() {
  const w = 2200;
  const h = 1500;
  const body = `
  ${sectionTitle('记忆 × Harness 双飞轮：知识活过上下文，规则会删除自己', '给外部读者的人话版：左轮管理知识，右轮管理规则，中间闭环让两轮互相供数', w)}

  ${stepPanel(
    70,
    170,
    760,
    C.green,
    '左轮：知识飞轮',
    '让知识活过上下文重置',
    '问题：agent 每次开新上下文，过去决策和教训会丢',
    [
      { title: '工作产出文档和讨论', impl: '(docs / discussions)' },
      { title: '系统自动扫描建索引', impl: '(scan → evidence.sqlite)' },
      { title: 'Agent 开工前先搜', impl: '(search_evidence)' },
      { title: '搜到就用，用完反馈', impl: '(recall → feedback)' },
      { title: '人工审核，沉淀正式知识', impl: '(review → materialize)' },
      { title: '重新索引，检测过时/矛盾', impl: '(reindex + stale / contradiction)' },
    ],
    ['知识越多 → 搜索越准', '搜索越准 → 决策越好', '决策越好 → 产出更好的知识'],
  )}

  ${stepPanel(
    1370,
    170,
    760,
    C.orange,
    '右轮：Harness 飞轮',
    '让规则会删除自己',
    '问题：事故后只加规则不删规则，harness 会越来越重',
    [
      { title: '规则被触发', impl: '(rule fire)' },
      { title: '记录触发信号', impl: '(trace: 违规 / 绕行 / 拉闸)' },
      { title: '区分永久协议和临时脚手架', impl: '(skeleton / explanation)' },
      { title: '临时规则写入删除条件', impl: '(sunset condition)' },
      { title: '连续 N 次不触发，降级', impl: '(default → dynamic)' },
      { title: '确认无用后删除并归档', impl: '(sunset removal + lesson)' },
    ],
    ['删掉不需要的规则 → 系统更轻', '系统更轻 → agent 更快更准', '触发数据更干净 → 删除判断更准'],
  )}

  ${box(880, 430, 440, 560, { fill: '#f8fafc', stroke: C.blue, r: 34, label: '中间齿轮', labelColor: C.blue })}
  ${lines(['现实闭环', '连接两个飞轮的桥'], 1100, 505, { size: 32, weight: 900, fill: C.blue, anchor: 'middle', leading: 1.15 })}
  ${lines(['1. 看现实状态', '2. 建计算模型', '3. 执行动作', '4. 改变现实', '5. 验证结果', '6. 做治理决策'], 965, 585, { size: 25, weight: 800, fill: C.ink, leading: 1.25 })}
  ${box(915, 805, 370, 132, { fill: 'white', stroke: C.blue, r: 22, shadow: false })}
  ${lines(['左轮提供：知识是否还被引用', '右轮提供：规则是否还在触发', '闭环让两轮同步转'], 1100, 850, { size: 21, weight: 800, fill: C.blue, anchor: 'middle', leading: 1.25 })}
  ${arrow(830, 445, 900, 505, { color: C.green, sw: 5, cx1: 855, cy1: 440, cx2: 875, cy2: 480 })}
  ${arrow(1320, 505, 1370, 445, { color: C.orange, sw: 5, cx1: 1345, cy1: 480, cx2: 1350, cy2: 440 })}
  ${arrow(900, 950, 830, 1040, { color: C.green, sw: 5, cx1: 860, cy1: 985, cx2: 850, cy2: 1025 })}
  ${arrow(1370, 1040, 1320, 950, { color: C.orange, sw: 5, cx1: 1350, cy1: 1025, cx2: 1345, cy2: 985 })}
  ${yarn(1100, 1018, 40, C.teal)}
  ${lines(['现实证据在中间回流'], 1100, 1086, { size: 24, weight: 900, fill: C.teal, anchor: 'middle' })}

  ${box(180, 1310, 1840, 92, { fill: '#fffbeb', stroke: '#d97706', r: 26, shadow: false })}
  ${lines(['常见六大件主要覆盖左轮的知识/产物熵控；Cat Cafe 额外把 harness 自身熵控画成右轮：规则要能产出删除自己的证据。'], 1100, 1366, { size: 25, weight: 820, fill: '#92400e', anchor: 'middle' })}
  `;
  return svgShell(w, h, body);
}

function metadataBox(x, y, w, title, note, color) {
  return `
    <rect x="${x}" y="${y}" width="${w}" height="112" rx="24" fill="white" stroke="${color}" stroke-width="3" filter="url(#shadow)"/>
    ${lines([title], x + w / 2, y + 42, { size: 25, weight: 900, fill: color, anchor: 'middle' })}
    ${lines([note], x + w / 2, y + 78, { size: 19, weight: 760, fill: C.muted, anchor: 'middle' })}
  `;
}

function projectBox(x, y, title, note, color) {
  return `
    <rect x="${x}" y="${y}" width="220" height="118" rx="24" fill="white" stroke="${color}" stroke-width="3" filter="url(#shadow)"/>
    ${lines([title], x + 110, y + 44, { size: 25, weight: 900, fill: color, anchor: 'middle' })}
    ${lines([note], x + 110, y + 80, { size: 18, weight: 760, fill: C.muted, anchor: 'middle' })}
  `;
}

function flywheelExpansionDiagram() {
  const w = 2200;
  const h = 1650;
  const body = `
  ${sectionTitle('图 4.1：飞轮扩展 — 减 × 出 × 联', 'F163 让知识能减；F152 让方法论能出去；F186 让跨域知识能联起来', w)}

  ${box(90, 165, 2020, 335, { fill: C.greenSoft, stroke: C.green, r: 34, label: 'F163 减：让知识能证明自己', labelColor: C.green })}
  ${lines(['问题：知识只有“增”没有“减”，越积越噪，过期决策还会继续误导 agent'], 1100, 232, { size: 27, weight: 850, fill: C.ink, anchor: 'middle' })}
  ${lines(['解法：每条知识自带证明链，多维判断，不是一刀切'], 1100, 277, { size: 25, weight: 850, fill: C.green, anchor: 'middle' })}
  ${metadataBox(170, 320, 430, 'authority', '谁说的？来源多可靠', C.green)}
  ${metadataBox(650, 320, 430, 'activation', '最近还被引用吗', C.green)}
  ${metadataBox(1130, 320, 430, 'criticality', '多重要，错了多危险', C.green)}
  ${metadataBox(1610, 320, 430, 'verify_date', '多久没验证，过期了吗', C.green)}
  ${lines(['效果：高权威但过期 ≠ 低权威但活跃；为图 4 左轮的 stale detect / contradiction flag 提供工程实现'], 1100, 472, { size: 24, weight: 850, fill: C.green, anchor: 'middle' })}

  ${simpleArrow(1100, 520, 1100, 585, { color: C.line, sw: 5 })}
  ${pill(940, 540, '知识质量有保障', C.greenSoft, C.green, { w: 320, size: 24, textFill: C.green })}

  ${box(90, 610, 2020, 385, { fill: '#f5f3ff', stroke: C.purple, r: 34, label: 'F152 出：把飞轮带到新地方', labelColor: C.purple })}
  ${lines(['问题：方法论锁在 Cat Cafe 自己家，外部项目还是从零摸索'], 1100, 677, { size: 27, weight: 850, fill: C.ink, anchor: 'middle' })}
  ${lines(['解法：猫猫驻场冷启动，和铲屎官一起做 AI native 改造，再把经验带回来'], 1100, 722, { size: 25, weight: 850, fill: C.purple, anchor: 'middle' })}
  ${projectBox(235, 798, 'Cat Cafe', '双飞轮方法论', C.green)}
  ${projectBox(745, 798, 'F152 远征', '冷启动记忆 / 驻场', C.purple)}
  ${projectBox(1255, 798, '外部项目', 'AI native 改造', C.blue)}
  ${projectBox(1705, 798, '经验回流', '决策 / 教训 / 模式', C.orange)}
  ${simpleArrow(455, 857, 735, 857, { color: C.purple, sw: 5 })}
  ${simpleArrow(965, 857, 1245, 857, { color: C.purple, sw: 5 })}
  ${simpleArrow(1475, 857, 1695, 857, { color: C.orange, sw: 5 })}
  ${arrow(1815, 930, 350, 930, { color: C.orange, sw: 5, cx1: 1500, cy1: 1002, cx2: 670, cy2: 1002 })}
  ${lines(['类比 Palantir FDE：不是卖工具，而是把平台能力带到现场做改造'], 1100, 960, { size: 23, weight: 850, fill: C.purple, anchor: 'middle' })}

  ${simpleArrow(1100, 1018, 1100, 1084, { color: C.line, sw: 5 })}
  ${pill(915, 1038, '经验从外部回来了', C.orangeSoft, C.orange, { w: 370, size: 24, textFill: C.orange })}

  ${box(90, 1110, 2020, 390, { fill: C.blueSoft, stroke: C.blue, r: 34, label: 'F186 联：让所有知识互通', labelColor: C.blue })}
  ${lines(['问题：回流经验散落在不同项目 / 方法论库里，猫开工时搜不到'], 1100, 1177, { size: 27, weight: 850, fill: C.ink, anchor: 'middle' })}
  ${lines(['解法：多域联邦检索，不统一存储，但统一发现和路由'], 1100, 1222, { size: 25, weight: 850, fill: C.blue, anchor: 'middle' })}
  ${projectBox(210, 1280, 'Cat Cafe', '本项目 docs', C.green)}
  ${projectBox(510, 1280, '项目 A', '外部项目知识', C.purple)}
  ${projectBox(810, 1280, '项目 B', '另一套真相源', C.orange)}
  ${projectBox(1110, 1280, '方法论库', '跨项目经验', C.teal)}
  ${box(1440, 1265, 290, 140, { fill: 'white', stroke: C.blue, r: 24, shadow: false })}
  ${lines(['LibraryCatalog', '元数据注册', 'truth source / review 策略'], 1585, 1315, { size: 21, weight: 850, fill: C.blue, anchor: 'middle', leading: 1.18 })}
  ${box(1800, 1265, 250, 140, { fill: 'white', stroke: C.blue, r: 24, shadow: false })}
  ${lines(['LibraryResolver', '联邦搜索', '跨域返回结果'], 1925, 1315, { size: 21, weight: 850, fill: C.blue, anchor: 'middle', leading: 1.18 })}
  ${simpleArrow(430, 1338, 500, 1338, { color: C.blue, sw: 4 })}
  ${simpleArrow(730, 1338, 800, 1338, { color: C.blue, sw: 4 })}
  ${simpleArrow(1030, 1338, 1100, 1338, { color: C.blue, sw: 4 })}
  ${simpleArrow(1330, 1338, 1432, 1338, { color: C.blue, sw: 4 })}
  ${simpleArrow(1730, 1338, 1792, 1338, { color: C.blue, sw: 4 })}
  ${lines(['例：搜“Redis 踩坑”→ 命中本项目 + 外部项目 + 方法论库的相关教训'], 1100, 1462, { size: 24, weight: 850, fill: C.blue, anchor: 'middle' })}

  ${box(220, 1530, 1760, 74, { fill: '#fffbeb', stroke: '#d97706', r: 24, shadow: false })}
  ${lines(['闭环：减 → 出 → 联 → 联邦知识回到图 4 左飞轮 → 再由 F163 熵减清理；飞轮不只在自己家转。'], 1100, 1578, { size: 25, weight: 850, fill: '#92400e', anchor: 'middle' })}
  `;
  return svgShell(w, h, body);
}

function runtimeStackDiagram() {
  const w = 1800;
  const h = 1200;
  const body = `
  ${sectionTitle('Cat Cafe 运行时技术栈：代码在哪，改什么影响什么', 'Hub → Fastify API → Provider / MCP / Storage；6399 是 runtime 用户数据圣域', w)}

  ${box(110, 165, 1580, 245, { fill: C.purpleSoft, stroke: C.purple, r: 28, label: '用户交互', labelColor: C.purple })}
  ${lines(['Hub (React + Zustand)', 'Workspace：对话 / 监控 / 知识 / 导航', 'Rich Block / Preview / Audio', 'WebSocket：实时 bubble stream'], 190, 245, { size: 30, weight: 820, fill: C.ink, leading: 1.28 })}
  ${box(1120, 230, 460, 120, { fill: C.white, stroke: C.orange, r: 24, shadow: false })}
  ${lines(['外部 IM', '飞书 · 企微 · Telegram · Email'], 1350, 282, { size: 27, weight: 850, fill: C.orange, anchor: 'middle', leading: 1.22 })}
  ${simpleArrow(900, 432, 900, 505, { color: C.line, sw: 5 })}
  ${lines(['HTTP / WS'], 955, 475, { size: 23, weight: 800, fill: C.muted })}

  ${box(110, 510, 1580, 285, { fill: C.blueSoft, stroke: C.blue, r: 28, label: 'API (Fastify)', labelColor: C.blue })}
  ${lines(['InvocationQueue → QueueProcessor', 'AgentRouter → Provider Adapters (Claude / GPT / Gemini)', 'SessionBootstrap（窄口注入）', 'A2A Callback → 统一执行平面', 'Transport Gateway（外部触达）'], 190, 590, { size: 29, weight: 820, fill: C.ink, leading: 1.22 })}
  ${cat(1285, 595, 0.48, C.purple, 'Claude', 'adapter', { face: '#f8fafc' })}
  ${cat(1435, 595, 0.48, C.blue, 'GPT', 'adapter', { face: '#fef3c7', mane: '#d6a45f' })}
  ${cat(1585, 595, 0.48, C.teal, 'Gemini', 'adapter', { face: '#e0f2fe' })}

  ${simpleArrow(640, 814, 520, 900, { color: C.line, sw: 5 })}
  ${simpleArrow(1160, 814, 1280, 900, { color: C.line, sw: 5 })}

  ${box(110, 910, 745, 215, { fill: '#f5f3ff', stroke: C.purple, r: 28, label: 'MCP Servers', labelColor: C.purple })}
  ${lines(['cat-cafe (core)', 'cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals', 'external MCPs'], 190, 972, { size: 27, weight: 820, fill: C.ink, leading: 1.15 })}

  ${box(945, 910, 745, 215, { fill: C.greenSoft, stroke: C.green, r: 28, label: 'Storage', labelColor: C.green })}
  <rect x="1015" y="968" width="560" height="44" rx="18" fill="${C.redSoft}" opacity="0.45"/>
  ${lines(['Redis 6399：runtime / 用户数据圣域', 'Redis 6398：worktree / alpha / test 隔离', 'SQLite：evidence.sqlite', 'docs/：真相源', 'git：版本控制 / 审计'], 1025, 988, { size: 27, weight: 820, fill: C.ink, leading: 1.18 })}
  ${lines(['production Redis (sacred)'], 1570, 1000, { size: 22, weight: 900, fill: C.red })}
  `;
  return svgShell(w, h, body);
}

function pipelineLayer(x, y, w, h, n, title, subtitle, bullets, color, icon) {
  return `
    ${box(x, y, w, h, { fill: `${color}12`, stroke: color, r: 30, shadow: true })}
    <circle cx="${x + 70}" cy="${y + h / 2}" r="42" fill="white" stroke="${color}" stroke-width="4"/>
    <text x="${x + 70}" y="${y + h / 2 + 10}" text-anchor="middle" font-size="24" font-weight="900" fill="${color}">${esc(icon)}</text>
    ${pill(x + 138, y + 22, `${n}. ${title}`, `${color}22`, color, { w: 520, size: 25, textFill: color })}
    ${lines([subtitle], x + 148, y + 94, { size: 25, weight: 850, fill: C.ink })}
    ${lines(bullets, x + 148, y + 136, { size: 22, weight: 700, fill: C.ink, leading: 1.22 })}
  `;
}

function memoryPipelineDiagram() {
  const w = 2400;
  const h = 1860;
  const leftX = 95;
  const layerW = 1560;
  const layerH = 212;
  const ys = [170, 410, 650, 890, 1130, 1370];
  const body = `
  ${sectionTitle('记忆系统管线架构 2026-05：从项目索引到图书馆联邦', '记忆不是 RAG API，而是 truth source → scanner/gate → compiled index → resolver → recall → lifecycle governance', w)}

  ${pipelineLayer(
    leftX,
    ys[0],
    layerW,
    layerH,
    1,
    'Truth Sources 真相源',
    '所有知识先有可追溯来源，索引只是编译产物',
    [
      'project docs / ADR / lessons / discussions / markers',
      'global methods / shared rules / skills',
      'external collections：F152 外部项目、lexander、domain notes',
    ],
    C.green,
    'TS',
  )}
  ${pipelineLayer(
    leftX,
    ys[1],
    layerW,
    layerH,
    2,
    'Scanner + Safety Gates',
    '先判断能不能入库，再 chunk / embed',
    [
      'CatCafeScanner / GenericRepoScanner / StructuredScanner',
      'SecretScanner before chunk/embed；prompt boundary：外部 AGENTS.md 只是 evidence data',
      'provenance.tier：authoritative / derived / soft_clue',
    ],
    C.orange,
    'SCAN',
  )}
  ${pipelineLayer(
    leftX,
    ys[2],
    layerW,
    layerH,
    3,
    'Compiled Indexes 编译层',
    '每个域有自己的索引，坏了可从 truth source 重建',
    [
      'evidence.sqlite（project:cat-cafe） · global_knowledge.sqlite（global:methods）',
      'library/{collectionId}/index.sqlite（F186 多域 Collection）',
      'LibraryCatalog：只存 metadata / policy / route，不存正文',
    ],
    C.blue,
    'IDX',
  )}
  ${pipelineLayer(
    leftX,
    ys[3],
    layerW,
    layerH,
    4,
    'LibraryResolver / KnowledgeResolver 查询层',
    '联邦 fan-out + RRF，把多域结果分组返回',
    [
      'lexical：BM25 / Feature ID / 精确术语；semantic：vector / 跨语言',
      'hybrid：BM25 + vector + RRF（日常默认）',
      'route：scope(docs/threads/sessions) + dimension + collections',
    ],
    C.purple,
    'Q',
  )}
  ${pipelineLayer(
    leftX,
    ys[4],
    layerW,
    layerH,
    5,
    'Recall Surfaces 给猫用的面',
    '猫开工前不是猜，而是从共享记忆接住上下文',
    [
      'SessionBootstrap：窄口上下文 + task snapshot + recall instructions',
      'search_evidence：主动检索；raw drill-down：thread/session/event 原文追溯',
      'Memory Lens / Typed Graph：跨 collection anchor 关系可视',
    ],
    C.teal,
    'RC',
  )}
  ${pipelineLayer(
    leftX,
    ys[5],
    layerW,
    layerH,
    6,
    'Lifecycle Governance 生命周期治理',
    '知识会被审核、证明、过期检测和重新索引',
    [
      'Knowledge Feed：自动提取候选 → owner review → materialize',
      'F163 四维证明链：authority / activation / criticality / verify_date',
      'stale detection / contradiction flagging / entropy reduction → reindex',
    ],
    C.red,
    'LC',
  )}

  ${ys
    .slice(0, -1)
    .map((y) => simpleArrow(leftX + layerW / 2, y + layerH + 16, leftX + layerW / 2, y + 228, { color: C.line, sw: 5 }))
    .join('')}
  ${[
    'scan / bind dry-run / hash',
    'chunk / embed / rebuild',
    'fan-out / timeout / RRF',
    'recall / drill-down / bootstrap',
    'feedback / marker / usage signal',
  ]
    .map((label, idx) =>
      lines([label], leftX + layerW / 2 + 32, ys[idx] + layerH + 58, { size: 18, weight: 800, fill: C.muted }),
    )
    .join('')}

  ${box(1715, 210, 600, 1330, { fill: '#fff7ed', stroke: C.orange, r: 34, label: '右侧治理旁路', labelColor: C.orange })}
  ${lines(['为什么它不只是 RAG？'], 2015, 290, { size: 32, weight: 900, fill: C.orange, anchor: 'middle' })}
  ${lines(
    [
      '1. 安全先于索引',
      '   Secret gate 在 chunk/embed 前执行',
      '',
      '2. 记忆是数据，不是指令',
      '   外部 prompt-like 文件不进 system prompt',
      '',
      '3. 联邦优先，不统一存储',
      '   Collection 独立治理、独立 review 策略',
      '',
      '4. 搜索结果带权威语义',
      '   confidence / authority / reviewStatus',
      '',
      '5. 知识能证明自己仍成立',
      '   authority × activation × criticality × verify_date',
      '',
      '6. 人和猫都能浏览关系',
      '   Memory Lens / Typed Graph / Graph tab',
    ],
    1788,
    370,
    { size: 24, weight: 760, fill: C.ink, leading: 1.24 },
  )}
  ${box(1765, 1318, 500, 150, { fill: 'white', stroke: C.orange, r: 24, shadow: false })}
  ${lines(['F102：本地 SQLite 记忆基座', 'F152：外部项目冷启动', 'F163：知识熵减证明链', 'F186：图书馆联邦'], 2015, 1362, { size: 24, weight: 850, fill: C.orange, anchor: 'middle', leading: 1.2 })}

  ${box(210, 1640, 1980, 92, { fill: '#fffbeb', stroke: '#d97706', r: 26, shadow: false })}
  ${lines(['关键原则：索引是加速器，不是真相。真相源始终是 docs / collections 中人能读、能改、能 git 追溯的文件。'], 1200, 1698, { size: 27, weight: 850, fill: '#92400e', anchor: 'middle' })}
  ${lines(['valid_as_of: 2026-05-06 · article v2 replacement for memory-architecture-illustrated-by-codex.png'], 2280, 1810, { size: 20, weight: 700, fill: C.muted, anchor: 'end' })}
  `;
  return svgShell(w, h, body);
}

function globalLayer(x, y, w, h, n, title, bullets, color, icon) {
  return `
    ${box(x, y, w, h, { fill: `${color}12`, stroke: color, r: 28, shadow: true })}
    <circle cx="${x + 62}" cy="${y + h / 2}" r="38" fill="white" stroke="${color}" stroke-width="4"/>
    <text x="${x + 62}" y="${y + h / 2 + 13}" text-anchor="middle" font-size="36" font-weight="900" fill="${color}">${n}</text>
    <text x="${x + 118}" y="${y + 48}" font-size="30" font-weight="900" fill="${color}">${esc(title)}</text>
    ${lines(bullets, x + 130, y + 92, { size: 23, weight: 760, fill: C.ink, leading: 1.18 })}
  `;
}

function globalArchitectureDiagram() {
  const w = 2400;
  const h = 1920;
  const x = 90;
  const layerW = 2220;
  const layerH = 170;
  const ys = [150, 345, 540, 735, 930, 1125, 1320];
  const body = `
  ${sectionTitle('Cat Cafe 全局架构总图 2026-05', '从 CVO 到猫、从产品面到队列、从记忆到治理：一张看全貌', w)}

  ${globalLayer(x, ys[0], layerW, layerH, 1, 'CVO / Human Direction Layer', ['愿景 · 拍板 · 纠偏 · Magic Words · 验收 · eval 信号', '人不是逐步审批器，而是方向与判断力的来源'], C.orange, '☕')}
  ${globalLayer(x, ys[1], layerW, layerH, 2, 'Product Surfaces Layer', ['Hub / Workspace：对话 · 监控 · 知识 · 导航', 'Rich Block / Preview / Audio / image gallery · 外部 IM：飞书 · 企微 · Telegram · Email'], C.purple, '🖥')}
  ${globalLayer(x, ys[2], layerW, layerH, 3, 'Collaboration Semantics Layer', ['猫猫身份：布偶/Claude · 缅因/GPT · 暹罗/Gemini（身份/引擎，不是岗位）', 'A2A：@ 行首路由 · targetCats · multi_mention · hold_ball · 接/退/升 · 跨族 review · CVO 终裁'], C.teal, '🧶')}
  ${globalLayer(x, ys[3], layerW, layerH, 4, 'Unified Execution Plane', ['InvocationQueue：user / agent / multi_mention 统一入队', 'QueueProcessor：自动执行、暂停、恢复、取消 · InvocationTracker：谁在跑/等/完成 · SessionBootstrap：窄口上下文'], C.blue, '⚙')}
  ${globalLayer(x, ys[4], layerW, layerH, 5, 'Shared State / Memory Layer', ['Thread / Task / Workflow / Session Chain · docs 真相源 · evidence.sqlite · LibraryCatalog', 'Knowledge Feed · F163 熵减 · F186 图书馆联邦 · F152 外部项目冷启动与经验回流'], C.green, '📚')}
  ${globalLayer(x, ys[5], layerW, layerH, 6, 'Runtime / Tools / Storage Layer', ['Hub React + Zustand → API Fastify · Provider Adapters：Claude / GPT / Gemini / OpenCode', 'MCP Servers：core / collab / memory / signals / external · Tools：exec / browser / GitHub / image_gen / Pencil · Redis production Redis (sacred) / 6398 隔离 / SQLite / git'], C.blue, '🔌')}
  ${globalLayer(x, ys[6], layerW, layerH, 7, 'Governance / Evolution Layer', ['SOP Gates：feat → design → plan → tdd → quality → review → merge · shared-rules / ADR / lessons / Knowledge Feed', 'F177：hotfix 治理 · fallback 层数检测 · 创意实现解耦 · Build to Delete：skeleton / explanation / probe / sunset'], C.red, '🛡')}

  ${ys
    .slice(0, -1)
    .map((y) => simpleArrow(w / 2, y + layerH + 8, w / 2, y + 188, { color: C.line, sw: 5 }))
    .join('')}

  ${box(110, 1548, 680, 235, { fill: '#fff7ed', stroke: C.orange, r: 28, label: '任务链', labelColor: C.orange })}
  ${lines(['CVO 目标', '→ 球权', '→ 执行平面', '→ 工具运行', '→ 可见产出'], 185, 1622, { size: 28, weight: 840, fill: C.ink, leading: 1.2 })}
  ${box(860, 1548, 680, 235, { fill: C.greenSoft, stroke: C.green, r: 28, label: '记忆链', labelColor: C.green })}
  ${lines(['docs / events', '→ 编译索引', '→ recall / drill-down', '→ 反馈 / 教训', '→ 回流到知识层'], 935, 1622, { size: 28, weight: 840, fill: C.ink, leading: 1.2 })}
  ${box(1610, 1548, 680, 235, { fill: C.redSoft, stroke: C.red, r: 28, label: '治理链', labelColor: C.red })}
  ${lines(['真实运行信号', '→ 规则判断', '→ 删除 / 升级规则', '→ ADR / lessons', '→ 回到运行'], 1685, 1622, { size: 28, weight: 840, fill: C.ink, leading: 1.2 })}

  ${box(430, 1810, 1540, 70, { fill: '#fffbeb', stroke: '#d97706', r: 24, shadow: false })}
  ${lines(['这不是图 1 Hero，也不是图 5 Runtime Stack；它是 article v2 附录的一张全局技术索引图。'], 1200, 1855, { size: 25, weight: 850, fill: '#92400e', anchor: 'middle' })}
  ${lines(['valid_as_of: 2026-05-06 · replacement for architecture-overview-illustrated-by-codex.png'], 2290, 1900, { size: 20, weight: 700, fill: C.muted, anchor: 'end' })}
  `;
  return svgShell(w, h, body);
}

const diagrams = [
  ['01-hero-overview', heroDiagram()],
  ['02-harness-engineering-map', harnessMapDiagram()],
  ['03-a2a-ball-ownership-flow', a2aDiagram()],
  ['04-dual-flywheel', dualFlywheelDiagram()],
  ['04.1-flywheel-expansion', flywheelExpansionDiagram()],
  ['05-runtime-stack', runtimeStackDiagram()],
  ['06-memory-pipeline-architecture', memoryPipelineDiagram()],
  ['07-cat-cafe-global-architecture', globalArchitectureDiagram()],
];

await fs.mkdir(OUT_DIR, { recursive: true });

for (const [name, svg] of diagrams) {
  const svgPath = path.join(OUT_DIR, `${name}.svg`);
  const pngPath = path.join(OUT_DIR, `${name}.png`);
  const cleanSvg = svg.replace(/[ \t]+$/gm, '');
  await fs.writeFile(svgPath, cleanSvg, 'utf8');
  await sharp(Buffer.from(cleanSvg)).png({ compressionLevel: 9, quality: 94 }).toFile(pngPath);
  const meta = await sharp(pngPath).metadata();
  console.log(`${name}.png ${meta.width}x${meta.height}`);
}
