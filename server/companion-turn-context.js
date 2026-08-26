import { analyzeMessage } from './auto-memory.js';

const MEMORY_QUESTION_PATTERN = /(?:你还记得|还记得.*吗|你记得吗|你是不是忘了|你忘记.*吗|之前.*说过.*吗|刚才.*说.*吗|以前.*提过.*吗|回忆一下)/i;
const MEMORY_SAVE_PATTERN = /^(?:请|帮我|希望你)?(?:记住|记下|保存)[:： ]?/i;
const ADVICE_PATTERN = /(怎么办|怎么做|该怎么办|建议|你觉得|如何|要不要|该不该|怎么解决|帮我想)/i;
const GREETING_PATTERN = /^(你好|嗨|哈喽|hello|hi|早上好|晚上好|晚安|在吗|回来了吗)[！!。.!？? ]*$/i;
const NEGATIVE_PATTERN = /(累|疲惫|焦虑|难过|伤心|害怕|担心|生气|烦|孤独|压力|委屈|崩溃|没有进展|失败|不想|迷茫|失望)/i;
const POSITIVE_PATTERN = /(喜欢|开心|高兴|期待|谢谢|温暖|安心|顺利|满意|幸福|兴奋|完成了|学完了|做完了|成功了|实现了)/i;

const TOPIC_PATTERNS = [
  ['创业项目', /(创业|项目|产品|产品设计|用户|发布|业务)/i],
  ['工作学习', /(工作|上班|学习|考试|作业|课程|设计)/i],
  ['关系相处', /(关系|朋友|家人|伴侣|相处|沟通|我们)/i],
  ['身体状态', /(身体|健康|睡眠|失眠|吃饭|休息|生病)/i],
  ['目标计划', /(目标|计划|打算|准备|坚持|以后|未来)/i],
  ['生活日常', /(今天|最近|周末|日常|天气|出门|回家)/i]
];

function normalizeText(value, max = 8_000) {
  return String(value ?? '').trim().slice(0, max);
}

function emotionLabel(text, valence) {
  if (/(焦虑|担心|害怕|压力|迷茫)/i.test(text)) return '焦虑与压力';
  if (/(累|疲惫|没精神|困)/i.test(text)) return '疲惫';
  if (/(难过|伤心|委屈|孤独|失望)/i.test(text)) return '低落';
  if (valence > 0.2 || POSITIVE_PATTERN.test(text)) return '积极';
  if (valence < -0.1 || NEGATIVE_PATTERN.test(text)) return '负面情绪';
  return '中性';
}

function detectIntent(text, emotion) {
  if (MEMORY_QUESTION_PATTERN.test(text)) return 'memory_check';
  if (MEMORY_SAVE_PATTERN.test(text)) return 'sharing';
  if (ADVICE_PATTERN.test(text)) return 'advice';
  if (GREETING_PATTERN.test(text)) return 'greeting';
  if (emotion.valence < -0.1 || NEGATIVE_PATTERN.test(text)) return 'venting';
  if (POSITIVE_PATTERN.test(text) || /(我正在|我已经|我想继续|我完成了|最近在)/.test(text)) return 'sharing';
  return 'casual';
}

function explicitNeedFor(intent) {
  if (intent === 'memory_check') return 'recall';
  if (intent === 'advice') return 'advice';
  if (intent === 'venting') return 'listening';
  if (intent === 'sharing') return 'acknowledgement';
  return 'conversation';
}

function topicsFor(text) {
  return TOPIC_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([topic]) => topic);
}

function lastAssistantQuestion(messages = []) {
  return [...messages]
    .reverse()
    .find(message => message?.role === 'assistant' && /[？?]/.test(String(message.content || '')))?.content || null;
}

export function analyzeCompanionTurn({ message = '', messageId = null, messages = [], summary = '' } = {}) {
  const text = normalizeText(message);
  const coordinates = analyzeMessage(text);
  const emotion = {
    label: emotionLabel(text, coordinates.valence),
    valence: coordinates.valence,
    arousal: coordinates.arousal,
    signals: [
      NEGATIVE_PATTERN.test(text) ? 'negative_language' : null,
      POSITIVE_PATTERN.test(text) ? 'positive_language' : null,
      /[？?]/.test(text) ? 'question' : null,
      /[！!]/.test(text) ? 'exclamation' : null
    ].filter(Boolean)
  };
  const intent = detectIntent(text, emotion);
  const topics = topicsFor(text);
  const asksAboutMemory = intent === 'memory_check';
  const asksForAdvice = intent === 'advice';

  return {
    schemaVersion: 1,
    messageId: messageId ? String(messageId) : null,
    message: text,
    intent,
    explicitNeed: explicitNeedFor(intent),
    emotion,
    topics,
    asksAboutMemory,
    asksForAdvice,
    conversation: {
      messageCount: Array.isArray(messages) ? messages.length : 0,
      summaryPresent: Boolean(String(summary || '').trim()),
      lastAssistantQuestion: lastAssistantQuestion(messages)
    }
  };
}

export { MEMORY_QUESTION_PATTERN, MEMORY_SAVE_PATTERN, ADVICE_PATTERN };
