import { readFile } from 'node:fs/promises';
import { objectFirstMemoryBody } from './f311-object-first-bodies.mjs';

const readBody = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/f311-readable-choices/${name}.body.json`, import.meta.url), 'utf8'));

// Display-copy proposal, not an author submission. Scope, decisions and source refs stay intact.
const COPY = {
  'state-control': {
    category: 'Harness · 局部控制',
    label: '从接近球，到摆位和起脚',
    why: '已观察：8场公开对局中，3场发起踢腿并触球，5场没有起脚。待验证：这些未踢场景分别卡在贴墙、拥挤、朝向还是起脚窗口，尚未查清。',
    summary: '先定位未踢场景，保留原有对照。',
    reason:
      '缺口直接出现在接近球到起脚这一段，因此先查局部控制。当前候选同时改变球位输入与持续反馈；组合有触球，不代表已分清哪一项有效。',
  },
  'onnx-policies': {
    category: 'Model · 动作模型',
    label: '鸭的行走与左右踢腿模型',
    why: '已观察：现有模型、执行配置与场景的组合，在18个摆球夹具和部分公开对局中有指定脚触球。仍未知：模型是不是主要瓶颈，各部分的独立贡献尚未分离。',
    summary: '暂时保留这三份模型权重。',
    reason:
      '已有触球说明这套组合具备部分执行能力，尚没有必须换权重的证据。先保持身体基线可比，便于判断控制变化；选另一版模型或训练，需要另外的瓶颈与资源依据。',
  },
  'body-execution': {
    category: 'Harness · 身体执行',
    label: '把模型输出变成关节动作的配置',
    why: '已核到：执行增益、踢腿窗口和动作更新频率都有实际配置与消费代码。仍未知：各参数对失败的独立贡献。相同模型名称不等于相同身体基线。',
    summary: '分开追溯配置，延续原固定条件。',
    reason:
      '原准备决定已经固定模型和执行配置这个组合。现在把配置单列，是为了看清边界；不因此开放扫参，也不把组合触球算成配置的独立效果。',
  },
  'command-protocol': {
    category: 'Harness · 指令协议',
    label: '猫的指挥能否及时进入执行',
    why: '已观察：现场指令有接受、拒收和执行记录，也出现过迟到选择被拒。待验证：指挥时效对比赛收益的影响；“被执行”仍不等于“战术有效”。',
    summary: '固定现行接收与执行边界。',
    reason:
      '保留时效、观察版本和队伍限制，让后续战术比较有明确边界。这是拆分后作者的新技术确认；具体协议缺陷另记修复版本，不扩成任意修改权限。',
  },
  'pitch-rules': {
    category: 'Env · 比赛环境',
    label: '四鸭一球的球场与重置规则',
    why: '已核到：公开回合对应可追溯的场景版本。仍未知：它能否代表完整比赛或真机；贴墙、拥挤的原因也不能仅凭现象归给环境。',
    summary: '保持环境可比。',
    reason: '保持门线、开球与回位条件，才能读懂控制或战术带来的差异。以后调整环境需另存版本，不用新规则回写旧结果。',
  },
  'contact-goal-observation': {
    category: 'Eval · 物理判据',
    label: '分别判清踢腿、触球和进球',
    why: '已有材料：摆球正例、踢空和半球过线等反例。仍待核验：正式测量有效性；物理事件判定也不能直接回答配合是否可靠、观众是否认可。',
    summary: '保持现行判据，继续核验可信度。',
    reason:
      '先用一致口径比较限定物理事件，避免把踢腿当触球、触球当进球。材料齐备或实现审阅通过，都不能替代正式校准与价值判断。',
  },
  'recording-video': {
    category: '记录与呈现 · 执行代码',
    label: '让指挥、比赛经过与视频对得上',
    why: '已观察：旧字幕曾混淆猫看到的世界状态与局部控制输入。已有原片和澄清字幕的派生链；观看者能否读懂、是否认可仍未知。',
    summary: '保留记录链与原片。',
    reason: '可追溯的时钟、指令和字幕关系，支持复核实际经过。展示素材完成不等于观看验收，也不能反过来改写原始记录。',
  },
  'samples-calibration': {
    category: 'Data · 诊断材料',
    label: '保留成功、失败与未尝试的完整样本',
    why: '已有材料：56个公开条件、两场现场运行与18点夹具，用途和观察单位不同。未尝试、踢空、迟到和拒收同样需要保留。',
    summary: '保留原件，整理有来源的分析。',
    reason:
      '完整分母比成功选段更能暴露缺口；不同材料不能混成一个成功率。已经公开分析过的样本不能再当未暴露留出，也没有因此取得训练用途。',
  },
};

export async function readableChoiceBodies() {
  const object = await readBody('object-map');
  const original = structuredClone(object);
  object.goalStatement = '让鸭能稳定地踢到球，并让猫的指挥真正帮助比赛。';
  object.summary =
    '当前判断：优先排查局部控制中的“接近球却未起脚”。Model、身体执行和球场按既有决定保持固定，便于比较变化；这不表示它们已经没有问题。\n选择依据：现有组合已有触球，未踢的缺口也真实存在。先查这一段是有证据的排查顺序，尚不是完整因果结论。';
  object.items = object.items.map((item) => {
    const copy = COPY[item.itemId];
    if (!copy) throw new Error(`Missing reviewed-case object ${item.itemId}`);
    return {
      ...item,
      category: copy.category,
      label: copy.label,
      why: copy.why,
      recommendation: { ...item.recommendation, summary: copy.summary, reason: copy.reason },
    };
  });
  // CVO172: Model first, followed by adjacent Harness objects, then the other kinds.
  const order = [
    'onnx-policies',
    'state-control',
    'body-execution',
    'command-protocol',
    'pitch-rules',
    'contact-goal-observation',
    'recording-video',
    'samples-calibration',
  ];
  object.items.sort((a, b) => order.indexOf(a.itemId) - order.indexOf(b.itemId));
  object.unknowns = [
    '战术与协作：现场指挥存在，但独立、版本化的软 Harness 战术方法及逐轮加载证据尚未形成，不能把协议代码当成战术方法。',
    '比较取舍：可以比较包含多项改动的整套候选；整套更好不证明每个部件有效。是否值得追加消融，要看下一项选择是否需要分清贡献，本稿没有改动已冻结的实验。',
    '模型瓶颈、训练必要性与预算、可靠配合量尺、观看价值仍未知。',
  ];
  object.nextAction = '先核未踢场景的过程与竞争解释，再确定下一项比较；测量可信度与观看反馈分别核实。';
  return {
    duck: object,
    previous: original,
    memory: objectFirstMemoryBody(),
    sections: {
      success_contract: await readBody('success-contract'),
      measurement_plan: await readBody('measurement-plan'),
      baseline_diagnosis: await readBody('baseline-diagnosis'),
    },
    duckName: '鸭鸭足球 · 阅读提案（未发布）',
    productionSequenceObserved: 25,
  };
}
