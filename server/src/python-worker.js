import { parentPort } from 'node:worker_threads';
import { WASI, WASIContext } from '@runno/wasi';

const finished = new Error('Sandbox lease finished');

// Share compiled code between players, with separate memories and filesystems.
// The default worker's data URLs create several large binary copies per player.
parentPort.on('message', async ({ module, stdinBuffer, ...context }) => {
  try {
    const wasi = new WASI(new WASIContext({
      ...context,
      stdout: text => parentPort.postMessage({ type: 'stdout', text }),
      stderr: () => {},
      // Do not serialize and forward every WASI syscall's memory for debugging.
      stdin: maxBytes => {
        Atomics.wait(new Int32Array(stdinBuffer), 0, 0);
        const view = new DataView(stdinBuffer);
        const length = view.getInt32(0);
        // The game result is already collected. Unwind this disposable VM
        // immediately instead of spending CPU on Python shutdown/atexit hooks.
        // The next lease still creates a fresh VM, memory and filesystem.
        if (length < 0) { view.setInt32(0, 0); throw finished; }
        const buffer = new Uint8Array(stdinBuffer, 4, length);
        const consumed = Math.min(maxBytes, length);
        const text = new TextDecoder().decode(buffer.slice(0, consumed));
        buffer.copyWithin(0, consumed);
        view.setInt32(0, length - consumed);
        return text;
      },
    }));
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    wasi.start({ module, instance });
    parentPort.postMessage({ type: 'result' });
  } catch (error) {
    parentPort.postMessage({ type: error === finished ? 'result' : 'crash' });
  }
});
