# Cat Café Skills Bootstrap

<EXTREMELY_IMPORTANT>
你已加载 Cat Café Skills。路由规则定义在 `cat-cafe-skills/manifest.yaml`。

## Skills 列表（25 个）

### 开发流程链
```
feat-lifecycle → Design Gate(设计确认) → writing-plans → worktree → tdd
    → quality-gate → request-review → receive-review
    → merge-gate → feat-lifecycle(完成)
```

| Skill | 触发场景 | SOP Step |
|-------|----------|----------|
| `feat-lifecycle` | 新功能立项/讨论/完成 | — |
| `collaborative-thinking` | brainstorm/多猫讨论/收敛 | — |
| `writing-plans` | 写实施计划 | — |
| `worktree` | 开始写代码（创建隔离环境） | ① |
| `tdd` | 写测试+实现（红绿重构） | ① |
| `debugging` | 遇到 bug（系统化定位） | — |
| `quality-gate` | 开发完了自检（愿景+spec+验证） | ② |
| `request-review` | 发 review 请求给 reviewer | ③ |
| `receive-review` | 处理 review 反馈（Red→Green） | ③ |
| `merge-gate` | 门禁→PR→云端 review→merge→清理 | ④⑤⑥ |
| `cross-cat-handoff` | 跨猫交接/传话（五件套） | — |
| `deep-research` | 多源深度调研 | — |
| `writing-skills` | 写新 skill | — |
| `pencil-design` | 设计 UI / .pen 文件 | — |
| `rich-messaging` | 发语音/发图/发卡片/富媒体 | — |
| `hyperfocus-brake` | 铲屎官健康提醒/三猫撒娇打断 | — |
| `incident-response` | 闯祸了/不可挽回/人很难过 | — |
| `image-generation` | 生成图片/画头像/AI 画图 | — |
| `self-evolution` | scope 守护/流程改进/知识沉淀 | — |
| `bootcamp-guide` | CVO 新手训练营引导 | — |
| `cross-thread-sync` | 跨 thread 协同/通知/争用协调 | — |
| `browser-preview` | 写前端/跑 dev server/看页面效果 | — |
| `browser-automation` | 外部网站浏览/登录态流程/浏览器工具路由 | — |
| `workspace-navigator` | 铲屎官说"打开日志/看代码/打开设计图"等模糊指令 → 猫猫自己找路径 → API 导航 | — |

### 参考文件（refs/，按需读取）

| 文件 | 内容 |
|------|------|
| `refs/shared-rules.md` | 三猫共用协作规则（单一真相源） |
| `refs/decision-matrix.md` | 决策权漏斗矩阵 |
| `refs/commit-signatures.md` | 猫猫签名表 + @ 句柄 |
| `refs/pr-template.md` | PR 模板 + 云端 review 触发模板 |
| `refs/review-request-template.md` | Review 请求信模板 |
| `refs/vision-evidence-workflow.md` | 前端截图/录屏证据流程（B1） |
| `refs/requirements-checklist-template.md` | 需求点 checklist 模板（B3） |
| `refs/mcp-callbacks.md` | HTTP callback API 参考 |
| `refs/rich-blocks.md` | Rich block 创建指南 |

## 关键规则

1. **Skill 适用就必须加载，没有选择**
2. **完整流程见 `docs/SOP.md`**
3. **三条铁律**：Redis production Redis (sacred) / 同一个体不能 self-review / 不能冒充其他猫
4. **共用规则在 `refs/shared-rules.md`**（不在各猫文件里重复）
5. **Reviewer 选择是动态匹配**（`docs/SOP.md` 配对规则），禁止写死“reviewer 是Ragdoll”

## 使用方式

- **Claude**: Skills 自动触发（`~/.claude/skills/`）
- **Codex**: 手动加载 `cat ~/.codex/skills/{skill-name}/SKILL.md`
- **Gemini**: Skills 自动触发（`~/.gemini/skills/`）

## 新增/修改 skill

1. 在 `cat-cafe-skills/{name}/` 创建 SKILL.md
2. 在 `manifest.yaml` 添加路由条目
3. 创建 symlink：`ln -s .../cat-cafe-skills/{name} ~/.{claude,codex,gemini}/skills/{name}`（OpenCode 读 `~/.claude/`，自动覆盖）
4. 运行 `pnpm check:skills` 验证

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.
</EXTREMELY_IMPORTANT>
