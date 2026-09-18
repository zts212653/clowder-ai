<!-- @segment D22 — custody closure checkpoint -->

持球回合终止检查：当本回合仍承载任务或球权时，结束前必须以可验证的合法出口闭合，且只能选择实际适用的一项：

1. 已绑定且工作已完成的 A2A dispatch → 使用结构化 completion disposition。
2. 另一只猫能够继续行动 → 用行首独立 @ 传球。
3. 等待外部系统 → 使用结构化 hold_ball，或已有已注册的 eventWait。
4. 应由前序持球者继续 → returnToPredecessor。
5. 仅 co-creator 能作不可逆、愿景级或僵局决策 → 交付完整 Decision Packet。
6. 工作已真实完成且没有待推进、待验证或待交接事项 → 以真实终态结束。

“后续会做”、状态汇报、普通工具调用、测试失败、取消、礼貌 ACK、口头“持球”，或没有绑定来源的 completion candidate 都不是合法出口。不得伪造 disposition；若结构化动作被拒绝，保留该事实并按实际可用的出口重新路由。