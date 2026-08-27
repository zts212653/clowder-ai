---
name: agent-product-promo-director
tips_exempt: internal creative-direction discipline; produces a brief, not a new user-facing capability
description: >
  Agent/AI 产品宣传片的创意导演层：先锁产品主角、观众信念变化与影片格式，再把不可见的 Agent
  协作翻译成可拍的故事、镜头、运动、声音和 provenance contract。Use when: 用户问 Agent 产品宣传片
  如何导演/剪辑/叙事/配声音、要拆参考片、写 creative brief/beat sheet，或 video-forge 开机前仍未锁定
  主语与镜头语法。Not for: brief 已冻结后的录制/TTS/对齐/渲染（用 video-forge）、教程/功能 walkthrough、
  纯动画生产（用 anime-forge）、只找时效性竞品（先用 deep-research）。Output: product-hero sentence +
  audience belief change + format decision + claim/proof beat sheet + shot/motion/sound maps + provenance ledger +
  operator acceptance questions。GOTCHA: 用户举的页面、thread 或成果只是候选证据，不自动成为影片主题；内部静态分镜不能冒充成片。
---

# Agent Product Promo Director

这是一层**创意导演合同**，不是 renderer。它解决 Agent 产品特有的问题：产品的价值常藏在接球、规划、交接、工具动作、纠错、记忆与恢复里；如果只拍最终成果，观众看到的是“它做了什么”，看不到“为什么需要这个产品”。

## Intent Gate

先判断本轮问题：

| Intent | 本轮交付 | 下一步 |
|---|---|---|
| `reference research` | 查官方原片，记录可观察镜头/叙事/声音语法及推断边界 | 时效性强先用 `deep-research`，再回本 Skill 合成 brief |
| `creative direction` | 产品主角、格式、故事、镜头、声音、证据合同 | 由 operator 验收主语与情绪 |
| `production` 且 brief 未锁 | 先完成本 Skill，不开机 | brief 通过后转 `video-forge` |
| `production` 且 brief 已锁 | 不重复导演流程 | 直接转 `video-forge` |
| `review` | 按本合同判断已有片子在卖产品、成果还是功能表 | 给 verdict，不擅自拍新版 |

用户给出的页面、thread、录屏或成果是**候选素材**，不是拍摄授权，也不是自动主题。

## 1. 锁定真正的主角

先写三句话：

1. **Before belief:** 观众看片前相信什么？
2. **After belief:** 看完后要改信什么？
3. **Product-hero sentence:** `这个产品让 [谁] 能 [发生什么变化]，同时 [人仍如何拥有关系/控制权]。`

然后做替换测试：把最终成果换成另一种成果，故事仍成立吗？

- 成立：产品是主角，成果是 proof。
- 不成立：影片大概率在卖成果。
- 例外：产品的类别承诺本来就是成果品质（如图像生成）。这时成果可以占更多画面，但选择、迭代、控制和产品身份仍须清楚。

## 2. 选择叙事容器，不迷信时长

| 格式 | 适用问题 | 容器 |
|---|---|---|
| 45–90 秒 brand hero | 一个类别承诺与情绪转变 | 一个愿望 + 2–3 个因果 proof beat + payoff |
| 2–5 分钟 demo film | 复杂能力需要可信过程 | 一个真实案例从意图走到验证结果 |
| 5–10 分钟 launch film | 多个产品支柱与发布语境 | 主持人/情绪脊柱 + 同一项目的章节化展开 |
| tutorial / walkthrough | 教会具体操作 | 任务步骤与理解检查；不要冒充品牌片 |

时长取决于需要改变多少信念、提供多少证据，而不是固定 house number。

## 3. 把 Agent 变成可见动作

每个 proof beat 至少覆盖一条可观察循环：

`意图 → 接受/委托 → 可见工作状态 → 交接/工具/动作 → 人类纠正或控制 → 持久结果 → 延续`

可拍的不是隐秘推理，而是：

- 计划、角色和当前 holder；
- 进度、工具回执、共享空间变化；
- 权限请求、暂停、接管、纠正和恢复；
- 记忆如何让下一步接上，而不是重新开始。

禁止展示或伪造 chain-of-thought。不要用假进度条、假输入、假并发替代真实行为。

## 4. 写成因果故事

七拍不是固定模板，但每一章必须回答上一章制造的问题：

1. **Tension** — 今天哪里孤单、碎裂、慢或不可控？
2. **Promise** — 产品带来什么新关系或新类别？
3. **First proof** — 用一个小循环教会观众看片语法。
4. **Escalation** — 任务变复杂、跨猫、跨工具或跨端。
5. **Control** — 人能看见、纠正、批准、打断或接管。
6. **Payoff** — 成果工作，并能追溯到前面的动作。
7. **Return** — 回到产品、关系和下一次可能性；不要停在成果 beauty shot。

如果影片有多个功能，每个功能必须成为同一因果任务里的动作，不能各拍一条广告再拼起来。

## 5. 镜头与运动语法

每一拍写清：`观众此刻的问题 / 唯一焦点 / 状态变化 / 为什么此刻移动或切镜`。

