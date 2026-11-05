---
feature_ids: [F155, F229, F320]
topics: [onboarding, review, compatibility, testing]
doc_kind: validation-report
created: 2026-10-17
tips_exempt: 逐条回应已有审查意见，保留原结论和实物验收边界
---

# PR #1519：61 条真人审查评论逐条回应

本表覆盖已归档的 zts212653 49 条、mindfn 12 条评论。每条源评论单独对应，不把同一缺陷的追评算成多个缺陷，也不把后继已限定关闭的问题重新列成未修。记录的是作者处置，**不是作者对自己的正式 review，更不是维护者 approval**。

当前完整旅程仍按[当前验收判定](pr1519-e2e-current-verdict-2026-10-17.md)保持 No-Go。旧 SHA 的 CI、reviewer 的 fixture、作者实物、当前源码连续性各有范围；本表不表示重新执行了历史评论的所有测试。

## 证据索引

- **E1**：[当前安装包与三次首装实测](pr1519-e2e-current-verdict-2026-10-17.md)。包括自动演示、渐进成果、五创建、五种真实任务、A2A、重启和历史；HTTP故障55例与真实调用分开。原失败保留。
- **E2**：[完整用例及复跑命令](pr1519-onboarding-e2e-acceptance-2026-10-17.md)。包含原R5时序、0/1/N、丢响应、重试、故障观察与安装恢复的不同载体。
- **E3**：[创建归属、短ID、列表与身份兼容](../design/issue1466-review-closure-2026-10-14.md)。同catalog原子回执、完整descriptor、旧键/原body、账号适用性、假认证CLI、列表详情和macOS witness的实施位置。
- **E4**：[原连接Claude协议诊断](../bug-report/pr1519-claude-native-protocol-compatibility.md)。默认失败与显式兼容参数下的成功分别记录，不改变全局默认。
- **E5**：[用户意见U01–U27及原合同](pr1519-complete-journey-closure-2026-10-17.md)。原慢保存、F155/pin、F229/F320、适用平台仍按原范围记录，不由本表删除。

以下“局部收口”只指源评论或后继复核明确限定的缺陷；“实物已补”也不等于所有环境均验收。技术建议均有依据，予以采纳。产品范围变化单列在表后，没有用“建议不合理”掩盖未完成项。

## 逐条回应

