import { spawn } from 'node:child_process';

export class PiClientError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'PiClientError'; this.code = code; }
}

// Pi RPC 客户端：spawn `pi --mode rpc`，JSONL over stdio。
// prompt(message, onEvent)：发送提示词，每个事件实时回调，agent_settled 时 resolve。
export function createPiClient({ cwd = process.cwd(), timeoutMs = 10 * 60 * 1000 } = {}) {
  let child = null;
  let buffer = '';

  const start = () => {
    if (child) return child;
    child = spawn('pi', ['--mode', 'rpc', '--no-session'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    child.stderr.on('data', () => { /* pi 的日志不干扰协议 */ });
    child.on('error', () => { child = null; });
    child.on('exit', () => { child = null; });
    return child;
  };

  const prompt = (message, onEvent) => new Promise((resolve, reject) => {
    const proc = start();
    if (!proc || !proc.stdin) { reject(new PiClientError('PI_NOT_AVAILABLE', 'pi 命令不可用，请确认已全局安装 pi')); return; }

    const timer = setTimeout(() => {
      proc.stdout.off('data', dataHandler);
      reject(new PiClientError('PI_TIMEOUT', 'Pi 执行超时'));
    }, timeoutMs);

    const dataHandler = chunk => {
      buffer += chunk.toString();
      while (true) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        let payload;
        try { payload = JSON.parse(line); } catch { continue; }
        if (payload.type === 'response') continue; // 命令回执，忽略
        if (payload.type === 'agent_settled') { clearTimeout(timer); proc.stdout.off('data', dataHandler); resolve(); continue; }
        onEvent(payload);
      }
    };
    proc.stdout.on('data', dataHandler);
    try { proc.stdin.write(JSON.stringify({ type: 'prompt', message }) + '\n'); }
    catch (error) { clearTimeout(timer); proc.stdout.off('data', dataHandler); reject(new PiClientError('PI_WRITE_FAILED', error.message)); }
  });

  return { prompt, close: () => { if (child) { child.kill(); child = null; } } };
}
