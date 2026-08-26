import { buildCompanionMessages, buildCompanionSystemPrompt } from './model-message-builder.js';

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
function trimTerminalPunctuation(value) { return String(value ?? '').trim().replace(/[。！!？?]+$/u, ''); }
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

function linkAbortSignal(externalSignal) {
  const controller = new AbortController();
  if (!externalSignal) return { controller, dispose: () => {} };
  const forwardAbort = () => controller.abort();
  if (externalSignal.aborted) controller.abort();
  else externalSignal.addEventListener('abort', forwardAbort, { once: true });
  return {
    controller,
    dispose: () => externalSignal.removeEventListener('abort', forwardAbort)
  };
}

export function resolveModelConfig(provider = process.env.MODEL_PROVIDER || 'mock', overrides = {}) {
  const preset = MODEL_PRESETS[provider];
  if (!preset) return { provider, label: provider, protocol: 'unknown', ready: false, error: `Unsupported model provider: ${provider}` };
  const active = provider === (process.env.MODEL_PROVIDER || 'mock');
  const apiKey = overrides.apiKey || process.env[providerEnvName(provider, 'API_KEY')] || (active ? process.env.MODEL_API_KEY : '');
  const model = overrides.model || process.env[providerEnvName(provider, 'NAME')] || (active ? process.env.MODEL_NAME : '') || (provider === 'mock' ? 'mock' : '');
  const apiURL = overrides.apiURL || process.env[providerEnvName(provider, 'API_URL')] || (active ? process.env.MODEL_API_URL : '') || preset.baseURL;
  const retentionPolicy = overrides.retentionPolicy
    || process.env[providerEnvName(provider, 'RETENTION_POLICY')]
    || (active ? process.env.MODEL_RETENTION_POLICY : '')
    || '';
  const configurationError = !apiKey || !model
    ? `Configure ${providerEnvName(provider, 'API_KEY')} and ${providerEnvName(provider, 'NAME')} (or active provider generic variables)`
    : null;
  const policyError = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
    && preset.protocol !== 'mock'
    && (!String(retentionPolicy).trim() || String(retentionPolicy).trim().toLowerCase() === 'unknown')
    ? 'MODEL_RETENTION_POLICY is required for this external model provider in production'
    : null;
  const error = preset.protocol === 'mock' ? null : configurationError || policyError;
  const errorCode = policyError ? 'MODEL_EXTERNAL_POLICY_REQUIRED' : configurationError ? 'MODEL_NOT_CONFIGURED' : null;
  return { provider, label: preset.label, protocol: preset.protocol, apiKey, model, apiURL, retentionPolicy, ready: !error, error, errorCode, suggestedModels: preset.suggestedModels };
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
  if (!config.ready) return { ok: false, code: config.errorCode || 'MODEL_NOT_CONFIGURED', error: config.error, config };
  const selectedModel = requestedModel || config.model;
  const allowed = provider === 'mock' || !requestedModel || config.model === requestedModel || config.suggestedModels.includes(requestedModel);
  if (!allowed) return { ok: false, code: 'MODEL_NOT_ALLOWED', error: `Model ${requestedModel} is not available for provider ${provider}`, config };
  return { ok: true, config: { ...config, model: selectedModel } };
}

export function validateProductionModelPolicy({ nodeEnv = process.env.NODE_ENV, provider = process.env.MODEL_PROVIDER || 'mock', retentionPolicy } = {}) {
  if (String(nodeEnv || '').toLowerCase() !== 'production' || String(provider || '').toLowerCase() === 'mock') return;
  const policy = String(
    retentionPolicy
      ?? process.env[providerEnvName(provider, 'RETENTION_POLICY')]
      ?? (provider === (process.env.MODEL_PROVIDER || 'mock') ? process.env.MODEL_RETENTION_POLICY : '')
      ?? ''
  ).trim();
  if (!policy || policy.toLowerCase() === 'unknown') {
    throw Object.assign(
      new Error('MODEL_RETENTION_POLICY is required for an external model provider in production'),
      { code: 'MODEL_EXTERNAL_POLICY_REQUIRED', status: 503 }
    );
  }
}