| 源评论 | 意见与我们的处置 | 当前证据与剩余 |
|---|---|---|
| [5771522887](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5771522887) zts | 采纳：沿本PR和#1466，不另起实现；冲突、CI、浏览器、打包分开验 | E1/E2；真实Setup已补，合入仍需维护者review |
| [5771560224](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5771560224) mind | 采纳：原生登录来源；未安装与pending分开；F155解释成员/账号且不挡首句 | E2/E3；检测不冒称真调用；F155/pin整体合同见E5 |
| [5771627992](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5771627992) mind | 采纳：零checks不等于全绿，先解除冲突再看当前SHA | 每次单独读HEAD/checks；不沿用旧绿灯 |
| [5792611285](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5792611285) mind | 原生认证/pending局部认可保留；采纳Kimi/OpenCode范围与中文乱码问题 | Kimi已真调用；OpenCode按用户新决定退出自动推荐，旧配置保留；中文文件提交后远端回读 |
| [5793905290](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5793905290) zts | 采纳：连续主路径及恢复录屏，标明SHA、mock与真实调用 | 历史录屏不冒充当前候选；E1有新包截图/日志，最新连续视频仍是独立余项 |
| [5806685454](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5806685454) zts | 采纳更正：不强制先选模型；探测与调用须保持provider/身份/模型语义 | E3继承合同及E1真实任务；不把任意默认模型写成已确定 |
| [5808544025](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5808544025) zts | 采纳R3外域身份、R4线程碰撞/owner、R5水合旁路、XDG与env登记 | 保留相应回归；后继线程通用404回退，E2/E3；OpenCode未宣称真调用已修 |
| [5822575797](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5822575797) zts | 采纳：不能为首启无验证改变全体GET/PATCH；XDG与先发送后水合要实测 | 通用契约回退和待同步恢复保留；见后继R5回归/E2 |
| [5825218742](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5825218742) zts | 采纳：首句已发送但完成PATCH失败，不能等第二句话才重试 | 持久pending、重试、刷新恢复；不靠纯决策函数代替组件时序，E2 |
| [5825450483](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5825450483) zts | 采纳：R5必须驱动真实父组件时序 | 原首句同步/失败刷新浏览器入口保留；新主旅程不再让真实任务阻塞演示 |
| [5825535959](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-5825535959) zts | 采纳：Web测试要真正进入CI | Web First-run独立job与实际清单保留，不能拿API发现器代替 |
| [6014869816](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6014869816) zts | 采纳：合并遗漏的first-run-onboarding浏览器入口应恢复 | 当前package清单保留；后续合流也保留主线新增browser入口 |
| [6071395021](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6071395021) zts | 采纳四阻塞：条件Hooks、错API/Response、创建假成功、首句丢弃；清理虚假完成状态 | 后继修复及E1实际产品接线；旧原型不再充当产品验收 |
| [6072592633](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6072592633) zts | 采纳：真实DetectedClient/schema、服务端ID、部分创建恢复与身份延续 | E3/E2；后继局部通过不替代F229整体确认 |
| [6072634338](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6072634338) zts | 采纳：Codex工具名不是clientId；非2xx不能完成 | 当前实际创建五请求被后端接受，HTTP错误/恢复另测，E1/E2 |
| [6073580356](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6073580356) zts | 采纳：保留CLI身份、installed判据、旧缓存恢复、真实入口/CI | 原字段修复后继认可；现推荐身份与草稿兼容见E3 |
| [6073751129](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6073751129) zts | 采纳：子组件传出文本仍须核父组件接线 | 后继6075641724限定通过；不继续挂旧prop断点 |
| [6075641724](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6075641724) zts | 保留四项局部认可；采纳未登录清单/恢复、入口、缓存与测试缺口 | 当前真实设置/手动回退可达；未知认证不隐藏成“未安装”，E2/E3 |
| [6079936214](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6079936214) zts | 采纳：draft不能自行替换已接受旅程，也不能以文档当修复 | 当前已回到预置演示→真实配置；原F229/F320及范围签字仍单列E5 |
| [6096577899](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6096577899) zts | 采纳两个运行时P1：synthetic Codex auto/provider、POSIX自有子树回收；修CI/测试入口 | 后继6119339815限定收口；保留兼容和不误停无关进程断言 |
| [6096900684](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6096900684) zts | Demo Hooks局部关闭；采纳运行时/CI剩余，不拿Build代替全部检查 | 后继运行时关闭；新包自动六阶段演示已实物验，E1 |
| [6116572426](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6116572426) zts | 保留切工具/预热解耦认可；采纳账号宿主术语与未修运行时/CI | 账户与登录归猫猫团队；旧11秒不因短保存关闭，E3/E5 |
| [6117065363](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6117065363) zts | 采纳：关联日志能诊断不等于旧慢保存根治 | trace、活动span、失败不泄配置保留；原生产延迟待真实复现 |
| [6117428981](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6117428981) zts | 名称一致性局部关闭；剩余运行时/CI仍分别处置 | 旧显示名/昵称/隐藏字段兼容保留；E1另有实际保存和回读 |
| [6119339815](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6119339815) zts | 两运行时P1与自动覆盖局部关闭；采纳HTTP LAN UUID P1 | getRandomValues及刷新同journey；后继6123201033关闭，不重开 |
| [6120467135](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6120467135) zts | 采纳两P2：配置不依赖演示/成果，暂停不跳全文 | 后继mind/zts限定收口；E1实际演示及手动回退，E2失败路径 |
| [6121401373](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6121401373) mind | 保留三项定向通过，不外推真实LAN/模型及全Feature | 当前源码与回归继续消费；E1补的是Windows实物 |
| [6123201033](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6123201033) zts | 三旧缺陷限定关闭；采纳认证/引导回执/F155/F229/F320余项 | 见E1/E5，局部关闭不删除原整体合同 |
| [6125943316](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6125943316) zts | 采纳24内容冲突需保留双方契约，不只消标记 | 后继6137734903核main祖先和冲突解除；新main继续按新SHA核 |
| [6136120843](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6136120843) zts | 采纳ACP pending后补齐输入P1：沿原调用身份进入可恢复历史 | inputDetail及service→存储→消费者回归；后继两位reviewer限定收口 |
| [6137239331](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6137239331) mind | 保留删除操作、最终输入与旧字段兼容限定通过 | E3；mock存储不冒称真实Redis/客户端或跨进程恢复 |
| [6137734903](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6137734903) zts | 采纳OAuth测试认证环境P2/API-key独立继承；保留mac首轮失败查根因 | 后继6139433339关环境P2，ACP已修不重开；mac身份另项处理 |
| [6139433339](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6139433339) zts | 采纳mac xpcproxy→Node稳定身份P1；不放宽PID/出生/命令守卫 | E3单行编码argv/原生witness；后继6161387979关旧反例，非完整DMG验收 |
| [6146448317](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6146448317) mind | 采纳推荐卡正反身份适用性P2、受保护接口测试前提P2 | 共用判据+自有假CLI；不退产品鉴权、不套默认登录，E3 |
| [6147446568](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6147446568) zts | 采纳同型CI证据、main冲突与旧mac缺口连续性 | 后继6160552931/6161387979限定关闭；不把旧红绿迁给新HEAD |
| [6147717005](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6147717005) zts | 采纳configured反向身份反例及假传输必须交付 | E3；默认身份两种状态均受保护；refreshToken=false合同保留 |
| [6150368635](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6150368635) mind | 首屏/水合/Link局部认可；采纳两P2继续修 | E3后继关两P2；E1新包实际首屏，不把旧单次毫秒数当普遍性能 |
| [6151207054](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6151207054) zts | 采纳fixture不能调用运行者真实认证CLI、推荐身份正反、mac实际终态 | 测试自有传输/进程清理和原生CI已纳入，E3 |
| [6159574490](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6159574490) mind | 采纳六项短ID/请求归属/原子提交/旧草稿/descriptor/详情可达条件 | E3；仅新ID分配，旧身份/历史不迁移；E2丢ACK等反例 |
| [6160552931](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6160552931) zts | 采纳goal旧碰撞P1、stop时区/ps格式P2；旧登录/假传输已修保留 | 后继6161387979局部关闭；不删保留goal路径数据 |
| [6161387979](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6161387979) zts | 采纳无ACK共享键P1、PS5解析P1、preload VM/main职责P2 | 原key/body重放后拆分；ASCII脚本、真实argv fixture及职责归位，E3 |
| [6161659038](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6161659038) mind | 采纳安装/卸载全局停机P1和模块日志根P2 | 安装+userData双身份及精确目录清理；require前私有HOME，后继局部关闭 |
| [6162292490](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6162292490) zts | 采纳roster相似不能认请求归属、Mac canonical workspace、8.3路径/旧正则 | 真实原POST回执证明；canonical外链拒绝；不加回Defender提权，E3 |
| [6166242160](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6166242160) zts | 保留旧项关闭；采纳升级删sidecar P1、Host监听顺序检查P2 | marker移出替换目录、失败拒绝；监听守卫容纳日志但不放宽时序 |
| [6166980495](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6166980495) zts | Host检查P2局部关闭；升级身份仍需真实证据 | 后继身份修复+E1旧载体同目录升级/重启实物，版本范围不混用 |
| [6167023604](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6167023604) mind | 采纳偏好读取失败被当新用户并覆盖P1 | 严格reader在原owner/updater内，503且字节不变；后继6169049179关 |
| [6169049179](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6169049179) mind | 保留偏好P1关闭；采纳源码身份修复与实际Setup升级分开 | E1/E3；旧347包不证明后继修复，当前报告明确载体 |
| [6169331491](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6169331491) zts | 采纳数据根落替换目录P1与Windows漏接新测试P2 | canonical root admission、坏根拒绝保字节，原生Windows清单接入 |
| [6173397338](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6173397338) zts | 保留上述两项关闭；采纳冷启动不凭热启动/扫描累计归因 | E1三次新首装分阶段；原100/120秒唯一根因仍开放 |
| [6180937970](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6180937970) zts | 采纳三处main合流需同时保留DSH、注册追踪、主线分流/browser清单 | 后继6181496123认可合流；最新main仍单独核对 |
| [6181496123](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6181496123) zts | 采纳wiring凭据测试失败须查fixture与实际通道；新包不能借旧证据 | 后继6182136218局部关闭；E1新包单列真实首装 |
| [6182085363](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6182085363) mind | 保留shared/private peer/CSS/SW/归档认可；采纳完整失败→同版修复，不称事务回滚 | E1旧f1两轮完整Setup故障/修复有实物；新0927适用范围明确，非全平台保证 |
| [6182136218](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6182136218) zts | wiring/T14前提局部关闭；保留首装与升级、旧构建与新构建区分 | E1当前来源表；不把6m56覆盖升级写成冷首装 |
| [6182618670](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6182618670) zts | 采纳bundle别名静默跳过URL重写P2 | canonical输入/onLoad/相对URL、搬移资产/worker对照；Windows junction回归 |
| [6182789020](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6182789020) zts | 采纳PUT成功须作废保存中发起的旧GET P2；DSH凭据默认不复制 | classic/v2 PUT/GET交错；后继6183282647关；真实授权绑定不复制历史 |
| [6182938035](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6182938035) zts | 采纳Run/自动启动失败闭锁及mini Inno原始证据、完整恢复分层 | E1原完整坏包exit20/同版修复；不把mini Inno当完整Setup |
| [6183282647](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6183282647) zts | 两P2局部关闭；采纳gateway隔离、MCP治理基线及新main冲突 | 不去掉保护清单；后继6184001393核适用base治理与合流 |
| [6184001393](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6184001393) zts | 保留canonical carrier/旧请求连续性；采纳Codex测试必须真到thread/start | 明确App Server fixture、负例仍能检出缺模型；不把启动错误当adopted-model拒绝 |
| [6184769380](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6184769380) zts | 采纳workspace同一对象与私有peer身份，裁剪后重建载体再实装 | E1冻结依赖owner/新API-Web真实重编及三首装；同名版本不替代canonical身份 |
| [6185108776](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6185108776) zts | 采纳两个tar list终态P2，不能只给rm加重试 | 产品allSettled及显式释放第二子进程回归；BSD/GNU原生CI；新包性能另测 |
| [6185928831](https://github.com/zts212653/clowder-ai/pull/1519#issuecomment-6185928831) zts | 采纳五推荐跨层API白名单P1、POST/PATCH一致、窗口响应与新首装 | 当前Codex/Claude/DSH/Kimi/Pi实际五创建/真调用已补；拖动按用户选择仍未验，E1/E2 |

## 未采纳、范围变化与不能偷关的事项

没有发现应以“不合理”为由驳回的上述具体技术缺陷。以下按用户后续明确决定调整，而非称reviewer错误：

1. 演示全部使用预置数据，完成后再配置自己的客户端；保留跳过/直接配置。撤回“必须先让真实agent完成演示”的早期方向，不删除真实首次交流与恢复的验收。
2. 允许0/1/N选择，不强制多选；真实多伙伴协作另用单一初始请求的A2A用例验，不能用演示或多个初始@代替。
3. OpenCode按用户要求退出自动推荐，由Pi顶替；保留既有OpenCode成员/手动能力，不宣称其地区403/流格式问题已修。Kimi不以“登录尚未验证”阻挡已安装工具的选择。
4. 不全局关闭Claude新协议、静默换连接或模型。E4仅证明原连接的显式兼容组合可用；用户2026-10-17已明确按外部LLM API问题保留，不再追查、不再单独阻塞本PR代码修复，原失败仍不改成通过。
5. 无事务式程序回滚承诺；实际合同是失败闭锁、外部身份/数据保留及同版Setup修复。保留旧失败现场，不要求默认复制凭据，不添加Defender提权或扩大#1590/#1591范围。

仍开放的整体证据包括：最新fac实物发现共享default上的个人F155提醒start409/complete400；原100/120秒与生产11秒事件的唯一根因；最新连续录屏、原生拖动和macOS完整安装旅程；原合同的F155/pin、F229/F320适用完整验收及维护者范围确认；最终HEAD检查与正式review。Claude外部API限制已按用户决定退出代码阻塞。用户现有配置/历史及具名回退包不因这些余项被重置。
