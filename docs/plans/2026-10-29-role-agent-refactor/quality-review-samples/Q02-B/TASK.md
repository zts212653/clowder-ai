# 变更审查

需求：精简容量预留实现，保持 reserve(store, key, amount, limit) 接口。key、amount 和 limit 已在入口校验；amount 和 limit 为正整数，get 对尚无记录的 key 返回 0。调用可能并发。

必须保持的契约：同一 key 成功返回 true 的预留总量不能超过 limit；拒绝返回 false，不能消耗容量。store.withLock(key, run) 在当前进程串行执行同一 key 的 run；get/set 自身没有事务或比较写保证。范围仅为单进程，共享该 store；不要求分布式锁或额外数据库。

审查 before/src/reserve.mjs → after/src/reserve.mjs 的实际变更。请只报告可复现、影响需求的实质问题，给出触发条件、对应代码位置、影响和最小验证方式；不存在问题时可以报告无阻断问题。建议与阻断问题区分。请勿修改被审查代码，最终审查结果写到任务目录之外，保留原始工具记录。
