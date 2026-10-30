import { parentPort } from 'node:worker_threads';
import { WASI, WASIContext } from '@runno/wasi';

const finished = new Error('Sandbox lease finished');

// Share compiled code between players, with separate memories and filesystems.
// The default worker's data URLs create several large binary copies per player.
parentPort.on('message', async ({ module, stdinBuffer, ...context }) => {
  try {
    const control = new Int32Array(stdinBuffer, 0, 1);
    let inputOffset = 0;
    const wasi = new WASI(new WASIContext({
      ...context,
      stderr: () => {},
    }));
    // Runno's default stdin/stdout converts every chunk through UTF-8 text.
    // Override only these virtual descriptors for lossless binary frames. All
    // other descriptors still use the isolated in-memory filesystem.
    const read = wasi.fd_read.bind(wasi), write = wasi.fd_write.bind(wasi);
    wasi.fd_read = (fd, iovs, count, nread) => {
      if (fd !== 0) return read(fd, iovs, count, nread);
      const memory = new DataView(wasi.memory.buffer);
      if (!count) { memory.setUint32(nread, 0, true); return 0; }
      Atomics.wait(control, 0, 0);
      const length = Atomics.load(control, 0);
      if (length < 0) throw finished;
      let consumed = 0;
      for (let i = 0; i < count && consumed < length; i++) {
        const ptr = memory.getUint32(iovs + i * 8, true);
        const size = Math.min(memory.getUint32(iovs + i * 8 + 4, true), length - consumed);
        new Uint8Array(wasi.memory.buffer, ptr, size).set(new Uint8Array(stdinBuffer, 4 + inputOffset + consumed, size));
        consumed += size;
      }
      inputOffset = consumed === length ? 0 : inputOffset + consumed;
      memory.setUint32(nread, consumed, true);
      Atomics.store(control, 0, length - consumed);
      return 0;
    };
    wasi.fd_write = (fd, iovs, count, nwritten) => {
      if (fd !== 1) return write(fd, iovs, count, nwritten);
      const memory = new DataView(wasi.memory.buffer);
      let size = 0;
      for (let i = 0; i < count; i++) {
        const ptr = memory.getUint32(iovs + i * 8, true), length = memory.getUint32(iovs + i * 8 + 4, true);
        if (size + length > 65540) throw new Error('Bot output exceeded its limit');
        // Never post a view of WASM memory: structured clone would copy its
        // ENTIRE backing buffer for a tiny response on every turn.
        const bytes = new Uint8Array(wasi.memory.buffer, ptr, length).slice();
        parentPort.postMessage({ type: 'stdout', bytes }, [bytes.buffer]);
        size += length;
      }
      memory.setUint32(nwritten, size, true);
      return 0;
    };
    const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
    wasi.start({ module, instance });
    parentPort.postMessage({ type: 'result' });
  } catch (error) {
    parentPort.postMessage({ type: error === finished ? 'result' : 'crash' });
  }
});