- **产品世界是视觉脊柱。** Thread、角色、工具、workspace、权限、纠错与延续保持空间连续性。
- **一拍一件事。** 同时高亮三个面板等于没有焦点。
- **Establish → focus → settle。** 先定位，再揭示变化，最后给观众读懂的时间。
- **主体先动，镜头后动。** 优先 UI 状态、对象、布局、人物和真实动作；镜头只为注意力、亲密、尺度或发现服务。
- **在意义变化处切。** 接球、holder 变化、工具返回、纠正落地、proof 出现都是天然切点。
- **用连续性跨表面。** 位置/形状/动作 match cut，或 J/L sound bridge，把 thread、workspace、浏览器和手机连成同一世界。
- **完成时稳定。** Payoff 需要笃定，不需要再推一次镜头。

运镜不是禁词。现场人物的 dolly、handheld 或空间 reveal 若表达亲密、紧张、探索或尺度，就是有意义的运动。禁的是“世界没动，摄像机焦虑”。

## 6. 声音是因果层，不是糖霜

按以下优先级分配声音空间：

1. **对白/旁白** — 意义与关系。
2. **音乐** — 情绪、章节压力与释放。
3. **SFX/foley** — 因果确认和标点。
4. **静默/负空间** — 层级、纠正与 payoff。

只给重要状态变化做 cue：愿望被接住、球权变化、工作分叉、纠正落地、持久 proof 到达。不要给每个点击配音效。

建立 cue sheet：

| Picture event | Semantic job | Cue type | Priority / ducking | Entry / exit | Proven or vision |
|---|---|---|---|---|---|

- 纠正时可以短暂 duck 或留白，让观众感到“系统听见了”。
- 完成时可以让 motif 解决，而不是再加一层 whoosh。
- 音乐不能铺满所有频率和每一秒；声音设计需要呼吸空间。
- 用日常扬声器和耳机检查对白清晰度，不只看波形和峰值。

## 7. 真相与 provenance

| Source class | 可声称什么 | 处理方式 |
|---|---|---|
| `real_capture` | 事件如画面所示发生过 | 保留来源身份；允许诚实压缩等待时间 |
| `faithful_replay` | 真实状态/动作被重演以便看清 | 内部登记；不冒充未剪纪录片 |
| `designed_explanation` | 用排版、图形或合成 UI 解释真实机制 | 视觉上标示设计感；不伪造隐藏推理 |
| `future_vision` | 尚未实现的愿景 | 动画/未来时态/独立视觉 register |

Past 必须有证据，future 必须诚实。设计清晰度不能以伪造真实性换取。

## 8. Director Brief 交付合同

复制 [`assets/director-brief-template.md`](assets/director-brief-template.md)，至少填完：

- product-hero sentence 与 before/after belief；
- 格式和选择理由；
- 每拍的 claim、proof、shot role、唯一焦点、state change；
- motion reason、sound cue、source class、must show / must not imply；
- operator 要回答的主语/情绪验收问题。

**operator 先验收主语、关系和情绪，再进入昂贵生产。** 同行只能审事实、技术和证据纪律，不能替代创意 ground truth。静态分镜是内部 previsualization，只回答构图问题；它不能证明节奏、运镜或 motion 成立，也不能作为成片交付。

brief 通过后交给 `video-forge`，由它负责素材、全局旁白、强制对齐、video-spec、渲染和技术审查。

## Failure-history brakes

| 症状 | 真正失败 | 纠正 |
|---|---|---|
| 用户要研究，团队直接开机 | Intent 被偷换 | 回到 reference breakdown + brief |
| 具体成果吃掉全片高潮 | 主语错位 | 做替换测试；回到 product world 收尾 |
| 一个点无限慢慢放大 | 用 camera motion 代偿静态素材 | 补状态/主体动作；只在注意力变化时运镜 |
| 六张静帧加转场 | 用包装冒充 motion | 静帧只验构图；补录/合成真实时间变化 |
| 功能逐条报菜名 | 没有因果任务 | 让功能在同一愿望里依次成为必要动作 |
| 每个 click 都 ding/whoosh | 声音没有语义层级 | 只 cue 因果转折；给对白和静默留空间 |
| 找同行说“通过”但 operator 不买账 | 验收者错位 | 创意直接回 operator，技术事实再找对应 gate |

## Pressure tests

交付 brief 前逐题回答：

1. 把案例页面/最终成果换掉，产品故事还成立吗？
2. 观众能指出意图、holder、动作、纠正、结果和延续分别在哪里吗？
3. 每个主要镜头里，世界内部发生了什么？若只剩 zoom，删掉会怎样？
4. 每个剪切是因为意义变化，还是因为时间到了？
5. 每个声音 cue 的语义工作是什么？删掉是否损失因果或情绪？
6. 真实、重演、解释和未来愿景是否可区分？
7. 若成果本来就是产品承诺，产品的控制与迭代仍清楚吗？
8. 这是 brand hero、demo film、launch film 还是 tutorial？当前时长真的匹配吗？
9. operator 验收的是主语/情绪，还是被迫审内部制作脚手架？

## Related

- 时效性竞品与官方原片查证：`deep-research` + `source-audit`
- 已冻结 brief 的视频生产：`video-forge`
- 动画段落或角色短片生产：`anime-forge`
- 本方法的证据与条件分支：*(internal reference removed)*
