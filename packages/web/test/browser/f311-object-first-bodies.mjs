import { readFile } from 'node:fs/promises';

const cortex = 'docs/videos/f311-microduck-roadshow/pipeline/cortex/';
const cut = '35dfed114be3ca292aac304a888d4a9519d0dbea';
const labCut = '54989dff8e4ec8735a89ff5969c17e12882bf0c0';
const mainCut = '00bba388c8';
const clarification = { ownerFeatureId: 'F117', ownerStateRef: 'message:0001789635982467-000720-8ada8be9' };
const git = (path, version = cut, ownerFeatureId = 'F311') => ({
  ownerFeatureId,
  ownerStateRef: `git:${version}:${path}`,
});
const file = (path) => git(`${cortex}${path}`);
const lab = (path) => git(`microduck_local/src/microduck_local/${path}`, labCut, 'microduck-lab');

export const objectRelevance = JSON.parse(
  await readFile(new URL('./fixtures/f311-object-first-relevance.json', import.meta.url), 'utf8'),
);
const relevanceSource = { ownerFeatureId: 'F117', ownerStateRef: `message:${objectRelevance.source.messageId}` };

/** Draft content only: historical choices retain their source; new split decisions cite 720. */
export async function objectFirstDuckBody() {
  const previous = JSON.parse(
    await readFile(
      new URL(
        '../../../../docs/videos/f311-microduck-roadshow/pipeline/cortex/preparation/20260914/object-map.body.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const old = Object.fromEntries(previous.items.map((item) => [item.itemId, item]));
  const item = (from, itemId, label, category, scope, sources, recommendation) => {
    const relevance = objectRelevance.items.find((entry) => entry.itemId === itemId);
    if (!relevance) throw new Error(`Original author relevance missing for ${itemId}`);
    return {
      ...structuredClone(old[from]),
      itemId,
      label,
      category,
      scope,
      why: relevance.why,
      sourceRefs: [...sources, clarification, relevanceSource],
      recommendation: {
        summary: recommendation,
        reason: relevance.recommendation.reason,
        basisRefs: [
          relevanceSource,
          ...relevance.recommendation.basisRefs.map((key) => objectRelevance.basisRefs[key]),
        ],
      },
    };
  };
  const local = item(
    'local-skill',
    'state-control',
    '当前球位输入与持续摆位／起脚控制',
    '局部控制 · 执行代码',
    'WorldBallTracker + StateVisibleChase，由 run.py 的 state 路径装配并复用 Lab Chase。输入域和控制反馈共同变化，两队一致；本地集成由 T1 Astra 持有。',
    [file('state_skill.py'), lab('brain/controllers.py')],
    '先查未尝试、贴墙和拥挤局面，保留 sensor 对照。',
  );
  const weights = item(
    'motor',
    'onnx-policies',
    '鸭的行走与左右踢腿策略',
    '三份权重资产',
    '三份官方 ONNX；历史身份取 live2 manifest，装载由 run.py / Lab SKILLS 消费。此项不包括执行器配置，也未核读当前供应方权重字节。',
    [file('evidence/20260910/cortex-793-live2-state/manifest.json'), file('run.py')],
    '保留本轮权重；模型选版与训练分别判断。',
  );
  const actuator = item(
    'motor',
    'body-execution',
    '鸭的身体执行配置',
    '参数与执行代码',
    'Lab arena.py 的关节目标、踢腿窗口、增益与物理 decimation，以及 compose.py 的初始姿态。权重之外的配置；本地版本由 Lab cut 追溯。',
    [lab('world/arena.py'), lab('world/compose.py')],
    '单独追溯执行配置，延续原固定比较条件。',
  );
  actuator.decision.reason =
    '原作者720确认：316的 motor 已包含 ONNX + position actuator；拆项延续原固定条件，不是316曾对每个参数独立作出决定。';
  actuator.decision.basisRefs = [clarification, ...actuator.decision.basisRefs];
  actuator.modifiability = {
    state: 'not_modifiable_this_round',
    reason: '延续316中身体和可比动力学的固定条件；拆出执行配置不产生新的扫参权限。',
    basisRefs: [clarification],
  };
  actuator.existingWork = {
    summary: '执行配置和消费路径已定位；既有校准针对旧 motor 组合，未单独证明配置的因果贡献。',
    sourceRefs: [lab('world/arena.py'), lab('world/compose.py'), clarification],
  };
  actuator.nextAction = '逐项追溯现行配置；以后若探索 gain、clip、频率或窗口，显式另立干预版本和依据。';
  const protocol = item(
    'cat-tactics',
    'command-protocol',
    '猫指令的接收、拒收与执行适配',
    '硬 Harness · 有限协议实现',
    'contract.command_errors → CommandInbox → CoachedTeam/local_intent。范围是有限动作、观察版本、TTL、目标鸭与队伍约束，由 T1 Astra 持本地实现；不包含猫的全部战术。',
    [file('contract.py'), file('inbox.py'), file('control.py')],
    '固定现行协议边界；具体缺陷另记修复与版本差异。',
  );
  protocol.decision = {
    state: 'fixed',
    responsibility: { kind: 'cat', basis: 'technical' },
    basisRefs: [clarification],
    reason: '09-17原作者720的新技术确认，尚未发布为生产修订；316没有单列协议决定，不能继承旧组合 explore。',
  };
  protocol.modifiability = {
    state: 'not_modifiable_this_round',
    reason: '本次拆分后的比较边界固定；不暂停物理、不偷换观察版本、不控制对手。',
    basisRefs: [clarification],
  };
  protocol.existingWork = {
    summary: '有限协议已实现；曾修正重生失效范围。这不等于协议从未变，也不授权任意改协议。',
    sourceRefs: [file('test_command_lifetime.py'), clarification],
  };
  protocol.nextAction = '保留当前有限协议用于比较；发现具体缺陷才按边界记录可复核的修复与版本差异。';
  const world = item(
    'world',
    'pitch-rules',
    '四鸭一球的场景与重置规则',
    '场景与执行代码',
    'World.football_pitch / _check_goal / step；门框、开球和摔倒回位等比赛条件。T1持本地场景集成，固定是本轮决定。',
    [file('world.py')],
    '保留环境版本，不改门线让旧结果变好。',
  );
  const observation = item(
    'evaluation',
    'contact-goal-observation',
    '指定脚接触采集和整球越线判定',
    '执行代码 · 取证与判分用途',
    'world._observed_substep + contract.goal_crossing；calibrate.py 提供校准夹具。与场景可共享文件，但函数范围不同；可信性仍待核。',
    [file('world.py'), file('contract.py'), file('calibrate.py')],
    '区分踢腿、触球、进球与配合，沿用限定事件判定。',
  );
  const recording = item(
    'tracking',
    'recording-video',
    '运行记录与视频派生实现',
    '执行代码 · 追溯用途',
    'run.py、video.py、annotate_evidence.py 的有界组合，保存时钟、事件、轨迹、原片与字幕关系。由 T1 持有；当前活动另读。',
    [file('run.py'), file('video.py'), file('annotate_evidence.py')],
    '保持记录链，不回写旧时钟、指令和视频。',
  );
  const data = item(
    'evidence-data',
    'samples-calibration',
    '公开运行与校准材料',
    '数据资产 · 诊断与校准用途',
    '56条件、两场live及18点摆球校准；原件固定，只探索派生分析。801–808已公开，不能再称独立未暴露 holdout；未用于新训练。',
    [file('evidence/20260910/runs.json.gz'), file('evidence/20260910/cortex-kick-calibration-v2.json')],
    '保留完整失败分母和原件，整理派生分析。',
  );
  return {
    kind: 'object_map',
    goalStatement: previous.goalStatement,
    summary:
      '隔离语义修订稿 · 未发布到真实 Program。先看有边界的具体对象；以下8项只属这个案例。旧决定引用316，D4新确认引用720。对话来源使用冻结原文快照；可读不代表生产此刻的可用状态。',
    items: [local, protocol, weights, actuator, world, observation, recording, data],
    unknowns: [
      '猫的可复用战术方法：独立、版本化策略资产尚未形成。方法讨论存在；reason/assignments 是输出，不是已逐轮加载的 skill。',
      '整体 Agent = Model + Harness，可以整体比较；没有在这里和其零件平铺。',
      '权重、执行代码、方法与数据不自动决定成本或因果可辨性。',
      '软方法逐轮加载版本、可靠配合量尺、观看反馈仍未知；本预览未增加训练、预算或运行授权。',
    ],
    nextAction: '在真实壳审阅对象、来源与决定边界；通过对应设计判断后由原作者正式续修，保留生产seq17历史。',
  };
}

export function objectFirstMemoryBody() {
  const item = (itemId, label, path, scope, recommendation, relevance, work, category) => {
    const source = git(path, mainCut, 'F102');
    return {
      itemId,
      label,
      ...(category ? { category } : {}),
      scope,
      why: relevance.why,
      sourceRefs: [source],
      recommendation: { summary: recommendation, reason: relevance.reason, basisRefs: [source] },
      decision: { state: 'undecided', reason: '这是迁移阅读反例，没有正式创建记忆项目或选定干预。', neededFrom: 'cat' },
      existingWork: { summary: work, sourceRefs: [source] },
      modifiability: { state: 'unknown', reason: '本稿只读核查；未接管原 owner 的修改范围。', basisRefs: [] },
      nextAction: '按具体任务查消费证据，再由相应 owner 确认是否需要改变。',
    };
  };
  return {
    kind: 'object_map',
    goalStatement: '让猫找到并读对权威原文。',
    summary: '隔离迁移反例 · 未创建真实记忆进化项目。只列本次任务需要的实物；无类别标签也可正常阅读。',
    items: [
      item(
        'search-method',
        '检索与回读的方法文本',
        'cat-cafe-skills/memory-search-best-practices/SKILL.md',
        '现有方法原文，教猫扩展查询与读原件，是软 Harness；修改权在既有方法 owner。文件存在不证明本轮加载。',
        '先核实际任务是否消费了方法，再判断是否改文。',
        {
          why: '找到权威原文既需要检索工具，也需要猫确实扩展查询并回读；方法文本可能影响这段行为。',
          reason: '当前只核到方法存在，尚无本轮消费证据；先查是否使用，才能区分未使用与方法不适用。',
        },
        '方法正文可核；逐任务加载证据需另外核验。',
        '方法文本 · 软 Harness',
      ),
      item(
        'distance-ranking',
        '已有候选的距离排序实现',
        'packages/api/src/domains/memory/SemanticReranker.ts',
        'rerankWithDistances 是纯距离排序，不调用模型；是 F102 执行代码，不因 reranker 名称归 Model。',
        '先区分没有召回与候选排序错误。',
        {
          why: '权威原文已进入候选却排得靠后，与根本没有召回，需要检查不同的环节。',
          reason: '此实现只排序已有候选；先核候选集合和距离，避免把召回缺失归给排序或虚构模型干预。',
        },
        '源码已核；本轮没有改变实现。',
        '执行代码',
      ),
      item(
        'embedding-client',
        '向 embedding 服务发请求的客户端',
        'packages/api/src/domains/memory/EmbeddingService.ts',
        'HTTP 客户端属于执行代码；独立服务中的模型身份要另读加载证据，不能把客户端文件当模型权重。',
        '先核服务实际加载版本，当前未知保持未知。',
        {
          why: '请求客户端和实际生成向量的服务共同参与检索，只有客户端文件不能确定在用哪一版模型。',
          reason: '模型版本与部署权限仍未核实；先向原服务核读，才能界定未来可能的改动与比较条件。',
        },
        '客户端可定位；当前模型版本与部署写权未核定。',
        '执行代码',
      ),
      item(
        'project-source',
        '项目原文：F102 记忆组件说明',
        'docs/features/F102-memory-adapter-refactor.md',
        '被搜索的文档资产；CatCafeScanner 将原文形成索引。事实与修改权归原文 owner。',
        '先看原文是否缺失或歧义，再判断是否改内容。',
        {
          why: '检索即使命中也可能读到缺失或歧义的内容；源文档本身影响查证结果。',
          reason: '当前只确认原文和扫描路径存在；改写前应核原文事实与实际索引，不能为命中检查改写真相。',
        },
        '原文与扫描路径存在；实际索引快照和本轮使用未核实。',
      ),
      item(
        'measurement-questions',
        '检索检查题目与期望答案',
        'packages/api/test/memory/memory_eval_corpus.yaml',
        'query / expected_anchors 与词法 Recall@5 适用范围。它和项目原文都是数据，但本次用途不同；不能替 embedding 模型背书。',
        '核测量范围，改题目不自动改善检索能力。',
        {
          why: '判断检索是否改善需要知道题目究竟检查哪种检索路径，分数不能超出其适用范围。',
          reason: '现有题集限定词法Recall@5；调整题目改变的是测量，不能据此声称embedding模型或真实任务已改善。',
        },
        '词法测量材料存在；本例没有新建 eval 或签采用决定。',
      ),
    ],
    unknowns: ['无正式探索决定；不补齐固定分类格，也不推导原 owner 的写权。'],
    nextAction: '比较这份迁移例与鸭鸭读面：能否从对象及来源判断干预和解释边界。',
  };
}
