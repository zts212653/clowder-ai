/**
 * F210 Phase H2b: AgyTrajectoryExtractor
 *
 * 从 AGY trajectory step_payload (proto blob) 提取本轮 final answer text，用于替换 resumed turn
 * 的 stdout 重放（根治 `[1]→[1,2]→[1,2,3]` 累加重放）。
 *
 * 手写 minimal proto wire-format parser（owner 砚砚拍 2026-06-02：不引 protobufjs，只解需要的路径）。
 * proto 逆向证据（B spike §7.4 + protoc --decode_raw 实测 fresh turn 33d040c7 apple→pomme）：
 *   step_payload 顶层 `field 20` = assistant message 子结构
 *     - `20.1` = final answer text（首选）
 *     - `20.8` = final answer text（fallback）
 *     - `20.3` = thinking/reasoning（**排除**，不能当 final）
 *
 * 边界（砚砚 AC）：varint/size bounds，未知 wire type 抛错，任何解析失败 / 越界 / 无 final → null
 * （fail-open，调用方保留现有 stdout，绝不输出截断/错误回复）。
 */

import Database from 'better-sqlite3';

const MAX_VARINT_BYTES = 10; // 64-bit varint 最多 10 字节
const FIELD_ASSISTANT_MESSAGE = 20;
const FIELD_FINAL_TEXT = 1;
const FIELD_FINAL_TEXT_FALLBACK = 8;

/** 读 varint，返回 [value, nextOffset]；越界 / 超长抛错（调用方 fail-open）。 */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (pos >= buf.length) throw new Error('varint out of bounds');
    const byte = buf[pos] as number;
    pos++;
    // 用 2**shift 而非 <<，避免 >32-bit 移位溢出（tag/length 实际很小，number 精度够）。
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7;
  }
  throw new Error('varint too long');
}

/**
 * 扫一层 proto message，返回 length-delimited (wire type 2) field 的 bytes（Map<field, Buffer>）。
 * 其他 wire type（varint/64-bit/32-bit）正确跳过；未知 wire type / 越界抛错。同 field 多次取最后一个。
 */
function scanLengthDelimitedFields(buf: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let offset = 0;
  while (offset < buf.length) {
    const [tag, afterTag] = readVarint(buf, offset);
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 0x7;
    offset = afterTag;
    if (wireType === 0) {
      [, offset] = readVarint(buf, offset); // varint
    } else if (wireType === 1) {
      offset += 8; // 64-bit
    } else if (wireType === 2) {
      const [len, afterLen] = readVarint(buf, offset);
      const end = afterLen + len;
      if (end > buf.length) throw new Error('length-delimited out of bounds');
      fields.set(fieldNum, buf.subarray(afterLen, end));
      offset = end;
    } else if (wireType === 5) {
      offset += 4; // 32-bit
    } else {
      throw new Error(`unknown wire type ${wireType}`);
    }
    if (offset > buf.length) throw new Error('offset overflow');
  }
  return fields;
}

/**
 * 解单个 step_payload，取顶层 field 20 → field 1 (final)，field 8 fallback；排除 field 3 (thinking)。
 * 失败 / 无 final → null（fail-open）。
 */
export function parseAgyStepFinalText(payload: Buffer): string | null {
  try {
    if (!payload || payload.length === 0) return null;
    const top = scanLengthDelimitedFields(payload);
    const assistantMsg = top.get(FIELD_ASSISTANT_MESSAGE);
    if (!assistantMsg) return null;
    const inner = scanLengthDelimitedFields(assistantMsg);
    const finalBytes = inner.get(FIELD_FINAL_TEXT) ?? inner.get(FIELD_FINAL_TEXT_FALLBACK);
    if (!finalBytes || finalBytes.length === 0) return null;
    const text = finalBytes.toString('utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null; // fail-open
  }
}

export interface AgyTrajectoryStep {
  readonly stepType: number;
  readonly payload: Buffer;
}

/**
 * 读 trajectory SQLite 的所有 step（step_type + step_payload），按 idx 升序。
 * 只读连接 + fail-open（文件/表缺失/锁/损坏 → `[]`，调用方保留现有 stdout）。
 * 复用 H2a observer 的同一 SQLite store（CLI 猫读 trajectory）。
 */
export function readAgyTrajectorySteps(dbPath: string): AgyTrajectoryStep[] {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 50');
    const rows = db.prepare('SELECT step_type, step_payload FROM steps ORDER BY idx').all() as Array<{
      step_type: number;
      step_payload: Buffer | null;
    }>;
    return rows
      .filter((r) => r.step_payload != null)
      .map((r) => ({ stepType: r.step_type, payload: r.step_payload as Buffer }));
  } catch {
    return []; // fail-open
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort */
    }
  }
}

/**
 * 从 trajectory steps 取本轮 final answer：最后一个 step_type 15 且能解出非空 final text 的。
 * 无 → null（fail-open，调用方保留现有 stdout）。
 */
