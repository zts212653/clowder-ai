---
feature_ids: [F032, F127, F143, F161, F241]
topics: [ci, startup, develop, packaging]
doc_kind: implementation-plan
created: 2026-10-30
---

# PR #1748：CI 与 Windows 启动修复

本轮原始要求：“继续把 CI 和 Windows 打包的启动门禁问题修好，验证通过后更新当前 PR，目标分支保持 develop。完成CI后合入develop”。沿用既有 feature 与构建工位，不改生产环境，不关闭尚未完成的整份重构 Feature。

完成条件：当前代码的适用 GitHub CI 全绿；正常干净 Windows 构建通过原90秒启动分析、生成并核查最终安装物；非作者审查覆盖最终 PR 交付范围且无开放 P1/P2；远端 base 仍为 develop，满足检查后实际合入并回读 merge 结果。没有 Mac 和企业 CodeAgent 的边界保留，不以 CI smoke 代替原34项端到端验收。

实施顺序：保留远端与本地 RED → 按具体根因修复产品或过期夹具 → 定向验证并推动完整 CI → 干净发行构建与包内检查 → 独立 review、更新 PR 并合入 develop。需要时重用已有可信失败，不堆叠同义测试，不增加 skip、门禁豁免或延长启动时限。

已复现：成员创建前置提醒失败被误记为不确定写入；ACP 工厂拒绝后残留 active turn 阻止重试。修复分别把前置步骤移到写入意图落盘前、把工厂准备移到 turn 占用前。目录门禁通过将一个注册清理文件移入既有 lifecycle 目录解决。测试同步新的缺失终态失败语义、平台路径大小写、冻结参数和目录发布入口；超时测试使用真实内存执行 store，置换测试先绑定新会话执行边界再声明既有原生历史，不改变产品的未知旧会话拒绝规则。

Windows 诊断使用既有 e184 冻结程序及独立临时实例。逐路由标记记录了默认插件准备阶段约38秒的等待，安装 journal 记录16项 prepared；诊断脚本最初用两条语句替换单条注册语句，破坏了无花括号 for 的作用域并导致 ReferenceError，此错误来自诊断本身，不是产品故障，已改为单个 await 表达式。诊断运行不计验收通过。继续用明确的 listen 屏障验证初始插件安装与 HTTP 就绪的关系。

Architecture cell：identity-session / transport / runtime-host；Map delta：none；Why：沿用配置 writer、会话 provider、插件安装 journal、既有 Host listen 屏障和发行构建，不引入新持久对象或调度体系。

首次修复已推送 `df3a14e60053b6464575ff0265904c81603ca85d`：Web 重试5 PASS；API首批集合54 PASS、3 FAIL，其中两条置换夹具随后通过先 bind 后设置 cliSessionId 转绿（该文件7 PASS），另一条为本机私有目录 ACL 的严格拒绝，不改 ACL、不计通过。目录门禁通过。CI 继续运行后 Lint 暴露 OS 的 ComSpec 未登记，按现有 OS 变量分类补充原因，注册完整性10 PASS。

修正标记表达式后的第二次诊断中，原 e184 冻结程序在温缓存条件下通过，说明不能把冷启动超时称为必现死锁。诊断证据支持去除默认插件准备对 HTTP 监听的阻塞，而不延长门禁。本轮在既有 prepareHostInitialPlugins 加入必需的 hostListening 屏障，index 不等待准备完成才能监听；准备完成后仍按原 journal 激活。失败监听不应触发插件发现的新测试先出现 Missing expected rejection，修复后插件安装、catalog 与监听集合27 PASS，API tsc通过。完整干净 Windows 构建结果仍待验证。

`d224f138b949a46392ed72d25a68d4078dec5e24` 的正常完整 Windows 构建已通过原90秒启动分析：deploy-20261030101301834、profile-fe2f7e11-6617-41fc-a8b7-5d4fc2a34472、端口62650、1581个文件/40,366,210 bytes；实例已停止、数据保留。随后在 Redis 下载遇到匿名 GitHub API rate limit，构建退出，尚无最终安装器；不能把启动门禁通过称为整包完成。

非作者对整个阶段性交付风险审查给出 changes_requested：一个P2，后台初始安装未归入关闭流程。真实runtime/Manager/installer反例证明关闭后释放延迟发现仍会启用插件。现沿既有 preClose 先 abort 初始任务、停止当前carrier并排空已进入的写操作，再调用原runtime.shutdown。只读listen/发现/catalog等待可取消；已进入的安装仍写完整receipt后排空，取消不会将未完成项记done；不创建通用任务注册中心。两条真实runtime/Fastify关闭回归覆盖挂起发现和在途archive，连同原安装/catalog/关闭集合32 PASS，API tsc通过。仍待同一reviewer对修复SHA复审。

CI后续暴露三条Biome问题：总账格式、一个type import位置和旧browser测试import顺序。只运行精确三文件修正；JSON解析后逐项比较完全一致，34项状态未变化。d224的六条public shard又暴露下一批首次失败，原日志已保存并继续按根因处理，不把先前修复说成全量CI已通过。
