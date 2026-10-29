import { Worker } from 'node:worker_threads';
import { fetchWASIFS } from '@runno/sandbox';

const runtime = new URL('./langs/', import.meta.resolve('@runno/sandbox'));
let baseFiles;
const wrapper = `import json, sys, io, contextlib
class Quiet:
    def write(self, text): return len(text)
    def flush(self): pass
namespace = {}
try:
    with contextlib.redirect_stdout(Quiet()), contextlib.redirect_stderr(Quiet()):
        exec(open('/submission.py').read(), namespace)
    move_fn = namespace.get('get_next_move', namespace.get('getNextMove'))
    if not callable(move_fn): raise ValueError('Bot must define get_next_move')
    print(json.dumps({'ready': True}), flush=True)
except BaseException:
    print(json.dumps({'error': 'Cannot load Python bot'}), flush=True)
    sys.exit(1)
for line in sys.stdin:
    try:
        request = json.loads(line)
        with contextlib.redirect_stdout(Quiet()), contextlib.redirect_stderr(Quiet()):
            move = move_fn(request['player'], request['state'])
        print(json.dumps({'move': move}), flush=True)
    except BaseException:
        print(json.dumps({'error': 'Python bot execution failed'}), flush=True)
`;

// Only a WASI virtual filesystem is exposed: no host files, credentials or network.
export async function preparePythonRuntime() {
  baseFiles ||= fetchWASIFS(new URL('python-3.11.3.tar.gz', runtime).href);
  return baseFiles;
}

export async function createPythonBot(code, { moveTimeoutMs = 2000, bootTimeoutMs = 15000 } = {}) {
  const files = await preparePythonRuntime();
  const stdin = new SharedArrayBuffer(128 * 1024);
  const view = new DataView(stdin);
  const worker = new Worker(new URL(import.meta.resolve('@runno/sandbox/worker')), {
    resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 },
    execArgv: [],
  });
  let pending, buffer = '', closed = false;
  const fail = (error) => {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
  };
  const wait = (ms) => new Promise((resolve, reject) => {
    pending = { resolve, reject, timer: setTimeout(() => {
      fail(new Error('Bot exceeded its time limit'));
      closed = true;
      void worker.terminate();
    }, ms) };
  });
  worker.on('error', error => { closed = true; fail(error); });
  worker.on('exit', () => { closed = true; fail(new Error('Bot sandbox stopped')); });
  worker.on('message', message => {
    if (message.type === 'stdout') {
      buffer += message.text;
      if (buffer.length > 65536) {
        fail(new Error('Bot output exceeded its limit')); closed = true; void worker.terminate(); return;
      }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!pending) continue;
        try {
          const packet = JSON.parse(line);
          const current = pending; pending = null; clearTimeout(current.timer);
          if (packet.error) current.reject(new Error(packet.error)); else current.resolve(packet);
        } catch { fail(new Error('Bot returned invalid JSON')); }
      }
    } else if (message.type === 'crash' || message.type === 'result') {
      closed = true; fail(new Error('Bot sandbox exited')); void worker.terminate();
    }
  });
  const file = content => ({ path: '', content, mode: 'string', timestamps: {
    access: new Date(), change: new Date(), modification: new Date(),
  } });
  const ready = wait(bootTimeoutMs);
  worker.postMessage({ type: 'start', binaryURL: new URL('python-3.11.3.wasm', runtime).href,
    stdinBuffer: stdin, args: ['python', '-u', '/runner.py'], env: {},
    fs: { ...files, '/runner.py': file(wrapper), '/submission.py': file(code) },
  });
  try { await ready; } catch (error) { closed = true; await worker.terminate(); throw error; }
  return {
    async move(player, state) {
      if (closed) throw new Error('Bot sandbox is closed');
      const input = new TextEncoder().encode(JSON.stringify({ player, state }) + '\n');
      if (input.length > stdin.byteLength - 4 || view.getInt32(0) !== 0) throw new Error('Invalid sandbox input');
      const response = wait(moveTimeoutMs);
      new Uint8Array(stdin, 4, input.length).set(input);
      view.setInt32(0, input.length);
      Atomics.notify(new Int32Array(stdin), 0);
      return (await response).move;
    },
    async close() { closed = true; fail(new Error('Bot sandbox closed')); await worker.terminate(); },
  };
}
