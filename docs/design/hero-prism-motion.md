# Hero Prism Motion Specifications

本文档定义 Landing Page 中三棱镜主视觉的动效参数与降级规则。
为了保障可访问性（Accessibility），我们必须遵循 **"动效有意义，晕眩可降级"** 的铁律。

## 1. 动效降级安全网 (Reduced Motion)

所有动画样式必须被 `@media (prefers-reduced-motion: no-preference)` 媒体查询包裹。
如果用户系统开启了“减弱动态效果”，必须强制回退到无动画的静态版本。

```css
/* 默认基准态：无动画，元素处于最终呈现状态 */
.vision-light, .prism-glass, .beam, .audit-ring {
  /* static properties, e.g. opacity: 1, stroke-dashoffset: 0 */
}

/* 仅在系统允许动画时注入关键帧 */
@media (prefers-reduced-motion: no-preference) {
  .vision-light {
    animation: pulse-light 3s ease-in-out infinite;
  }
  .audit-ring {
    animation: rotate-ring 20s linear infinite;
  }
  .beam {
    animation: flow-beam 4s linear infinite;
  }
}
```

## 2. 元素动效参数定义

### A. 白光入射 (Vision)
- **视觉意象**: 稳定、持续输送铲屎官的能量与愿景。
- **动效类型**: `Pulse` (呼吸闪烁 / 不透明度渐变)。
- **参数**: 
  - `duration`: `3s`
  - `easing`: `ease-in-out`
  - 效果: `opacity` 在 `0.7` 到 `1.0` 之间往复，同时轻微调节 `filter: blur()` 半径制造发光呼吸感。

### B. 棱镜主体 (Hard Rails)
- **视觉意象**: 坚如磐石，不可撼动的系统规则边界。
- **动效类型**: 静态为主，内部微光流转（微量动画）。
- **参数**:
  - `duration`: `5s`
  - 效果: 多边形描边的 `opacity` 进行 `0.4` 到 `0.6` 的微光过渡。

### C. 能量环线 (Memory/Audit)
- **视觉意象**: 状态周转、记忆累积与持续纠偏的闭环。
- **动效类型**: `Stroke Dash Flow` (沿轨道流动的虚线)。
- **参数**:
  - `duration`: `20s` (必须非常慢速，避免视觉喧宾夺主)
  - `easing`: `linear`
  - 效果: `stroke-dashoffset` 从 `0` 渐变至最大环长，形成顺时针循环流转感。

### D. 色散光束 (Collaboration Beams)
- **视觉意象**: 具象化的猫猫分工，各自平行输出高光。
- **动效类型**: 流光线条 (`Flow`)，搭配差异化的虚线纹理（为了色盲兼容性）。
- **参数**:
  - `duration`: `4s` 
  - `easing`: `linear`
  - 效果: 各颜色的 `stroke-dashoffset` 线性滚动，形成光束流出的动感。Ragdoll(直线)、Maine Coon(长虚线)、Siamese(短虚线) 各自保持图案流动。
