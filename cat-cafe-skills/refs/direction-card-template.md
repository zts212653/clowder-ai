# Direction Card 模板（F168 Phase A）

> 返回 → opensource-ops SKILL.md
> 返回 → [repo-inbox.md](./repo-inbox.md)

## 用法

triage 完成后（主人翁五问填完），用 `cat_cafe_create_rich_block` 向 Inbox thread 发一张结构化 Direction Card：

```json
{
  "kind": "card",
  "v": 1,
  "id": "direction-{repo}-{issueNumber}-{timestamp}",
  "title": "#{issueNumber} {issue 标题}",
  "tone": "info|warning|danger",
  "bodyMarkdown": "{一句话说明这是什么 + 来自哪个 repo}",
  "fields": [
    { "label": "来源", "value": "{repo}#{issueNumber} {issue|PR}" },
    { "label": "类型", "value": "{bug|feature|enhancement|question}" },
    { "label": "GitHub anchors", "value": "{referenced #NNN issue/PR + state/owner，或 '无'}" },
    { "label": "关联 feat", "value": "{Fxxx 或 '无'}" },
    { "label": "Q1 愿景", "value": "PASS|WARN|FAIL" },
    { "label": "Q2 功能冲突", "value": "PASS|WARN|FAIL" },
    { "label": "Q3 需求度", "value": "PASS|WARN|FAIL" },
    { "label": "Q4 技术栈", "value": "PASS|WARN|FAIL" },
    { "label": "Q5 债务", "value": "PASS|WARN|FAIL" },
    { "label": "建议", "value": "WELCOME|NEEDS-DISCUSSION|POLITELY-DECLINE" },
    { "label": "路由", "value": "stay-current|cross-post|propose-thread|external-wait|close" },
    { "label": "路由依据", "value": "active-pr|accepted-issue|author-intent|existing-thread|feature-domain|spam|none" },
    { "label": "Owner", "value": "{当前 thread / 目标 thread / 猫猫 handle}" },
    { "label": "下一步", "value": "{review-existing-pr / merge-gate / fix / ask-author-pr-intent / ask-info / close / wait-author / maintainer-decision}" },
    { "label": "回报协议", "value": "{完成后 cross-post 回 inbox / 无需回报 / 等作者回复}" },
    { "label": "需要铲屎官", "value": "{决策点描述 或 '猫自决'}" }
  ]
}
```

## tone 映射

| Verdict | tone |
|---------|------|
| WELCOME | `info` |
| NEEDS-DISCUSSION | `warning` |
| POLITELY-DECLINE | `danger` |

## 台账联动

发 Direction Card 后，调用 `PATCH /api/community-issues/:id` 更新对应 issue 台账：

```json
{
  "directionCard": { /* card fields snapshot */ },
  "state": "pending-decision"
}
```

## 双猫交叉（非 bugfix 必须）

发完卡片后，如果不是明确 bugfix，用 `multi_mention` @ 第二只猫独立评估：

> "请独立评估这个 issue 的方向，看完后在 Inbox 发你的 Direction Card。"

两猫卡片都到齐后：
1. 汇总两张卡片的 verdict
2. 一致 → 直接执行（更新台账 `state`）
3. 不一致 → 升级铲屎官（更新台账 `ownerDecision` 待定 + state 改 `pending-decision`）

## 路由字段语义

| 路由 | 含义 |
|------|------|
| `stay-current` | 守门 thread 继续拥有这张单 |
| `cross-post` | 已有平行 thread 接球；目标 thread 负责后续等待和回报 |
| `propose-thread` | 需要新 thread；Owner 填预期 thread 名 / 预期接球猫，proposal 的 initialMessage 必须写 report-back 协议 |
| `external-wait` | 当前 owner 等外部作者 / CI / bot / review |
| `close` | obvious spam / duplicate / decline，当前 thread 收口 |

**路由依据优先级**：`active-pr` > `author-intent` / `accepted-issue` > `existing-thread` > `feature-domain`。
Direction Card 必须写明 GitHub `#NNN` anchors；如果跳过 active PR / issue owner 而改投
feature thread，要说明为什么。没有理由就先 route 到 PR / issue owner，或 propose 一个窄 thread。

**下一步语义**：如果 `路由依据 = active-pr`，下一步默认是 `review-existing-pr` 或
`merge-gate`，不是 `fix`。`fix` 只用于没有可用社区 PR、PR 被退回、或作者明确放弃的情况。
如果 `路由依据 = author-intent`，下一步是 `ask-author-pr-intent`，守门 thread 等作者表态或
短 SLA 到期后再决定 review PR / 内部 fix。

**谁接球，谁负责等待。** 如果 Direction Card 的路由是 `cross-post` 或 `propose-thread`，
后续 hold / event-driven 责任属于接球 thread，不属于守门 thread。

## 来源

- 主人翁五问：[ownership-gate.md](./ownership-gate.md)
- Issue Triage SOP：opensource-ops-issue-triage.md
