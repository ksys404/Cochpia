import test from 'node:test';
import assert from 'node:assert/strict';
import { createPiClient, PI_RPC_SAFE_ARGS } from './pi-client.js';

test('Pi RPC starts with an explicit text-only, no-project-resources policy', () => {
  assert.deepEqual(PI_RPC_SAFE_ARGS, [
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-context-files',
    '--no-prompt-templates',
    '--no-themes',
    '--no-approve'
  ]);
});

test('Pi client passes the safe policy flags to the spawned RPC process', async () => {
  let command = null;
  let args = null;
  let stdoutHandler = null;
  const child = {
    stdin: { write() { setImmediate(() => stdoutHandler?.(Buffer.from('{"type":"agent_settled"}\n'))); } },
    stdout: { on(_event, handler) { stdoutHandler = handler; }, off() {} },
    stderr: { on() {} },
    on() {},
    kill() {}
  };
  const client = createPiClient({ spawnProcess: (spawnCommand, spawnArgs) => {
    command = spawnCommand;
    args = spawnArgs;
    return child;
  } });
  await client.prompt('safe', () => {});
  assert.equal(command, 'pi');
  assert.deepEqual(args, ['--mode', 'rpc', '--no-session', ...PI_RPC_SAFE_ARGS]);
});
