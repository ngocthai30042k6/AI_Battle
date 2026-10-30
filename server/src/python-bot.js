import { acquirePythonWorker, discardPythonWorker, releasePythonWorker } from './python-worker-pool.js';
import { readFile } from 'node:fs/promises';
import { fetchWASIFS } from '@runno/sandbox';
import { encodePythonInput } from './python-input.js';

const runtime = new URL('./langs/', import.meta.resolve('@runno/sandbox'));
let baseFiles;
let compiledPython;
// Use the bundled CPython JSON accelerator directly. Importing the public json
// package also initializes re/enum and their dependencies for every fresh VM.
// The codec settings below match json.loads/json.dumps for our data-only wire.
const wrapper = `import _json, marshal, sys
def unsupported(value): raise TypeError('Not JSON serializable')
encode = _json.make_encoder({}, unsupported, _json.encode_basestring_ascii, None, ':', ',', False, False, False)
class Quiet:
    def write(self, text): return len(text)
    def flush(self): pass
namespace = {}
protocol_out = sys.stdout
protocol_in = sys.stdin.buffer
quiet = Quiet()
def send(packet):
    protocol_out.write(''.join(encode(packet, 0)) + '\\n')
    protocol_out.flush()
try:
    sys.stdout = sys.stderr = quiet
    exec(open('/submission.py').read(), namespace)
    move_fn = namespace.get('get_next_move', namespace.get('getNextMove'))
    if not callable(move_fn): raise ValueError('Bot must define get_next_move')
    send({'ready': True})
except BaseException:
    send({'error': 'Cannot load Python bot'})
    sys.exit(1)
while True:
    try:
        header = protocol_in.read(4)
        if len(header) != 4: break
        size = int.from_bytes(header, 'little')
        if size > 131064: break
        request = marshal.loads(protocol_in.read(size))
        sys.stdout = sys.stderr = quiet
        move = move_fn(request['player'], request['state'])
        send({'move': move})
    except BaseException:
        send({'error': 'Python bot execution failed'})
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
  const control = new Int32Array(stdin, 0, 1);
  const worker = acquirePythonWorker();
  let pending, buffer = Buffer.alloc(0), closed = false, closePromise, finishClose;
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
      buffer = Buffer.concat([buffer, message.bytes]);
      if (buffer.length > 65536) {
        fail(new Error('Bot output exceeded its limit')); closed = true; void discardPythonWorker(worker); return;
      }
      let end;
      while ((end = buffer.indexOf(10)) >= 0) {
        const payload = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        if (!pending) continue;
        try {
          const packet = JSON.parse(payload.toString('utf8'));
          if (!packet || typeof packet !== 'object') throw new Error('Invalid packet');
          const current = pending; pending = null; clearTimeout(current.timer);
          if (packet.error) current.reject(new Error(packet.error)); else current.resolve(packet);
        } catch { fail(new Error('Bot returned invalid data')); }
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
    // The bundled runtime contains only the standard library. Skip automatic
    // site initialization; bots can still import all bundled stdlib modules.
    stdinBuffer: stdin, args: ['python', '-S', '-u', '/runner.py'], env: {},
    fs: { ...files, '/runner.py': file(wrapper), '/submission.py': file(code) },
  });
  try { await ready; } catch (error) { closed = true; detach(); await discardPythonWorker(worker); throw error; }
  return {
    async move(player, state) {
      if (closed) throw new Error('Bot sandbox is closed');
      if (pending) throw new Error('Bot already has a pending move');
      const input = encodePythonInput({ player, state });
      if (input.length > stdin.byteLength - 4 || Atomics.load(control, 0) !== 0) throw new Error('Invalid sandbox input');
      const response = wait(moveTimeoutMs);
      new Uint8Array(stdin, 4, input.length).set(input);
      Atomics.store(control, 0, input.length);
      Atomics.notify(control, 0);
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
        // Stop the disposable VM before returning its Node thread to the pool.
        Atomics.store(control,0,-1); Atomics.notify(control,0);
      });
      return closePromise;
    },
  };
}
