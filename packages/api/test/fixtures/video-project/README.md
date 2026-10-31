---
feature_ids: [F326, F138, F309, F202]
doc_kind: evidence
created: 2026-10-07
description: "F326 Phase A 两部真实影片的通用 JSON fixture、外部语义 adapter、源摘要与编辑逆向验证。"
---

# F326 真实样片合同证据

采集 UTC：`2026-10-08T07:54:33Z`。这是导入时间；历史作者与负责人未知，
因此 imported origin 的 actor 和检查页 assignee 均为 null。父 Task 不复制、不迁移。

外部工具归既有 `remotion-studio` 仓：
`/home/user/projects/remotion-studio-f326-adapter-sol61/scripts/editing-desk-adapter/`，
独立提交 `e769e6247fd412e49ce0f52419ce3f9721af527b`（adapter 1.0.3，包含基础提交
`b7b0ba3bdbc50317971fc126f865421148870bb8`），分支 `feat/f326-editing-desk-adapter`。
原仓 main 为 `df34e15`，无 remote；原仓 4 个 Showcase tracked dirty 文件，以及两片和媒体的
untracked 文件均未修改。该外部工位保留到 2026-10-15，owner codex61-sol；没有代清别人的工位。
该提交是本机可复核的 adapter 证据，不代表正式插件安装、发布或渲染。

主仓只保存纯通用 JSON；没有 EP0/Remotion importer 或新增 Remotion 依赖。
`provenance.json` 列全部源 ref/digest 与支持边界；素材仅索引精确字节，没有搬移或备份。
定位只用 rootId + relative path；此测试登记不授予 runtime 文件权限。

| Frozen fixture | sha256 |
| --- | --- |
| ep0.json | `18243ff96219f3b5a82be3c19b37d03b38088b34c81be51dbb600bb208b9f452` |
| parallel-world.json | `9139e6f657a84e4c56f352c9c3234c2f3d21a2b7f28066a59497db65fdae06d9` |
| provenance.json | `fbe89de191d106a26ab45dfe516011ad161e14e9b32458455e6ecd6a8f0fa1af` |

## 真实数据与映射

EP0：30 fps、11841 帧、9 场、100 镜头。75 条 cue events 为 39 line / 28 sfx / 8 sub；
另外读取 SbAnimatic 实际 BGM/急刹，得到 83 条通用事件。369 个素材 logical IDs 的引用全部
指向带 full sha256 的 version IDs；UI 为 generated visual，layers 的 percent origin、
fx、counter、overlay、reveal、dissolve 均保留，未知源字段显式拒绝。

cue fps/total/id/scene/from_/dur 映射 timebase/duration/segment；imgs/switchAt 映射精确素材
与视觉切点；line/sub/sfx 映射事件；其余有语义名称的字段归 renderer extension，没有 raw dump。
逆向从这些字段逐项构造源 JSON，与真实 cue 全字段相等。

实数据编辑证明：shared `resizeVideoProjectSegment` 把通用第一个镜头 durationTicks 减3，
同时规范资产/UI区间，逆向只有对应 dur 改变；C05 第二张 visual startTick 和前一张 endTick
同步加1形成连续区间，逆向只有对应 switchAt 改变。未对真实源文件写入。C08 从 1359 开始，
105 帧三张平均硬切，C08c 首次可见为 1429（格内70），不是1359。单测还保护 UI > reveal >
dissolve > hardcut；dissolve 首次非零与切换中心不同，reveal 要到 trigger 后一帧才非零。

《平行世界》：30 fps、1035 帧、8 beats。T 的全部46字段与 BRANCHES/L、40条实际声效、score、
gain/default volume/60帧 gate 及 Film component gate 全部进入通用字段或语义扩展并逐项逆向。
T.pullOut=32 是 duration，T.beat=15 是 interval；它们没有伪装成绝对 marker。数组事件保留
source index，重排通用 event 列表不会改 done/merged 或声音源次序。

末 beat 与全片 duration 同加5，逆向 T.end 1035→1040；只在内存里 patch 真实 timeline.ts，
确认除该字段外源码字节完全相等。Root 原本读 T.end。Film gate 的边界引用通用 marker/
project duration，不另存竞争的可写起止。任意 JSX 排版、字体、程序运镜和混音代码只用摘要固定，
未声称自动转换/逆向或渲染。输入 census 穷举 ParallelWorld 全部18个 `.ts/.tsx`（含 Root、
theme、layers、parts、craft、scenes、Ghost）及 layers.json，保守索引 public/parallel-world
全部现存媒体；Ghost 作为相邻输入列入，不宣称其每个文件都参与主片。

