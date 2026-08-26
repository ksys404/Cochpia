import { randomUUID } from 'node:crypto';

function header(request, name) {
  if (typeof request?.get === 'function') return request.get(name) || '';
  const headers = request?.headers || {};
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] || '' : '';
}

export function createMemoryWriteIngress({ collector, producer = 'mcp-adapter', sourcePrefix = 'mcp' } = {}) {
  if (!collector?.collect) throw new TypeError('Memory write ingress requires an Interaction Collector');

  return ({ request, id, name, args = {} } = {}) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const requestedKey = input.idempotency_key
      || input.idempotencyKey
      || header(request, 'Idempotency-Key')
      || `rpc-${id ?? request?.requestId ?? randomUUID()}`;
    const sourceId = `${sourcePrefix}:${name}`;
    const commandId = `${sourcePrefix}:${name}:${requestedKey}`;
    return collector.collect({
      event_id: commandId,
      event_type: 'memory.write.requested',
      source_type: 'external',
      source_id: sourceId,
      is_final: true,
      event_status: 'final',
      content_type: 'structured',
      content: `${sourcePrefix} memory write request: ${name}`,
      structured_data: {
        tool: name,
        request_id: request?.requestId || null,
        rpc_id: id == null ? null : String(id)
      },
      privacy_directive: input.storage_directive === 'do_not_store' ? 'do_not_store' : 'default',
      idempotency_key: `${sourcePrefix}-memory-write:${name}:${requestedKey}`,
      correlation_id: commandId,
      producer
    }, { request });
  };
}

export function createMcpWriteIngress(options = {}) {
  return createMemoryWriteIngress({ ...options, producer: 'mcp-adapter', sourcePrefix: 'mcp' });
}
