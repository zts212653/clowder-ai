---
feature_ids: [F155, F229, F320]
topics: [onboarding, windows, installer, performance]
doc_kind: implementation-plan
created: 2026-10-15
---

# PR #1519 Windows 安装耗时与可观测性

来源：用户实际安装 `29f590622` 时停留在解压界面；要求当前 worktree/PR 继续优化、重新打包并验证真实安装和首次启动。API 归档实测 243900ms、Web 149040ms；2.19GB Setup 的四个主要归档共 270492 个条目。这些数字不是优化后的结果。

## 结果与边界

- Windows 冻结生产依赖仅物化一份公共 hoisted tree，包自己的 node_modules 保留，Node 原生模块版本、私有 peer、workspace 模块和锁文件不变。Mac 继续原布局。
- Windows Electron 只提供壳；API/Web/MCP/文档等由同一安装根提供，避免 resources 再复制一次。
- 每个归档有条目数、字节数、校验和清单。解压开始、周期心跳、成功、失败立即落盘；安装界面消费同一个进度事件，不凭时间伪造完成。
- 不延长 API120秒期限、不修改 Defender 配置，不把热启动/单测通过冒充冷启动改善。
- 生成归档限制并发为4，打包/解压CLI降低自己的CPU调度优先级，进度日志记录实际priority；不宣称CPU优先级等同磁盘I/O限速，也不凭安装后低占用证明所有应用卡顿已修复。
- 用户补充反馈：测试包额外的PowerShell启动器显窗并继承stdout；新验收包去掉该包装脚本，快捷方式直接运行产品GUI，后台child仍使用windowsHide。主题CSS404来自遗漏Web构建生成的public/vendor，冻结snapshot本身不含生成物；必须从同一Web构建携带public/.next，缺少核心CSS即拒绝打包。
- 原实例 marker、数据根、角色 ID、历史消息、CLI 认证和引导回执不迁移。新增公共 node_modules 也属于替换边界，删除前拒绝其中的资料根（含目录别名）。

## 实施与验证

1. 先补共享依赖实际解析、私有覆盖/peer、移动后使用、未知目录拒绝的 RED；再改 Windows exporter、安装器/portable/CI 载体和边界。
2. 补解压中间事件、失败事件、归档损坏/不完整的 RED；实现带清单的 Node tar 打包、进度和 Inno stdout callback。
3. 使用 `node --test desktop/frozen-runtime-export.test.mjs desktop/extract-runtime-archive.test.cjs desktop/instance-data-boundary.test.js desktop/instance-upgrade.test.js` 等受影响检查。格式化使用 `pnpm biome format --write <本次文件>`，终态检查依据 package.json 的 `pnpm check`。
4. 新的独立安装根/资料根/HOME/Redis/三端口；记录 Setup SHA/源版本、每个阶段和总耗时。实际执行 Setup，确认解压日志持续变化、退出码、API ready、Web 可用和首次自动引导；首次启动失败必须保留失败日志并继续分析，不能自动重试后宣布成功。
5. 自有实例创建角色和历史后执行同目录升级，不重复首装参数，完整退出/启动并回读 marker、偏好、角色/消息。生产和用户当前正在安装的目录不作为破坏性试验对象。
6. 独立 reviewer 检查最终差异；PR 分开记录单测、实际安装、首次启动、升级保留，未验收内容继续列出。

状态生命周期：Setup 拥有逐归档解压；每次运行有独立 runId，start → progress → complete/failed。条目计数表示已读取条目，完成须等待写入及入口校验；中断留下最后心跳，不写 complete。进度只允许更新本安装的界面和日志。归档清单不含用户认证或历史。

Architecture cell: Windows offline installer / frozen runtime exporter。
Map delta: Windows 公共依赖从三份包内复制改为同一安装根一份；不改变 agent adapter、凭据 owner 或持久数据 owner。

## 2026-10-15 首次实物验收

实物源版本 `30891685a405ec6618c452246dbb9800b5c67f41`，已合入 main `7b6123077`；其后 `b148f26e3` 仅隔离测试的能力配置，不改变产品。Web构建来自 `63bcb3e73`，至实物版本的Web/API运行代码无差异，BUILD_ID为 `qLkWauL2ZgMPSj-pB4pOl`。

在独立安装根、资料根、HOME及5164/3164/6336端口执行实际Setup，未提前启动API，未重试首次启动：

| 检查 | 实测 |
| --- | --- |
| Setup | 1,430,136,711字节；SHA256 `1f1e0ba7afa074f93f182705b8093e47af9af369137feb3cb443392e78ada97d` |
| 首装 | 08:18:16—08:30:08，711288ms，退出码0 |
| 公共依赖 / API / Web / MCP / Electron解压 | 391179 / 169840 / 97518 / 9023 / 6613ms |
| 主要归档条目 | 107452；旧包270492 |
| 首次桌面启动 | 13732ms达到ready；Redis、SQLite、sessionHooks实际检查通过 |
| 初始角色 / 实际使用 | `/api/cats`为空；通过本实例API创建测试伙伴后，真实Claude返回`INSTALL_UPGRADE_OK`，用户消息和回复均已持久化 |
| 主题资源 | 十个全局CSS均有实际规则，页面背景有主题颜色；原生演示截图仍待Windows解锁后验收 |

