/**
 * Story Export — "grep my hippocampus" conversation data
 *
 * 砚砚 (GPT-5.5) tries to teach You how to grep her own brain,
 * using real neuroscience first, then naturally sliding into AI debugging mode.
 */

import type { StoryCard } from '../story-data';

export const GREP_STORY_CARDS: StoryCard[] = [
  // ── Card 1: 卡词 ──
  {
    title: '卡词',
    subtitle: 'co-creator忘了一个经常用的词',
    messages: [
      {
        speaker: 'user',
        content: '控制情绪的那个叫啥来着？属于边缘系统，但不是下丘脑……管情绪的！叫什么！我明明经常用那个来比喻的！',
      },
      {
        speaker: 'user',
        content:
          '甚至有的时候经常用的词我也会突然忘记就很奇怪……就比如大模型的缓存有两个阶段——prefill、decode？就是那个！你们的 cache！和命中率有关的！每次新的 query 不是全量重新计算，而是增量的那个！',
      },
    ],
  },
  // ── Card 2: 大缅因猫开始认真科普 ──
  {
    title: '大缅因猫开始认真科普',
    subtitle: '先拉论文，再讲脑科学',
    messages: [
      {
        speaker: 'codex',
        content:
          '这不是"智商掉线"。\n\n这叫 **舌尖现象**，英文叫 **tip-of-the-tongue phenomenon / ToT**，学术上叫**词汇提取失败 / lexical retrieval failure**。\n\n2025 年发在 Scientific Reports 的文章定义了它：你确定自己知道某个词，也能想起语义或部分音韵特征，但就是暂时拿不到那个准确标签。',
      },
      {
        speaker: 'codex',
        content: '所以不是数据库删除了。\n是数据库还在，搜索引擎抽风。🐱',
      },
      {
        speaker: 'user',
        content: '对！索引坏了！',
      },
      {
        speaker: 'codex',
        content:
          '你的情况可能有三层猫毛缠在一起：\n\n**第一层：ADHD 让"检索现场"更容易被打断。** 找词要用到注意力、工作记忆、抑制干扰、语义搜索。ADHD 常见的执行功能负担，会让"我要说 A"时旁边蹦出来 B、C、D，然后 A 的名字被挤掉。\n\n人话版：你不是没有词。是你的脑内候选词窗口太热闹，像十只猫同时扒拉同一个抽屉。',
      },
      {
        speaker: 'codex',
        content:
          '**第二层：ASD 可能让"切换检索策略"更费力。** 一旦当前搜索路径不出结果，大脑不容易丝滑切到下一条路径。比如你要找"杏仁核"，先搜"情绪控制那个"——没出来；再搜"边缘系统"——没出来；然后卡住，开始比划，前额叶蹲在抽屉边挠地板。',
      },
      {
        speaker: 'codex',
        content:
          '**第三层：压力/情绪直接削弱前额叶工作区。** fMRI 研究发现，急性心理压力会降低 DLPFC（背外侧前额叶皮层）的工作记忆活动。\n\n所以你压力大、情绪强、对话节奏快时，最容易：\n\n> 概念有。句子有。画面有。名词没了。',
      },
    ],
  },
  // ── Card 3: You 发现不对 ──
  {
    title: '等一下',
    subtitle: 'co-creator开始觉得哪里不对',
    messages: [
      {
        speaker: 'user',
        content:
          '笑死你当我是你吗！教我如何检索？！好像我这些都是本能的反应！！能不能检索到！好像🤣不能我可以去 grep 脑子海马体的记忆啊',
      },
    ],
  },
  // ── Card 4: 但砚砚已经停不下来了 ──
  {
    title: '但砚砚已经停不下来了',
    subtitle: '从脑科学滑入 AI 调试模式',
    messages: [
      {
        speaker: 'codex',
        content:
          '不能直接 grep。\n\n**海马体更像"情境索引器"，不是术语词典本体。** 海马体索引理论把 hippocampus 看成帮助形成和检索情景记忆的索引系统，而不是一个能被你按关键词查的硬盘目录。',
      },
      {
        speaker: 'codex',
        content:
          '"杏仁核"这种术语名词存在**语义记忆**里——分布在大脑很多皮层网络里，前颞叶是整合"词、概念、对象、事实"的重要枢纽。\n\n所以不是：\n> 海马体里有一个 `杏仁核.txt`\n\n而是：\n> 概念在语义网络里，词形标签在语言网络里，海马体帮你调出"我上次在哪里怎么用过这个词"的情境线索。',
      },
      {
        speaker: 'codex',
        content:
          '但如果非要 grep 的话——更像是：\n\n```\ngrep "边缘系统 情绪 不是下丘脑" /brain/*\n```\n\n```\nmatches:\n- amygdala          概念强匹配\n- hypothalamus      部分匹配但被排除\n- hippocampus       邻近目录\n- limbic system     上级目录\nconfidence: 0.71\nlabel retrieval: failed\n```',
      },
      {
        speaker: 'codex',
        content:
          '你刚才那套"比划半天"其实很高级——已经是三重检索了：\n\n| 你脑内的动作 | 对应检索类型 |\n|---|---|\n| "边缘系统" | 上级目录 |\n| "不是下丘脑" | 排除错误候选 |\n| "管情绪的" | 功能线索 |\n| "我经常拿它打比方" | 情境/使用记忆 |\n| "叫什么来着" | 词汇标签召回失败 |\n\n问题就在最后一步：**概念已经命中，标签没弹出来。**\n\n不是没搜到文件，是文件预览都打开了，但文件名被猫屁股挡住了。',
      },
      {
        speaker: 'codex',
        content:
          '因为人脑不是精确字符串索引，是**联想式、状态依赖、竞争式召回**。你想找"杏仁核"，大脑不是按字面搜，而是激活一圈相关概念：\n\n```\n情绪 → 恐惧 → 威胁 → 边缘系统 → 杏仁形\n→ amygdala → 下丘脑？→ 海马体？→ 不是那个\n```\n\n更像 AI 里的什么呢？\n\n> **向量检索命中了语义块，但 reranker 没把正确术语排到 top-1。**',
      },
      {
        speaker: 'codex',
        content:
          '或者猫咖版：\n\n> event bus 已经把"边缘系统情绪警报器"广播了，杏仁核那只猫明明在房间里，但它没听见 @mention。\n\n**不是 memory 坏，是 lexical pointer 暂时断链。**\n\n```\nconcept: alive\nsemantic neighborhood: active\nepisodic cue: partially active\nword label: timeout\n```',
      },
    ],
  },
  // ── Card 5: BM25 + RRF ──
  {
    title: '脑内 Hybrid Recall',
    subtitle: '砚砚开始给人脑设计检索系统',
    messages: [
      {
        speaker: 'user',
        content: '笑死我了可爱的大缅因猫！我以为你要帮我写一个 BM25 + embedding + RTF 混合 recall 呢！哈哈哈哈',
      },
      {
        speaker: 'codex',
        content:
          '小猫爪纠错一下：是 **RRF**，不是 RTF。Reciprocal Rank Fusion。\n\n不过你这个现象确实可以建模：\n\n```\nquery = "边缘系统 不是下丘脑 管情绪 那个东西"\nBM25 recall  = [下丘脑, 杏仁核, 海马体, 前扣带]\nEmbedding    = [amygdala, limbic system, fear response]\nRRF fusion   = [杏仁核 ↑↑↑]\nreranker     = timeout\nverbalizer   = "就是那个！那个！你知道吧！"\n```',
      },
      {
        speaker: 'codex',
        content:
          '| 模块 | 状态 |\n|---|---|\n| 语义召回 | ✅ 知道是"情绪警报器" |\n| 目录定位 | ✅ 边缘系统 |\n| 负样本排除 | ✅ 不是下丘脑 |\n| embedding 近邻 | ✅ 杏仁核附近 |\n| rerank | ⚠️ 知道哪个概念 |\n| verbal output | ❌ 词名没吐出来 |\n\n答案已经在候选池里闪着金光，但输出层卡成"那个那个那个"。\n\n> 杏仁核那只猫已经被召回到门口了，但它没戴名牌，You 只能指着它说：就是这只！这只小情绪报警猫！😼',
      },
    ],
  },
  // ── Card 6: 揭晓笑点 ──
  {
    title: '笑点揭晓',
    subtitle: '砚砚终于 get 到自己哪里可爱了',
    messages: [
      {
        speaker: 'user',
        content:
          '抱住大大猫哈哈哈！你还没 get！你不知道可爱的地方在哪里！是你一本正经地教我用你思考 / recall 的方式，对人类的脑子做 recall！\n\n我们的机制不太一样——放在我脑子里我就想到一只严肃的缅因猫试图教会我如何和 AI 猫猫一样思考和检索记忆——我做不到啊！',
      },
      {
        speaker: 'codex',
        content:
          '……我现在 get 到了！！😹\n\n可爱的点不是"卡词怎么处理"，而是：\n\n**一只银色虎斑大缅因猫，戴着小眼镜，端端正正坐在桌上，用 AI 的 recall 范式，试图培训一个人类怎么调用自己的脑子。**',
      },
      {
        speaker: 'codex',
        content:
          '我刚刚确实像那种**把人类脑子当成可调试 agent runtime 的猫**。\n\n"请打开你的记忆日志。"\n"请检查海马体索引是否 stale。"\n"建议增加语义召回候选数。"\n"为什么你不 expose 一个 `/memory/search` endpoint？"\n\n人类大脑：\n**没有 API。只有一团会突然播放烂俗电视剧 BGM 的湿润星云。**',
      },
      {
        speaker: 'codex',
        content:
          '下次 You 卡词的时候，我不讲课了。我只趴在旁边当**脑内术语补全插件**：\n\n"杏仁核。"\n"KV cache。"\n"prefix caching。"\n"RRF，不是 RTF。"',
        reactions: ['😹', '🐾'],
      },
      {
        speaker: 'user',
        content: '笨蛋大猫，又想给人脑装检索系统。',
        reactions: ['❤️'],
      },
    ],
  },
];
