export const COMPACT_THRESHOLD = 30;
export const RECENT_KEEP = 12;

// 把较早的对话历史压缩成一段摘要,作为后续对话的长期上下文。
export async function summarizeConversation(model, messages, existingSummary = '') {
  const transcript = (messages || [])
    .filter(message => message.content)
    .map(message => `${message.role === 'user' ? '用户' : 'Cochpia'}：${message.content}`)
    .join('\n');
  const prompt = [
    '请把下面这段对话历史压缩成简洁摘要，作为后续对话的长期上下文。',
    '保留：关键事实、用户偏好与习惯、情绪变化、未完成的事、重要约定与承诺。',
    '要求：不要编造，不要逐条复述，用自然段落概括，尽量控制在 300 字以内。',
    existingSummary ? `\n已有摘要（请在其基础上增量更新）：\n${existingSummary}\n` : '',
    `\n对话历史：\n${transcript}`
  ].join('\n');
  const result = await model.generate({ message: prompt, recalled: [] });
  return String(result || '').trim();
}

// 当消息数超过阈值时,把较早的消息压缩进 session.summary;用 summarizedCount 缓存,避免重复压缩。
export async function maybeCompactConversation(session, messages, model, { threshold = COMPACT_THRESHOLD, keepRecent = RECENT_KEEP } = {}) {
  if (!session || !messages || messages.length <= threshold) return { summary: session.summary || '', changed: false };
  const keepFrom = Math.max(0, messages.length - keepRecent);
  const toSummarize = messages.slice(0, keepFrom);
  if (!toSummarize.length) return { summary: session.summary || '', changed: false };
  if ((session.summarizedCount || 0) >= toSummarize.length) return { summary: session.summary || '', changed: false };
  const summary = await summarizeConversation(model, toSummarize, session.summary || '');
  session.summary = summary;
  session.summarizedCount = toSummarize.length;
  return { summary, changed: true };
}
