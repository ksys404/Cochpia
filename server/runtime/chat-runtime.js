export function createChatRuntime(deps) {
  const {
    state, saveState, getSession, touchSession, currentUserId, runtimeKey,
    agents, agentAvatar, createModelProvider, resolveModelSelection,
    buildRuntimeContext, findRegenerationTarget, routeMessage,
    recordDynamicAlphaObservation, chatMemoryForRequest, shouldRemember, collectUpcomingEvents,
    maybeCompactConversation, executeTool, findTool, getToolRisk, toOpenAITools,
    innerContinuity,
    wakeEngine,
    createPiClient, agentTasks, taskScheduler, send, fail, activeRuns, streamRuns,
    attachStreamResponse, finishRun, chatRunTimeoutMs, waitForApproval, randomUUID,
    chatPrepareTimeoutMs = Math.max(1_000, Number(process.env.CHAT_PREPARE_TIMEOUT_MS || 30_000)),
    chatTerminationGraceMs = Math.max(500, Number(process.env.CHAT_TERMINATION_GRACE_MS || 5_000))
  } = deps;

  // 准备阶段的看门狗:存储写入 / Memory Module / 唤醒对账都发生在 SSE 建立之前,
  // 既没有超时也没有兜底。上游一旦挂住,客户端会静默悬挂(连响应头都收不到)。
  const armPrepareGuard = res => {
    const guard = { fired: false, passed: false, timer: null };
    guard.timer = setTimeout(() => {
      if (guard.passed || res.headersSent || res.writableEnded || res.destroyed) return;
      guard.fired = true;
      fail(res, 503, 'CHAT_PREPARE_TIMEOUT', 'Preparing this turn timed out before the stream started');
    }, chatPrepareTimeoutMs);
    guard.timer.unref?.();
    // 准备结束。返回 true 表示可以继续,false 表示看门狗已经代为回应过。
    return () => {
      guard.passed = true;
      clearTimeout(guard.timer);
      return !guard.fired;
    };
  };

  // 超时不能只 abort:上游若忽视 abort 信号,SSE 会一直开着。
  // 先标记 cancelled 让在飞循环立刻退出,再挂一个兜底定时器强制收尾。
  const armRunDeadline = (run, res, messageId = null) => {
    run.deadline = setTimeout(() => {
      if (run.finished) return;
      run.timedOut = true;
      run.cancelled = true;
      run.controller.abort();
      run.termination = setTimeout(() => {
        if (run.response && !run.response.writableEnded && !run.response.destroyed) {
          run.cancelNotified = true;
          send(run.response, 'error', { runId: run.id, code: 'CHAT_RUN_TIMEOUT', message: '本轮对话超时,已中断。' }, run);
          send(run.response, 'done', { runId: run.id, ok: false, timedOut: true, messageId }, run);
          run.response.end();
        }
        finishRun(run);
      }, chatTerminationGraceMs);
      run.termination.unref?.();
    }, chatRunTimeoutMs);
  };

  const dispatchAgentTask = async (args, ownerId, res, run) => {
    const target = String(args.target || '').toLowerCase();
    const taskText = String(args.task || '').trim().slice(0, 8000);
    if (!['codex', 'pi', 'claude'].includes(target)) return 'dispatch_task 需要有效的 target（codex / pi / claude）';
    if (!taskText) return 'dispatch_task 需要具体的任务描述（做什么、涉及哪些文件、验收标准）';
    try {
      const task = await agentTasks.create({ target, task: taskText, spec: { goal: taskText, acceptance: [taskText] } }, ownerId);
      taskScheduler.enqueue(task);
      if (res && run) send(res, 'agent_task_dispatched', { taskId: task.id, target, task: taskText }, run);
      return `已把任务派给 ${target}（任务 ID ${task.id}，状态 ${task.status}）。任务会在沙箱中执行。你现在应该结束工具调用，直接告诉用户任务已派发、以及在哪里查看进度。`;
    } catch (error) {
      return `派发任务失败：${error.message}`;
    }
  };

  const innerStateTool = {
    name: 'update_inner_state',
    sideEffect: 'write',
    risk: 'write',
    requiresApproval: false,
    description: '留下或结束一条只属于自己的感受或念头；默认不写，只有明确决定时调用。',
    parameters: { type: 'object', properties: { patch: { type: 'object', properties: {
      upsert: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', description: '给这条状态起个简短名字（如 joy、想念），同名会更新同一条' }, kind: { type: 'string', description: 'affective（情绪/感受）或 motivational（欲望/念头）' }, direction: { type: 'string', description: 'increase / decrease / hold / uncertain' }, level: { type: 'number' }, limit: { type: 'number' }, positive: { type: 'number' }, negative: { type: 'number' }, arousal: { type: 'number' }, returnPull: { type: 'number' }, strength: { type: 'number' }, readiness: { type: 'number' }, inhibition: { type: 'number' }, endorsement: { type: 'number' }, certainty: { type: 'number' } } } },
      release: { type: 'array', items: { type: 'string' } }
    } } }, required: ['patch'] }
  };

  const findChatTool = name => name === innerStateTool.name ? innerStateTool : findTool(name);
  const chatTools = () => [...toOpenAITools(), { name: innerStateTool.name, description: innerStateTool.description, parameters: innerStateTool.parameters, sideEffect: innerStateTool.sideEffect, risk: innerStateTool.risk, requiresApproval: false }];
  const executeChatTool = (name, args, res, run, agentId) => name === 'dispatch_task'
    ? dispatchAgentTask(args, currentUserId(), res, run)
    : name === innerStateTool.name
      ? (agentId
        ? innerContinuity.applyPatch(agentId, args?.patch || {}).then(snap => `已更新内在状态：当前 ${snap.items.length} 条`)
        : '当前对话没有绑定 Agent，无法留下内在状态。')
      : executeTool(name, args);

  async function runModelWithTools({ model, system, messages, res, run, sessionId, agentId }) {
    if (typeof model.generateWithTools !== 'function' || typeof model.composeSystemPrompt !== 'function') return null;
    const conversation = [...messages];
    let finalContent = '';
    let lastToolSignature = '';
    let repeatedToolCalls = 0;
    for (let step = 0; step < 12; step += 1) {
      if (run.cancelled) return { cancelled: true };
      const result = await model.generateWithTools({ system, messages: conversation, tools: chatTools(), signal: run.controller.signal });
      if (!result.toolCalls.length) { finalContent = result.content || ''; break; }
      conversation.push({ role: 'assistant', content: result.content || '', tool_calls: result.toolCalls });
      for (const toolCall of result.toolCalls) {
        const name = toolCall.function?.name || '';
        let args = {};
        try { args = JSON.parse(toolCall.function?.arguments || '{}'); } catch { args = {}; }
        const toolSignature = `${name}:${JSON.stringify(args)}`;
        repeatedToolCalls = toolSignature === lastToolSignature ? repeatedToolCalls + 1 : 0;
        lastToolSignature = toolSignature;
        if (repeatedToolCalls >= 2) return { content: '', termination: 'TOOL_LOOP_REPEATED', toolName: name };
        const tool = findChatTool(name);
        const risk = name === innerStateTool.name ? innerStateTool.risk : getToolRisk(name, args);
        send(res, 'tool', { runId: run.id, name, args }, run);
        let toolResult;
        if (tool?.requiresApproval) {
          send(res, 'tool_pending', { runId: run.id, toolCallId: toolCall.id, name, args, risk }, run);
          const approval = await waitForApproval(run.id, toolCall.id, { risk, sessionId });
          toolResult = approval.approved
            ? await executeChatTool(name, args, res, run, agentId)
            : approval.decision === 'interrupt'
              ? `用户打断了这次操作，补充意见：${approval.feedback || '请先补充上下文'}。请根据意见调整后重试。`
              : '用户拒绝了这次操作。';
        } else {
          toolResult = await executeChatTool(name, args, res, run, agentId);
        }
        const safeResult = String(toolResult).slice(0, 8000);
        send(res, 'tool_result', { runId: run.id, name, result: safeResult.slice(0, 4000) }, run);
        conversation.push({ role: 'tool', tool_call_id: toolCall.id, content: safeResult });
      }
    }
    return { content: finalContent, termination: finalContent ? null : 'TOOL_LOOP_LIMIT' };
  }

  const toolTerminationMessage = termination => ({
    TOOL_LOOP_REPEATED: '工具调用出现重复，我先暂停在这里。请补充更具体的目标后再继续。',
    TOOL_LOOP_LIMIT: '工具调用已达到本轮上限，我先暂停在这里。请补充更具体的目标后再继续。',
    TOOL_NO_FINAL_RESPONSE: '工具已执行，但模型没有生成最终回复。'
  }[termination] || '工具调用未完成。');

  const detectModeSwitch = text => {
    const t = String(text || '').trim();
    const wantsWork = /(切换到|进入|开启|切到|回到|切换).{0,4}工作模式/.test(t) || t === '工作模式'
      || /^(帮我|请|麻烦).{0,8}(修复|改代码|写代码|开发|实现|部署|重构|检查|优化|跑测试|写测试)/.test(t);
    const wantsCompanion = /(切换到|进入|开启|切到|回到|切换).{0,4}陪伴模式/.test(t) || t === '陪伴模式';
    if (wantsWork) return 'work';
    if (wantsCompanion) return 'companion';
    return null;
  };

  async function runPiWorkMode({ res, run, userMessage, assistantMessage, sessionId, mode = 'work' }) {
    const pi = createPiClient({ cwd: process.cwd() });
    let fullText = '';
    await pi.prompt(userMessage.content, event => {
      if (run.cancelled) return;
      if (event.type === 'message_update') {
        const e = event.assistantMessageEvent;
        if (e?.type === 'text_delta') { fullText += e.delta; send(res, 'text', { delta: e.delta }, run); }
      } else if (event.type === 'tool_execution_start') {
        send(res, 'tool', { runId: run.id, name: event.toolName, args: event.args }, run);
      } else if (event.type === 'tool_execution_end') {
        const text = (event.result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('') || '';
        send(res, 'tool_result', { runId: run.id, name: event.toolName, result: text.slice(0, 4000) }, run);
      }
    });
    assistantMessage.content = fullText || '（Pi 未返回内容）';
    state.messages[sessionId].push(assistantMessage);
    touchSession(getSession(sessionId));
    await saveState(state);
    return true;
  }

  async function finalizeMemoryModule({ chatMemory, userEvent, userMessage, assistantMessage, sessionId, channel, agentId = null }) {
    let memoryId = null;
    try {
      await chatMemory.recordTurn({ eventId: `chat:${sessionId}:${assistantMessage.id}`, content: assistantMessage.content, eventRole: 'agent', channel, sourceAgentId: agentId });
      if (shouldRemember(userMessage.content)) {
        const remembered = await chatMemory.remember({ messageId: userMessage.id, content: userMessage.content, sourceEventId: userEvent?.rawEventId || null });
        memoryId = remembered?.memory?.memoryId || remembered?.memory?.id || null;
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'memory_chat_write_failed', code: error.code || 'MEMORY_MODULE_WRITE_FAILED' }));
    }
    return memoryId;
  }

  async function handleChatStream(req, res, { regenerateMessageId = null, retry = false } = {}) {
    const { sessionId, message, provider, model: requestedModel, channel, companionIntent } = req.body || {};
    const activeChannel = String(channel || '默认').slice(0, 60);
    const validCompanionIntents = new Set(['listen', 'comfort', 'advice', 'accompany', 'quiet']);
    if (!sessionId || (!regenerateMessageId && !String(message || '').trim())) return res.status(400).json({ error: 'sessionId and message are required' });
    if (!getSession(sessionId)) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    if (!state.messages[sessionId]) state.messages[sessionId] = [];
    const regeneration = regenerateMessageId ? findRegenerationTarget(state.messages[sessionId], regenerateMessageId) : null;
    if (regenerateMessageId && !regeneration) return fail(res, 404, 'REGENERATE_TARGET_NOT_FOUND', 'Assistant message with a preceding user message was not found');
    const userMessage = regeneration?.user || { id: randomUUID(), role: 'user', content: String(message).trim().slice(0, 8000), createdAt: new Date().toISOString(), channel: activeChannel };
    const session = getSession(sessionId);
    const proceed = armPrepareGuard(res);
    await wakeEngine?.reconcileAll?.();
    // 私聊绑定到某个 Agent 时，用该 Agent 的人格与模型覆盖会话默认（群聊走 /api/chat/group，不受此影响）。
    const boundAgent = session?.agentId ? agents.get(session.agentId) : null;
    if (session?.kind === 'private' && session.agentId && !boundAgent) return fail(res, 409, 'AGENT_NOT_FOUND', 'This private session is bound to an agent that no longer exists');
    const effectivePersona = boundAgent?.persona || session.persona || '';
    // Agent 绑定时优先用 agent 的模型；否则回退前端请求/会话默认。
    const effectiveProvider = boundAgent?.provider || provider || session.modelProvider || process.env.MODEL_PROVIDER || 'mock';
    const effectiveModel = boundAgent?.model || requestedModel || session.modelName || '';
    const currentMode = () => session.mode || state.mode || 'companion';
    const activeCompanionIntent = validCompanionIntents.has(companionIntent) ? companionIntent : (session.companionIntent || 'listen');
    if (currentMode() === 'companion' && validCompanionIntents.has(companionIntent) && session.companionIntent !== companionIntent) {
      session.companionIntent = companionIntent;
      touchSession(session);
    }
    const hasRequestSelection = !boundAgent && Boolean(provider || requestedModel);
    const requestedProvider = effectiveProvider;
    const requestedName = effectiveModel;
    const selection = resolveModelSelection(requestedProvider, requestedName);
    if (!selection.ok) return fail(res, selection.code === 'MODEL_NOT_CONFIGURED' ? 503 : 400, selection.code, selection.error);
    const selectedModel = createModelProvider(requestedProvider, { model: selection.config.model });
    const previousMessage = state.messages[sessionId].at(-1);
    const routing = routeMessage({ userInput: userMessage.content, timestamp: userMessage.createdAt, lastLogTimestamp: previousMessage?.createdAt || userMessage.createdAt });
    const routingMode = currentMode() === 'work' ? 'work' : 'love';
    recordDynamicAlphaObservation({ sessionId, mode: routingMode, routing, modelProvider: selectedModel.provider, modelName: selectedModel.model });
    if (hasRequestSelection) { session.modelProvider = selection.config.provider; session.modelName = selection.config.model; touchSession(session); }
    if (!regeneration) {
      state.messages[sessionId].push(userMessage);
      try { await saveState(state); } catch (error) { state.messages[sessionId].pop(); return fail(res, 503, error.code || 'STORAGE_WRITE_FAILED', error.message); }
    }
    const chatMemory = chatMemoryForRequest(req);
    let recalled = [];
    let memoryBundle = null;
    let userEvent = null;
    try {
      userEvent = await chatMemory.recordTurn({ eventId: `chat:${sessionId}:${userMessage.id}`, content: userMessage.content, eventRole: 'user', channel: activeChannel, sourceAgentId: boundAgent?.id || null });
      const retrieved = await chatMemory.retrieve(userMessage.content, boundAgent?.id || null);
      recalled = retrieved.recalled;
      memoryBundle = retrieved.bundle;
    } catch (error) { console.error(JSON.stringify({ event: 'memory_chat_retrieve_failed', code: error.code || 'MEMORY_MODULE_RETRIEVE_FAILED' })); }
    const assistantMessage = { id: randomUUID(), role: 'assistant', content: '', createdAt: new Date().toISOString(), regeneratedFrom: regeneration?.assistant.id || null, channel: activeChannel, ...(boundAgent ? { senderId: boundAgent.id, senderName: boundAgent.name, senderAvatar: agentAvatar(boundAgent), ...(boundAgent.avatarImage ? { senderAvatarImage: boundAgent.avatarImage } : {}) } : {}) };
    if (regeneration) { regeneration.assistant.supersededAt = new Date().toISOString(); regeneration.assistant.supersededBy = assistantMessage.id; }
    const restoreRegeneration = () => { if (regeneration) { delete regeneration.assistant.supersededAt; delete regeneration.assistant.supersededBy; } };
    const runKey = runtimeKey(sessionId);
    if (activeRuns.has(runKey)) return fail(res, 409, 'CHAT_ALREADY_RUNNING', 'A chat run is already active for this session');
    if (!proceed()) return;
    const run = { id: randomUUID(), key: runKey, userId: currentUserId(), sessionId, controller: new AbortController(), cancelled: false, finished: false, timedOut: false, sequence: 0, events: [], response: null, connected: false };
    activeRuns.set(runKey, run); streamRuns.set(run.id, run); attachStreamResponse(run, res);
    armRunDeadline(run, res, assistantMessage.id);
    send(res, 'meta', { runId: run.id, messageId: assistantMessage.id, recalled: recalled.length, protocol: 'cochpia.sse.v1', provider: selectedModel.provider, model: selectedModel.model, regeneratedFrom: regeneration?.assistant.id || null, retry, dynamicAlpha: { scores: routing.scores, alphaWork: routing.alphaWork, alphaLove: routing.alphaLove, decision: routing.decision, placement: routing.placements?.[routingMode] || null, isAnchor: routing.isAnchor } }, run);
    let summary = session.summary || '';
    try { const compact = await maybeCompactConversation(session, state.messages[sessionId], selectedModel); summary = compact.summary; if (compact.changed) await saveState(state); }
    catch (error) { console.error(JSON.stringify({ event: 'compaction_failed', code: error.code || 'COMPACTION_FAILED' })); }
    const switchTo = detectModeSwitch(userMessage.content);
    if (switchTo && switchTo !== currentMode()) {
      session.mode = switchTo; touchSession(session); await saveState(state);
      assistantMessage.content = switchTo === 'work' ? '已切换到「工作模式」。现在我会以任务为导向，帮你执行具体任务。需要切回时，说「切换到陪伴模式」即可。' : '已切回「陪伴模式」。我会继续像平常一样陪着你。需要工作时，说「切换到工作模式」即可。';
      state.messages[sessionId].push(assistantMessage); touchSession(getSession(sessionId)); send(res, 'text', { delta: assistantMessage.content }, run); send(res, 'done', { runId: run.id, messageId: assistantMessage.id, mode: currentMode(), provider: selectedModel.provider, model: selectedModel.model }, run); finishRun(run); if (run.response) run.response.end(); return;
    }
    if (currentMode() === 'work') {
      // 工作模式：优先让 LLM 直接调用工具（读/写/执行/派发），走统一审批流；模型/供应商不支持工具时才回退 pi RPC。
      try {
        const workProviderName = process.env.WORK_MODEL_PROVIDER || requestedProvider;
        const workModelName = process.env.WORK_MODEL_NAME || selection.config.model;
        const workModel = (workProviderName === requestedProvider && workModelName === selection.config.model) ? selectedModel : createModelProvider(workProviderName, { model: workModelName });
        const workRuntime = buildRuntimeContext({ messages: state.messages[sessionId], recalled, memoryBundle, summary, persona: effectivePersona, profile: { ...state.profile, name: boundAgent?.name || '独立 Agent' }, mode: currentMode(), companionIntent: activeCompanionIntent, innerState: boundAgent ? innerContinuity.snapshot(boundAgent.id) : null, dynamicRouting: { ...routing, placement: routing.placements?.work } });
        const toolResult = await runModelWithTools({ model: workModel, system: workModel.composeSystemPrompt?.({ recalled, runtimeContext: workRuntime }), messages: state.messages[sessionId].slice(0, -1).slice(-10).map(item => ({ role: item.role, content: item.content })).concat({ role: 'user', content: userMessage.content }), res, run, sessionId, agentId: boundAgent?.id });
        if (toolResult?.cancelled) { restoreRegeneration(); finishRun(run); return; }
        if (toolResult) {
          assistantMessage.content = toolResult.content || (toolResult.termination ? toolTerminationMessage(toolResult.termination) : '');
          if (toolResult.termination) send(res, 'error', { runId: run.id, code: toolResult.termination, message: assistantMessage.content }, run);
          state.messages[sessionId].push(assistantMessage); touchSession(getSession(sessionId));
          const memoryId = await finalizeMemoryModule({ chatMemory, userEvent, userMessage, assistantMessage, sessionId, channel: activeChannel, agentId: boundAgent?.id || null });
          await saveState(state);
          await wakeEngine?.kick(boundAgent?.id);
          send(res, 'text', { delta: assistantMessage.content }, run);
          send(res, 'done', { runId: run.id, messageId: assistantMessage.id, memoryId, mode: currentMode(), provider: selectedModel.provider, model: selectedModel.model }, run); finishRun(run); if (run.response) run.response.end(); return;
        }
      } catch (error) { console.error(JSON.stringify({ event: 'work_tool_loop_failed', error: error.code || error.message })); }
      // 回退 1：模型/供应商不支持工具调用时，用 pi RPC 子进程执行。
      try {
        if (await runPiWorkMode({ res, run, userMessage, assistantMessage, sessionId, mode: currentMode() })) {
          const memoryId = await finalizeMemoryModule({ chatMemory, userEvent, userMessage, assistantMessage, sessionId, channel: activeChannel, agentId: boundAgent?.id || null });
          await wakeEngine?.kick(boundAgent?.id);
          send(res, 'done', { runId: run.id, messageId: assistantMessage.id, memoryId, engine: 'pi', mode: currentMode() }, run); finishRun(run); if (run.response) run.response.end(); return;
        }
      } catch (error) { console.error(JSON.stringify({ event: 'pi_rpc_unavailable', error: error.code || error.message })); }
      // 回退 2：普通流式回复。
      try {
        const workProviderName = process.env.WORK_MODEL_PROVIDER || requestedProvider;
        const workModelName = process.env.WORK_MODEL_NAME || selection.config.model;
        const workModel = (workProviderName === requestedProvider && workModelName === selection.config.model) ? selectedModel : createModelProvider(workProviderName, { model: workModelName });
        const workRuntime = buildRuntimeContext({ messages: state.messages[sessionId], recalled, memoryBundle, summary, persona: effectivePersona, profile: { ...state.profile, name: boundAgent?.name || '独立 Agent' }, mode: currentMode(), companionIntent: activeCompanionIntent, innerState: boundAgent ? innerContinuity.snapshot(boundAgent.id) : null, dynamicRouting: { ...routing, placement: routing.placements?.work } });
        for await (const delta of workModel.stream({ message: userMessage.content, recalled, runtimeContext: workRuntime, signal: run.controller.signal })) { if (run.cancelled) { restoreRegeneration(); finishRun(run); return; } assistantMessage.content += delta; send(res, 'text', { delta }, run); }
        state.messages[sessionId].push(assistantMessage); touchSession(getSession(sessionId));
        const memoryId = await finalizeMemoryModule({ chatMemory, userEvent, userMessage, assistantMessage, sessionId, channel: activeChannel, agentId: boundAgent?.id || null });
        await saveState(state);
        await wakeEngine?.kick(boundAgent?.id);
        send(res, 'done', { runId: run.id, messageId: assistantMessage.id, memoryId, mode: currentMode(), provider: selectedModel.provider, model: selectedModel.model }, run); finishRun(run); if (run.response) run.response.end();
      } catch (error) { send(res, 'error', { code: error.code || 'WORK_MODE_FAILED', message: error.message }, run); send(res, 'done', { ok: false, messageId: assistantMessage.id, runId: run.id }, run); restoreRegeneration(); finishRun(run); if (run.response) run.response.end(); }
      return;
    }
    try {
      const runtimeContext = buildRuntimeContext({ messages: state.messages[sessionId], recalled, memoryBundle, summary, persona: effectivePersona, profile: { ...state.profile, name: boundAgent?.name || '独立 Agent' }, mode: currentMode(), companionIntent: activeCompanionIntent, innerState: boundAgent ? innerContinuity.snapshot(boundAgent.id) : null, dynamicRouting: { ...routing, placement: routing.placements?.[routingMode] } });
      const toolResult = await runModelWithTools({ model: selectedModel, system: selectedModel.composeSystemPrompt?.({ recalled, runtimeContext }), messages: state.messages[sessionId].slice(0, -1).slice(-10).map(item => ({ role: item.role, content: item.content })).concat({ role: 'user', content: userMessage.content }), res, run, agentId: boundAgent?.id });
      if (toolResult?.cancelled) { restoreRegeneration(); finishRun(run); return; }
      if (toolResult) { assistantMessage.content = toolResult.content || (toolResult.termination ? toolTerminationMessage(toolResult.termination) : ''); if (toolResult.termination) send(res, 'error', { runId: run.id, code: toolResult.termination, message: assistantMessage.content }, run); send(res, 'text', { delta: assistantMessage.content }, run); }
      else for await (const delta of selectedModel.stream({ message: userMessage.content, recalled, runtimeContext, signal: run.controller.signal })) { if (run.cancelled) { restoreRegeneration(); finishRun(run); return; } assistantMessage.content += delta; send(res, 'text', { delta }, run); }
    } catch (error) { if (!run.cancelNotified) { send(res, 'error', { code: error.code || 'MODEL_UNAVAILABLE', message: error.message }, run); send(res, 'done', { ok: false, messageId: assistantMessage.id, runId: run.id }, run); if (run.response) run.response.end(); } restoreRegeneration(); finishRun(run); return; }
    if (run.cancelled) { restoreRegeneration(); finishRun(run); return; }
    let heldMemoryId = null;
    try { state.messages[sessionId].push(assistantMessage); touchSession(getSession(sessionId)); heldMemoryId = await finalizeMemoryModule({ chatMemory, userEvent, userMessage, assistantMessage, sessionId, channel: activeChannel, agentId: boundAgent?.id || null }); await saveState(state); }
    catch (error) { send(res, 'error', { code: 'FINALIZE_FAILED', message: error.message }, run); send(res, 'done', { ok: false, messageId: assistantMessage.id, runId: run.id }, run); restoreRegeneration(); finishRun(run); if (run.response) return run.response.end(); return; }
    await wakeEngine?.kick(boundAgent?.id);
    send(res, 'done', { runId: run.id, messageId: assistantMessage.id, memoryId: heldMemoryId, provider: selectedModel.provider, model: selectedModel.model, regeneratedFrom: regeneration?.assistant.id || null, retry }, run); finishRun(run); if (run.response) run.response.end();
  }

  async function handleGroupChat(req, res) {
    const { sessionId, message, channel } = req.body || {};
    if (!sessionId || !String(message || '').trim()) return fail(res, 400, 'INVALID_REQUEST', 'sessionId and message are required');
    const session = getSession(sessionId);
    const proceed = armPrepareGuard(res);
    await wakeEngine?.reconcileAll?.();
    if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', 'Session not found');
    const runKey = runtimeKey(sessionId);
    if (activeRuns.has(runKey)) return fail(res, 409, 'CHAT_ALREADY_RUNNING', 'A chat run is already active for this session');
    const activeChannel = String(channel || '默认').slice(0, 60);
    if (!state.messages[sessionId]) state.messages[sessionId] = [];
    const groupLimit = Math.max(1, Number(process.env.GROUP_AGENT_LIMIT) || 6);
    const agentIds = (Array.isArray(session.agentIds) ? session.agentIds : []).slice(0, groupLimit);
    const userMessage = { id: randomUUID(), role: 'user', content: String(message).trim().slice(0, 8000), createdAt: new Date().toISOString(), channel: activeChannel };
    state.messages[sessionId].push(userMessage); await saveState(state);
    const chatMemory = chatMemoryForRequest(req); let recalled = []; let memoryBundle = null;
    try { await chatMemory.recordTurn({ eventId: `chat:group:${sessionId}:${userMessage.id}`, content: userMessage.content, eventRole: 'user', channel: activeChannel }); const retrieved = await chatMemory.retrieve(userMessage.content); recalled = retrieved.recalled; memoryBundle = retrieved.bundle; }
    catch (error) { console.error(JSON.stringify({ event: 'group_memory_retrieve_failed', code: error.code || 'MEMORY_MODULE_RETRIEVE_FAILED' })); }
    if (!proceed()) return;
    const run = { id: randomUUID(), key: runKey, userId: currentUserId(), sessionId, controller: new AbortController(), cancelled: false, finished: false, timedOut: false, sequence: 0, events: [], response: null, connected: false };
    activeRuns.set(runKey, run); streamRuns.set(run.id, run); attachStreamResponse(run, res); armRunDeadline(run, res); send(res, 'meta', { runId: run.id, sessionId, agents: agentIds, protocol: 'cochpia.group.sse.v1' }, run);
    const generateAgentReply = async (agent, priorReplies = []) => {
      const reply = { id: randomUUID(), role: 'assistant', content: '', createdAt: new Date().toISOString(), channel: activeChannel, senderId: agent.id, senderName: agent.name, senderAvatar: agentAvatar(agent), ...(agent.avatarImage ? { senderAvatarImage: agent.avatarImage } : {}) };
      send(res, 'agent_start', { agentId: agent.id, senderName: agent.name, messageId: reply.id }, run);
      try {
        const provider = agent.provider || session.modelProvider || process.env.MODEL_PROVIDER || 'mock'; const modelName = agent.model || session.modelName || ''; const selection = resolveModelSelection(provider, modelName); let model;
        if (selection.ok) model = createModelProvider(provider, { model: selection.config.model }); else { const fallbackProvider = session.modelProvider || process.env.MODEL_PROVIDER || 'mock'; const fallbackSelection = resolveModelSelection(fallbackProvider, session.modelName || ''); model = fallbackSelection.ok ? createModelProvider(fallbackProvider, { model: fallbackSelection.config.model }) : createModelProvider('mock'); }
        const contextMessages = [...state.messages[sessionId], ...priorReplies.map(item => ({ id: item.id, role: item.role, content: `${item.senderName || 'Agent'}：${item.content}`, createdAt: item.createdAt }))]; let full = '';
        for await (const delta of model.stream({ message: String(message), recalled, runtimeContext: buildRuntimeContext({ messages: contextMessages, recalled, memoryBundle, persona: agent.persona || session.persona, profile: { ...state.profile, name: agent.name }, innerState: innerContinuity.snapshot(agent.id), groupContext: { ...groupContext, currentAgent: agent.name } }), signal: run.controller.signal })) { if (run.cancelled) break; full += delta; send(res, 'text', { agentId: agent.id, delta, messageId: reply.id }, run); }
        reply.content = String(full || '').trim(); if (!reply.content) throw new Error('Agent returned empty reply'); send(res, 'agent_done', { agentId: agent.id, messageId: reply.id, content: reply.content }, run); return reply;
      } catch (error) { const fallback = `（${agent.name} 暂时无法回应）`; reply.content = fallback; send(res, 'agent_error', { agentId: agent.id, senderName: agent.name, messageId: reply.id, error: error?.message || 'Generation failed' }, run); send(res, 'text', { agentId: agent.id, delta: fallback, messageId: reply.id }, run); send(res, 'agent_done', { agentId: agent.id, messageId: reply.id, content: fallback }, run); return reply; }
    };
    const members = agentIds.map(id => agents.get(id)).filter(Boolean);
    const groupContext = { name: session.title || '群聊', description: session.description || '', members: [...members.map(agent => agent.name), '用户'] };
    let replies;
    if (session.groupMode === 'turn') { const turnReplies = []; for (const agent of members) { if (run.cancelled) break; const reply = await generateAgentReply(agent, turnReplies); if (reply) turnReplies.push(reply); } replies = turnReplies; }
    else { const settled = await Promise.allSettled(members.map(agent => generateAgentReply(agent))); replies = settled.filter(item => item.status === 'fulfilled' && item.value).map(item => item.value); }
    for (const reply of replies) state.messages[sessionId].push(reply); touchSession(session);
    for (const reply of replies) await wakeEngine?.kick(reply.senderId);
    try { await saveState(state); } catch (error) { console.error(JSON.stringify({ event: 'group_save_failed', code: error.code || 'STORAGE_WRITE_FAILED' })); }
    for (const reply of replies) { try { await chatMemory.recordTurn({ eventId: `chat:group:${sessionId}:${reply.id}`, content: reply.content, eventRole: 'agent', channel: activeChannel, sourceLabel: reply.senderName || 'Agent', sourceAgentId: reply.senderId || null }); } catch (error) { console.error(JSON.stringify({ event: 'group_memory_record_failed', agentId: reply.senderId, code: error.code || 'MEMORY_MODULE_WRITE_FAILED' })); } }
    send(res, 'done', { runId: run.id, sessionId, messages: replies }, run); finishRun(run); if (run.response && !run.response.writableEnded) run.response.end();
  }

  return { handleChatStream, handleGroupChat };
}