旧包四个主要归档现场合计1140865ms，新包五个主要归档合计674173ms，单次现场记录下降约41%。这不是相同缓存/负载下的多次基准；首装仍接近12分钟，不能称作快速安装。没有复现旧API120秒失败，也没有证明所有其他应用卡顿均已消失。

57项受影响检查无跳过通过，另有独立review；这些证据与实际Setup分开记录。同目录覆盖升级、升级后角色/消息/偏好回读以及原生演示最终截图的结果，以本轮实物验收回执及PR更新为准，未完成前不宣称全部闭环。

## 第二轮：安装与冷启动、DSH 重新检测

用户继续反馈六七分钟安装过慢，并要求定位原120秒失败。原日志中一次模块图加载94857ms，CPU合计6671ms；之后telemetry至103276ms、memory至105409ms，120秒尚未监听。这个失败发生在模块加载/初始化阶段，不能归因认证或Redis历史损坏；磁盘/安全扫描的具体影响仍须按阶段对照取证，不把Defender累计时长当总耗时占比。

同一实际归档在新自有目录的系统tar对照：API12518ms、公共依赖27114ms，均退出0。拟采用完整SHA/count/路径/入口预检查后调用系统原生解压，周期进度根据真实输出条目更新；Windows系统tar在Unicode文件名回归里仍报错，含此类条目的归档必须明确记录并使用Node安全提取，不静默丢文件。更早的校验失败不能写入payload；整套安装仍不承诺事务式回滚，按mind/zts意见实测失败后保留身份/历史，再运行同版Setup恢复。

继续核对运行载体：不再携带应用test、纯声明文件等确认无运行引用的开发输入；保留src/plugins、动态资产、原生依赖、worker和路径语义。冷启动尝试将API内部模块图打包减少逐文件加载，必须先验证import.meta.url、动态import和worker原路径，再实测完整API和真实客户端；不能简单把相对路径统一到bundle目录。

DSH已在用户当前Fresh实例复现：实际接口3166重新探测仍not_installed，但原用户HOME的npx缓存和ACP profile可正常只读发现。测试连接快照只有Codex/Claude，隔离HOME/LOCALAPPDATA后没有准备DSH。修复独立验收连接准备，引用只读CLI安装并复制必要的ACP连接配置，不复制会话/存储或改源文件。另覆盖“初次不存在→安装/profile补齐→同一进程重新检测出现”，清楚区分安装、ACP配置与实际调用，不能把启动`npx @deepseek-ai/dsh web`当作ACP认证可用证明。

在当前分支、同一PR实施；生产和用户当前Fresh实例不用于故障注入。新自有实例依次验证真实首装、冷启阶段、引导、三工具真实回复、覆盖升级和故障恢复，记录配置/历史/marker前后值。最终提供另一份未使用的干净测试实例供用户从安装开始验收。

## 第三轮：首装全链路与 workspace 身份去重

来源：用户要求不能用覆盖升级代替首装；继续当前 worktree/PR，实际走完干净安装、首次启动、自动引导、一键创建和真实调用，并另留未使用的环境。

新目录基线已执行：安装前 app/instance 均不存在，独立5174/3174/6330；Setup 88870ms退出0，第一次启动96157ms ready，无重试。角色为0，仅有系统default线程。API监听60905ms，其中模块读取46094ms；没有清除操作系统文件缓存，故不称受控重启后的冷盘基准。引导在真实Electron自动播放，typing/A2A及右侧成果完成，随后进入推荐创建页；无凭据的隔离HOME明确显示尚未登录。后续认证准备、创建及真实请求分别登记，不能把创建记录当回复成功。

已确认冻结图中API/MCP/collective等的共享workspace链接指向同一个源目录，物化时却重复复制；已有单测补真实重复链接后RED。将这些相同canonical目录的workspace包放到一份公共node_modules，保留各包不同身份的私有版本和peer；只按版本号或名字相同不合并。非Windows旧布局不变。不对整个第三方依赖进行未经验证的裁剪或打包，不合并可能产生第二个registry实例的模块。

工作单元：覆盖相同身份单例、同名同版本但不同身份、私有peer和搬移后的实际加载；重新物化冻结图、生成API bundle及安装包，记录条目变化；随后在另一个全新目录重复实际Setup及首次启动，运行完整产品路径。启动日志新增脱敏包分组耗时；解压日志分开校验/写入用时；只读系统资源采样用于定位相关活动，不足以断言安全软件的因果占比。格式化运行`pnpm biome format --write`指定文件，定向Node测试及Windows安装数据边界检查后再提交。

数据边界：既有Fresh/Runtime2/生产不重装、不清库、不修改HOME。新CleanCold/CleanUser的认证资料须按目标单独获授权，只补缺失的必要连接文件，不带历史；未获授权时保持登录待处理。最终给用户的实例不预先创建角色或运行引导；作者验收实例与交付实例分别有独立AppId、目录及三端口。

Architecture cell: Windows offline installer / frozen runtime exporter。Map delta: workspace包按canonical源身份共享，私有依赖owner与所有用户持久化owner不变。Why: 减少重复文件与重复模块实例，实际首装和真调用验证才作验收。
