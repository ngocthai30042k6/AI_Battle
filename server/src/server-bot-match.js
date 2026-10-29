import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { hashCanonical, hashReplayState } from './replay.js';
import { createPythonBot } from './python-bot.js';
const require = createRequire(import.meta.url);
const { OTTGameEngine } = require('../../shared/OTTGameEngine.js');

export async function playServerBotMatch({ matchId, seed, rules, codes, maxPlies = 1000, maxMatchMs = 60000 }, createBot = createPythonBot) {
  let state = OTTGameEngine.createGame(seed, 9, rules);
  const replay = { format: 'ottv2-replay-v1', matchId, seed,
    initialState: OTTGameEngine.serialize(state), moves: [], execution: 'server' };
  const bots = [];
  const deadline = Date.now() + maxMatchMs;
  let fault = null;
  try {
    // Sequential startup keeps peak memory bounded on the free Render instance.
    const startupErrors = [];
    for (let seat = 0; seat < 2; seat++) {
      try { bots[seat] = await createBot(codes[seat]); }
      catch { startupErrors.push(seat + 1); }
    }
    if (startupErrors.length) {
      fault = { reason: 'bot-load-error', players: startupErrors };
      state = { ...state, winner: startupErrors.length === 2 ? 0 : 3 - startupErrors[0] };
    }
    while (state.winner === null) {
      if (Date.now() >= deadline) {
        state = { ...state, winner: 0, drawReason: 'server-time-limit' };
        break;
      }
      const player = state.turn;
      let move;
      try {
        const raw = await bots[player - 1].move(player, OTTGameEngine.createBotGameState(state, player));
        move = { from: raw?.from ?? raw?.fromRow * 9 + raw?.fromCol,
          to: raw?.to ?? raw?.toRow * 9 + raw?.toCol };
        if (!Number.isInteger(move.from) || !Number.isInteger(move.to)) throw new Error('Invalid move');
        const nonce = randomBytes(16).toString('hex');
        const commit = hashCanonical({ matchId, stepCount: state.stepCount, player, move, nonce });
        const next = OTTGameEngine.applyMove(state, move);
        if (next === state || next.stepCount !== state.stepCount + 1) throw new Error('Illegal move');
        state = next;
        replay.moves.push({ stepCount: state.stepCount, player, move, nonce, commit, stateHash: hashReplayState(state) });
      } catch {
        fault = { reason: 'bot-error-or-timeout', players: [player] };
        state = { ...state, winner: 3 - player };
      }
      if (state.winner === null && state.stepCount >= maxPlies) {
        state = { ...state, winner: 0, drawReason: 'server-move-limit' };
      }
    }
    replay.result = { winner: state.winner, drawReason: state.drawReason || null, fault };
    return { winner: state.winner, moveCount: state.stepCount, replay,
      finalHash: hashReplayState(state), fault };
  } finally { await Promise.all(bots.filter(Boolean).map(bot => bot.close())); }
}
