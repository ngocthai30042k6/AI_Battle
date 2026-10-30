import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPythonBot } from '../src/python-bot.js';
import { playServerBotMatch } from '../src/server-bot-match.js';
import { encodePythonInput } from '../src/python-input.js';
import { createRequire } from 'node:module';
import { verifyReplay } from '../src/replay.js';
const { OTTGameEngine } = createRequire(import.meta.url)('../../shared/OTTGameEngine.js');

// This asserts bounded memory, not desktop CPU speed; allow slower CI/laptops.
test('repeated two-player sandboxes stay within the free server memory budget', { timeout: 90000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createPythonBot } from ${JSON.stringify(new URL('../src/python-bot.js', import.meta.url).href)};
    let peak = 0;
    const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
    const timer = setInterval(sample, 10);
    try {
      for (let i = 0; i < 40; i++) {
        const [first,second] = await Promise.all([
          createPythonBot('def get_next_move(p,s): return None'),
          createPythonBot('def get_next_move(p,s): return None'),
        ]);
        try { sample(); await first.move(1, {}); await second.move(2, {}); }
        finally { await first.close(); await second.close(); }
      }
    } finally { clearInterval(timer); }
    console.log(peak);
  `], { timeout: 80000 });
  // Leave at least 112 MB of the 512 MB instance for HTTP, Redis and Postgres.
  assert.ok(Number(stdout.trim()) < 400 * 1024 * 1024, `Sandbox peak RSS: ${stdout.trim()} bytes`);
});

test('Python bot retains state, receives legal moves and cannot access host files', async () => {
  const bot = await createPythonBot(`counter=0
def get_next_move(player, state):
    global counter
    counter+=1
    try:
        open('/etc/passwd').read()
        return None
    except OSError:
        pass
    move=dict(state['validMoves'][0])
    move['counter']=counter
    return move
`);
  try {
    assert.equal((await bot.move(1, { validMoves: [{ from: 1, to: 2 }] })).counter, 1);
    assert.equal((await bot.move(2, { validMoves: [{ from: 2, to: 3 }] })).counter, 2);
  } finally { await bot.close(); }
});

test('reused worker threads start fresh Python memory, modules and filesystems for each game', async () => {
  const poisoned = await createPythonBot(`import builtins,sys,os
builtins.previous_bot = 'private'
sys.modules['previous_bot_module'] = sys
os.environ['PREVIOUS_BOT'] = 'private'
open('/previous-bot.txt','w').write('private')
counter = 0
def get_next_move(p,s):
 global counter
 counter += 1
 return {'counter':counter}
`);
  assert.equal((await poisoned.move(1,{})).counter,1);
  await poisoned.close();
  const fresh = await createPythonBot(`import builtins,sys,os
counter = 0
def get_next_move(p,s):
 global counter
 counter += 1
 return {'counter':counter,'leaked':hasattr(builtins,'previous_bot') or 'previous_bot_module' in sys.modules or 'PREVIOUS_BOT' in os.environ or os.path.exists('/previous-bot.txt')}
`);
  try {
    assert.deepEqual(await fresh.move(1,{}),{counter:1,leaked:false});
    assert.deepEqual(await fresh.move(1,{}),{counter:2,leaked:false});
  } finally {await fresh.close();}
});

test('infinite Python loops time out without blocking the server', async () => {
  const bot = await createPythonBot('def get_next_move(p,s):\n while True: pass', { moveTimeoutMs: 100 });
  try { await assert.rejects(bot.move(1, {}), /time limit/); } finally { await bot.close(); }
});

test('lean interpreter startup preserves stdlib imports and suppresses bot prints', async () => {
  const bot=await createPythonBot(`import math,random,collections,statistics,heapq,json,itertools
print('startup output')
def get_next_move(p,s):
 print('move output')
 return {'from':math.floor(statistics.mean([1,1])),'to':heapq.nsmallest(1,[3,2])[0]}
`);
  try {assert.deepEqual(await bot.move(1,{}),{from:1,to:2});}
  finally {await bot.close();}
});

test('illegal bot moves forfeit; player seats are not reordered', async () => {
  const seats = [];
  const result = await playServerBotMatch({ matchId: 'test', seed: 123, codes: ['first', 'second'] },
    async code => ({ move: async player => { seats.push([code, player]); return { from: -1, to: -1 }; }, close: async () => {} }));
  assert.equal(result.winner, 2);
  assert.deepEqual(seats, [['first', 1]]);
  assert.equal(result.fault.reason, 'bot-error-or-timeout');
});

test('both sandboxes begin loading together while preserving player seats', async () => {
  const started=[],moves=[];
  const result=await playServerBotMatch({matchId:'parallel-load',seed:123,codes:['first','second']},code=>{
    started.push(code);
    return Promise.resolve().then(()=>{
      assert.equal(started.length,2);
      return { move:async seat=>{moves.push([code,seat]);return {from:-1,to:-1};},close:async()=>{} };
    });
  });
  assert.deepEqual(started,['first','second']);
  assert.deepEqual(moves,[['first',1]]);
  assert.equal(result.winner,2);
  assert.equal(result.fault.reason,'bot-error-or-timeout');
});

test('server computes a game from the submitted Python and saves all moves', async () => {
  const code = `def get_next_move(player,state):\n return state['validMoves'][0]`;
  const result = await playServerBotMatch({ matchId: 'wasm-game', seed: 4321, codes: [code, code], maxPlies: 12 });
  assert.equal(result.fault, null);
  assert.ok([0, 1, 2].includes(result.winner));
  assert.ok(result.replay.moves.length > 0);
  assert.equal(result.replay.moves.length, result.moveCount);
});

test('binary input preserves the complete bot API, Unicode, scalars and independent containers', async () => {
  const bot = await createPythonBot('def get_next_move(p,s): return s');
  try {
    for (const player of [1,2]) {
      const state = OTTGameEngine.createBotGameState(OTTGameEngine.createGame(54321,9),player);
      state.extra = { text: 'Tiếng Việt 🤖\u0000\n', decimals: [0.5,-2.75],
        integers: [2147483648,-2147483649,Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER],
        nested: [{ same: 'paper' },{ same: 'paper' }], blank: '', empty: [], flags: [true,false,null] };
      assert.deepEqual(await bot.move(player,state),state);
    }
  } finally { await bot.close(); }
  const mutator = await createPythonBot(`def get_next_move(p,s):
 s['a']['x']=99
 return s['b']['x']
`);
  try { const shared={x:1}; assert.equal(await mutator.move(1,{a:shared,b:shared}),1); }
  finally { await mutator.close(); }
});

test('input framing handles partial WASI reads and UTF-8 chunk boundaries', async () => {
  const bot = await createPythonBot(`def get_next_move(p,s):
 return {'text':s['text'][-4:],'length':len(s['text'])}
`);
  try {
    const text='a'.repeat(8190)+'🤖ệ'.repeat(10000);
    assert.deepEqual(await bot.move(1,{text}),{text:'🤖ệ🤖ệ',length:28190});
  } finally { await bot.close(); }
  assert.throws(()=>encodePythonInput({text:'x'.repeat(131072)}),/limit/);
  const circular={}; circular.self=circular;
  assert.throws(()=>encodePythonInput(circular),/deeply nested/);
});

test('a complete optimized Python game agrees with JS and its replay hashes verify', async () => {
  const input={matchId:'transport-equivalence',seed:20261029,codes:Array(2).fill("def get_next_move(p,s): return s['validMoves'][0]")};
  const python=await playServerBotMatch(input);
  const js=await playServerBotMatch(input,async()=>({move:async(p,s)=>s.validMoves[0],close:async()=>{}}));
  assert.equal(python.fault,null);
  assert.deepEqual(python.replay.moves.map(m=>m.move),js.replay.moves.map(m=>m.move));
  assert.equal(python.finalHash,js.finalHash);
  assert.equal(verifyReplay(python.replay,input.seed,input.matchId).finalHash,python.finalHash);
});

test('oversized output, startup failure and move errors discard a sandbox cleanly', async () => {
  await assert.rejects(createPythonBot('raise RuntimeError("bad startup")'),/load/);
  for (const code of ['def get_next_move(p,s): return "x"*70000','def get_next_move(p,s): raise ValueError("bad move")']) {
    const bot=await createPythonBot(code);
    try { await assert.rejects(bot.move(1,{})); }
    finally { await bot.close(); }
  }
  const healthy=await createPythonBot('def get_next_move(p,s): return {"from":1,"to":2}');
  try { assert.deepEqual(await healthy.move(1,{}),{from:1,to:2}); }
  finally { await healthy.close(); }
});
