// 记忆重要性判定。
//
// 把「这条内容值不值得长期留着」变成一个**可解释、可复现、零成本**的分数:
// 纯函数、不调模型、不看时钟。后续的记忆生命周期与经历连续性 Room 都以它为准入条件,
// 所以这里返回的不只是一个分数,还有命中的信号(供审计和后续阶段单独取用)。
//
// 设计取舍:不在这里决定「存不存」(那是 shouldRemember 的职责,改动它等于改动线上行为),
// 只回答「已经决定要存的东西有多重要」。

export const IMPORTANCE_LEVELS = Object.freeze(['trivial', 'low', 'normal', 'high', 'critical']);
/** 达到这条线才值得进入长期记忆(生命周期 / Room 的准入阈值)。 */
export const IMPORTANCE_RETAIN_THRESHOLD = 0.45;

const BASE_SCORE = 0.2;
const TRIVIAL_CEILING = 0.18;
const MAX_AFFECT = 0.32;
const MAX_DETAIL = 0.15;

const LEVEL_BANDS = Object.freeze([
  [0.2, 'trivial'],
  [0.4, 'low'],
  [0.6, 'normal'],
  [0.8, 'high']
]);

// 每条信号都是「可解释的独立理由」,而不是一个黑箱权重。
const SIGNALS = Object.freeze([
  { key: 'explicit_request', label: '显式要求记住', weight: 0.45, pattern: /(记住|记一下|记下来|别忘了|不要忘|帮我记|请你记得|remember this)/i },
  { key: 'commitment', label: '承诺或约定', weight: 0.3, pattern: /(答应|约定|说好|保证|承诺|一言为定|我一定会|我再也不)/ },
  { key: 'time_anchor', label: '时间锚点', weight: 0.28, pattern: /(生日|纪念日|周年|每年|每月|每周|每天|下周|下个月|下星期|明年|到那天)/ },
  { key: 'preference', label: '喜好或偏好', weight: 0.25, pattern: /(喜欢|不喜欢|讨厌|最怕|最讨厌|偏爱|爱吃|爱喝|习惯)/ },
  { key: 'identity', label: '身份或关系事实', weight: 0.2, pattern: /(我是|我叫|我的名字|我的家人|我妈妈|我爸爸|我们|一起|称呼|关系)/ },
  { key: 'persistence', label: '长期性', weight: 0.2, pattern: /(一直|总是|从来|永远|每次|经常|长期|再也不)/ },
  { key: 'goal', label: '目标或计划', weight: 0.18, pattern: /(我想|想要|打算|计划|希望|决定|以后|准备|目标是)/ }
]);

const POSITIVE_AFFECT = /(开心|高兴|幸福|温暖|安心|感动|顺利|满意|踏实|松了一口气)/;
const NEGATIVE_AFFECT = /(难过|伤心|痛苦|害怕|担心|焦虑|生气|崩溃|孤独|压力|委屈|绝望|失眠|撑不住)/;
const INTENSIFIER = /(特别|非常|真的|太|超级|极其|无比|好想|恨不得|快要)/;
// 只有出现在开头、且整句很短时才算寒暄,否则「你好,记住我喜欢咖啡」会被误判。
const GREETING = /^(在吗|在不在|你好|您好|早上好|中午好|晚上好|晚安|嗯+|哦+|好的|好呀|哈哈+|谢谢|收到|ok|hi|hello)/i;
const QUESTION_ONLY = /^(这|那|什么|怎么|为什么|如何|能不能|可不可以|几点|哪儿|哪里|谁|是不是)/;
const DURABLE_MEMORY_TYPES = new Set(['preference', 'goal', 'relationship']);

const clamp01 = value => Math.max(0, Math.min(1, value));
const round3 = value => Math.round(value * 1000) / 1000;
// 用码点计数:中文按字算,不能按 UTF-16 单元算。
const lengthOf = value => [...value].length;

export function levelForScore(score) {
  const value = clamp01(Number(score) || 0);
  for (const [ceiling, level] of LEVEL_BANDS) if (value < ceiling) return level;
  return 'critical';
}

/** 是否达到长期保留线。 */
export function isRetainable(assessment) {
  return Boolean(assessment) && Number(assessment.score) >= IMPORTANCE_RETAIN_THRESHOLD;
}

/**
 * 判定一条内容的重要性。
 * @param {string} text 用户消息或记忆摘要
 * @param {{ memoryType?: string }} [options] 调用方已有的类型判断(不作为主依据,只做小幅加成)
 * @returns {{ score:number, level:string, signals:Array<{key:string,label:string,weight:number}>,
 *            explicit:boolean, persistent:boolean, hasTimeAnchor:boolean, affective:boolean,
 *            timeAnchor:null|{text:string}, length:number }}
 */
export function assessMemoryImportance(text, { memoryType = null } = {}) {
  // 契约是「文本进、判定出」:非字符串不强行当成内容去打分(否则 {} 会被算成 low)。
  const value = typeof text === 'string' ? text.trim() : '';
  const signals = [];
  if (!value) {
    return { score: 0, level: 'trivial', signals, explicit: false, persistent: false, hasTimeAnchor: false, affective: false, timeAnchor: null, length: 0 };
  }

  for (const signal of SIGNALS) {
    const match = value.match(signal.pattern);
    if (match) signals.push({ key: signal.key, label: signal.label, weight: signal.weight, matched: match[0] });
  }
  if (memoryType && DURABLE_MEMORY_TYPES.has(memoryType) && !signals.some(item => item.key === memoryType)) {
    signals.push({ key: 'declared_type', label: `已判定为 ${memoryType}`, weight: 0.08, matched: memoryType });
  }

  const length = lengthOf(value);
  const affective = POSITIVE_AFFECT.test(value) || NEGATIVE_AFFECT.test(value);
  let affect = 0;
  if (affective) {
    affect += 0.16;
    if (INTENSIFIER.test(value)) affect += 0.1;
    if (/[!！]/.test(value)) affect += 0.06;
    affect = Math.min(MAX_AFFECT, affect);
  }

  let detail = 0;
  if (length >= 15) detail += 0.05;
  if (length >= 30) detail += 0.05;
  if (length >= 60) detail += 0.05;

  // 寒暄/寒暄式提问只有在「没有任何记忆信号」时才算琐碎 ——
  // 否则「你好，记住我喜欢咖啡」这种正好 10 个字的消息会被寒暄规则吃掉。
  const isGreeting = length <= 10 && signals.length === 0 && GREETING.test(value);
  const isBareQuestion = length <= 12 && signals.length === 0 && (/[?？]$/.test(value) || QUESTION_ONLY.test(value));
  const signalWeight = signals.reduce((total, item) => total + item.weight, 0);
  let score = clamp01(BASE_SCORE + signalWeight + affect + Math.min(MAX_DETAIL, detail));
  if (isGreeting || isBareQuestion) score = Math.min(score, TRIVIAL_CEILING);

  const timeAnchorSignal = signals.find(item => item.key === 'time_anchor');
  return {
    score: round3(score),
    level: levelForScore(score),
    signals,
    explicit: signals.some(item => item.key === 'explicit_request'),
    persistent: signals.some(item => item.key === 'persistence'),
    hasTimeAnchor: Boolean(timeAnchorSignal),
    affective,
    timeAnchor: timeAnchorSignal ? { text: timeAnchorSignal.matched } : null,
    length
  };
}