export function extractAgyFinalTextFromSteps(steps: readonly AgyTrajectoryStep[]): string | null {
  let finalText: string | null = null;
  for (const step of steps) {
    if (step.stepType !== 15) continue;
    const text = parseAgyStepFinalText(step.payload);
    if (text) finalText = text; // 取最后一个有 final 的
  }
  return finalText;
}

export interface AgyToolInfo {
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly toolCallId?: string;
  readonly toolResultOutput?: string;
}

const KNOWN_TOOLS = new Set([
  'list_dir',
  'view_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'run_command',
  'grep_search',
  'ask_permission',
  'ask_question',
  'define_subagent',
  'invoke_subagent',
  'manage_subagents',
  'manage_task',
  'schedule',
  'search_web',
  'send_message',
  'read_url_content',
  'read_resource',
  'list_resources',
  'generate_image',
]);

export function parseAgyStepTools(payload: Buffer, idx: number): AgyToolInfo | null {
  try {
    if (!payload || payload.length === 0) return null;
    const top = scanLengthDelimitedFields(payload);

    // 1. 处理 runCommand (顶层 field 28)
    const runCommandBytes = top.get(28);
    if (runCommandBytes) {
      const inner = scanLengthDelimitedFields(runCommandBytes);
      const cwd = inner.get(2)?.toString('utf8');
      const cmd = inner.get(23)?.toString('utf8') ?? inner.get(25)?.toString('utf8');
      if (cmd) {
        const stdout = inner.get(13)?.toString('utf8') ?? inner.get(14)?.toString('utf8');
        return {
          toolName: 'run_command',
          toolInput: { CommandLine: cmd, Cwd: cwd ?? '' },
          toolCallId: `run-command-${idx}`,
          toolResultOutput: stdout ?? undefined,
        };
      }
    }

    // 2. 处理 Tool Call / MCP Tool (顶层 field 5)
    const metadataBytes = top.get(5);
    if (metadataBytes) {
      const inner = scanLengthDelimitedFields(metadataBytes);

      // 路径 A (Step 75): 顶层 field 5 直接平铺字段
      const toolNameA = inner.get(2)?.toString('utf8') ?? inner.get(9)?.toString('utf8');
      const toolCallIdA = inner.get(12)?.toString('utf8');
      const argsJsonA = inner.get(3)?.toString('utf8');

      if (
        toolNameA &&
        KNOWN_TOOLS.has(toolNameA) &&
        toolCallIdA &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(toolCallIdA)
      ) {
        let toolInput: Record<string, unknown> | undefined;
        if (argsJsonA && argsJsonA.startsWith('{')) {
          try {
            toolInput = JSON.parse(argsJsonA);
          } catch {
            // ignore
          }
        }

        // 尝试从顶层 field 14 (toolResult) 提取 output
        let toolResultOutput: string | undefined;
        const toolResultBytes = top.get(14);
        if (toolResultBytes) {
          const resInner = scanLengthDelimitedFields(toolResultBytes);
          toolResultOutput = resInner.get(4)?.toString('utf8');
        }

        return {
          toolName: toolNameA,
          toolCallId: toolCallIdA,
          toolInput,
          toolResultOutput,
        };
      }

      // 路径 B (Step 77): 顶层 field 5 内嵌 field 4
      const toolCallBytesB = inner.get(4);
      if (toolCallBytesB) {
        const innerB = scanLengthDelimitedFields(toolCallBytesB);
        // 使用 field 5.4.1 (innerB 的 field 1) 提取 per-tool 级唯一的 toolCallId
        const toolCallIdB = innerB.get(1)?.toString('utf8');
        const toolNameB = innerB.get(2)?.toString('utf8');

        if (toolNameB && KNOWN_TOOLS.has(toolNameB) && toolCallIdB) {
          let toolInput: Record<string, unknown> = {};
          const argsJsonB = innerB.get(3)?.toString('utf8');

          if (argsJsonB && argsJsonB.startsWith('{')) {
            try {
              toolInput = JSON.parse(argsJsonB);
            } catch {
              // ignore
            }
          } else {
            const subParamsBytes = innerB.get(3);
            if (subParamsBytes) {
              try {
                const paramFields = scanLengthDelimitedFields(subParamsBytes);
                const strValues: string[] = [];
                for (const [, val] of paramFields.entries()) {
                  const s = val.toString('utf8');
                  if (/^[\x20-\x7E\s\u4e00-\u9fa5\d\-_{}:",]+$/.test(s) && s.length > 0) {
                    strValues.push(s);
                  }
                }
                toolInput = { rawArguments: strValues };
              } catch {
                // ignore
              }
            }
          }

          // 尝试从顶层 field 10 (toolResult) 提取 output (field 26)
          let toolResultOutput: string | undefined;
          const resultBytes = top.get(10);
          if (resultBytes) {
            try {
              const resInner = scanLengthDelimitedFields(resultBytes);
              toolResultOutput = resInner.get(26)?.toString('utf8');
            } catch {
              // ignore
            }
          }

          return {
            toolName: toolNameB,
            toolCallId: toolCallIdB,
            toolInput,
            toolResultOutput,
          };
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
