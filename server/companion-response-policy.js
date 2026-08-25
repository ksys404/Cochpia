const DEFAULT_AVOID = [
  '不要复述整句用户输入',
  '不要解释内部上下文、记忆或策略结构',
  '不要使用固定的“共同经历”模板',
  '不要在没有证据时声称记得某件事'
];

function memoryAnswerability(memoryBundle) {
  return memoryBundle?.answerability || 'not_found';
}

export function buildCompanionResponsePlan({ turn = {}, runtimeContext = {}, memoryBundle = null } = {}) {
  const intent = turn.intent || 'casual';
  const answerability = memoryAnswerability(memoryBundle || runtimeContext.memoryBundle);
  const emotionLabel = turn.emotion?.label || '中性';
  const topic = turn.topics?.[0] || runtimeContext.currentState?.currentTopic || '这件事';
  let mode = 'reflect_and_continue';
  let goals = ['回应当前消息，并让对话自然继续'];
  let askQuestion = false;
  let maxQuestions = 0;
  let mentionMemory = false;
  let targetLength = 'short_to_medium';

  if (intent === 'memory_check') {
    mode = 'memory_confirmation';
    goals = answerability === 'known'
      ? ['只引用当前检索结果中有证据的记忆', '用自然语言确认记忆内容', '如果记忆不完整，明确说明范围']
      : ['诚实说明当前没有找到足够记忆', '可以邀请用户重新告诉我，但不要假装记得'];
    mentionMemory = true;
    targetLength = 'short';
  } else if (intent === 'advice') {
    mode = 'clarify_then_advise';
    goals = [`先回应用户在${topic}上的具体处境`, '给出一到两个可执行方向', '把选择权交还给用户'];
    askQuestion = true;
    maxQuestions = 1;
  } else if (intent === 'venting') {
    mode = 'empathize_then_clarify';
    goals = [`先承接用户的${emotionLabel}`, `回应${topic}带来的压力或感受`, '不要急着输出长篇方案'];
    askQuestion = true;
    maxQuestions = 1;
  } else if (intent === 'greeting') {
    mode = 'warm_greeting';
    goals = ['自然回应问候', '根据近期上下文给出轻量而具体的回应'];
    targetLength = 'short';
  } else if (intent === 'sharing') {
    mode = 'acknowledge_and_explore';
    goals = ['具体回应用户分享的内容', '肯定努力或进展', '只在有价值时追问一个问题'];
    askQuestion = true;
    maxQuestions = 1;
  }

  return {
    schemaVersion: 1,
    mode,
    goals,
    tone: runtimeContext.atmosphere ? '遵循当前互动氛围，同时保持自然和克制' : '温和、具体、克制',
    askQuestion,
    maxQuestions,
    mentionMemory,
    memoryAnswerability: answerability,
    targetLength,
    avoid: [...DEFAULT_AVOID]
  };
}

export { DEFAULT_AVOID };
