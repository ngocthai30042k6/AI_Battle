import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPythonBot } from '../src/python-bot.js';
import { playServerBotMatch } from '../src/server-bot-match.js';

test('repeated two-player sandboxes stay within the free server memory budget', { timeout: 30000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { createPythonBot } from ${JSON.stringify(new URL('../src/python-bot.js', import.meta.url).href)};
    let peak = 0;
    const sample = () => { peak = Math.max(peak, process.memoryUsage().rss); };
    const timer = setInterval(sample, 10);
    try {
      for (let i = 0; i < 6; i++) {
        const first = await createPythonBot('def get_next_move(p,s): return None');
        const second = await createPythonBot('def get_next_move(p,s): return None');
        try { sample(); await first.move(1, {}); await second.move(2, {}); }
        finally { await first.close(); await second.close(); }
      }
    } finally { clearInterval(timer); }
    console.log(peak);
  `], { timeout: 25000 });
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

test('infinite Python loops time out without blocking the server', async () => {
  const bot = await createPythonBot('def get_next_move(p,s):\n while True: pass', { moveTimeoutMs: 100 });
  try { await assert.rejects(bot.move(1, {}), /time limit/); } finally { await bot.close(); }
});

test('illegal bot moves forfeit; player seats are not reordered', async () => {
  const seats = [];
  const result = await playServerBotMatch({ matchId: 'test', seed: 123, codes: ['first', 'second'] },
    async code => ({ move: async player => { seats.push([code, player]); return { from: -1, to: -1 }; }, close: async () => {} }));
  assert.equal(result.winner, 2);
  assert.deepEqual(seats, [['first', 1]]);
  assert.equal(result.fault.reason, 'bot-error-or-timeout');
});

test('server computes a game from the submitted Python and saves all moves', async () => {
  const code = `def get_next_move(player,state):\n return state['validMoves'][0]`;
  const result = await playServerBotMatch({ matchId: 'wasm-game', seed: 4321, codes: [code, code], maxPlies: 12 });
  assert.equal(result.fault, null);
  assert.ok([0, 1, 2].includes(result.winner));
  assert.ok(result.replay.moves.length > 0);
  assert.equal(result.replay.moves.length, result.moveCount);
});
