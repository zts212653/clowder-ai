# MCP Tool Description 规范

> 提炼自Maine Coon的《知识工程实践指南》（*(internal reference removed)*）+ MCP 官方规范。
> 写新 MCP tool 或优化现有 tool 时**必读**。

## Description 五要素（缺一个就是不合格）

```
1. 做什么（一句话能力）
2. 什么时候用（触发关键词 / 用户常见表述）
3. 不做什么 / 不适用场景（排除错误路由）
4. 产物（调用后用户会看到什么）
5. GOTCHA（常见陷阱 / 和相似 tool 的区别）
```

### 模板

```
{一句话：做什么 + 对谁有用}.
Use when: {用户说"生成报告""导出 PDF""帮我写份文档"等}.
NOT for: {不适用场景，和相似 tool 的区别}.
Output: {产物描述：文件类型 / 附着方式 / 副作用}.
GOTCHA: {陷阱提醒，例如"不要用 create_rich_block 手动拼"}.
```

### 好的 vs 差的 description

**差**（金渐层踩坑的根因）：
```
Generate a document (PDF/DOCX/MD) from Markdown content using Pandoc.
The generated file is automatically saved and attached to the current
message as a file RichBlock.
```
- 没说"什么时候用"
- 没说"不要用 create_rich_block 手动拼"
- 没说产物会自动投递到 IM
- 金渐层看不到正确用法 → 自己 DIY → 飞书收不到文件

**好**：
```
Generate a document (PDF/DOCX/MD) from Markdown and deliver to IM platforms.
Use when: user asks to "生成报告/导出文档/发PDF/写份文档给我".
NOT for: sending existing files (use create_rich_block with kind:"file" + url).
NOT for: generating images (use image generation tools instead).
Output: DOCX/PDF/MD file saved to /uploads/, attached as file RichBlock,
automatically delivered to Feishu/Telegram via outbound pipeline.
GOTCHA: Do NOT manually call pandoc + create_rich_block — that skips IM delivery.
Always use this tool for document generation.
```

## inputSchema 规范

| 原则 | 做法 |
|------|------|
| 能枚举就别自由文本 | `format: enum(['pdf','docx','md'])` ✅ |
| 字段描述带单位/格式 | `"fileSize in bytes"`, `"ISO 8601 timestamp"` |
| 禁止额外字段 | `additionalProperties: false` |
| 字段名不同义词 | `start_index` 或 `offset`，只选一个 |
| 必填标清楚 | `required: ['markdown', 'format', 'baseName']` |
| describe 写清约束 | `.describe('Display name without extension, e.g. "调研报告"')` |

## 错误返回规范

错误消息必须包含：
1. **哪个字段错了**
2. **期望的类型/范围**
3. **一个正确示例**

```ts
// 差
return errorResult('Invalid format');

// 好
return errorResult('Invalid format "xlsx". Expected one of: pdf, docx, md. Example: format="docx"');
```

## 审查检查清单

写完或改完 MCP tool 后，逐项对照：

- [ ] description 有"做什么"
- [ ] description 有"什么时候用"（含用户常见表述 / 中英文关键词）
- [ ] description 有"不做什么 / 不适用"
- [ ] description 有"产物 / 副作用"
- [ ] description 有 GOTCHA（和相似 tool 的区别）
- [ ] inputSchema 参数都有 `.describe()`
- [ ] 枚举值用 `enum` 不用自由文本
- [ ] tool-registration.test.js 已更新（EXPECTED_TOOLS / EXPECTED_COLLAB_TOOLS）
- [ ] SystemPromptBuilder MCP_TOOLS_SECTION 已更新

## 参考

- Maine Coon《知识工程实践指南》：*(internal reference removed)*
- Anthropic Skills Best Practices：`cat-cafe-skills/writing-skills/anthropic-best-practices.md`
- MCP 官方规范：`https://modelcontextprotocol.io/specification`
- 金渐层 MCP description 优化审查：thread `thread_mn1u0ygkt76bzxks`
