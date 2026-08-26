import { timingSafeEqual } from 'node:crypto';

export const MCP_WRITE_TOOL_NAMES = Object.freeze(new Set(['hold', 'grow']));

function tokenMatches(provided, expected) {
  const left = Buffer.from(String(provided || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}

export function assertMcpWriteAuthorized({ name, providedToken, expectedToken = process.env.MCP_WRITE_SERVICE_TOKEN } = {}) {
  const toolName = String(name || '').trim();
  if (!MCP_WRITE_TOOL_NAMES.has(toolName)) return { write: false, authorized: true };
  if (!String(expectedToken || '').trim()) {
    throw Object.assign(new Error('MCP write boundary is not configured'), { code: 'MCP_WRITE_BOUNDARY_NOT_CONFIGURED', status: 503 });
  }
  if (!tokenMatches(providedToken, expectedToken)) {
    throw Object.assign(new Error('MCP write tool requires service authentication'), { code: 'MCP_WRITE_SERVICE_AUTH_REQUIRED', status: 403 });
  }
  return { write: true, authorized: true };
}
