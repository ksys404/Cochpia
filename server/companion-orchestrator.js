import { analyzeCompanionTurn } from './companion-turn-context.js';
import { buildCompanionResponsePlan } from './companion-response-policy.js';

export function createCompanionOrchestrator({
  collector,
  contextBuilder,
  finalizer,
  turnAnalyzer = analyzeCompanionTurn,
  responsePolicy = buildCompanionResponsePlan
} = {}) {
  if (!collector?.collect) throw new TypeError('Companion Orchestrator requires an Interaction Collector');
  if (!contextBuilder?.build) throw new TypeError('Companion Orchestrator requires a Context Builder');
  if (!finalizer?.finalize) throw new TypeError('Companion Orchestrator requires an Interaction Finalizer');

  const prepareChatTurn = async ({
    request = null,
    context,
    sessionId,
    runId = null,
    attempt = 1,
    userMessage,
    channel = '默认',
    retrieve = async () => ({ bundle: null, recalled: [] }),
    contextInput = {}
  } = {}) => {
    const userEvent = await collector.collect({
      event_id: `chat:${sessionId}:${userMessage.id}`,
      event_type: 'conversation.user_message.created',
      source_type: 'chat',
      source_id: sessionId,
      session_id: sessionId,
      source_revision: String(userMessage.sourceRevision ?? userMessage.source_revision ?? '1'),
      is_final: true,
      event_status: 'final',
      run_id: runId,
      content_type: 'plain_text',
      content: userMessage.content,
      correlation_id: userMessage.id,
      producer: 'chat-adapter',
      attempt,
      structured_data: { message_id: userMessage.id, channel: String(channel || '默认').slice(0, 60) }
    }, { request, context, sourceId: sessionId, sessionId, producer: 'chat-adapter', storageSessionId: sessionId });
    let retrieved = { bundle: null, recalled: [] };
    let retrievalError = null;
    try {
      retrieved = await retrieve(userMessage.content);
    } catch (error) {
      retrievalError = error;
    }
    const turn = turnAnalyzer({
      message: userMessage.content,
      messageId: userMessage.id,
      messages: contextInput.messages,
      summary: contextInput.summary
    });
    let runtimeContext;
    let responsePlan;
    try {
      const preliminaryContext = contextBuilder.build({
        ...contextInput,
        turn,
        memoryBundle: retrieved.bundle,
        recalled: retrieved.recalled
      });
      responsePlan = responsePolicy({
        turn,
        runtimeContext: preliminaryContext,
        memoryBundle: retrieved.bundle
      });
      runtimeContext = contextBuilder.build({
        ...contextInput,
        turn,
        responsePlan,
        memoryBundle: retrieved.bundle,
        recalled: retrieved.recalled
      });
    } catch (error) {
      // Preserve the already-committed user event so the caller can record a
      // content-free failed turn instead of pretending collection never ran.
      error.userEvent = userEvent;
      throw error;
    }
    return { userEvent, retrieved, runtimeContext, turn, responsePlan, retrievalError };
  };

  const finalizeChatTurn = input => finalizer.finalize(input);

  return {
    prepareChatTurn,
    finalizeChatTurn,
    recordFailedChatTurn: input => finalizer.recordFailure(input),
    recordSupersededChatTurn: input => finalizer.recordSuperseded(input),
    buildContext(input = {}) {
      const turn = input.turn || (input.message
        ? turnAnalyzer({
            message: input.message,
            messageId: input.messageId || null,
            messages: input.messages,
            summary: input.summary
          })
        : null);
      const preliminaryContext = contextBuilder.build({ ...input, ...(turn ? { turn } : {}) });
      const responsePlan = input.responsePlan || (turn
        ? responsePolicy({ turn, runtimeContext: preliminaryContext, memoryBundle: input.memoryBundle })
        : null);
      return contextBuilder.build({
        ...input,
        ...(turn ? { turn } : {}),
        ...(responsePlan ? { responsePlan } : {})
      });
    }
  };
}
