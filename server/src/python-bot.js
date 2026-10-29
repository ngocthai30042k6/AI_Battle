import { acquirePythonWorker, discardPythonWorker, releasePythonWorker } from './python-worker-pool.js';
import { readFile } from 'node:fs/promises';
import { fetchWASIFS } from '@runno/sandbox';

const runtime = new URL('./langs/', import.meta.resolve('@runno/sandbox'));
let baseFiles;
let compiledPython;
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
  compiledPython ||= readFile(new URL('python-3.11.3.wasm', runtime)).then(bytes => WebAssembly.compile(bytes));
  const module = await compiledPython;
  const stdin = new SharedArrayBuffer(128 * 1024);
  const view = new DataView(stdin);
  const worker = acquirePythonWorker();
  let pending, buffer = '', closed = false, closePromise, finishClose;
  const fail = (error) => {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
  };
  const wait = (ms) => new Promise((resolve, reject) => {
    pending = { resolve, reject, timer: setTimeout(() => {
      fail(new Error('Bot exceeded its time limit'));
      closed = true;
      void discardPythonWorker(worker);
    }, ms) };
  });
  const onError = error => { closed = true; fail(error); if(finishClose) finishClose(false); };
  const onExit = () => onError(new Error('Bot sandbox stopped'));
  const onMessage = message => {
    if (message.type === 'stdout') {
      buffer += message.text;
      if (buffer.length > 65536) {
        fail(new Error('Bot output exceeded its limit')); closed = true; void discardPythonWorker(worker); return;
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
      if (finishClose) { finishClose(message.type === 'result'); return; }
      closed = true; fail(new Error('Bot sandbox exited')); void discardPythonWorker(worker);
    }
  };
  const detach = () => { worker.removeListener('error',onError); worker.removeListener('exit',onExit); worker.removeListener('message',onMessage); };
  worker.on('error',onError); worker.on('exit',onExit); worker.on('message',onMessage);
  const file = content => ({ path: '', content, mode: 'string', timestamps: {
    access: new Date(), change: new Date(), modification: new Date(),
  } });
  const ready = wait(bootTimeoutMs);
  worker.postMessage({ type: 'start', module,
    stdinBuffer: stdin, args: ['python', '-u', '/runner.py'], env: {},
    fs: { ...files, '/runner.py': file(wrapper), '/submission.py': file(code) },
  });
  try { await ready; } catch (error) { closed = true; detach(); await discardPythonWorker(worker); throw error; }
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
    async close() {
      if(closePromise) return closePromise;
      if(closed) { detach(); await discardPythonWorker(worker); return; }
      closed = true; fail(new Error('Bot sandbox closed'));
      closePromise=new Promise(resolve=>{
        const timer=setTimeout(()=>finishClose?.(false),1000);
        finishClose=reusable=>{
          finishClose=null; clearTimeout(timer); detach();
          void (reusable ? releasePythonWorker(worker) : discardPythonWorker(worker)).then(resolve);
        };
        // EOF lets this Python interpreter exit before the thread is reused.
        view.setInt32(0,-1); Atomics.notify(new Int32Array(stdin),0);
      });
      return closePromise;
    },
  };
}
