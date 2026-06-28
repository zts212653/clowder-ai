/**
 * F245 Phase A Task2 — 爪感差 marker 提取纯函数
 *
 * 从自由文本里提取 `[爪感差: 工具+现象]` marker（L0 staging 约定格式），
 * 拆出工具名与现象描述。纯函数无 IO，供 PawFeelAdapter 回扫消息时调用。
 */

/** 单条爪感差 marker 的提取结果（中间值，Adapter 再组装成 FrictionSignal）。 */
export interface PawFeelMarker {
  /** 解析出的工具名；措辞自由无明确工具时 = undefined */
  tool?: string;
  /** 现象描述（marker 内容主体，永远完整保留） */
  symptom: string;
  /** 原始匹配文本（整条 `[爪感差: …]`） */
  raw: string;
}

/**
 * marker 匹配：`[爪感差: …]`（半/全角冒号）。symptom 段支持一层嵌套方括号
 * （如 `[爪感差: rg 输出 [WARN] 多]`，cloud review P2-2 避免截断 recall），非贪婪正确分离多条。
 */
const MARKER_RE = /\[爪感差[:：]\s*((?:[^[\]]|\[[^\]]*\])*?)\]/g;

/** 「像工具名」判定：ASCII 标识符（字母开头 + 字母数字下划线连字符点冒号），不含中文/空格。 */
const TOOL_LIKE_RE = /^[A-Za-z][\w.\-:]*$/;

export function extractPawFeelMarkers(text: string): PawFeelMarker[] {
  const markers: PawFeelMarker[] = [];
  if (!text) return markers;
  for (const match of text.matchAll(MARKER_RE)) {
    const raw = match[0];
    const content = match[1].trim();
    markers.push({ ...parseToolSymptom(content), raw });
  }
  return markers;
}

/**
 * 拆 tool/symptom。tool 是 best-effort（宁缺勿误拆，46 警告）：candidate 必须「像工具名」
 * 才采用，否则整段做 symptom（symptom recall=100%，永不丢信息）。
 */
function parseToolSymptom(content: string): { tool?: string; symptom: string } {
  // 1. '+' 优先——L0 官方格式 `工具+现象`
  const plus = content.indexOf('+');
  if (plus > 0) {
    const candidate = content.slice(0, plus).trim();
    const rest = content.slice(plus + 1).trim();
    if (rest && TOOL_LIKE_RE.test(candidate)) {
      return { tool: candidate, symptom: rest };
    }
  }
  // 2. 首个空格拆——工具名可能含冒号（alpha:start / test:redis），故空格优先于冒号
  //    （cloud review P2-1）；strip 尾随冒号分隔残留（`hold_ball: 现象` → tool=hold_ball）
  const spaceMatch = content.match(/^(\S+)\s+(\S.*)$/);
  if (spaceMatch) {
    const candidate = spaceMatch[1].replace(/[:：]+$/, '');
    if (TOOL_LIKE_RE.test(candidate)) {
      return { tool: candidate, symptom: spaceMatch[2].trim() };
    }
  }
  // 3. 冒号拆——无空格的紧贴格式 `工具:现象`
  for (const sep of [':', '：']) {
    const idx = content.indexOf(sep);
    if (idx > 0) {
      const candidate = content.slice(0, idx).trim();
      const rest = content.slice(idx + sep.length).trim();
      if (rest && TOOL_LIKE_RE.test(candidate)) {
        return { tool: candidate, symptom: rest };
      }
    }
  }
  // 4. 拆不出工具 → 整段 symptom，tool=undefined
  return { symptom: content };
}