后续带目核实复现 P1：通用单条 SFX durationTicks 改61，逆向仍取扩展 soundDuration=60，
造成静默丢编辑。两项行为测试亲见 RED 后，当轮删去竞争扩展值。现在唯一 gate 从全部 SFX
通用 durationTicks 推导；原生 S 只有一个 gate，单条不一致修改明确 unsupported，不假成功。
真实40条同步改61，逆向只有 sfxDuration 60→61，其余静态字段相等；只在内存 patch 真实
Sound.tsx 的 literal gate，反 patch 后源码字节完全相等。没有改实际源片、渲染或增 Phase D。
相应证明见 provenance 的 parallelCommonSfxDurationSourcePatch /
parallelPartialSfxDurationRejected。Marker/beat 有源绑定；不协调边界的修改已有一致性拒绝，
不宣称任意 TSX、独立 per-SFX 原生 gate 或所有 generic 编辑均支持。

另一次从源码出发的消费审计实复现 C08.visuals[2].startTick+1 被忽略、appearance仍1429，
以及9项 EP0 与固定 Parallel contract 的行为 RED。1.0.2 对所有已承诺映射的时空/事件字段
做 native 表达性校验；不是把无原生字段的 Host-only id/label/segment association 假装译回。
完整 Source→generic→inverse 清单在外部提交的 README。

| 通用语义字段 | 实际原生消费与边界 |
| --- | --- |
| EP0 asset-backed start/end | even严格ceil序列；explicit必须0开始/递增/ends=nextstart或dur；独立end拒绝 |
| Native UI generated range | native-ui参数对象，完整0/dur；子区间/未知renderer拒绝 |
| dissolve/reveal/UI common switches | 效果由原生参数控制，不能用common hardcut切点宣称改变appearance；explicit mode拒绝 |
| EP0 timebase/canvas | numerator必须1，denominator写fps且Root消费SB_FPS；固定1920/1080不能改 |
| EP0 event kind/fields | kind与native line/sub/sfx绑定一致；SFX新增dur/text/speaker、sub新增voice等拒绝 |
| Derived BGM / 新事件 | 用实际源绑定从prospective cuts重算；起止/e-stop须协调，旧投影不能放行新cut |
| Parallel timebase/canvas/score | 固定1/30与1920/1080；score只支持原连续at0、不接受span/source变更 |
| Parallel marker/SFX/beat | marker不能span，音频不能text/speaker或改kind；不支持插入visual代替Film组成 |
| Owned extension version | 只接受唯一已知namespace的version1；未知version明确unsupported |

一个效果格中原生 switchAt 仍可能控制 layer group，而不控制底图的揭开/溶接；这类源参数
以 `nonHardcutNativeSwitchAt` 明示保存，不当作common base-picture appearance控制。
shared helper 单镜头 C08 105→108 得0/36/72，首次可见1431；整片逆向则用 C08缩到102
避免撞后镜头，只有native dur改变。非规范C08、UI子区间、BGM start+1均实测拒绝。
这些限制不迁移主仓内容owner，也不改原片/PLAN/TSX或扩入Phase D。

检查页：scene07/08/09 的 sheets.json 各17/4/15项，共36个真实 recipe/output result。
每个历史登记作为独立页，名称/title、既有 subtitle、精确 tiles/output 字节与原裁切 recipe
可追溯，按对应 scene 限定。字幕不是“检查已通过”的声明；未知历史负责人仍为空。
scene03/04 确认没有 sheets.json，因此没有补造结果、criteria、assignee 或 coveredBy。

EP0 的 cue 是生成基线。本阶段不逆写原 PLAN/override、不改旧生成器；Phase D 启用人编辑前
仍须把生成前输入收敛到同一个 owner，以避免覆盖。当前索引也不承诺旧媒体字节已有备份。

## 决定后的真实绑定复核（adapter 1.0.3）

独立 reviewer 复现 C36 start+1/duration-1（结束不变）被 Host 与旧 exporter 接受，
但原生 `cutStart("C36") + 48` 将 bgm:3 从5337/585改为5338/584；通用事件仍旧。
同样，T.ballHit+1后原Sound消费283，但旧inverse仍282。两者先按真实输入见RED，
不是仅比较同一旧projection或把源raw塞回。新增14项定点/同类用例后34项全部GREEN。

EP0 的配乐/e-stop 现在保留纯JSON的 scenePrefix/cutId/constant/offset 绑定，export先
构造将输出的新cuts，再重算全部音频起止。旧generic BGM不随cut/scene更新时明确
unsupported；协调调整则能逆向，绑定/素材/volume本身仍由实际源投影固定。
e-stop表达式与音量从原Sequence/Audio读取，不硬编码。实片遍历全部9个影响BGM的
cut/scene输入，分别证实stale拒绝、coordinated inverse和C36的5338/584。

