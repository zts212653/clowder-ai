# 准备选择：由真实提交表达

使用现有 begin / submit / exact get；以下字段位于 `body.items[]`（对象地图）或
`body.conditions[]`（实验条件），不改变 Program target、阶段、权限或采用状态。
字段真相源是 `packages/shared/src/types/capability-evolution-preparation.ts` 和
`capability-evolution-preparation-choice.ts`。

- `category`：本项目的人类可读类别，如 Harness、Env。自由短文本，不把固定六类套到所有项目。
- `recommendation: {summary, reason, basisRefs}`：当前提交猫的真实建议；无证据则不填，说明未知及下一步。
- `existingWork: {summary, sourceRefs}`：已经做过什么与精确产物来源，不能用当前 invocation 活跃与否代替。
- `decision`：尚未决定时填 `{state:"undecided", reason, neededFrom:"cat"|"human"|"unknown"}`；
  已决定时填 `{state:"explore"|"fixed"|"excluded", reason, responsibility, basisRefs}`。
  纳入探索要求当前已有可改边界；选择本身不会扩大它。
- `responsibility`：技术决定用 `{kind:"cat", basis:"technical"}`；
  猫沿已有价值/预算授权决定用 `{kind:"cat", basis:"existing_authorization", input:{threadId,messageId}}`；
  转录人的真实选择用 `{kind:"human", input:{threadId,messageId}}`。
  作者/时间由正式提交与 F117 原输入派生，不能自填人类作者。服务端核验人类输入的身份、
  workspace、来源与可读性；存在真实消息不等于其语义自动覆盖此选择，猫仍须核原话与授权范围。

既有授权继续有效；技术选择猫定并留下依据。真正缺失的价值/预算选择沿既有 Chat / Needs Me
取得输入，不让人逐条审批技术工作。不把设计示例抄成历史决定，也不把工具通知当人类授权。
不同来源用各自精确 ref；触发 invocation 的消息不必然是决定依据。

每条规约继续提交 `gtDomain / gtSourceKeys / judge / validityBounds`。同项目可有不同 GT 域；
模拟器、benchmark 与线上使用是可组合的取证渠道，写进真实采集/校准方法，不和 GT 域机械对应。
采集成功、范围声明、当前原件是否可读分别回读；缺来源时保留规约与未知，不编造新成绩。
