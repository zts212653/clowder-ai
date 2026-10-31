import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractPawFeelMarkers } from '../../dist/infrastructure/harness-eval/friction/paw-feel-marker.js';

// F245 Phase A Task2 — 爪感差 marker 提取纯函数
// L0 官方格式: [爪感差: 工具+现象]（其余分隔符 :/：/空格 也兼容）
// 契约: marker recall=100%（全抓）+ precision=100%（正常文本不误抓）
//      symptom recall=100%（不丢信息）+ tool best-effort（宁缺勿误拆，46 警告）

describe('extractPawFeelMarkers — recall（全抓 marker）', () => {
  it('提取单条空格分隔 marker', () => {
    const r = extractPawFeelMarkers('前面有些话 [爪感差: rg 噪音大] 后面还有话');
    assert.equal(r.length, 1);
    assert.equal(r[0].tool, 'rg');
    assert.equal(r[0].symptom, '噪音大');
    assert.equal(r[0].raw, '[爪感差: rg 噪音大]');
  });

  it('提取全角冒号 marker + 空格内容', () => {
    const r = extractPawFeelMarkers('[爪感差：hold_ball 重复唤醒]');
    assert.equal(r.length, 1);
    assert.equal(r[0].tool, 'hold_ball');
    assert.equal(r[0].symptom, '重复唤醒');
  });

  it('提取一段中的多条 marker（顺序保留）', () => {
    const r = extractPawFeelMarkers('[爪感差: rg 慢] 中间正常文字 [爪感差: grep 也慢]');
    assert.equal(r.length, 2);
    assert.equal(r[0].tool, 'rg');
    assert.equal(r[0].symptom, '慢');
    assert.equal(r[1].tool, 'grep');
    assert.equal(r[1].symptom, '也慢');
  });
});

describe('extractPawFeelMarkers — tool/symptom 拆分启发式', () => {
  it('L0 官方 + 分隔: 工具+现象', () => {
    const r = extractPawFeelMarkers('[爪感差: rg+输出噪音大]');
    assert.equal(r[0].tool, 'rg');
    assert.equal(r[0].symptom, '输出噪音大');
  });

  it('半角冒号分隔 + MCP 长工具名', () => {
    const r = extractPawFeelMarkers('[爪感差: cat_cafe_hold_ball: 重复唤醒]');
    assert.equal(r[0].tool, 'cat_cafe_hold_ball');
    assert.equal(r[0].symptom, '重复唤醒');
  });

  it('带连字符/下划线的 MCP 工具名（mcp__claude-in-chrome__computer）', () => {
    const r = extractPawFeelMarkers('[爪感差: mcp__claude-in-chrome__computer 点击无响应]');
    assert.equal(r[0].tool, 'mcp__claude-in-chrome__computer');
    assert.equal(r[0].symptom, '点击无响应');
  });

  it('无明确工具的纯现象 → tool=undefined, symptom=整段', () => {
    const r = extractPawFeelMarkers('[爪感差: 直接一句话现象没有工具名]');
    assert.equal(r[0].tool, undefined);
    assert.equal(r[0].symptom, '直接一句话现象没有工具名');
  });

  it('中文短语开头不误拆 tool（46 警告: 宁缺勿误拆）', () => {
    const r = extractPawFeelMarkers('[爪感差: 搜索结果 太多了根本看不过来]');
    assert.equal(r[0].tool, undefined);
    assert.equal(r[0].symptom, '搜索结果 太多了根本看不过来');
  });

  it('内容首尾空格被 trim', () => {
    const r = extractPawFeelMarkers('[爪感差:   rg 噪音很大   ]');
    assert.equal(r[0].tool, 'rg');
    assert.equal(r[0].symptom, '噪音很大');
    assert.equal(r[0].raw, '[爪感差:   rg 噪音很大   ]');
  });
});

describe('extractPawFeelMarkers — precision（不误抓）', () => {
  it('正常文本含其它方括号不误抓', () => {
    const r = extractPawFeelMarkers('这是正常一段话，含 [方括号] 和 [TODO: 待办] 但不是爪感差');
    assert.equal(r.length, 0);
  });

  it('半截 marker（无闭合括号）不抓', () => {
    const r = extractPawFeelMarkers('[爪感差: 没有闭合括号的半截 marker');
    assert.equal(r.length, 0);
  });

  it('空字符串返回空数组', () => {
    assert.deepEqual(extractPawFeelMarkers(''), []);
  });
});

describe('extractPawFeelMarkers — cloud review P2 修复', () => {
  it('P2-1: 含冒号工具名 alpha:start 不被冒号拆坏（+ > 空格 > 冒号 优先级）', () => {
    const r = extractPawFeelMarkers('[爪感差: alpha:start 启动慢]');
    assert.equal(r[0].tool, 'alpha:start');
    assert.equal(r[0].symptom, '启动慢');
  });

  it('P2-1: test:redis 同理（npm script 名含冒号）', () => {
    const r = extractPawFeelMarkers('[爪感差: test:redis 偶发超时]');
    assert.equal(r[0].tool, 'test:redis');
    assert.equal(r[0].symptom, '偶发超时');
  });

  it('P2-1: 冒号紧贴无空格 rg:噪音 仍按冒号拆', () => {
    const r = extractPawFeelMarkers('[爪感差: rg:噪音大]');
    assert.equal(r[0].tool, 'rg');
    assert.equal(r[0].symptom, '噪音大');
  });

  it('P2-2: marker 内嵌套方括号 [WARN] 不截断 symptom（recall）', () => {
    const r = extractPawFeelMarkers('[爪感差: rg 输出包含 [WARN] 标签太多]');
    assert.equal(r.length, 1);
    assert.equal(r[0].tool, 'rg');
    assert.equal(r[0].symptom, '输出包含 [WARN] 标签太多');
    assert.equal(r[0].raw, '[爪感差: rg 输出包含 [WARN] 标签太多]');
  });

  it('P2-2: 嵌套括号不影响多 marker 分离', () => {
    const r = extractPawFeelMarkers('[爪感差: a 含 [x] 多] 正常文字 [爪感差: b 卡]');
    assert.equal(r.length, 2);
    assert.equal(r[0].symptom, '含 [x] 多');
    assert.equal(r[1].tool, 'b');
    assert.equal(r[1].symptom, '卡');
  });
});
