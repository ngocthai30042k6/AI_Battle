import { Worker } from 'node:worker_threads';

// Reuse only the Node thread. Each lease starts a NEW WASM instance, Python
// interpreter, memory and virtual filesystem; bot globals never cross games.
const idle = [];
const dead = new WeakSet();
function remove(worker) {
  const index=idle.indexOf(worker);
  if(index>=0) idle.splice(index,1);
  dead.add(worker);
}
export function acquirePythonWorker() {
  let worker=idle.pop();
  if (!worker) {
    worker=new Worker(new URL('./python-worker.js',import.meta.url), {
      resourceLimits:{maxOldGenerationSizeMb:128,stackSizeMb:4},execArgv:[],
    });
    worker.on('exit',()=>remove(worker));
    worker.on('error',()=>remove(worker));
  }
  worker.ref();
  return worker;
}
export async function discardPythonWorker(worker) {
  remove(worker);
  await worker.terminate();
}
export async function releasePythonWorker(worker) {
  if (dead.has(worker) || idle.length>=2) return discardPythonWorker(worker);
  idle.push(worker);
  worker.unref();
}
