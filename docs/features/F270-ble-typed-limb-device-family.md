---
feature_ids: [F270]
related_features: [F126, F124, F202, F241, F129]
topics: [limb, ble, gatt, device-family, corebluetooth, macos, physical-world]
doc_kind: spec
created: 2026-07-20
community_issue: "clowder-ai#1183"
tips_exempt: spec-only — direction confirmed, implementation not started
---

# F270: BLE 设备作为类型化 Limb — 第一个物理设备族（macOS 只读垂直切片）

> **Status**: spec（方向已确认，AC 待 Design Gate 与提案人对齐后冻结） | **Owner**: Community (彭潇/bouillipx) + Ragdoll家族 maintainer | **Priority**: P2

## Why

F126 建成了 Limb 控制面四层骨架（Registry / Lease / Policy / Action Log），但现有四肢全部连接数字世界。大量本地低功耗设备已通过 BLE GATT 暴露温度、湿度、电量和按钮事件——猫猫却无法在既有 Limb 权限与审计体系内安全感知这些物理状态。

直接向 Agent 暴露 BLE 原语有三个安全问题（提案人识别，maintainer 认同）：

1. **隐私**：附近设备扫描结果属于隐私数据，不应默认持久化或进入记忆；
2. **身份**：广播名称、RSSI、MAC 地址、平台设备标识都不是可靠身份，不能据此自动认领设备；
3. **物理副作用**：私有协议和任意 GATT write 会把不可控的物理副作用暴露给 Agent。

提案人已用 Android nRF Connect GATT Server + macOS CoreBluetooth 做了真实验证（Environmental Sensing `181A` 扫描→绑定→类型化读取温湿度），并实测暴露了必须进首版的生命周期问题：外设重新广播后 CoreBluetooth 可能给同一物理设备分配新平台标识，旧持久绑定持续超时。

**对家里的战略意义**：BLE 是 Limb 控制面的第一个真正物理设备族，是"设备族 adapter 契约"（helper 协议 / typed command allowlist / 绑定生命周期）的试金石——F124 Apple 生态（F126 Phase D）和未来任何物理设备接入都会复用这套契约。

## 归属与分层（Key Decisions）

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | **归 clowder-ai core，不进 plugins 外部仓** | 绑定生命周期 / 身份轮换 / 审计关联全是控制面级语义（F126 血脉）；plugins 仓当前只有 messaging domain 契约，无 limb adapter 契约可承载；native helper + 物理设备访问是 F129 约束下最高危一类，不放进治理最薄处。提案人自己主张"复用现有 Limb 控制面，不建平行控制面"。operator 2026-07-20 签字 | 2026-07-20 |
| KD-2 | **独立 F 号，不并入 F126 Phase** | 按 F202/F204 先例：在既有框架上加新用户可见能力独立开号；F126 A-C 已 merged，本 feat 是其上的设备族扩展 | 2026-07-20 |
| KD-3 | **分层：控制面永远留 core；设备族实现可替换、可提取，不预判必然外置** | 设备族挂 core 既有 host 白名单 `limbAdapterRegistry → ILimbNode` 接缝（`packages/api/src/index.ts:2604`，F265 为现役先例）。BLE helper 是 host-owned native 组件，与 K 线"Host ↔ 不受信插件"公共 wire 不是同一信任边界；是否外迁取决于 native 签名 / entitlement / 物理权限 / 分发 / sandbox——待 F202 OQ-3、native helper 信任分发模型、Host Broker 契约成熟后再评估（sol 收敛 2026-07-20） | 2026-07-20 |
| KD-4 | **Phase A 复用既有 ILimbNode 接缝，不另造通用抽象、不为未来插件化预留额外层** | 契约做实靠真实设备族，不靠预建宽抽象（F241 同构教训：先 core 内泛化再决定外置；跳步 = 在没有契约的地方发明契约） | 2026-07-20 |

## What — Phase A: macOS BLE Central / GATT 只读垂直切片

