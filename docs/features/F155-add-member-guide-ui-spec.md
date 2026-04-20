---
feature_ids: [F155]
related_features: [F099, F127]
topics: [guidance, ui, interaction, accessibility]
doc_kind: spec
created: 2026-03-27
---

# F155: Add-Member Internal Guide UI Spec (Phase A)

> **Status**: spec | **Owner**: Maine Coon/Maine Coon (codex) | **Scope**: 内部场景（添加成员）

## Why

Pencil MCP 当前不可用（`failed to connect to running Pencil app: antigravity`）。
为不阻塞明早演示，这份文档提供可直接实现的 UI 结构化规格。

## Scope

- 仅覆盖 **场景 1：添加成员**（纯内部引导）
- 覆盖：聚光灯遮罩、tips HUD、进度 dots、完成态持久化反馈
- 不含：手动上一步/下一步/跳过导航；外部步骤富媒体面板

## Component Tree

```text
GuideOverlayRoot
├─ SpotlightMask
│  └─ SpotlightCutout (target rect)
├─ StepAnchorPulse (挂在目标元素附近)
├─ GuideHUD
│  ├─ GuideHUDHeader
│  │  ├─ StepTitle
│  │  └─ ProgressDots
│  ├─ GuideHUDBody
│  │  └─ InstructionText
│  └─ GuideHUDAction
│     └─ ExitButton
└─ CompletionCard (持久化成功/失败反馈)
```

## Props Contract

```ts
export type GuidePhase = 'locating' | 'active' | 'complete';

export interface GuideStep {
  id: string;
  target: string; // data-guide-id
  tips: string;
  advance: 'click' | 'visible' | 'input' | 'confirm';
}

export interface GuideOverlayRootProps {
  sessionId: string;
  flowId: 'add-member';
  steps: GuideStep[];
  currentStepIndex: number;
  phase: GuidePhase;
  onExit: () => void;
}
```

## Add-Member Step Set (Internal)

```yaml
flow_id: add-member
steps:
  - id: open-hub
    target: hub.trigger
    advance: click
  - id: click-add-member
    target: cats.overview
    advance: click
  - id: click-add-member
    target: cats.add-member
    advance: click
  - id: edit-member-profile
    target: member-editor.profile
    advance: confirm
```

## `data-guide-id` Naming (Phase A Required)

- `hub.trigger`
- `cats.overview`
- `cats.add-member`
- `member-editor.profile`

命名规则：`domain.section.action`，语义化，禁止位置语义（如 left/top/row1）。

## State Machine

```text
hidden
  -> locating(target not yet found)
locating
  -> active(target found)
active
  -> active(next auto-advanced step)
active
  -> complete(all steps confirmed)
any
  -> exited(user exit)
```

### Transition Rules

- `locating -> active`: 当前 step 目标元素出现在页面中
- `active -> active`: 用户完成当前 step 预期动作，自动推进到下一步
- `active -> complete`: 最后一个 `confirm` step 成功，进入完成态并持久化
- `any -> exited`: 用户点击退出

## Visual Tokens

```css
:root {
  --guide-overlay-bg: rgba(12, 16, 24, 0.62);
  --guide-cutout-ring: #d4853a; /* 猫咖橙 */
  --guide-cutout-shadow: rgba(212, 133, 58, 0.35);
  --guide-hud-bg: #fffdf8;
  --guide-hud-border: #e7dac7;
  --guide-text-primary: #2b251f;
  --guide-text-secondary: #6f6257;
  --guide-success: #2f9e44;
  --guide-error: #d94848;
  --guide-z-overlay: 1100;
  --guide-z-hud: 1110;
  --guide-z-pulse: 1120;
  --guide-radius: 14px;
  --guide-gap: 12px;
  --guide-motion-fast: 160ms;
  --guide-motion-normal: 260ms;
}
```

## Motion Spec

- Cutout 跟随目标：`transform/clip-path`，`260ms ease-out`
- Anchor Pulse：1.4s 循环，透明度 0.35 -> 0.0
- HUD 入场：`opacity + translateY(8px)`，`160ms`
- CatEye
  - `idle`: 低频摆动
  - `active`: 轻微脉冲
  - `success`: 绿色短闪
  - `error`: X 轴轻抖（不超过 2 次）
  - `verifying`: 旋转 loading

## Interaction and Fallback

1. 定位目标失败（首次）
- 显示 `GuideStatusToast`: “未找到当前目标，正在重试定位…”
- 自动重试一次（300ms）

2. 定位目标失败（重试后）
- HUD 保持 `locating`
- 等待目标元素重新出现，不提供手动跳步

3. 用户停滞超时（8s）
- HUD 显示轻提示，不强制中断
- 保持当前步骤，等待用户继续操作或主动退出

4. 退出
- 立即销毁 overlay 和 observer
- 记录 `flowId + stepId + exitedAt`

## Accessibility

- 退出按钮必须可键盘触达
- 引导期间全局 `Esc` 禁用，避免误退
- HUD 必须提供 `aria-live="polite"` 文本更新
- 遮罩不阻断屏幕阅读器读取 HUD 文本

## Performance Guardrail

- 避免频繁 layout thrash：目标 rect 读取节流到 `requestAnimationFrame`
- MutationObserver 仅在引导会话活跃时挂载，结束必须 `disconnect`
- 只动画 `opacity/transform`，避免昂贵属性

## Acceptance Criteria (UI)

- [ ] AC-UI-1: 8 个添加成员步骤均可被 Spotlight 正确定位
- [ ] AC-UI-2: HUD 提供上一步/下一步/跳过/退出完整闭环
- [ ] AC-UI-3: CatEye 5 态与 `GuideObservationState` 一一对应
- [ ] AC-UI-4: 目标缺失可降级，不出现引导卡死
- [ ] AC-UI-5: 移动端（>=390px）HUD 不遮挡主操作区

## Notes for Phase A Implementation

- 先接通最小链路：`data-guide-id` 查询 + overlay 渲染 + step 切换
- 再接状态：`GuideObservationState` 与 step 验证
- 最后补动效与降级提示
