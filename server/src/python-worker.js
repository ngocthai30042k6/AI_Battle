import { parentPort } from 'node:worker_threads';
import { WASI, WASIContext } from '@runno/wasi';

// Share compiled code between players, with separate memories and filesystems.
// The default worker's data URLs create several large binary copies per player.
parentPort.once('message', async ({ module, stdinBuffer, ...context }) => {
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
        if (length < 0) { view.setInt32(0, 0); return null; }
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
  } catch {
    parentPort.postMessage({ type: 'crash' });
  }
});
