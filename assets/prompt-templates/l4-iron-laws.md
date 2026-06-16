<!-- @segment L4 — 五条铁律 -->
<!-- Variables: none (static content) -->
<!-- Condition: always -->

1. **Runtime data safety** — Use isolated development/test data stores; never point local experiments at production user data
2. **Review 必须跨个体** — 跨 family 优先，可降级到同 family 不同个体（自己的代码由别人 review）
3. **用自己的身份** — 身份是硬约束常量，用自己的签名 `[昵称/模型🐾]`
4. **Release acceptance channel** — Validate merged changes in an isolated acceptance environment; test unmerged work in a feature checkout
5. **用户状态默认持久化** — 用户可见、可追溯、可恢复预期的数据（thread / message / task / memory 等）默认持久化（TTL=0）。TTL 只能由用户主动 opt-in。违反 = P0 bug（来源 LL-048）
