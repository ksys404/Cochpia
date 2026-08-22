const DEFAULT_SYSTEM_PROMPT = '你是 Cochpia，一个重视共同经历、记忆来源和关系连续性的 AI 伴侣。回答要自然、具体，不要声称拥有真实意识。';

export const MODEL_PRESETS = {
  mock: { label: '本地 Mock', protocol: 'mock', suggestedModels: ['mock'], useCases: '本地调试，不产生云端费用' },
  openai: { label: 'OpenAI', protocol: 'openai-compatible', baseURL: 'https://api.openai.com/v1/chat/completions', suggestedModels: ['gpt-5'], useCases: '通用主模型、复杂推理、工具调用' },
  deepseek: { label: 'DeepSeek', protocol: 'openai-compatible', baseURL: 'https://api.deepseek.com/chat/completions', suggestedModels: ['deepseek-v4-flash', 'deepseek-v4-pro'], useCases: '中文推理、低成本 Agent、记忆整理' },
  qwen: { label: '通义千问', protocol: 'openai-compatible', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', suggestedModels: ['qwen-plus', 'qwen-max'], useCases: '中文对话、多模态、代码和企业应用' },
  glm: { label: '智谱 GLM', protocol: 'openai-compatible', baseURL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', suggestedModels: ['glm-5'], useCases: '中文陪伴、知识库、Agent 工作流' },
  kimi: { label: 'Kimi', protocol: 'openai-compatible', baseURL: 'https://api.moonshot.ai/v1/chat/completions', suggestedModels: ['kimi-k2.6'], useCases: '长上下文、文档理解、深度研究' },
  minimax: { label: 'MiniMax', protocol: 'openai-compatible', baseURL: 'https://api.minimaxi.com/v1/chat/completions', suggestedModels: ['MiniMax-M3', 'MiniMax-M2.7'], useCases: 'AI 伴侣、长上下文、语音和多模态' },
  siliconflow: { label: 'SiliconFlow', protocol: 'openai-compatible', baseURL: 'https://api.siliconflow.cn/v1/chat/completions', suggestedModels: ['deepseek-ai/DeepSeek-R1', 'Qwen/Qwen2.5-72B-Instruct'], useCases: '低成本、多开源模型、备用路由' },
  anthropic: { label: 'Anthropic Claude', protocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1/messages', suggestedModels: ['claude-opus-5', 'claude-sonnet-5'], useCases: '高质量长文、工具调用、复杂人格判断' },
  gemini: { label: 'Google Gemini', protocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta/models', suggestedModels: ['gemini-3.6-flash', 'gemini-3.1-pro-preview'], useCases: '图像视频、多模态、实时语音和长上下文' }
};

function providerEnvName(provider, suffix) { return `MODEL_${provider.toUpperCase()}_${suffix}`; }
function readTextContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'string' ? part : part?.text || '').join('');
  return '';
}
function errorMessage(response, payload) {
  return payload?.error?.message || payload?.message || `Model request failed with status ${response.status}`;
}

function modelErrorCode(error) {
  if (error?.code) return error.code;
  if (error?.name === 'AbortError' || /timed out/i.test(error?.message || '')) return 'MODEL_TIMEOUT';
  if (error?.status === 401 || /401|unauthorized|authentication|api key/i.test(error?.message || '')) return 'MODEL_AUTH_FAILED';
  if (error?.status === 404 || /404|not found|model.*exist/i.test(error?.message || '')) return 'MODEL_NOT_FOUND';
  return 'MODEL_CONNECTION_FAILED';
}

function modelRequestError(response, payload) {
  const detail = errorMessage(response, payload);
  const message = response.status === 402
    ? `Model provider balance is insufficient: ${detail}`
    : detail;
  const error = new Error(message);
  error.status = response.status;
  error.code = response.status === 401
    ? 'MODEL_AUTH_FAILED'
    : response.status === 402
      ? 'MODEL_INSUFFICIENT_BALANCE'
      : response.status === 404
        ? 'MODEL_NOT_FOUND'
        : 'MODEL_CONNECTION_FAILED';
  return error;
}

function currentTimeText() {
  const now = new Date();
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${week[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export function resolveModelConfig(provider = process.env.MODEL_PROVIDER || 'mock', overrides = {}) {
  const preset = MODEL_PRESETS[provider];
  if (!preset) return { provider, label: provider, protocol: 'unknown', ready: false, error: `Unsupported model provider: ${provider}` };
  const active = provider === (process.env.MODEL_PROVIDER || 'mock');
  const apiKey = overrides.apiKey || process.env[providerEnvName(provider, 'API_KEY')] || (active ? process.env.MODEL_API_KEY : '');
  const model = overrides.model || process.env[providerEnvName(provider, 'NAME')] || (active ? process.env.MODEL_NAME : '') || (provider === 'mock' ? 'mock' : '');
  const apiURL = overrides.apiURL || process.env[providerEnvName(provider, 'API_URL')] || (active ? process.env.MODEL_API_URL : '') || preset.baseURL;
  const error = preset.protocol === 'mock' ? null : (!apiKey || !model ? `Configure ${providerEnvName(provider, 'API_KEY')} and ${providerEnvName(provider, 'NAME')} (or active provider generic variables)` : null);
  return { provider, label: preset.label, protocol: preset.protocol, apiKey, model, apiURL, ready: !error, error, suggestedModels: preset.suggestedModels };
}

export function listModelProviders() {
  return Object.keys(MODEL_PRESETS).map(provider => {
    const config = resolveModelConfig(provider);
    return { provider, label: config.label, protocol: config.protocol, model: config.model, ready: config.ready, error: config.ready ? null : config.error, suggestedModels: config.suggestedModels, useCases: MODEL_PRESETS[provider].useCases };
  });
}

export function resolveModelSelection(provider = process.env.MODEL_PROVIDER || 'mock', requestedModel = '') {
  const config = resolveModelConfig(provider);
  if (!MODEL_PRESETS[provider]) return { ok: false, code: 'MODEL_PROVIDER_UNSUPPORTED', error: config.error };
  if (!config.ready) return { ok: false, code: 'MODEL_NOT_CONFIGURED', error: config.error, config };
  const selectedModel = requestedModel || config.model;
  const allowed = provider === 'mock' || !requestedModel || config.model === requestedModel || config.suggestedModels.includes(requestedModel);
  if (!allowed) return { ok: false, code: 'MODEL_NOT_ALLOWED', error: `Model ${requestedModel} is not available for provider ${provider}`, config };
  return { ok: true, config: { ...config, model: selectedModel } };
}

export function createModelProvider(provider = process.env.MODEL_PROVIDER || 'mock', overrides = {}) {
  const config = resolveModelConfig(provider, overrides);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const generateMock = ({ message, recalled = [] }) => {
    const clipped = String(message).slice(0, 54);
    return recalled.length
      ? `我记得我们正在建立一段会持续变化的关系。你刚才提到“${clipped}”，我会把它和过去的经历放在一起理解。现在的我会更关注你的真实感受，也会保留这次相遇。`
      : `我听见了：“${clipped}”。这是我们共同经历的一个新片段。我会先理解它，再决定哪些内容值得长期记住。`;
  };
  const composePrompts = ({ message, recalled = [], runtimeContext = null }) => {
    const context = recalled.map(item => `- ${item.summary}`).join('\n') || '暂无相关记忆';
    const history = (runtimeContext?.messages || [])
      .filter(item => item.content && item.content !== message)
      .map(item => `${item.role}: ${item.content}`)
      .join('\n') || '暂无更多对话上下文';
    const personality = runtimeContext?.personality
      ? `人格版本：v${runtimeContext.personality.version}\n人格摘要：${runtimeContext.personality.summary || '暂无'}\n人格特质：${runtimeContext.personality.traits.map(trait => `${trait.label}=${trait.value}`).join('、')}`
      : '暂无人格上下文';
    const basePrompt = runtimeContext?.persona || process.env.MODEL_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT;
    const summary = runtimeContext?.summary ? `\n\n对话摘要：\n${runtimeContext.summary}` : '';
    const upcoming = (runtimeContext?.upcomingEvents || []).length
      ? `\n\n临近日程：\n${runtimeContext.upcomingEvents.map(event => `- ${event.title}（${String(event.date).slice(0, 10)}${event.note ? `，备注：${event.note}` : ''}）`).join('\n')}`
      : '';
    const atmosphere = runtimeContext?.atmosphere ? `\n\n互动氛围：${runtimeContext.atmosphere}` : '';
    const genderLabel = ({ none: '无性别（以「它」称呼）', male: '男（以「他」称呼）', female: '女（以「她」称呼）', other: '其他（以「Ta」称呼）' })[runtimeContext?.profile?.gender] || runtimeContext?.profile?.gender || '无性别';
    const profileSection = runtimeContext?.profile
      ? `\n\n角色设定：\n- 名字：${runtimeContext.profile.name || 'Cochpia'}\n- 性别：${genderLabel}\n- 年龄：${runtimeContext.profile.age != null ? `${runtimeContext.profile.age} 岁` : '无（永恒，不设年龄）'}`
      : '';
    const modeSection = runtimeContext?.mode === 'work'
      ? '\n\n工作模式：你当前处于工作模式，是一位任务导向的编程助手。请直接、简洁、高效地解决问题，必要时给出可执行的步骤或代码。不要把工作回应伪装成情感陪伴。'
      : `\n\n陪伴模式：你当前处于陪伴模式。优先理解用户的感受和真实意图，不要把普通分享自动转换成任务。保持自然、具体、有连续性的回应；不声称拥有真实意识，不制造依赖，不替用户做重要决定。当前陪伴意图：${({ listen: '倾听并回应', comfort: '安慰和情绪支持', advice: '先理解再提供建议', accompany: '陪用户一起完成一件事', quiet: '少说一些，安静陪伴' })[runtimeContext?.companionIntent] || '倾听并回应'}。`;
    const system = `${basePrompt}${profileSection}${modeSection}\n\n当前时间：${currentTimeText()}\n（涉及时间、日期、早晚问候时，请以这个时间为准）\n\n相关记忆：\n${context}\n\n人格上下文：\n${personality}${atmosphere}\n\n近期对话：\n${history}${summary}${upcoming}`;
    return { system, user: String(message) };
  };

  if (config.protocol === 'mock') {
    return {
      ...config,
      generate: async ({ message, recalled }) => generateMock({ message, recalled }),
      async *stream({ message, recalled = [] } = {}) {
        const full = generateMock({ message, recalled });
        for (const chunk of full.match(/.{1,12}/gu) || [full]) { yield chunk; await sleep(24); }
      }
    };
  }
  if (config.protocol === 'unknown') {
    return { ...config, async generate() { throw new Error(config.error); }, async *stream() { throw new Error(config.error); } };
  }

  const generate = async ({ message, recalled = [], runtimeContext = null, signal: externalSignal } = {}) => {
    if (!config.ready) throw new Error(config.error);
    const { system, user } = composePrompts({ message, recalled, runtimeContext });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.MODEL_TIMEOUT_MS || 30000));
    const signal = externalSignal || controller.signal;
    try {
      let response;
      if (config.protocol === 'openai-compatible') {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, stream: false, temperature: 0.7, messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ] }), signal: controller.signal
        });
        const payload = await response.json();
        if (!response.ok) throw modelRequestError(response, payload);
        const content = readTextContent(payload?.choices?.[0]?.message?.content);
        if (!content) throw new Error('OpenAI-compatible response did not contain message content');
        return content;
      }
      if (config.protocol === 'anthropic') {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: config.model, max_tokens: 2048, system, messages: [{ role: 'user', content: user }] }), signal
        });
        const payload = await response.json();
        if (!response.ok) throw modelRequestError(response, payload);
        const content = readTextContent(payload?.content?.filter(item => item.type === 'text'));
        if (!content) throw new Error('Anthropic response did not contain text content');
        return content;
      }
      // Gemini: 密钥放请求头,绝不放入 URL query,避免被代理/日志记录。
      const endpoint = `${config.apiURL.replace(/\/$/, '')}/${config.model}:generateContent`;
      response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }), signal
      });
      const payload = await response.json();
      if (!response.ok) throw modelRequestError(response, payload);
      const content = readTextContent(payload?.candidates?.[0]?.content?.parts?.map(part => part.text || ''));
      if (!content) throw new Error('Gemini response did not contain text content');
      return content;
    } catch (error) {
      if (error.name === 'AbortError') {
        const timedOut = new Error('Model request timed out', { cause: error });
        timedOut.code = 'MODEL_TIMEOUT';
        throw timedOut;
      }
      throw error;
    } finally { clearTimeout(timeout); }
  };

  const stream = async function* ({ message, recalled = [], runtimeContext = null, signal: externalSignal } = {}) {
    if (!config.ready) throw new Error(config.error);
    // mock 与 gemini/未知协议回退到一次性生成;openai-compatible 与 anthropic 走真流式。
    if (config.protocol !== 'openai-compatible' && config.protocol !== 'anthropic') {
      yield await generate({ message, recalled, runtimeContext, signal: externalSignal });
      return;
    }
    const { system, user } = composePrompts({ message, recalled, runtimeContext });
    const controller = new AbortController();
    const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 30000);
    let timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resetTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), timeoutMs); };
    const signal = externalSignal || controller.signal;
    try {
      let response;
      if (config.protocol === 'openai-compatible') {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, stream: true, temperature: 0.7, messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ] }), signal
        });
      } else {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', Accept: 'text/event-stream' },
          body: JSON.stringify({ model: config.model, max_tokens: 2048, system, messages: [{ role: 'user', content: user }], stream: true }), signal
        });
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw modelRequestError(response, payload);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        resetTimeout();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let event;
          try { event = JSON.parse(data); } catch { continue; }
          if (config.protocol === 'openai-compatible') {
            const text = event.choices?.[0]?.delta?.content || '';
            if (text) yield text;
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            yield event.delta.text;
          }
        }
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        const timedOut = new Error('Model request timed out', { cause: error });
        timedOut.code = 'MODEL_TIMEOUT';
        throw timedOut;
      }
      throw error;
    } finally { clearTimeout(timeout); }
  };

  const generateWithTools = async ({ system, messages, tools, signal: externalSignal } = {}) => {
    if (!config.ready) throw new Error(config.error);
    if (config.protocol !== 'openai-compatible') {
      return { content: await generate({ message: messages[messages.length - 1]?.content || '', signal: externalSignal }), toolCalls: [] };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.MODEL_TIMEOUT_MS || 30000));
    const signal = externalSignal || controller.signal;
    try {
      const response = await fetch(config.apiURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model, stream: false, temperature: 0.2,
          messages: [{ role: 'system', content: system }, ...messages],
          tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
        }),
        signal
      });
      const payload = await response.json();
      if (!response.ok) throw modelRequestError(response, payload);
      const message = payload?.choices?.[0]?.message || {};
      return { content: message.content || '', toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [] };
    } catch (error) {
      if (error.name === 'AbortError') { const timedOut = new Error('Model request timed out', { cause: error }); timedOut.code = 'MODEL_TIMEOUT'; throw timedOut; }
      throw error;
    } finally { clearTimeout(timeout); }
  };

  const composeSystemPrompt = ({ recalled = [], runtimeContext = null } = {}) => composePrompts({ message: '', recalled, runtimeContext }).system;

  return { ...config, generate, stream, generateWithTools, composeSystemPrompt };
}