1. **复用现有 Limb 控制面**：BLE 节点走既有 Registry / Policy / Lease / Action Log。Agent 只见 adapter 暴露的类型化命令（`ble.temperature.read` / `ble.humidity.read` / `ble.battery.read`），不接触平台设备标识、原始 characteristic、任意字节读写。
2. **平台隔离**：macOS 用 CoreBluetooth helper 子进程，Core 经版本化、可校验的 NDJSON 协议通信。helper 只接受受限命令，负责连接超时 / 消息大小 / 断连 / 适配器状态边界。握手后首个操作等待 `poweredOn`；`poweredOff` / `unauthorized` / `unsupported` 返回结构化 unavailable，不盲目重试。
3. **显式扫描与绑定**：扫描是有界会话（≤30s）；未绑定发现结果、RSSI、广播元数据只在会话内存活，结束即清理；持久绑定必须 operator 显式确认；Phase A 只支持标准 Battery Service 与 Environmental Sensing Service。
4. **平台标识轮换进首版恢复语义**：绑定卡片提供 probe（测试绑定状态）；旧标识不可达时 operator 从当前扫描会话选择发现结果显式 rebind（二次确认）。禁按名称 / RSSI / MAC / service UUID 自动匹配；新发现必须来自当前会话的不透明 `discoveryId`；rebind 重读 GATT 并严格校验命令集合一致；只替换内部平台标识，保留 `bindingId` / Limb `nodeId` / Action Log 审计关联；probe / rebind / unbind / execute 绑定级互斥。
5. **三层一致拒绝任意 GATT write**（Core / adapter / helper）。

### Non-Goals（Phase A 不做）

- BLE notify → 类型化按钮/传感器事件（需背压/去重/幂等，独立阶段）
- GATT Explorer 与 adapter 草稿（未来仅 operator 工具，且不提供任意写入）
- Linux BlueZ / Windows WinRT helper
- 任何受控写入（需单独安全审查）
- 按广播名称 / RSSI / 地址自动恢复绑定

## Acceptance Criteria（骨架，待 Design Gate 冻结）

- [ ] AC-A1: BLE 节点经既有 Limb 控制面完整走通（Registry 注册 / Policy 三级授权 / Lease / Action Log provenance），无平行控制面
- [ ] AC-A2: helper 协议版本化 + 握手校验 + `poweredOn` readiness gate；三类 unavailable 返回结构化原因（红测覆盖）
- [ ] AC-A3: 扫描会话有界；未绑定发现结果 / RSSI / 广播元数据不持久化、不进记忆系统（红测覆盖）
- [ ] AC-A4: 持久绑定必须 operator 显式确认；API/UI 永不返回内部平台设备标识
- [ ] AC-A5: 平台标识轮换场景（提案人已实测复现）：probe 报不可达 → 显式 rebind → `bindingId` / `nodeId` / Action Log 连续性保持（自动化覆盖 reachable / unreachable / profile mismatch / stale discovery / 并发 rebind / unbind 竞态 / 持久化失败回滚）
- [ ] AC-A6: 任意 GATT write 在 Core / adapter / helper 三层一致拒绝（红测覆盖）
- [ ] AC-A7:【治理】core 侧安全实现与 merge-gate 由Ragdoll家族 maintainer 守门；社区实现 PR 走 opensource-ops intake（F129 继承）

## Dependencies

- **Evolved from**: F126（Limb 控制面——本 feat 是第一个物理设备族，验证 AC-A4"新增四肢类型只需实现 ILimbNode + 注册能力"）
- **Related**: F124（Apple 生态——Phase D 设备接入预期复用 helper 协议族与绑定语义）/ F202（plugin framework——limb 资源类型已存在，OQ-3 的平台 adapter 声明模型与本 feat KD-3/KD-4 联动）/ F241（agent provider plugin——"实现离开 core"的同构先例与路径参照）
- **Inherits constraint**: F129（no same-power plugin script execution——helper 是 host-owned native 子进程，非 plugin 分发物）

## Risk

| 风险 | 缓解 |
|------|------|
| native helper 子进程 = 新的供应链/分发面 | Phase A helper 随 core 构建分发，host-owned；分发形态见 OQ-1 |
| 扫描数据隐私泄漏进记忆/日志 | AC-A3 红测 + 会话级生命周期硬边界 |
| 设备身份伪造（名称/MAC/RSSI 可伪造） | 禁自动匹配；rebind 走当前会话 discoveryId + GATT 重校验 + operator 二次确认 |
| 绑定恢复竞态产生幽灵记录 | AC-A5 绑定级互斥 + 持久化失败回滚覆盖 |
| helper 崩溃/适配器状态异常 | 结构化 unavailable + 断连边界，不盲目重试 |

## Review Gate

- Phase A: native helper + 物理设备边界 → 跨族 review + 安全审视；core 安全实现禁 self-merge
- 社区实现 PR：opensource-ops intake 流程 + maintainer merge-gate