Parallel为40条实际SFX保存T/key/index/offset绑定。export要求实际源静态数据作为第三参，
固定Sound/Film的绑定描述，再使用同一prospective T检验common SFX和派生Film ranges。
单改marker或独立改SFX起点被拒；协调移动允许。实片遍历39个Sound/Film所依赖marker，
仅在内存patch真实timeline.ts，再用原Sound/Film表达式消费该T，结果与inverse相等。
包括T.ballHit/SFX为283，done/merged数组indices和所有Film起止。没有复制或修改原片源码。

检查页摘要统一为 named definition contract：UTF-8 compact JSON，object keys递归排序、
arrays保序、Unicode不归一化。catalog沿用同一算法；36项初始摘要由新定义（含1.0.3来源）
重新生成，错误摘要必须由Host创建边界拒绝。原源census的35个文件digest全部与1.0.2相同，
素材索引仍只记精确字节。旧C08c1429、shared resize首次1431、dur/switchAt编辑逆向和
完整两片roundtrip保持PASS；未知表达式、binding修改、key/array cardinality变更明确拒绝。

## 可重跑证据

外部 codec/index/单测只用 Python 3 标准库，无新依赖；真实编辑证明另用现有 Node 调用
显式传入的已编译 shared resize helper，未导入 Remotion 或开启执行服务。首次无语义实现时，往返/编辑/出现位置与
Parallel source patch 检查 RED；catalog 的 parent traversal 另有真实失败，修后拒绝。
最终34项单测 GREEN，真实两片 replay PASS。原始 adapter 用相同采集时刻重放到独立临时目录，
3个原始 JSON 的字节一致已经实证。提交副本随后经过本仓 canonical Biome formatter；再次
独立重放并用同一 Biome 配置规范化，3个规范副本与这里字节相等，原始/规范副本的 JSON
语义也相等。两份文档通过实际 `videoProjectDocumentSchema`（shared dist）解析。
这次规范化不是 adapter 语义版本变化，也没有修改原素材或 origin.sources 的 byte digests。

| Adapter 原始输出 | sha256（格式化前重放一致） |
| --- | --- |
| ep0.json | `2cd87357dd46c2ab9880657208ba1f40829e925f1a39d41d5c0673fe6d982a71` |
| parallel-world.json | `f0bd4cbe3b6167430c1ef4bee11ffed914f38fea2902fbe70d14714110cfceda` |
| provenance.json | `47e120d642a78141acb552eb77515b3eafae647f2e8554d929ab7b2ab51f56ae` |

```sh
cd /home/user/projects/remotion-studio-f326-adapter-sol61
python3 -m unittest discover -s scripts/editing-desk-adapter -p 'test*.py'
python3 scripts/editing-desk-adapter/replay.py \
  --source-root /home/user/projects/remotion-studio \
  --artworks-root /home/user/cat-cafe-artworks/2026-10-04-ep0-cucu/final-v2 \
  --character-references-root /home/user/cat-cafe/docs/videos/cucu-pr-flow/assets/references/character-sheets \
  --host-helper-module /home/user/cat-cafe-f326-phase-a-sol61/packages/shared/dist/types/video-project-editing.js \
  --collected-at 2026-10-08T07:54:33Z \
  --output /tmp/f326-fixture-replay
```

在 Clowder AI 实施工位用该仓的 Biome 配置规范化；临时目录不在仓内，因此用 stdin 的
fixture 路径选择同一 formatter（直接传临时绝对路径会被 files 配置忽略）。

```sh
cd /home/user/cat-cafe-f326-phase-a-sol61
pnpm biome format --write packages/api/test/fixtures/video-project/ep0.json packages/api/test/fixtures/video-project/parallel-world.json packages/api/test/fixtures/video-project/provenance.json
pnpm biome format --stdin-file-path packages/api/test/fixtures/video-project/ep0.json < /tmp/f326-fixture-replay/ep0.json > /tmp/f326-fixture-replay/ep0.canonical.json
pnpm biome format --stdin-file-path packages/api/test/fixtures/video-project/parallel-world.json < /tmp/f326-fixture-replay/parallel-world.json > /tmp/f326-fixture-replay/parallel-world.canonical.json
pnpm biome format --stdin-file-path packages/api/test/fixtures/video-project/provenance.json < /tmp/f326-fixture-replay/provenance.json > /tmp/f326-fixture-replay/provenance.canonical.json
cmp /tmp/f326-fixture-replay/ep0.canonical.json packages/api/test/fixtures/video-project/ep0.json
cmp /tmp/f326-fixture-replay/parallel-world.canonical.json packages/api/test/fixtures/video-project/parallel-world.json
cmp /tmp/f326-fixture-replay/provenance.canonical.json packages/api/test/fixtures/video-project/provenance.json
```

最后一个 root 只为真实 recipe 中 `fable-r01.png`，没有注册整个 Home。
源变更后先比较 `provenance.json` 的 byte digests，不把新文件自动冒充旧版本。
本证据不代替 F138 重启/CAS/access 或 F309 canonical ledger 运行测试，也不勾 Phase A 终态。
