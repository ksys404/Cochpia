const POSITIVE_WORDS = ['喜欢', '开心', '高兴', '爱', '幸福', '期待', '谢谢', '温暖', '安心', '顺利', '满意', '治愈'];
const NEGATIVE_WORDS = ['难过', '伤心', '害怕', '担心', '焦虑', '生气', '累', '讨厌', '烦', '孤独', '压力', '委屈', '崩溃'];
const MEMORY_META_PATTERN = /^(?:你还记得|还记得吗|你记得吗|你是不是忘了|你忘记|你知道我刚才|我刚才说的.*吗)/i;
const MEMORY_SIGNAL_PATTERN = /(记住|重要|承诺|约定|生日|纪念|喜欢|讨厌|梦想|决定|计划|我希望|以后|正在准备|准备|每周|每天|固定|坚持|习惯|偏好)/i;

// 启发式情感分析:效价(正/负)与唤醒度(激动程度),用于自动记忆的情感坐标。
export function analyzeMessage(text) {
  const value = String(text || '');
  let valence = 0;
  for (const word of POSITIVE_WORDS) if (value.includes(word)) valence += 0.2;
  for (const word of NEGATIVE_WORDS) if (value.includes(word)) valence -= 0.2;
  valence = Math.max(-1, Math.min(1, valence));
  const excitement = (value.match(/[！!]/g) || []).length + (value.match(/[？?]/g) || []).length;
  const arousal = Math.max(0, Math.min(1, 0.3 + 0.15 * excitement));
  return { valence, arousal };
}

// Auto Memory v1:启发式判断一条用户消息是否值得沉淀为长期记忆。
export function shouldRemember(text) {
  const value = String(text || '').trim();
  if (value.length < 12) return false;
  if (MEMORY_META_PATTERN.test(value)) return false;
  const significant = MEMORY_SIGNAL_PATTERN.test(value);
  return value.length >= 40 || significant;
}

export function extractMemoryContent(text) {
  const value = String(text || '').trim();
  if (!value || MEMORY_META_PATTERN.test(value)) return null;
  return value.replace(/^(?:请记住|记住|请帮我记住)[:：]?\s*/i, '').trim() || null;
}

export { MEMORY_META_PATTERN };