export function createModelProvider(provider = process.env.MODEL_PROVIDER || 'mock', overrides = {}) {
  const config = resolveModelConfig(provider, overrides);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const generateMock = ({ message, recalled = [], runtimeContext = null }) => {
    const clipped = String(message || '').slice(0, 80);
    const plan = runtimeContext?.responsePlan;
    const memories = Array.isArray(runtimeContext?.recalled) && runtimeContext.recalled.length
      ? runtimeContext.recalled
      : recalled;
    const topic = runtimeContext?.turn?.topics?.[0] || runtimeContext?.currentState?.currentTopic || '这件事';
    const emotion = runtimeContext?.turn?.emotion?.label || '现在的感受';

    if (plan?.mode === 'memory_confirmation') {
      if (memories.length && plan.memoryAnswerability === 'known') {
        const summary = trimTerminalPunctuation(String(memories[0].summary || '').slice(0, 180));
        return `我能确认记得一部分：${summary}。如果你说的是另一件事，可以再给我一点线索。`;
      }
      return '我这次没有找到足够的相关记忆，不想假装自己记得。你愿意的话，可以再告诉我一次。';
    }
    if (plan?.mode === 'empathize_then_clarify') {
      return `听起来你在${topic}上正经历${emotion}，这确实会让人消耗不少。你更想让我先听你说说，还是一起找一个小的下一步？`;
    }
    if (plan?.mode === 'clarify_then_advise') {
      return `我先接住你现在关于${topic}的困惑。可以先把问题缩小成一个今天能完成的小步骤；如果你愿意，我也可以和你一起把这个步骤具体化。`;
    }
    if (plan?.mode === 'warm_greeting') return '我在。今天想从什么事情开始聊？';
    if (plan?.mode === 'acknowledge_and_explore') return `我听到了你关于${topic}的分享，这件事对你来说应该很重要。你现在最想继续展开哪一部分？`;
    if (plan) return `我在听你说的${topic}。你刚才提到“${clipped}”，我们可以从你最在意的地方继续。`;

    // Backward-compatible deterministic fallback for callers that do not yet provide Runtime Context.
    return memories.length
      ? `我记得我们正在建立一段会持续变化的关系。你刚才提到“${clipped}”，我会把它和过去的经历放在一起理解。`
      : `我听见了：“${clipped}”。这是我们共同经历的一个新片段。`;
  };

  const buildMessages = ({ message, recalled = [], runtimeContext = null, messages = null } = {}) => (
    Array.isArray(messages) && messages.length
      ? messages
      : buildCompanionMessages({ message, recalled, runtimeContext })
  );

  const composePrompts = ({ message, recalled = [], runtimeContext = null, messages = null }) => {
    const compiled = buildMessages({ message, recalled, runtimeContext, messages });
    return {
      system: compiled.find(item => item.role === 'system')?.content || '',
      messages: compiled
    };
  };

  if (config.protocol === 'mock') {
    return {
      ...config,
      generate: async ({ message, recalled, runtimeContext } = {}) => generateMock({ message, recalled, runtimeContext }),
      async *stream({ message, recalled = [], runtimeContext = null } = {}) {
        const full = generateMock({ message, recalled, runtimeContext });
        for (const chunk of full.match(/.{1,12}/gu) || [full]) { yield chunk; await sleep(24); }
      }
    };
  }
  if (config.protocol === 'unknown') {
    return { ...config, async generate() { throw new Error(config.error); }, async *stream() { throw new Error(config.error); } };
  }

  const generate = async ({ message, recalled = [], runtimeContext = null, messages: suppliedMessages = null, signal: externalSignal } = {}) => {
    if (!config.ready) throw new Error(config.error);
    const { system, messages } = composePrompts({ message, recalled, runtimeContext, messages: suppliedMessages });
    const linkedAbort = linkAbortSignal(externalSignal);
    const controller = linkedAbort.controller;
    const timeout = setTimeout(() => controller.abort(), Number(process.env.MODEL_TIMEOUT_MS || 30000));
    const signal = controller.signal;
    try {
      let response;
      if (config.protocol === 'openai-compatible') {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, stream: false, temperature: 0.7, messages }), signal
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
          body: JSON.stringify({ model: config.model, max_tokens: 2048, system, messages: messages.filter(item => item.role !== 'system') }), signal
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
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: messages.filter(item => item.role !== 'system').map(item => ({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: item.content }]
          }))
        }), signal
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
    } finally {
      clearTimeout(timeout);
      linkedAbort.dispose();
    }
  };

  const stream = async function* ({ message, recalled = [], runtimeContext = null, messages: suppliedMessages = null, signal: externalSignal } = {}) {
    if (!config.ready) throw new Error(config.error);
    // mock 与 gemini/未知协议回退到一次性生成;openai-compatible 与 anthropic 走真流式。
    if (config.protocol !== 'openai-compatible' && config.protocol !== 'anthropic') {
      yield await generate({ message, recalled, runtimeContext, messages: suppliedMessages, signal: externalSignal });
      return;
    }
    const { system, messages } = composePrompts({ message, recalled, runtimeContext, messages: suppliedMessages });
    const linkedAbort = linkAbortSignal(externalSignal);
    const controller = linkedAbort.controller;
    const timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 30000);
    let timeout = setTimeout(() => controller.abort(), timeoutMs);
    const resetTimeout = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), timeoutMs); };
    const signal = controller.signal;
    try {
      let response;
      if (config.protocol === 'openai-compatible') {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, stream: true, temperature: 0.7, messages }), signal
        });
      } else {
        response = await fetch(config.apiURL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', Accept: 'text/event-stream' },
          body: JSON.stringify({ model: config.model, max_tokens: 2048, system, messages: messages.filter(item => item.role !== 'system'), stream: true }), signal
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
    } finally {
      clearTimeout(timeout);
      linkedAbort.dispose();
    }
  };

  const generateWithTools = async ({ system, messages, tools, signal: externalSignal } = {}) => {
    if (!config.ready) throw new Error(config.error);
    if (config.protocol !== 'openai-compatible') {
      return { content: await generate({ message: messages[messages.length - 1]?.content || '', signal: externalSignal }), toolCalls: [] };
    }
    const linkedAbort = linkAbortSignal(externalSignal);
    const controller = linkedAbort.controller;
    const timeout = setTimeout(() => controller.abort(), Number(process.env.MODEL_TIMEOUT_MS || 30000));
    const signal = controller.signal;
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
    } finally {
      clearTimeout(timeout);
      linkedAbort.dispose();
    }
  };

  const composeSystemPrompt = ({ recalled = [], runtimeContext = null } = {}) => buildCompanionSystemPrompt({ recalled, runtimeContext });

  return { ...config, generate, stream, generateWithTools, composeSystemPrompt };
}
