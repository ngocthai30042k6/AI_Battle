import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomInt, randomUUID, randomBytes, generateKeyPairSync, sign as signCrypto } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { createToken, hashPassword, verifyPassword, verifyToken } from './auth.js';
import { calculateElo } from './elo.js';
import { enqueueOrMatch, cancelQueue, enqueueTournamentOrMatch, cancelTournamentQueue } from './matchmaker.js';
import { hashCanonical, verifyConsensusDispute, verifyReplay, verifySessionProof } from './replay.js';
import { createReplayStorage } from './storage.js';
import {
  applySprintRankReset,
  applyTournamentResult,
  buildTournamentMotivation,
  rankTier,
  TOURNAMENT_RANKS,
  tournamentRanks
} from './tournament-ranks.js';
import { areBothMatchPlayersOffline } from './match-disconnect.js';
import { createTournamentRunner, startServerGroupStage } from './tournament-runner.js';
import {
  buildTournamentRules,
  calculateGroupStandings,
  createDoubleRoundRobinFixtures,
  createKnockoutOpeningRound,
  createNextKnockoutRound,
  distributeTournamentGroups
} from './tournament-format.js';

const pool = new Pool({ connectionString: config.databaseUrl });
const redis = createClient({ url: config.redisUrl });
redis.on('error', err => console.error('Redis error:', err.message));
const redisEvents = redis.duplicate();
const instanceId = randomUUID();
const replayStorage = createReplayStorage(config);
const tournamentRunner = createTournamentRunner({ pool, completeFixture: completePostgresTournamentFixture,
  updateEntries: updateTournamentEntriesForResult, fideK: config.fideK });
const liveSockets = new Map();
const searchTimers = new Map();
const sparringSessions = new Map();
const SPARRING_BOT_ID = '00000000-0000-4000-8000-000000000001';
const MAX_BODY = 8 * 1024 * 1024;
const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024;
const PLAYER_AVATAR_IDS = [
  'pumpkin', 'ghost', 'bat', 'knight', 'fox', 'crown',
  'dragon', 'cat', 'wizard', 'alien', 'skull', 'robot', 'spider', 'unicorn'
];
const PROFILE_BACKGROUND_IDS = [
  'castle', 'moonlight', 'emerald', 'ocean', 'sunset', 'aurora', 'crimson', 'ice'
];
let tournamentLifecycleTimer = null;
let disconnectForfeitTimer = null;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DISCONNECT_FORFEIT_MS = 5000;
const TOURNAMENT_QUEUE_TIERS = [...TOURNAMENT_RANKS, 'Practice'];
const DEFAULT_SPRINT_RULES = ['standard', 'center_blockers', 'clipped_corners', 'corridor'];
const SPRINT_RULE_LAYOUTS = {
  standard: { title: 'Bàn chuẩn', blockedCells: [] },
  center_blockers: { title: 'Chướng ngại trung tâm', blockedCells: [30, 31, 32, 39, 40, 41, 48, 49, 50] },
  clipped_corners: { title: 'Bàn vát góc', blockedCells: [0, 1, 9, 10, 70, 71, 79, 80] },
  corridor: { title: 'Hành lang vật cản', blockedCells: [22, 24, 38, 40, 42, 56, 58] }
};

function tournamentQueueNamespace(search) {
  if (search.phase === 'practice') return 'ottv2:tournament-practice';
  return search.individual ? 'ottv2:tournament-player' : 'ottv2:tournament';
}

function weeklyRules(week, schedule = DEFAULT_SPRINT_RULES) {
  const sprint = Math.max(1, Number(week) || 1);
  const configuredSchedule = Array.isArray(schedule) && schedule.length ? schedule : DEFAULT_SPRINT_RULES;
  const layoutId = configuredSchedule[sprint - 1] || 'standard';
  const layout = SPRINT_RULE_LAYOUTS[layoutId] || SPRINT_RULE_LAYOUTS.standard;
  return { id: `sprint-${sprint}-${layoutId}`, week: sprint, title: layout.title, rows: 9, cols: 9, blockedCells: [...layout.blockedCells] };
}

async function clearTournamentQueues(tournamentId, ...weeks) {
  const keys = [...new Set(weeks.flatMap(week => ['ottv2:tournament', 'ottv2:tournament-player', 'ottv2:tournament-practice'].flatMap(namespace => TOURNAMENT_QUEUE_TIERS.map(tier => `${namespace}:${tournamentId}:${week}:${tier}`))))];
  if (keys.length) await redis.del(keys);
}

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
};
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === config.origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
const publicUser = user => ({
  id: user.id,
  email: user.email,
  displayName: user.display_name,
  elo: user.elo,
  avatarId: user.avatar_id || 'pumpkin',
  avatarUrl: user.avatar_url || null,
  profileBackgroundUrl: user.profile_background_url || null,
  profileBackgroundId: PROFILE_BACKGROUND_IDS.includes(user.profile_background_id)
    ? user.profile_background_id
    : 'castle',
  isAdmin: Boolean(user.is_admin),
  activeBotVersion: Number(user.active_bot_version || 0)
});
function isAllowedAvatarDataUrl(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AVATAR_UPLOAD_BYTES * 4 / 3) + 64) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_AVATAR_UPLOAD_BYTES || bytes.toString('base64') !== match[2]) return false;
  if (match[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (match[1] === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}
const readBody = req => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', chunk => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_BODY) {
      tooLarge = true;
      chunks.length = 0;
      reject(Object.assign(new Error('Request body too large'), { status: 413 }));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) return;
    try {
      const body = Buffer.concat(chunks).toString('utf8');
      resolve(body ? JSON.parse(body) : {});
    } catch {
      reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
    }
  });
  req.on('aborted', () => reject(new Error('Request body was aborted')));
  req.on('error', reject);
});
function authFromHeader(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) throw Object.assign(new Error('Authentication required'), { status: 401 });
  return verifyToken(match[1], config.jwtSecret);
}
function optionalAuthFromHeader(req) {
  return req.headers.authorization ? authFromHeader(req) : null;
}
function send(ws, type, data = {}) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data }));
}
function userSocket(userId) {
  const current = liveSockets.get(userId);
  return current && current.readyState === WebSocket.OPEN ? current : null;
}
async function deliverToUser(userId, type, data) {
  const socket = userSocket(userId);
  if (socket) {
    if (type === 'match-found') {
      socket.searchCancelled = true;
      socket.searching = false;
      const timer = searchTimers.get(userId); if (timer) clearTimeout(timer);
      searchTimers.delete(userId);
      await cancelQueue(redis, userId).catch(() => {});
      if (socket.tournamentSearch) {
        const search = socket.tournamentSearch;
        await cancelTournamentQueue(redis, search.tournamentId, search.teamId, userId, search.week, tournamentQueueNamespace(search)).catch(() => {});
        socket.tournamentSearch = null;
      }
    }
    send(socket, type, data);
    return;
  }
  await redis.publish(`ottv2:user:${userId}`, JSON.stringify({ type, data }));
}
function canonicalMatchIds(match) { return [match.player1_id, match.player2_id]; }

function createInitialConsensusState(mode = 'bot') {
  const now = Date.now();
  return {
    createdAtMs: now,
    p1ReadyAt: mode === 'human' ? now : null,
    p2ReadyAt: mode === 'human' ? now : null,
    bothReadyAt: mode === 'human' ? now : null,
    currentStep: 0,
    stepStartedAt: now,
    lastRevealStep: null,
    lastRevealSeat: null,
    lastRevealAt: null,
    lastRevealCommit: null,
    acksForPendingStep: {},
    finalProofs: {},
    finalProofAt: {},
    lastActivityAt: now
  };
}

async function createMatch(user, paired, mode = 'human') {
  const [opponentResult] = await Promise.all([pool.query('SELECT id, email, display_name, elo, is_admin, active_bot_version FROM users WHERE id=$1', [paired.opponentId])]);
  const opponent = opponentResult.rows[0];
  if (!opponent) throw new Error('Opponent account no longer exists');
  const player1 = user.id < opponent.id ? user : opponent;
  const player2 = user.id < opponent.id ? opponent : user;
  const matchId = randomUUID();
  const seed = randomInt(1, 0x7fffffff);
  const matchType = mode === 'bot' ? 'bot' : 'human';
  const consensusState = createInitialConsensusState(matchType);
  await pool.query(
    'INSERT INTO matches(id, seed, player1_id, player2_id, status, match_type, consensus_state) VALUES($1,$2,$3,$4,\'active\',$5,$6::jsonb)',
    [matchId, seed, player1.id, player2.id, matchType, JSON.stringify(consensusState)]
  );
  const baseMatch = {
    id: matchId,
    seed,
    pieceCount: 9,
    mode: matchType,
    player1_id: player1.id,
    player2_id: player2.id,
    match_type: matchType,
    tournamentId: null,
    tournamentPhase: null,
    rules: null,
    player1: { id: player1.id, displayName: player1.display_name, elo: player1.elo },
    player2: { id: player2.id, displayName: player2.display_name, elo: player2.elo },
    created_at: new Date().toISOString()
  };
  for (const [player, role, seat, other] of [[player1, 'player1', 1, player2], [player2, 'player2', 2, player1]]) {
    await deliverToUser(player.id, 'match-found', {
      match: baseMatch,
      role,
      seat,
      opponent: publicUser(other),
      signaling: 'server-relay',
      mode: matchType
    });
  }
}

const sparringStatePayload = state => ({
  board: Array.from(state.board),
  turn: state.turn,
  stepCount: state.stepCount,
  winner: state.winner === 0 ? 0 : state.winner || null,
  seed: state.seed,
  pieceCount: state.pieceCount,
  lastMove: state.lastMove || null,
  ...(state.rules ? { rules: state.rules } : {})
});
const sparringCanonical = value => Array.isArray(value)
  ? `[${value.map(sparringCanonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${sparringCanonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
function signSparringPayload(privateKey, payload) {
  return signCrypto('sha256', Buffer.from(sparringCanonical(payload)), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  }).toString('hex');
}
function pickSparringMove(state, botSeat) {
  const validMoves = OTTGameEngine.createBotGameState(state, botSeat).validMoves || [];
  if (!validMoves.length) return null;
  let best = validMoves[0];
  let bestScore = -Infinity;
  const targetRow = botSeat === 1 ? 0 : 8;
  const targetCol = botSeat === 1 ? 8 : 0;
  for (const move of validMoves) {
    const winningCell = botSeat === 1 ? 8 : 72;
    if (move.to === winningCell) return { from: move.from, to: move.to };
    const targetDistance = Math.abs(move.toRow - targetRow) + Math.abs(move.toCol - targetCol);
    const score = (move.isAttack ? 145 : 0) - targetDistance * 12 -
      (Math.abs(move.toRow - 4) + Math.abs(move.toCol - 4)) * 2 + Math.random() * 10;
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return { from: best.from, to: best.to };
}

async function createSparringMatch(user, mode = 'human', tournamentId = null) {
  const botResult = await pool.query(
    'SELECT id,email,display_name,elo,is_admin,avatar_id FROM users WHERE id=$1',
    [SPARRING_BOT_ID]
  );
  const bot = botResult.rows[0];
  if (!bot) throw Object.assign(new Error('Hắc Kỵ Sĩ AI chưa được khởi tạo trên máy chủ.'), { status: 503 });

  let tournament = null;
  if (tournamentId) {
    const result = await pool.query(
      'SELECT id,status,current_week,rules_json,registration_closes_at,ends_at FROM tournaments WHERE id=$1',
      [tournamentId]
    );
    tournament = result.rows[0];
    if (!tournament || !['registration', 'qualifying'].includes(tournament.status) || new Date(tournament.ends_at) <= new Date()) {
      throw Object.assign(new Error('Giải đấu không còn mở để đấu với Hắc Kỵ Sĩ AI.'), { status: 409 });
    }
  }

  const humanSeat = Math.random() < 0.5 ? 1 : 2;
  const player1 = humanSeat === 1 ? user : bot;
  const player2 = humanSeat === 2 ? user : bot;
  const seed = randomInt(1, 0x7fffffff);
  const matchId = randomUUID();
  const phase = tournament ? tournament.status === 'registration' ? 'practice' : 'ranked' : null;
  const rules = tournament && phase === 'ranked'
    ? tournament.rules_json || weeklyRules(tournament.current_week || 1)
    : null;
  const matchType = mode === 'bot' ? 'bot' : 'human';
  const consensusState = createInitialConsensusState(matchType);
  await pool.query(
    `INSERT INTO matches(id,seed,player1_id,player2_id,status,match_type,tournament_id,tournament_phase,tournament_rules,is_sparring,consensus_state)
     VALUES($1,$2,$3,$4,'active',$5,$6,$7,$8,TRUE,$9::jsonb)`,
    [matchId, seed, player1.id, player2.id, matchType, tournament?.id || null, phase, rules ? JSON.stringify(rules) : null, JSON.stringify(consensusState)]
  );

  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  await pool.query(`UPDATE matches SET ${humanSeat === 1 ? 'player2_key' : 'player1_key'}=$1::jsonb WHERE id=$2`, [JSON.stringify(publicJwk), matchId]);
  const session = {
    matchId,
    humanId: user.id,
    humanSeat,
    botSeat: humanSeat === 1 ? 2 : 1,
    privateKey: keys.privateKey,
    publicJwk,
    state: OTTGameEngine.createGame(seed, 9, rules),
    destroyed: false
  };
  sparringSessions.set(matchId, session);

  const socket = userSocket(user.id);
  if (!socket) throw Object.assign(new Error('Kết nối máy chủ đã đóng. Hãy thử tìm trận lại.'), { status: 409 });
  socket.searching = false;
  socket.searchCancelled = true;
  const playerPayload = player => ({ id: player.id, displayName: player.display_name, elo: player.elo });
  const match = {
    id: matchId,
    seed,
    pieceCount: 9,
    mode: matchType,
    match_type: matchType,
    isSparring: true,
    tournamentId: tournament?.id || null,
    tournamentPhase: phase,
    rules,
    player1: playerPayload(player1),
    player2: playerPayload(player2)
  };
  send(socket, 'sparring-ready', { matchId, botSeat: session.botSeat, publicKey: publicJwk });
  send(socket, 'match-found', {
    role: humanSeat === 1 ? 'player1' : 'player2',
    seat: humanSeat,
    match,
    opponent: playerPayload(bot),
    signaling: 'server-relay',
    mode: matchType
  });
  return session;
}

async function handleSparringRelay(session, socket, packet) {
  if (!session || session.destroyed || session.humanId !== socket.user.id) return;
  const sendToHuman = payload => send(socket, 'match-relay', {
    matchId: session.matchId,
    from: SPARRING_BOT_ID,
    payload
  });
  const broadcastFinalProof = state => {
    const proof = {
      matchId: session.matchId,
      roomId: session.matchId,
      stepCount: state.stepCount,
      stateHash: hashCanonical(sparringStatePayload(state)),
      winner: state.winner
    };
    sendToHuman({
      type: 'FINAL_PROOF',
      seat: session.botSeat,
      proof,
      signature: signSparringPayload(session.privateKey, proof)
    });
  };
  const playBotTurn = async () => {
    if (session.destroyed || (session.state.winner !== null && session.state.winner !== undefined) || session.state.turn !== session.botSeat) return;
    await new Promise(resolve => setTimeout(resolve, 180));
    if (session.destroyed || (session.state.winner !== null && session.state.winner !== undefined)) return;
    const move = pickSparringMove(session.state, session.botSeat);
    if (!move) return;
    const stepCount = session.state.stepCount;
    const nonce = randomBytes(32).toString('hex');
    const commit = hashCanonical({ matchId: session.matchId, stepCount, player: session.botSeat, move, nonce });
    const commitPayload = { kind: 'move-commit', matchId: session.matchId, stepCount, player: session.botSeat, hash: commit };
    sendToHuman({ type: 'CONSENSUS_COMMIT', attestation: { payload: commitPayload, signature: signSparringPayload(session.privateKey, commitPayload) } });
    const revealPayload = { kind: 'move-reveal', matchId: session.matchId, stepCount, player: session.botSeat, move, nonce, commit };
    const nextState = OTTGameEngine.applyMove(session.state, move);
    session.state = nextState;
    const stateHash = hashCanonical(sparringStatePayload(nextState));
    const ackPayload = { kind: 'state-ack', matchId: session.matchId, stepCount: nextState.stepCount, player: session.botSeat, moveCommit: commit, stateHash };
    sendToHuman({ type: 'CONSENSUS_REVEAL', attestation: { payload: revealPayload, signature: signSparringPayload(session.privateKey, revealPayload) } });
    sendToHuman({ type: 'CONSENSUS_ACK', attestation: { payload: ackPayload, signature: signSparringPayload(session.privateKey, ackPayload) } });
    if (nextState.winner !== null && nextState.winner !== undefined) broadcastFinalProof(nextState);
  };

  if (packet.type === 'BOT_READY') {
    sendToHuman({ type: 'BOT_READY', botLabel: 'Hắc Kỵ Sĩ AI' });
    await playBotTurn();
  } else if (packet.type === 'CONSENSUS_HELLO') {
    sendToHuman({ type: 'CONSENSUS_HELLO', seat: session.botSeat, publicKey: session.publicJwk });
    if (packet.autoStart) await playBotTurn();
  } else if (packet.type === 'CONSENSUS_REVEAL') {
    const payload = packet.attestation?.payload;
    if (!payload || payload.player !== session.humanSeat || payload.matchId !== session.matchId ||
        payload.stepCount !== session.state.stepCount || session.state.turn !== session.humanSeat ||
        !payload.move || !Number.isInteger(payload.move.from) || !Number.isInteger(payload.move.to)) return;
    session.state = OTTGameEngine.applyMove(session.state, payload.move);
    const stateHash = hashCanonical(sparringStatePayload(session.state));
    const ackPayload = {
      kind: 'state-ack', matchId: session.matchId, stepCount: session.state.stepCount,
      player: session.botSeat, moveCommit: payload.commit, stateHash
    };
    sendToHuman({ type: 'CONSENSUS_ACK', attestation: { payload: ackPayload, signature: signSparringPayload(session.privateKey, ackPayload) } });
    if (session.state.winner !== null && session.state.winner !== undefined) broadcastFinalProof(session.state);
    else await playBotTurn();
  }
}

async function createTournamentMatch(user, pairing) {
  const tournamentResult = await pool.query('SELECT current_week,rules_json FROM tournaments WHERE id=$1 AND status=\'qualifying\'', [pairing.tournamentId]);
  const tournament = tournamentResult.rows[0];
  if (!tournament) throw Object.assign(new Error('Giải đã đổi trạng thái, hãy tìm lại trận.'), { status: 409 });
  if (pairing.week && Number(pairing.week) !== Number(tournament.current_week)) throw Object.assign(new Error('Luật tuần vừa được cập nhật; hãy tìm lại trận.'), { status: 409 });
  const rules = pairing.rules || (tournament.rules_json?.id ? tournament.rules_json : weeklyRules(tournament.current_week || 1));
  const opponentResult = await pool.query('SELECT id,email,display_name,elo,is_admin FROM users WHERE id=$1', [pairing.opponentUserId]);
  const opponent = opponentResult.rows[0];
  if (!opponent) throw new Error('Opponent account no longer exists');
  const teamsResult = await pool.query(
    `SELECT t.id,t.name,b.version,b.code,b.code_sha256
     FROM teams t JOIN team_bot_versions b ON b.team_id=t.id
     WHERE (t.id=$1 AND b.version=$2) OR (t.id=$3 AND b.version=$4)`,
    [pairing.teamId, pairing.botVersion, pairing.opponentTeamId, pairing.opponentVersion]
  );
  const teamMap = new Map(teamsResult.rows.map(team => [team.id, team]));
  const ownTeam = teamMap.get(pairing.teamId);
  const opponentTeam = teamMap.get(pairing.opponentTeamId);
  if (!ownTeam || !opponentTeam) throw new Error('A submitted bot version could not be found');
  const first = user.id < opponent.id
    ? { user, team: ownTeam }
    : { user: opponent, team: opponentTeam };
  const second = user.id < opponent.id
    ? { user: opponent, team: opponentTeam }
    : { user, team: ownTeam };
  const matchId = randomUUID();
  const seed = randomInt(1, 0x7fffffff);
  await pool.query(
    `INSERT INTO matches(id,seed,player1_id,player2_id,status,match_type,tournament_id,player1_team_id,player2_team_id,player1_bot_version,player2_bot_version,tournament_rules)
     VALUES($1,$2,$3,$4,'active','bot',$5,$6,$7,$8,$9,$10)`,
    [matchId, seed, first.user.id, second.user.id, pairing.tournamentId, first.team.id, second.team.id, first.team.version, second.team.version, JSON.stringify(rules)]
  );
  const record = {
    id: matchId, seed, player1_id: first.user.id, player2_id: second.user.id,
    tournament_id: pairing.tournamentId, created_at: new Date().toISOString()
  };
  for (const [player, role, other] of [[first, 'player1', second], [second, 'player2', first]]) {
    await deliverToUser(player.user.id, 'match-found', {
      match: record,
      role,
      opponent: publicUser(other.user),
      signaling: 'server-relay',
      tournamentRules: rules,
      tournamentBot: {
        tournamentId: pairing.tournamentId,
        teamId: player.team.id,
        teamName: player.team.name,
        version: player.team.version,
        sha256: player.team.code_sha256,
        code: player.team.code
      }
    });
  }
}

async function createIndividualTournamentMatch(user, pairing) {
  const tournamentResult = await pool.query(
    `SELECT id,format,status,registration_closes_at,tournament_starts_at,ends_at,max_teams,current_week,rules_json
     FROM tournaments WHERE id=$1`,
    [pairing.tournamentId]
  );
  const tournament = tournamentResult.rows[0];
  if (!tournament) throw Object.assign(new Error('Không tìm thấy giải đấu.'), { status: 404 });
  const fixture = pairing.fixtureId
    ? (await pool.query(
      `SELECT * FROM tournament_fixtures WHERE id=$1 AND tournament_id=$2 AND status='active'`,
      [pairing.fixtureId, pairing.tournamentId]
    )).rows[0]
    : null;
  if (pairing.fixtureId && !fixture) {
    throw Object.assign(new Error('Trận theo lịch vừa được cập nhật; hãy tìm trận lại.'), { status: 409 });
  }
  const phase = fixture?.phase || pairing.phase;
  let rules = null;
  if (fixture) {
    if (tournament.format !== 'group_knockout' ||
        !['group_running', 'knockout'].includes(tournament.status) ||
        (tournament.status === 'knockout' && new Date(tournament.tournament_starts_at).getTime() > Date.now()) ||
        ![fixture.player1_id, fixture.player2_id].includes(pairing.opponentUserId) ||
        ![fixture.player1_id, fixture.player2_id].includes(user.id)) {
      throw Object.assign(new Error('Lịch đấu không còn hợp lệ.'), { status: 409 });
    }
    rules = tournament.rules_json;
    pairing.opponentUserId = user.id === fixture.player1_id ? fixture.player2_id : fixture.player1_id;
  } else if (phase === 'practice') {
    const participantCount = await pool.query('SELECT count(*)::int AS count FROM tournament_entries WHERE tournament_id=$1', [pairing.tournamentId]);
    if (tournament.status !== 'registration' || new Date(tournament.registration_closes_at) <= new Date() ||
        new Date(tournament.ends_at) <= new Date() ||
        (tournament.format !== 'group_knockout' && participantCount.rows[0].count >= tournament.max_teams)) {
      throw Object.assign(new Error('Vòng chạy đà đã kết thúc; hãy tìm trận chính thức nếu giải đã mở.'), { status: 409 });
    }
  } else {
    if (tournament.status !== 'qualifying' || new Date(tournament.ends_at) <= new Date()) {
      throw Object.assign(new Error('Giải chưa mở thi đấu chính thức hoặc đã kết thúc.'), { status: 409 });
    }
    if (Number(pairing.week) !== Number(tournament.current_week)) {
      throw Object.assign(new Error('Sprint vừa chuyển tuần; hãy tìm lại trận.'), { status: 409 });
    }
    rules = tournament.rules_json?.id ? tournament.rules_json : weeklyRules(tournament.current_week || 1);
  }
  const participants = await pool.query(
    `SELECT u.id,u.email,u.display_name,u.elo,u.is_admin,u.active_bot_version,b.code AS bot_code
     FROM users u
     LEFT JOIN user_bot_versions b ON b.user_id=u.id AND b.version=u.active_bot_version
     WHERE u.id=ANY($1::uuid[])`,
    [[user.id, pairing.opponentUserId]]
  );
  const byUser = new Map(participants.rows.map(row => [row.id, row]));
  const own = byUser.get(user.id);
  const opponent = byUser.get(pairing.opponentUserId);
  if (!own || !opponent) throw new Error('Không tìm thấy tài khoản của người chơi.');
  if (!own.bot_code || !opponent.bot_code) {
    throw Object.assign(new Error('Một trong hai người chơi chưa nộp Bot Python hợp lệ.'), { status: 409 });
  }
  const first = user.id < opponent.id ? own : opponent;
  const second = user.id < opponent.id ? opponent : own;
  const matchId = randomUUID();
  const seed = randomInt(1, 0x7fffffff);
  const consensusState = createInitialConsensusState('bot');
  const matchClient = fixture ? await pool.connect() : null;
  const matchDb = matchClient || pool;
  try {
    if (matchClient) {
      await matchClient.query('BEGIN');
      const lockedTournament = await matchClient.query(
        `SELECT format,status,tournament_starts_at FROM tournaments
         WHERE id=$1 FOR UPDATE`,
        [pairing.tournamentId]
      );
      const currentTournament = lockedTournament.rows[0];
      const expectedStatus = phase === 'group' ? 'group_running' : 'knockout';
      if (!currentTournament || currentTournament.format !== 'group_knockout' ||
          currentTournament.status !== expectedStatus ||
          new Date(currentTournament.tournament_starts_at).getTime() > Date.now()) {
        throw Object.assign(new Error('Giải không còn mở để bắt đầu trận này.'), { status: 409 });
      }
      const lockedFixture = await matchClient.query(
        `SELECT id FROM tournament_fixtures
         WHERE id=$1 AND tournament_id=$2 AND phase=$3 AND status='active' AND match_id IS NULL
         FOR UPDATE`,
        [fixture.id, pairing.tournamentId, phase]
      );
      if (!lockedFixture.rowCount) {
        throw Object.assign(new Error('Trận theo lịch đã được bắt đầu hoặc cập nhật.'), { status: 409 });
      }
    }
    await matchDb.query(
      `INSERT INTO matches(
         id,seed,player1_id,player2_id,status,match_type,tournament_id,tournament_phase,
         tournament_rules,tournament_fixture_id,player1_bot_version,player2_bot_version,consensus_state
       )
       VALUES($1,$2,$3,$4,'active','bot',$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        matchId,
        seed,
        first.id,
        second.id,
        pairing.tournamentId,
        phase,
        rules ? JSON.stringify(rules) : null,
        fixture?.id || null,
        first.active_bot_version,
        second.active_bot_version,
        JSON.stringify(consensusState)
      ]
    );
    if (fixture) {
      const linkedFixture = await matchDb.query(
        'UPDATE tournament_fixtures SET match_id=$1 WHERE id=$2 AND status=$3 AND match_id IS NULL RETURNING id',
        [matchId, fixture.id, 'active']
      );
      if (!linkedFixture.rowCount) {
        throw Object.assign(new Error('Trận theo lịch đã được bắt đầu hoặc cập nhật.'), { status: 409 });
      }
    }
    if (matchClient) await matchClient.query('COMMIT');
  } catch (error) {
    if (matchClient) await matchClient.query('ROLLBACK');
    throw error;
  } finally {
    if (matchClient) matchClient.release();
  }
  const baseMatch = {
    id: matchId,
    seed,
    pieceCount: 9,
    mode: 'bot',
    player1_id: first.id,
    player2_id: second.id,
    tournament_id: pairing.tournamentId,
    tournamentId: pairing.tournamentId,
    tournamentPhase: phase,
    rules,
    player1: { id: first.id, displayName: first.display_name, elo: first.elo },
    player2: { id: second.id, displayName: second.display_name, elo: second.elo },
    created_at: new Date().toISOString()
  };
  for (const [player, role, seat, other] of [[first, 'player1', 1, second], [second, 'player2', 2, first]]) {
    await deliverToUser(player.id, 'match-found', {
      match: baseMatch,
      role,
      seat,
      opponent: publicUser(other),
      signaling: 'server-relay',
      mode: 'bot',
      tournamentPhase: phase,
      tournamentRules: rules,
      myBotCode: player.bot_code,
      myBotVersion: player.active_bot_version
    });
  }
}

async function prepareGroupKnockoutFixture(tournamentId, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tournamentResult = await client.query(
      `SELECT id,status,tournament_starts_at,execution_mode FROM tournaments
       WHERE id=$1 AND format='group_knockout' FOR UPDATE`,
      [tournamentId]
    );
    const tournament = tournamentResult.rows[0];
    if (tournament?.execution_mode === 'server' && tournament.status === 'group_running') {
      throw Object.assign(new Error('Server đang tự chạy vòng bảng; bạn không cần tìm trận.'), { status: 409 });
    }
    if (!tournament || !['group_running', 'knockout'].includes(tournament.status) ||
        (tournament.status === 'knockout' && new Date(tournament.tournament_starts_at).getTime() > Date.now())) {
      throw Object.assign(new Error('Giải chưa đến thời gian thi đấu.'), { status: 409 });
    }
    const fixtureResult = await client.query(
      `SELECT * FROM tournament_fixtures
       WHERE tournament_id=$1 AND status='pending' AND $2::uuid IN (player1_id,player2_id)
       ORDER BY phase,round_number,match_number,leg
       LIMIT 1 FOR UPDATE`,
      [tournamentId, userId]
    );
    const fixture = fixtureResult.rows[0];
    if (!fixture) {
      await client.query('COMMIT');
      return null;
    }
    const readinessColumn = fixture.player1_id === userId ? 'player1_ready_at' : 'player2_ready_at';
    const updated = await client.query(
      `UPDATE tournament_fixtures SET ${readinessColumn}=COALESCE(${readinessColumn},now())
       WHERE id=$1 AND status='pending' RETURNING *`,
      [fixture.id]
    );
    const readyFixture = updated.rows[0];
    if (!readyFixture.player1_ready_at || !readyFixture.player2_ready_at) {
      await client.query('COMMIT');
      return null;
    }
    const activated = await client.query(
      `UPDATE tournament_fixtures SET status='active'
       WHERE id=$1 AND status='pending' RETURNING *`,
      [fixture.id]
    );
    await client.query('COMMIT');
    return activated.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function clearGroupKnockoutReadiness(tournamentId, userId) {
  await pool.query(
    `UPDATE tournament_fixtures SET player1_ready_at=NULL
     WHERE tournament_id=$1 AND player1_id=$2 AND status='pending'`,
    [tournamentId, userId]
  );
  await pool.query(
    `UPDATE tournament_fixtures SET player2_ready_at=NULL
     WHERE tournament_id=$1 AND player2_id=$2 AND status='pending'`,
    [tournamentId, userId]
  );
}

async function runIndividualTournamentSearch(userId) {
  await updateTournamentLifecycle();
  searchTimers.delete(userId);
  const socket = userSocket(userId);
  const search = socket?.tournamentSearch;
  if (!socket || !search || socket.searchCancelled) return;
  const result = await pool.query(
    `SELECT t.id AS tournament_id,t.format,t.status,t.registration_closes_at,
            t.tournament_starts_at,t.ends_at,t.max_teams,t.current_week,t.rules_json,
            e.rank_stars,e.season_points,e.tier,u.elo,u.active_bot_version,
            (SELECT count(*)::int FROM tournament_entries entries WHERE entries.tournament_id=t.id) AS participant_count
     FROM tournaments t JOIN tournament_entries e ON e.tournament_id=t.id AND e.player_id=$2
     JOIN users u ON u.id=e.player_id
     WHERE t.id=$1`, [search.tournamentId, userId]
  );
  const row = result.rows[0];
  if (!row || row.status === 'completed' || new Date(row.ends_at).getTime() <= Date.now()) {
    socket.searchCancelled = true; socket.searching = false;
    await cancelTournamentQueue(redis, search.tournamentId, userId, userId, search.week, tournamentQueueNamespace(search));
    socket.tournamentSearch = null;
    return send(socket, 'error', { message: 'Giải đấu đã kết thúc hoặc bạn chưa đăng ký.' });
  }
  if (!row.active_bot_version || row.active_bot_version <= 0) {
    socket.searchCancelled = true; socket.searching = false;
    await cancelTournamentQueue(redis, search.tournamentId, userId, userId, search.week, tournamentQueueNamespace(search));
    socket.tournamentSearch = null;
    return send(socket, 'error', { message: 'Bạn cần lưu Bot Python hợp lệ trong Phòng Lab trước khi tìm trận giải đấu.' });
  }
  if (row.format === 'group_knockout') {
    if (!['group_running', 'knockout'].includes(row.status)) {
      socket.searchCancelled = true;
      socket.searching = false;
      socket.tournamentSearch = null;
      return send(socket, 'error', { message: 'Giải chưa vào giai đoạn thi đấu.' });
    }
    const fixture = await prepareGroupKnockoutFixture(row.tournament_id, userId);
    if (socket.searchCancelled || socket.tournamentSearch !== search) return;
    if (!fixture) {
      searchTimers.set(userId, setTimeout(() => runIndividualTournamentSearch(userId).catch(error => {
        console.error('Group tournament fixture search failed:', error);
        socket.searchCancelled = true;
        socket.searching = false;
        socket.tournamentSearch = null;
        send(socket, 'error', { message: 'Không thể tìm lịch trận giải đấu lúc này.' });
      }), 2000));
      return;
    }
    const opponentUserId = fixture.player1_id === userId ? fixture.player2_id : fixture.player1_id;
    const opponentSocket = userSocket(opponentUserId);
    for (const [participantId, participantSocket] of [[userId, socket], [opponentUserId, opponentSocket]]) {
      const timer = searchTimers.get(participantId);
      if (timer) clearTimeout(timer);
      searchTimers.delete(participantId);
      if (participantSocket) {
        participantSocket.searchCancelled = true;
        participantSocket.searching = false;
      }
    }
    try {
      const userResult = await pool.query(
        'SELECT id,email,display_name,elo,is_admin,active_bot_version FROM users WHERE id=$1',
        [userId]
      );
      await createIndividualTournamentMatch(userResult.rows[0], {
        tournamentId: row.tournament_id,
        phase: fixture.phase,
        opponentUserId,
        fixtureId: fixture.id
      });
      if (socket.tournamentSearch) socket.tournamentSearch = null;
      if (opponentSocket) opponentSocket.tournamentSearch = null;
    } catch (error) {
      await pool.query(
        `UPDATE tournament_fixtures SET status='pending',match_id=NULL,
           player1_ready_at=NULL,player2_ready_at=NULL
         WHERE id=$1 AND status='active' AND match_id IS NULL`,
        [fixture.id]
      );
      throw error;
    }
    return;
  }
  if (socket.searchCancelled || socket.tournamentSearch !== search) return;
  const phase = row.status === 'registration' ? 'practice' : 'ranked';
  if (phase === 'practice' && (new Date(row.registration_closes_at).getTime() <= Date.now() ||
      (row.format !== 'group_knockout' && row.participant_count >= row.max_teams))) {
    socket.searchCancelled = true; socket.searching = false;
    await cancelTournamentQueue(redis, search.tournamentId, userId, userId, search.week, tournamentQueueNamespace(search));
    socket.tournamentSearch = null;
    return send(socket, 'error', { message: 'Vòng chạy đà đã kết thúc; hãy tìm trận chính thức nếu giải đã mở.' });
  }
  const priorPhase = search.phase;
  const priorWeek = search.week;
  const priorNamespace = tournamentQueueNamespace(search);
  search.phase = phase;
  search.week = phase === 'practice' ? 1 : row.current_week || 1;
  search.tier = phase === 'practice' ? 'Practice' : row.tier;
  const namespace = tournamentQueueNamespace(search);
  if (priorPhase !== phase || Number(priorWeek) !== Number(search.week)) {
    await cancelTournamentQueue(redis, search.tournamentId, userId, userId, priorWeek, priorNamespace);
    send(socket, 'searching', {
      tournamentId: row.tournament_id, mode: 'tournament', tournament: true, phase,
      tier: row.tier, week: row.current_week, rules: phase === 'ranked' ? row.rules_json : null
    });
  }
  const queueScore = phase === 'practice'
    ? row.elo
    : (row.tier === 'Challenger' ? row.season_points * 100 : row.rank_stars * 100);
  // In Practice: random pairing across all waiting participants; in Ranked: pair any two waiting players in the same tier & week
  const paired = await enqueueTournamentOrMatch(
    redis,
    {
      teamId: userId,
      userId,
      version: row.active_bot_version,
      elo: queueScore,
      tier: phase === 'practice' ? 'Practice' : row.tier,
      week: search.week
    },
    row.tournament_id,
    1000000,
    namespace,
    { randomPairing: phase === 'practice' }
  );
  if (paired) {
    socket.searchCancelled = true; socket.searching = false;
    const otherSocket = userSocket(paired.opponentUserId);
    if (otherSocket) { otherSocket.searchCancelled = true; otherSocket.searching = false; }
    await Promise.all([
      cancelTournamentQueue(redis, row.tournament_id, userId, userId, search.week, namespace),
      cancelTournamentQueue(redis, row.tournament_id, paired.opponentTeamId, paired.opponentUserId, paired.week, namespace)
    ]);
    const userResult = await pool.query('SELECT id,email,display_name,elo,is_admin,active_bot_version FROM users WHERE id=$1', [userId]);
    await createIndividualTournamentMatch(userResult.rows[0], {
      tournamentId: row.tournament_id, phase, week: search.week,
      opponentUserId: paired.opponentUserId
    });
    socket.tournamentSearch = null;
    if (otherSocket) otherSocket.tournamentSearch = null;
    return;
  }
  searchTimers.set(userId, setTimeout(() => runIndividualTournamentSearch(userId).catch(error => {
    console.error('Individual tournament matchmaking retry failed:', error);
    socket.searchCancelled = true; socket.searching = false;
    cancelTournamentQueue(redis, search.tournamentId, userId, userId, search.week, tournamentQueueNamespace(search)).catch(() => {});
    socket.tournamentSearch = null;
    send(socket, 'error', { message: 'Không thể tìm trận giải đấu lúc này.' });
  }), 2000));
}

async function runTournamentSearch(userId) {
  if (userSocket(userId)?.tournamentSearch?.individual) return runIndividualTournamentSearch(userId);
  await updateTournamentLifecycle();
  searchTimers.delete(userId);
  const socket = userSocket(userId);
  const search = socket?.tournamentSearch;
  if (!socket || !search || socket.searchCancelled) return;
  const entry = await pool.query(
    `SELECT t.id AS tournament_id,t.name AS tournament_name,t.status,t.ends_at,t.current_week,t.rules_json,
            e.rank_stars,e.tier,team.id AS team_id,team.name AS team_name,team.captain_id,
            bot.version,bot.code,bot.code_sha256
     FROM tournaments t
     JOIN tournament_entries e ON e.tournament_id=t.id AND e.team_id=$2
     JOIN teams team ON team.id=e.team_id
     JOIN team_bot_versions bot ON bot.team_id=team.id AND bot.version=$3
     WHERE t.id=$1`,
    [search.tournamentId, search.teamId, search.botVersion]
  );
  const row = entry.rows[0];
  if (!row || row.status !== 'qualifying' || new Date(row.ends_at).getTime() <= Date.now()) {
    socket.searchCancelled = true;
    socket.searching = false;
    await cancelTournamentQueue(redis, search.tournamentId, search.teamId, userId, search.week);
    socket.tournamentSearch = null;
    return send(socket, 'error', { message: 'Giải không ở giai đoạn vòng loại hoặc đã kết thúc.' });
  }
  if (row.captain_id !== userId) {
    socket.searchCancelled = true;
    socket.searching = false;
    socket.tournamentSearch = null;
    return send(socket, 'error', { message: 'Chỉ đội trưởng mới có thể đưa đội vào hàng chờ giải.' });
  }
  const priorWeek = search.week;
  const priorTier = search.tier;
  if (search.week && Number(search.week) !== Number(row.current_week)) {
    await cancelTournamentQueue(redis, search.tournamentId, search.teamId, userId, search.week);
  }
  search.week = row.current_week || 1;
  search.tier = row.tier;
  if (Number(priorWeek) !== Number(search.week) || priorTier !== search.tier) {
    send(socket, 'searching', { tournamentId: row.tournament_id, teamId: row.team_id, tournament: true, tier: row.tier, week: row.current_week, rules: row.rules_json });
  }
  const started = socket.searchStartedAt || Date.now();
  const gap = Math.min(config.maxEloGap, config.minEloGap + Math.floor((Date.now() - started) / config.expandEveryMs) * config.minEloGap);
  const paired = await enqueueTournamentOrMatch(redis, {
    teamId: row.team_id, userId, version: row.version, elo: row.rank_stars * 100, tier: row.tier, week: row.current_week
  }, row.tournament_id, gap);
  if (paired) {
    socket.searchCancelled = true;
    socket.searching = false;
    const otherSocket = userSocket(paired.opponentUserId);
    if (otherSocket) { otherSocket.searchCancelled = true; otherSocket.searching = false; }
    await Promise.all([
      cancelTournamentQueue(redis, row.tournament_id, row.team_id, userId, row.current_week),
      cancelTournamentQueue(redis, row.tournament_id, paired.opponentTeamId, paired.opponentUserId, paired.week)
    ]);
    const userResult = await pool.query('SELECT id,email,display_name,elo,is_admin FROM users WHERE id=$1', [userId]);
    await createTournamentMatch(userResult.rows[0], {
      tournamentId: row.tournament_id,
      tier: row.tier,
      week: row.current_week,
      rules: row.rules_json,
      teamId: row.team_id,
      botVersion: row.version,
      opponentTeamId: paired.opponentTeamId,
      opponentUserId: paired.opponentUserId,
      opponentVersion: paired.opponentVersion
    });
    socket.tournamentSearch = null;
    if (otherSocket) otherSocket.tournamentSearch = null;
    return;
  }
  searchTimers.set(userId, setTimeout(() => runTournamentSearch(userId).catch(error => {
    console.error('Tournament matchmaking retry failed:', error);
    socket.searchCancelled = true;
    socket.searching = false;
    cancelTournamentQueue(redis, search.tournamentId, search.teamId, userId, search.week).catch(() => {});
    socket.tournamentSearch = null;
    send(socket, 'error', { message: 'Không thể tìm trận giải đấu lúc này.' });
  }), 2000));
}

async function runSearch(userId, mode = 'human') {
  searchTimers.delete(userId);
  const socket = userSocket(userId);
  if (!socket || socket.searchCancelled) return;
  const userResult = await pool.query('SELECT id, email, display_name, elo FROM users WHERE id=$1', [userId]);
  const user = userResult.rows[0];
  if (!user) return;
  const started = socket.searchStartedAt || Date.now();
  const gap = Math.min(config.maxEloGap, config.minEloGap + Math.floor((Date.now() - started) / config.expandEveryMs) * config.minEloGap);
  const queueName = mode === 'bot' ? 'ottv2:bot-matchmaking' : 'ottv2:matchmaking';
  const paired = await enqueueOrMatch(redis, user, { ...config, currentGap: gap, queueName });
  if (paired) {
    socket.searchCancelled = true;
    await Promise.all([cancelQueue(redis, userId, queueName), cancelQueue(redis, paired.opponentId, queueName)]);
    await createMatch(user, paired, mode);
    return;
  }
  searchTimers.set(userId, setTimeout(() => runSearch(userId, mode).catch(err => {
    console.error('Matchmaking retry failed:', err);
    searchTimers.delete(userId);
    if (liveSockets.get(userId) === socket) {
      socket.searchCancelled = true;
      socket.searching = false;
    }
    cancelQueue(redis, userId, queueName).catch(cleanupError => {
      console.error('Could not clear failed matchmaking queue entry:', cleanupError);
    });
    send(socket, 'error', { message: 'Matchmaking temporarily unavailable', mode });
  }), 2000));
}

async function initializeTournamentEntries(tournamentId) {
  await pool.query(
    `UPDATE tournament_entries entry SET
       tier=CASE WHEN COALESCE(rating.elo,1200)>=1600 THEN 'Gold'
                 WHEN COALESCE(rating.elo,1200)>=1350 THEN 'Silver' ELSE 'Bronze' END,
       rank_stars=0,season_points=0,matches_played=0,wins=0,draws=0,losses=0
     FROM (SELECT tm.team_id,ROUND(AVG(u.elo))::int AS elo FROM team_members tm JOIN users u ON u.id=tm.user_id GROUP BY tm.team_id) rating
     WHERE entry.tournament_id=$1 AND entry.team_id=rating.team_id`,
    [tournamentId]
  );
  await pool.query(
    `UPDATE tournament_entries entry SET
       tier=CASE WHEN u.elo>=1600 THEN 'Gold'
                 WHEN u.elo>=1350 THEN 'Silver' ELSE 'Bronze' END,
       rank_stars=0,season_points=0,matches_played=0,wins=0,draws=0,losses=0
     FROM users u WHERE entry.tournament_id=$1 AND entry.player_id=u.id`,
    [tournamentId]
  );
}

async function applyTournamentSprintResets(tournamentId, fromWeek, toWeek) {
  const steps = Math.max(0, Number(toWeek) - Math.max(1, Number(fromWeek) || 1));
  if (!steps) return;
  const client = await pool.connect();
  let ackReceipt = null;
  try {
    await client.query('BEGIN');
    const entries = await client.query(
      'SELECT player_id, team_id, tier, rank_stars, season_points FROM tournament_entries WHERE tournament_id=$1 FOR UPDATE',
      [tournamentId]
    );
    for (const row of entries.rows) {
      let tier = row.tier;
      let stars = row.rank_stars;
      let seasonPoints = row.season_points;
      for (let s = 0; s < steps; s++) {
        const next = applySprintRankReset(tier, stars, seasonPoints);
        tier = next.tier;
        stars = next.stars;
        seasonPoints = next.seasonPoints;
      }
      if (row.player_id) {
        await client.query(
          'UPDATE tournament_entries SET tier=$3, rank_stars=$4, season_points=$5 WHERE tournament_id=$1 AND player_id=$2',
          [tournamentId, row.player_id, tier, stars, seasonPoints]
        );
      } else if (row.team_id) {
        await client.query(
          'UPDATE tournament_entries SET tier=$3, rank_stars=$4, season_points=$5 WHERE tournament_id=$1 AND team_id=$2',
          [tournamentId, row.team_id, tier, stars, seasonPoints]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function captureTournamentSprint(tournamentId, sprint) {
  await pool.query(
    `INSERT INTO tournament_sprint_standings
       (tournament_id,sprint,player_id,tier,rank_stars,season_points,matches_played,wins,draws,losses,registered_at)
     SELECT tournament_id,$2,player_id,tier,rank_stars,season_points,matches_played,wins,draws,losses,registered_at
     FROM tournament_entries
     WHERE tournament_id=$1 AND player_id IS NOT NULL
     ON CONFLICT (tournament_id,sprint,player_id) DO NOTHING`,
    [tournamentId, sprint]
  );
}

async function updateTournamentLifecycle() {
  await pool.query(
    "UPDATE tournaments SET status='registration' WHERE format='group_knockout' AND status='scheduled' AND registration_opens_at<=now()"
  );
  await pool.query(
    `UPDATE tournaments SET status='grouping'
     WHERE format='group_knockout' AND status='registration'
       AND registration_closes_at<=now()`
  );
  const uninitialized = await pool.query("SELECT id,rules_schedule,total_sprints FROM tournaments WHERE format='ranked_weekly' AND status='qualifying' AND week_started_at IS NULL");
  for (const tournament of uninitialized.rows) {
    const initialized = await pool.query(
      "UPDATE tournaments SET current_week=1,last_reset_week=1,week_started_at=now(),registration_closes_at=LEAST(registration_closes_at,now()),ends_at=now()+(total_sprints * interval '7 days'),rules_json=$1::jsonb WHERE id=$2 AND week_started_at IS NULL RETURNING id",
      [JSON.stringify(weeklyRules(1, tournament.rules_schedule)), tournament.id]
    );
    if (!initialized.rowCount) continue;
    await initializeTournamentEntries(tournament.id);
    await clearTournamentQueues(tournament.id, 0, 1);
  }
  const starting = await pool.query(
    `SELECT t.id,t.rules_schedule,t.total_sprints FROM tournaments t
     WHERE t.format='ranked_weekly' AND t.status='registration' AND t.ends_at>now()
       AND (t.registration_closes_at<=now() OR
         (SELECT count(*) FROM tournament_entries entries WHERE entries.tournament_id=t.id)>=t.max_teams)`
  );
  for (const tournament of starting.rows) {
    const started = await pool.query(
      `UPDATE tournaments SET status='qualifying',current_week=1,last_reset_week=1,week_started_at=now(),
         registration_closes_at=LEAST(registration_closes_at,now()),ends_at=now()+(total_sprints * interval '7 days'),rules_json=$1::jsonb
       WHERE id=$2 AND status='registration' RETURNING id`,
      [JSON.stringify(weeklyRules(1, tournament.rules_schedule)), tournament.id]
    );
    if (started.rowCount) {
      await initializeTournamentEntries(tournament.id);
      await clearTournamentQueues(tournament.id, 0, 1);
    }
  }

  await pool.query(
    `UPDATE matches m SET status='abandoned'
     FROM tournaments t
     WHERE m.tournament_id=t.id AND m.status='active' AND t.format='ranked_weekly'
       AND (
         t.ends_at <= now() OR
         (m.tournament_phase='practice' AND (
           t.status <> 'registration' OR t.registration_closes_at <= now() OR
           (SELECT count(*) FROM tournament_entries entries WHERE entries.tournament_id=t.id)>=t.max_teams
         )) OR
         (m.tournament_phase <> 'practice' AND (
           t.status <> 'qualifying' OR t.week_started_at IS NULL OR
           COALESCE(
             CASE WHEN (m.tournament_rules->>'week') ~ '^[0-9]+$'
               THEN (m.tournament_rules->>'week')::integer
               ELSE 0
             END,
             0
           ) <> t.current_week
         ))
       )`
  );

  const active = await pool.query(
    `SELECT id,current_week,total_sprints,COALESCE(last_reset_week, GREATEST(1, current_week)) AS last_reset_week,week_started_at,rules_schedule
     FROM tournaments
     WHERE format='ranked_weekly' AND status='qualifying' AND week_started_at IS NOT NULL AND ends_at>now()`
  );
  const now = Date.now();
  for (const tournament of active.rows) {
    const elapsedWeeks = Math.floor((now - new Date(tournament.week_started_at).getTime()) / WEEK_MS);
    const nextWeek = Math.max(1, elapsedWeeks + 1);
    if (nextWeek <= tournament.current_week) continue;
    await captureTournamentSprint(tournament.id, tournament.current_week);
    if (nextWeek > tournament.total_sprints) {
      await pool.query(
        "UPDATE tournaments SET status='completed',ends_at=LEAST(ends_at,now()) WHERE id=$1 AND status='qualifying'",
        [tournament.id]
      );
      await clearTournamentQueues(tournament.id, 0, tournament.current_week);
      continue;
    }
    await applyTournamentSprintResets(tournament.id, tournament.last_reset_week || tournament.current_week, nextWeek);
    const rules = weeklyRules(nextWeek, tournament.rules_schedule);
    await pool.query(
      'UPDATE tournaments SET current_week=$1,last_reset_week=$1,rules_json=$2::jsonb WHERE id=$3',
      [nextWeek, JSON.stringify(rules), tournament.id]
    );
    await clearTournamentQueues(tournament.id, 0, tournament.current_week, nextWeek);
  }
  await pool.query(  `UPDATE tournaments SET status='completed' WHERE format='ranked_weekly' AND status <> 'completed' AND ends_at <= now()`);
}

async function registerSessionKey(userId, packet) {
  if (!packet.matchId || !packet.publicKey) throw new Error('Missing matchId/publicKey');
  const result = await pool.query('SELECT id, player1_id, player2_id FROM matches WHERE id=$1 AND status IN (\'active\',\'pending\')', [packet.matchId]);
  const match = result.rows[0];
  if (!match || !canonicalMatchIds(match).includes(userId)) throw new Error('Player is not part of this active match');
  const key = packet.publicKey;
  if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string') throw new Error('Only ECDSA P-256 session keys are accepted');
  const column = match.player1_id === userId ? 'player1_key' : 'player2_key';
  await pool.query(`UPDATE matches SET ${column}=$1::jsonb WHERE id=$2`, [JSON.stringify(key), packet.matchId]);
  const otherId = match.player1_id === userId ? match.player2_id : match.player1_id;
  await deliverToUser(otherId, 'peer-session-key', { matchId: packet.matchId, playerId: userId, publicKey: key });
  const otherKey = match.player1_id === userId ? match.player2_key : match.player1_key;
  if (otherKey) {
    await deliverToUser(userId, 'peer-session-key', { matchId: packet.matchId, playerId: otherId, publicKey: otherKey });
  }
}

async function updateTournamentEntriesForResult(client, match, score1) {
  if (!match.tournament_id || match.tournament_phase === 'practice' || match.is_sparring) return new Map();
  const tournamentType = await client.query(
    'SELECT format FROM tournaments WHERE id=$1',
    [match.tournament_id]
  );
  if (tournamentType.rows[0]?.format === 'group_knockout') {
    const entries = await client.query(
      'SELECT player_id FROM tournament_entries WHERE tournament_id=$1 AND player_id=ANY($2::uuid[]) ORDER BY player_id FOR UPDATE',
      [match.tournament_id, [match.player1_id, match.player2_id]]
    );
    if (entries.rowCount !== 2) {
      throw Object.assign(new Error('Tournament entry missing for this fixture'), { status: 409 });
    }
    for (const [playerId, score] of [
      [match.player1_id, score1],
      [match.player2_id, 1 - score1]
    ]) {
      await client.query(
        `UPDATE tournament_entries SET
           matches_played=matches_played+1,
           wins=wins+CASE WHEN $3=1 THEN 1 ELSE 0 END,
           draws=draws+CASE WHEN $3=0.5 THEN 1 ELSE 0 END,
           losses=losses+CASE WHEN $3=0 THEN 1 ELSE 0 END,
           points=points+CASE WHEN $3=1 THEN 3 WHEN $3=0.5 THEN 1 ELSE 0 END
         WHERE tournament_id=$1 AND player_id=$2`,
        [match.tournament_id, playerId, score]
      );
    }
    return new Map();
  }
  const updatesByPlayer = new Map();
  if (match.player1_team_id && match.player2_team_id) {
    const entries = await client.query(
      'SELECT team_id,tier,rank_stars,season_points FROM tournament_entries WHERE tournament_id=$1 AND team_id=ANY($2::uuid[]) ORDER BY team_id FOR UPDATE',
      [match.tournament_id, [match.player1_team_id, match.player2_team_id]]
    );
    const firstEntry = entries.rows.find(entry => entry.team_id === match.player1_team_id);
    const secondEntry = entries.rows.find(entry => entry.team_id === match.player2_team_id);
    if (!firstEntry || !secondEntry) throw Object.assign(new Error('Tournament entry missing for this match'), { status: 409 });
    for (const [entry, playerId, score] of [[firstEntry, match.player1_id, score1], [secondEntry, match.player2_id, 1 - score1]]) {
      const progress = applyTournamentResult(entry.tier, entry.rank_stars, entry.season_points, score);
      await client.query(
        `UPDATE tournament_entries SET
           matches_played=matches_played+1,
           wins=wins+CASE WHEN $3=1 THEN 1 ELSE 0 END,
           draws=draws+CASE WHEN $3=0.5 THEN 1 ELSE 0 END,
           losses=losses+CASE WHEN $3=0 THEN 1 ELSE 0 END,
           tier=$4,rank_stars=$5,season_points=$6
         WHERE tournament_id=$1 AND team_id=$2`,
        [match.tournament_id, entry.team_id, score, progress.tier, progress.stars, progress.seasonPoints]
      );
      updatesByPlayer.set(playerId, { ...progress, phase: match.tournament_phase });
    }
    return updatesByPlayer;
  }
  const entries = await client.query(
    'SELECT player_id,tier,rank_stars,season_points FROM tournament_entries WHERE tournament_id=$1 AND player_id=ANY($2::uuid[]) ORDER BY player_id FOR UPDATE',
    [match.tournament_id, [match.player1_id, match.player2_id]]
  );
  const firstEntry = entries.rows.find(entry => entry.player_id === match.player1_id);
  const secondEntry = entries.rows.find(entry => entry.player_id === match.player2_id);
  if (!firstEntry || !secondEntry) throw Object.assign(new Error('Individual tournament entry missing for this match'), { status: 409 });
  for (const [entry, score] of [[firstEntry, score1], [secondEntry, 1 - score1]]) {
    const progress = applyTournamentResult(entry.tier, entry.rank_stars, entry.season_points, score);
    await client.query(
      `UPDATE tournament_entries SET
         matches_played=matches_played+1,
         wins=wins+CASE WHEN $3=1 THEN 1 ELSE 0 END,
         draws=draws+CASE WHEN $3=0.5 THEN 1 ELSE 0 END,
         losses=losses+CASE WHEN $3=0 THEN 1 ELSE 0 END,
         tier=$4,rank_stars=$5,season_points=$6
       WHERE tournament_id=$1 AND player_id=$2`,
      [match.tournament_id, entry.player_id, score, progress.tier, progress.stars, progress.seasonPoints]
    );
    updatesByPlayer.set(entry.player_id, { ...progress, phase: match.tournament_phase });
  }
  return updatesByPlayer;
}

async function completePostgresTournamentFixture(client, match, score1, moveCount) {
  if (!match.tournament_id || !match.tournament_fixture_id) return;
  const tournamentResult = await client.query(
    'SELECT id,status,group_count FROM tournaments WHERE id=$1 AND format=$2 FOR UPDATE',
    [match.tournament_id, 'group_knockout']
  );
  const tournament = tournamentResult.rows[0];
  if (!tournament || !['group_running', 'knockout'].includes(tournament.status)) return;
  const fixtureResult = await client.query(
    `SELECT * FROM tournament_fixtures
     WHERE id=$1 AND tournament_id=$2 AND status='active' FOR UPDATE`,
    [match.tournament_fixture_id, match.tournament_id]
  );
  const fixture = fixtureResult.rows[0];
  if (!fixture) return;
  if (fixture.phase === 'knockout' && score1 === 0.5) {
    await client.query(
      `UPDATE tournament_fixtures SET status='pending',leg=leg+1,match_id=NULL,
         player1_ready_at=NULL,player2_ready_at=NULL,winner_id=NULL,move_count=$1
       WHERE id=$2`,
      [moveCount, fixture.id]
    );
    return;
  }
  const winnerId = score1 === 1 ? match.player1_id : score1 === 0 ? match.player2_id : null;
  await client.query(
    `UPDATE tournament_fixtures SET status='completed',winner_id=$1,move_count=$2
     WHERE id=$3`,
    [winnerId, moveCount, fixture.id]
  );

  if (fixture.phase === 'group') {
    const remaining = await client.query(
      `SELECT 1 FROM tournament_fixtures
       WHERE tournament_id=$1 AND phase='group' AND status<>'completed' LIMIT 1`,
      [match.tournament_id]
    );
    if (remaining.rowCount) return;
    await client.query(
      "UPDATE tournaments SET status='group_complete' WHERE id=$1 AND status='group_running'",
      [match.tournament_id]
    );
    return;
  }

  const currentRound = await client.query(
    `SELECT * FROM tournament_fixtures
     WHERE tournament_id=$1 AND phase='knockout'
       AND round_number=(SELECT max(round_number) FROM tournament_fixtures
                        WHERE tournament_id=$1 AND phase='knockout')
     ORDER BY match_number FOR UPDATE`,
    [match.tournament_id]
  );
  if (!currentRound.rows.length ||
      currentRound.rows.some(item => item.status !== 'completed' || !item.winner_id)) return;
  const winners = currentRound.rows.map(item => item.winner_id);
  if (winners.length === 1) {
    await client.query(
      "UPDATE tournaments SET status='completed',ends_at=now() WHERE id=$1 AND status='knockout'",
      [match.tournament_id]
    );
    return;
  }
  for (const next of createNextKnockoutRound(
    winners,
    Number(currentRound.rows[0].round_number) + 1
  )) {
    await client.query(
      `INSERT INTO tournament_fixtures(
         tournament_id,phase,round_number,match_number,leg,player1_id,player2_id,status
       ) VALUES($1,'knockout',$2,$3,1,$4,$5,'pending')`,
      [
        match.tournament_id,
        next.roundNumber,
        next.matchNumber,
        next.player1Id,
        next.player2Id
      ]
    );
  }
}

async function isCurrentGroupKnockoutFixture(client, match, tournament) {
  const expectedStatus = match.tournament_phase === 'group' ? 'group_running'
    : match.tournament_phase === 'knockout' ? 'knockout' : null;
  if (!expectedStatus || tournament?.format !== 'group_knockout' ||
      tournament.status !== expectedStatus || !tournament.before_start ||
      !match.tournament_fixture_id) return false;
  const fixture = await client.query(
    `SELECT 1 FROM tournament_fixtures
     WHERE id=$1 AND tournament_id=$2 AND match_id=$3
       AND phase=$4 AND status='active'`,
    [match.tournament_fixture_id, match.tournament_id, match.id, match.tournament_phase]
  );
  return fixture.rowCount === 1;
}

async function adjudicateMatchForfeit(matchId, offenderId, reasonCode, winnerMessage, loserMessage) {
  const client = await pool.connect();
  let outcome = null;
  try {
    await client.query('BEGIN');
    const found = await client.query("SELECT * FROM matches WHERE id=$1 AND status='active' FOR UPDATE", [matchId]);
    const match = found.rows[0];
    if (!match || !canonicalMatchIds(match).includes(offenderId)) {
      await client.query('COMMIT');
      return null;
    }
    if (match.tournament_fixture_id) {
      const tournamentResult = await client.query(
        `WITH checked AS (SELECT clock_timestamp() AS at)
         SELECT t.format,t.status,
                checked.at >= t.tournament_starts_at AS before_start
         FROM tournaments t CROSS JOIN checked WHERE t.id=$1`,
        [match.tournament_id]
      );
      if (!await isCurrentGroupKnockoutFixture(client, match, tournamentResult.rows[0])) {
        await client.query('COMMIT');
        return null;
      }
    }
    const winnerId = offenderId === match.player1_id ? match.player2_id : match.player1_id;
    const score1 = winnerId === match.player1_id ? 1 : 0;
    const users = await client.query('SELECT id,elo FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[match.player1_id, match.player2_id]]);
    const player1 = users.rows.find(u => u.id === match.player1_id);
    const player2 = users.rows.find(u => u.id === match.player2_id);
    if (!player1 || !player2) throw new Error('Player in match no longer exists');

    const eloUpdated = match.match_type === 'bot' && !match.is_sparring;
    const p1After = eloUpdated ? calculateElo(player1.elo, player2.elo, score1, config.fideK) : player1.elo;
    const p2After = eloUpdated ? calculateElo(player2.elo, player1.elo, 1 - score1, config.fideK) : player2.elo;
    if (eloUpdated) {
      await client.query('UPDATE users SET elo=$1 WHERE id=$2', [p1After, player1.id]);
      await client.query('UPDATE users SET elo=$1 WHERE id=$2', [p2After, player2.id]);
    }
    await client.query(
      `INSERT INTO match_results(match_id,player1_elo_before,player2_elo_before,player1_elo_after,player2_elo_after,result_player1)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (match_id) DO NOTHING`,
      [match.id, player1.elo, player2.elo, p1After, p2After, score1]
    );
    const tournamentUpdates = await updateTournamentEntriesForResult(client, match, score1);
    const finalStepCount = Number(match.consensus_state?.currentStep) || 0;
    await completePostgresTournamentFixture(client, match, score1, finalStepCount);
    await client.query(
      `UPDATE matches SET status='completed',winner_id=$1,final_step_count=$2,completed_at=now(),
         disconnected_player_id=NULL,disconnected_at=NULL
       WHERE id=$3 AND status='active'`,
      [winnerId, finalStepCount, match.id]
    );
    await client.query('COMMIT');
    outcome = {
      matchId: match.id,
      winnerId,
      offenderId,
      player1Id: match.player1_id,
      player2Id: match.player2_id,
      winnerPlayer: winnerId === match.player1_id ? 1 : 2,
      offenderPlayer: offenderId === match.player1_id ? 1 : 2,
      reason: reasonCode,
      eloUpdated,
      p1Before: player1.elo,
      p1After,
      p2Before: player2.elo,
      p2After,
      tournamentUpdates
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (outcome?.matchId) sparringSessions.delete(outcome.matchId);
  for (const playerId of [outcome.player1Id, outcome.player2Id]) {
    const isP1 = playerId === outcome.player1Id;
    const isWinner = playerId === outcome.winnerId;
    await deliverToUser(playerId, 'match-forfeited', {
      matchId: outcome.matchId,
      winnerId: outcome.winnerId,
      winnerPlayer: outcome.winnerPlayer,
      offenderId: outcome.offenderId,
      offenderPlayer: outcome.offenderPlayer,
      reason: outcome.reason,
      message: isWinner ? winnerMessage : loserMessage,
      eloUpdated: outcome.eloUpdated,
      eloBefore: isP1 ? outcome.p1Before : outcome.p2Before,
      eloAfter: isP1 ? outcome.p1After : outcome.p2After,
      tournamentUpdate: outcome.tournamentUpdates.get(playerId) || null
    });
  }
  return outcome;
}

async function submitResult(userId, body) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [body.matchId]);
    const match = result.rows[0];
    if (!match || !canonicalMatchIds(match).includes(userId)) throw Object.assign(new Error('Match not found for this player'), { status: 404 });
    if (match.status === 'completed') {
      const prior = await client.query('SELECT * FROM match_results WHERE match_id=$1', [body.matchId]);
      await client.query('COMMIT');
      const row = prior.rows[0];
      sparringSessions.delete(match.id);
      return {
        alreadySubmitted: true,
        matchId: match.id,
        winnerId: match.winner_id,
        finalStateHash: match.final_state_hash,
        elo: row ? { player1: { before: row.player1_elo_before, after: row.player1_elo_after }, player2: { before: row.player2_elo_before, after: row.player2_elo_after } } : null,
        eloUpdated: match.match_type === 'bot' && !match.is_sparring,
        replaySha256: match.replay_sha256
      };
    }
    if (match.status !== 'active') throw Object.assign(new Error('Match is not active'), { status: 409 });
    if (match.tournament_id) {
      const lifecycle = await client.query(
        `WITH checked AS (SELECT clock_timestamp() AS at)
         SELECT t.format,t.status,t.registration_closes_at,t.tournament_starts_at,t.ends_at,t.max_teams,t.week_started_at,t.current_week,
                checked.at < t.ends_at AS before_end,
                checked.at < t.registration_closes_at AS before_registration_close,
                checked.at >= t.tournament_starts_at AS before_start,
                (SELECT count(*)::int FROM tournament_entries entries WHERE entries.tournament_id=t.id) AS participant_count
         FROM tournaments t CROSS JOIN checked WHERE t.id=$1`,
        [match.tournament_id]
      );
      const tournament = lifecycle.rows[0];
      const practiceStillOpen = tournament?.status === 'registration' && tournament.before_registration_close &&
        (tournament.format === 'group_knockout' || tournament.participant_count < tournament.max_teams);
      const matchWeek = Number(match.tournament_rules?.week);
      const rankedSprintStillOpen = tournament?.status === 'qualifying' && tournament.before_end &&
        Number.isInteger(matchWeek) && matchWeek === Number(tournament.current_week);
      const groupKnockoutStillOpen = await isCurrentGroupKnockoutFixture(client, match, tournament);
      const validPhase = match.tournament_phase === 'practice' ? practiceStillOpen
        : ['group', 'knockout'].includes(match.tournament_phase)
          ? groupKnockoutStillOpen
          : rankedSprintStillOpen;
      if (!validPhase) {
        await client.query("UPDATE matches SET status='abandoned' WHERE id=$1 AND status='active'", [match.id]);
        await client.query('COMMIT');
        return {
          rejectedLate: true,
          matchId: match.id,
          error: match.tournament_phase === 'practice'
            ? 'Vòng chạy đà đã kết thúc trước khi kết quả được nộp; trận bị loại và không được tính Elo.'
            : 'Sprint hoặc giải đã kết thúc trước khi kết quả được nộp; trận bị loại và không được tính điểm hay Elo.'
        };
      }
    }
    const p1 = body.proofs?.player1;
    const p2 = body.proofs?.player2;
    if (!p1?.proof || !p1.signature || !p2?.proof || !p2.signature) throw Object.assign(new Error('Both signed player proofs are required'), { status: 400 });
    if (!match.player1_key || !match.player2_key) throw Object.assign(new Error('Both session public keys must be registered over the authenticated WebSocket'), { status: 409 });
    const proofShapeValid = proof => proof.matchId === match.id && proof.roomId === match.id &&
      Number.isInteger(proof.stepCount) && proof.stepCount >= 1 && /^[0-9a-f]{64}$/i.test(proof.stateHash || '') &&
      Number.isInteger(proof.winner) && [0, 1, 2].includes(proof.winner);
    if (!proofShapeValid(p1.proof) || !proofShapeValid(p2.proof) ||
        p1.proof.winner !== p2.proof.winner || p1.proof.stepCount !== p2.proof.stepCount || p1.proof.stateHash !== p2.proof.stateHash) {
      throw Object.assign(new Error('Players submitted conflicting final proofs'), { status: 409 });
    }
    if (!verifySessionProof(match.player1_key, p1.proof, p1.signature) || !verifySessionProof(match.player2_key, p2.proof, p2.signature)) {
      throw Object.assign(new Error('A final proof signature is invalid'), { status: 400 });
    }
    const replayResult = verifyReplay(body.replay, match.seed, match.id, match.tournament_rules || null);
    if (replayResult.finalHash !== p1.proof.stateHash || replayResult.stepCount !== p1.proof.stepCount || replayResult.winner !== p1.proof.winner) {
      throw Object.assign(new Error('Replay result does not match signed final proof'), { status: 400 });
    }
    const usersResult = await client.query('SELECT id, elo FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[match.player1_id, match.player2_id]]);
    const u1 = usersResult.rows.find(user => user.id === match.player1_id);
    const u2 = usersResult.rows.find(user => user.id === match.player2_id);
    const score1 = replayResult.winner === 1 ? 1 : replayResult.winner === 2 ? 0 : 0.5;
    const eloUpdated = match.match_type === 'bot' && !match.is_sparring;
    const elo1 = eloUpdated ? calculateElo(u1.elo, u2.elo, score1, config.fideK) : u1.elo;
    const elo2 = eloUpdated ? calculateElo(u2.elo, u1.elo, 1 - score1, config.fideK) : u2.elo;
    const storedReplay = await replayStorage.put(match.id, body.replay);
    if (eloUpdated) {
      await client.query('UPDATE users SET elo=$1 WHERE id=$2', [elo1, u1.id]);
      await client.query('UPDATE users SET elo=$1 WHERE id=$2', [elo2, u2.id]);
    }
    await client.query('INSERT INTO match_results(match_id,player1_elo_before,player2_elo_before,player1_elo_after,player2_elo_after,result_player1) VALUES($1,$2,$3,$4,$5,$6)', [match.id, u1.elo, u2.elo, elo1, elo2, score1]);
    const winnerId = replayResult.winner === 1 ? u1.id : replayResult.winner === 2 ? u2.id : null;
    const tournamentUpdates = await updateTournamentEntriesForResult(client, match, score1);
    await completePostgresTournamentFixture(client, match, score1, replayResult.stepCount);
    await client.query(`UPDATE matches SET status='completed', winner_id=$1, final_state_hash=$2, final_step_count=$3, replay_key=$4, replay_sha256=$5, replay_json=$6::jsonb, player1_proof=$7::jsonb, player2_proof=$8::jsonb, completed_at=now() WHERE id=$9`, [winnerId, replayResult.finalHash, replayResult.stepCount, storedReplay.key, storedReplay.checksum, storedReplay.json ? JSON.stringify(storedReplay.json) : null, JSON.stringify(p1), JSON.stringify(p2), match.id]);
    await client.query('COMMIT');
    sparringSessions.delete(match.id);
    return {
      matchId: match.id,
      winnerId,
      winner: replayResult.winner,
      drawReason: replayResult.drawReason,
      finalStateHash: replayResult.finalHash,
      elo: { player1: { before: u1.elo, after: elo1 }, player2: { before: u2.elo, after: elo2 } },
      eloUpdated,
      tournamentUpdate: tournamentUpdates.get(userId) || null,
      replaySha256: storedReplay.checksum
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}

async function resolveDisconnectedMatch(matchId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT * FROM matches
       WHERE id=$1 AND status='active'
         AND disconnected_player_id IS NOT NULL
         AND disconnected_at <= clock_timestamp() - ($2 * interval '1 millisecond')
       FOR UPDATE`,
      [matchId, DISCONNECT_FORFEIT_MS]
    );
    const match = found.rows[0];
    if (!match) {
      await client.query('COMMIT');
      return null;
    }

    if (await areBothMatchPlayersOffline(redis, match.player1_id, match.player2_id)) {
      await client.query(
        `UPDATE matches SET status='abandoned',completed_at=now(),
           disconnected_player_id=NULL,disconnected_at=NULL
         WHERE id=$1 AND status='active'`,
        [match.id]
      );
      await client.query('COMMIT');
      return {
        matchId: match.id,
        abandoned: true,
        bothPlayersDisconnected: true,
        player1Id: match.player1_id,
        player2Id: match.player2_id
      };
    }

    if (match.tournament_id) {
      const lifecycle = await client.query(
        `WITH checked AS (SELECT clock_timestamp() AS at)
         SELECT t.format,t.status,t.registration_closes_at,t.tournament_starts_at,t.ends_at,t.max_teams,
                checked.at < t.ends_at AS before_end,
                checked.at < t.registration_closes_at AS before_registration_close,
                checked.at >= t.tournament_starts_at AS before_start,
                (SELECT count(*)::int FROM tournament_entries entries WHERE entries.tournament_id=t.id) AS participant_count,
                CASE WHEN t.week_started_at IS NULL THEN NULL
                     ELSE GREATEST(1, FLOOR(EXTRACT(EPOCH FROM (checked.at-t.week_started_at)) / 604800)::integer + 1)
                END AS active_week
         FROM tournaments t CROSS JOIN checked WHERE t.id=$1`,
        [match.tournament_id]
      );
      const tournament = lifecycle.rows[0];
      const practiceStillOpen = match.tournament_phase === 'practice' &&
        tournament?.status === 'registration' && tournament.before_registration_close &&
        tournament.before_end &&
        (tournament.format === 'group_knockout' || tournament.participant_count < tournament.max_teams);
      const matchWeek = Number(match.tournament_rules?.week);
      const rankedSprintStillOpen = match.tournament_phase === 'ranked' &&
        tournament?.status === 'qualifying' && tournament.before_end &&
        Number.isInteger(matchWeek) && matchWeek === Number(tournament.active_week);
      const groupKnockoutStillOpen = await isCurrentGroupKnockoutFixture(client, match, tournament);
      if (!practiceStillOpen && !rankedSprintStillOpen && !groupKnockoutStillOpen) {
        await client.query("UPDATE matches SET status='abandoned',completed_at=now() WHERE id=$1 AND status='active'", [match.id]);
        await client.query('COMMIT');
        return { matchId: match.id, abandoned: true, player1Id: match.player1_id, player2Id: match.player2_id };
      }
    }

    const disconnectedId = match.disconnected_player_id;
    const winnerId = disconnectedId === match.player1_id ? match.player2_id : match.player1_id;
    const score1 = winnerId === match.player1_id ? 1 : 0;
    const users = await client.query(
      'SELECT id,elo FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [[match.player1_id, match.player2_id]]
    );
    const player1 = users.rows.find(user => user.id === match.player1_id);
    const player2 = users.rows.find(user => user.id === match.player2_id);
    if (!player1 || !player2) throw new Error('A player in the disconnected match no longer exists');

    const eloUpdated = match.match_type === 'bot' && !match.is_sparring;
    const player1EloAfter = eloUpdated ? calculateElo(player1.elo, player2.elo, score1, config.fideK) : player1.elo;
    const player2EloAfter = eloUpdated ? calculateElo(player2.elo, player1.elo, 1 - score1, config.fideK) : player2.elo;
    if (eloUpdated) {
      await client.query('UPDATE users SET elo=$1 WHERE id=$2', [player1EloAfter, player1.id]);
      await client.query('UPDATE users SET elo=$1 WHERE id=$2', [player2EloAfter, player2.id]);
    }
    await client.query(
      `INSERT INTO match_results
         (match_id,player1_elo_before,player2_elo_before,player1_elo_after,player2_elo_after,result_player1)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [match.id, player1.elo, player2.elo, player1EloAfter, player2EloAfter, score1]
    );
    await updateTournamentEntriesForResult(client, match, score1);
    const finalStepCount = Number(match.consensus_state?.currentStep) || 0;
    await completePostgresTournamentFixture(client, match, score1, finalStepCount);
    await client.query(
      `UPDATE matches SET status='completed',winner_id=$1,final_step_count=$2,completed_at=now(),
         disconnected_player_id=NULL,disconnected_at=NULL
       WHERE id=$3 AND status='active'`,
      [winnerId, finalStepCount, match.id]
    );
    await client.query('COMMIT');
    return {
      matchId: match.id, winnerId, disconnectedId, player1Id: match.player1_id, player2Id: match.player2_id,
      eloUpdated, player1EloAfter, player2EloAfter
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function processDisconnectedMatches() {
  const due = await pool.query(
    `SELECT id FROM matches
     WHERE status='active' AND disconnected_player_id IS NOT NULL
       AND disconnected_at <= clock_timestamp() - ($1 * interval '1 millisecond')
     ORDER BY disconnected_at LIMIT 50`,
    [DISCONNECT_FORFEIT_MS]
  );
  for (const { id } of due.rows) {
    const result = await resolveDisconnectedMatch(id);
    if (!result) continue;
    const players = [result.player1Id, result.player2Id];
    if (result.abandoned) {
      for (const playerId of players) {
        await deliverToUser(playerId, 'match-aborted', {
          matchId: result.matchId,
          message: result.bothPlayersDisconnected
            ? 'Trận đã bị hủy vì cả hai người chơi đều rời trận. Không tính thắng thua hoặc Elo.'
            : 'Trận đã bị hủy vì Sprint hoặc giai đoạn giải đấu đã kết thúc trước khi đối thủ ngắt kết nối đủ lâu.'
        });
      }
      continue;
    }
    for (const playerId of players) {
      const playerNumber = playerId === result.player1Id ? 1 : 2;
      const isWinner = playerId === result.winnerId;
      await deliverToUser(playerId, 'match-forfeited', {
        matchId: result.matchId,
        winnerId: result.winnerId,
        winnerPlayer: result.winnerId === result.player1Id ? 1 : 2,
        disconnectedId: result.disconnectedId,
        message: isWinner
          ? 'Bạn thắng do đối thủ đã ngắt kết nối quá lâu.'
          : 'Bạn thua do đã ngắt kết nối quá lâu.',
        eloUpdated: result.eloUpdated,
        eloAfter: playerNumber === 1 ? result.player1EloAfter : result.player2EloAfter
      });
    }
  }
}

async function submitConsensusDispute(userId, body) {
  const report = body?.report;
  const evidence = body?.evidence;
  const proof = report?.payload;
  if (!proof || proof.kind !== 'consensus-dispute' || typeof report.signature !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(proof.evidenceHash || '')) {
    throw Object.assign(new Error('Malformed consensus dispute report'), { status: 400 });
  }
  const client = await pool.connect();
  let outcome;
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE', [proof.matchId]);
    const match = found.rows[0];
    if (!match || !canonicalMatchIds(match).includes(userId)) {
      throw Object.assign(new Error('Active match not found for this player'), { status: 404 });
    }
    if (match.status !== 'active') {
      const prior = await client.query(
        `SELECT d.status,d.winner_id,d.offender_id,d.reason,m.player1_id,m.player2_id,m.match_type,
                r.player1_elo_after,r.player2_elo_after
         FROM match_disputes d
         JOIN matches m ON m.id=d.match_id
         LEFT JOIN match_results r ON r.match_id=m.id
         WHERE d.match_id=$1`,
        [match.id]
      );
      if (prior.rows[0]) {
        const decision = prior.rows[0];
        await client.query('COMMIT');
        return {
          matchId: match.id,
          resolved: decision.status === 'adjudicated',
          winnerId: decision.winner_id,
          winnerPlayer: decision.winner_id === match.player1_id ? 1 : decision.winner_id === match.player2_id ? 2 : null,
          offenderPlayer: decision.offender_id === match.player1_id ? 1 : decision.offender_id === match.player2_id ? 2 : null,
          eloUpdated: decision.status === 'adjudicated' && match.match_type === 'bot' && !match.is_sparring,
          player1EloAfter: decision.player1_elo_after,
          player2EloAfter: decision.player2_elo_after,
          message: 'Biên bản tranh chấp của trận đấu này đã được xử lý trước đó.'
        };
      }
      throw Object.assign(new Error('Active match not found for this player'), { status: 404 });
    }
    const claimantSeat = match.player1_id === userId ? 1 : 2;
    if (proof.claimantSeat !== claimantSeat || evidence?.matchId !== match.id || hashCanonical(evidence) !== proof.evidenceHash) {
      throw Object.assign(new Error('Consensus dispute report does not match its evidence'), { status: 400 });
    }
    if (!evidence.faultType || evidence.faultType === 'state-ack-mismatch') {
      if (proof.stepCount !== evidence?.moves?.length + 1 ||
          proof.stepCount !== evidence?.disputedStep?.stepCount ||
          !Array.isArray(evidence?.disputedStep?.acknowledgements) ||
          evidence.disputedStep.acknowledgements.length !== 2) {
        throw Object.assign(new Error('Consensus dispute report does not match its evidence'), { status: 400 });
      }
      const localAcknowledgement = evidence.disputedStep.acknowledgements.find(item => item?.payload?.player === claimantSeat);
      const remoteAcknowledgement = evidence.disputedStep.acknowledgements.find(item => item?.payload?.player !== claimantSeat);
      if (proof.localHash !== localAcknowledgement?.payload?.stateHash ||
          proof.remoteHash !== remoteAcknowledgement?.payload?.stateHash ||
          proof.localHash !== evidence.disputedStep.stateHash ||
          proof.localHash === proof.remoteHash) {
        throw Object.assign(new Error('Reported hashes do not match the signed acknowledgements'), { status: 400 });
      }
    }
    const claimantKey = claimantSeat === 1 ? match.player1_key : match.player2_key;
    if (!verifySessionProof(claimantKey, proof, report.signature)) {
      throw Object.assign(new Error('Consensus dispute report signature is invalid'), { status: 400 });
    }
    const decision = verifyConsensusDispute(evidence, match);
    if (!decision.adjudicated) {
      await client.query(
        `INSERT INTO match_disputes(match_id,claimant_id,evidence,status,reason)
         VALUES($1,$2,$3::jsonb,'unresolved',$4)`,
        [match.id, userId, JSON.stringify(evidence), decision.reason]
      );
      await client.query("UPDATE matches SET status='disputed',completed_at=now() WHERE id=$1", [match.id]);
      outcome = {
        matchId: match.id, resolved: false,
        message: 'Server xác nhận có bất đồng hash nhưng bằng chứng chưa chỉ ra duy nhất bên sai. Trận bị hủy, không tính Elo hoặc Sao.'
      };
    } else {
      const offenderId = decision.offenderSeat === 1 ? match.player1_id : match.player2_id;
      const winnerId = offenderId === match.player1_id ? match.player2_id : match.player1_id;
      const score1 = winnerId === match.player1_id ? 1 : 0;
      const users = await client.query(
        'SELECT id,elo FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [[match.player1_id, match.player2_id]]
      );
      const player1 = users.rows.find(user => user.id === match.player1_id);
      const player2 = users.rows.find(user => user.id === match.player2_id);
      if (!player1 || !player2) throw new Error('A player in the disputed match no longer exists');
      const eloUpdated = match.match_type === 'bot' && !match.is_sparring;
      const player1EloAfter = eloUpdated ? calculateElo(player1.elo, player2.elo, score1, config.fideK) : player1.elo;
      const player2EloAfter = eloUpdated ? calculateElo(player2.elo, player1.elo, 1 - score1, config.fideK) : player2.elo;
      if (eloUpdated) {
        await client.query('UPDATE users SET elo=$1 WHERE id=$2', [player1EloAfter, player1.id]);
        await client.query('UPDATE users SET elo=$1 WHERE id=$2', [player2EloAfter, player2.id]);
      }
      await client.query(
        `INSERT INTO match_results
           (match_id,player1_elo_before,player2_elo_before,player1_elo_after,player2_elo_after,result_player1)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (match_id) DO NOTHING`,
        [match.id, player1.elo, player2.elo, player1EloAfter, player2EloAfter, score1]
      );
      const tournamentUpdates = await updateTournamentEntriesForResult(client, match, score1);
      await completePostgresTournamentFixture(client, match, score1, decision.stepCount);
      await client.query(
        `INSERT INTO match_disputes(match_id,claimant_id,evidence,status,offender_id,winner_id,reason)
         VALUES($1,$2,$3::jsonb,'adjudicated',$4,$5,$6)`,
        [match.id, userId, JSON.stringify(evidence), offenderId, winnerId, decision.reason]
      );
      await client.query(
        `UPDATE matches SET status='completed',winner_id=$1,final_step_count=$2,completed_at=now(),
           disconnected_player_id=NULL,disconnected_at=NULL WHERE id=$3`,
        [winnerId, decision.stepCount, match.id]
      );
      outcome = {
        matchId: match.id, resolved: true, winnerId,
        winnerPlayer: winnerId === match.player1_id ? 1 : 2,
        offenderId, offenderPlayer: decision.offenderSeat,
        stepCount: decision.stepCount, eloUpdated,
        player1EloBefore: player1.elo, player2EloBefore: player2.elo,
        player1EloAfter, player2EloAfter,
        tournamentUpdates,
        reason: decision.reason,
        winnerMessage: 'Đối thủ sai lệch mã băm trạng thái hoặc chữ ký đồng thuận — Bạn được xử thắng ngay lập tức!',
        loserMessage: 'Phát hiện sai lệch mã băm trạng thái hoặc chữ ký đồng thuận từ phía bạn — Bạn bị xử thua kỹ thuật.'
      };
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const playerId of [outcome.winnerId, outcome.offenderId].filter(Boolean)) {
    const isWinner = playerId === outcome.winnerId;
    const playerNumber = isWinner ? outcome.winnerPlayer : outcome.offenderPlayer;
    await deliverToUser(playerId, 'match-dispute-result', {
      matchId: outcome.matchId,
      resolved: outcome.resolved,
      winnerId: outcome.winnerId,
      winnerPlayer: outcome.winnerPlayer || null,
      offenderPlayer: outcome.offenderPlayer || null,
      reason: outcome.reason || null,
      eloUpdated: outcome.eloUpdated || false,
      eloBefore: playerNumber === 1 ? outcome.player1EloBefore : outcome.player2EloBefore,
      eloAfter: playerNumber === 1 ? outcome.player1EloAfter : outcome.player2EloAfter,
      tournamentUpdate: outcome.tournamentUpdates?.get(playerId) || null,
      message: isWinner ? outcome.winnerMessage : outcome.loserMessage
    });
  }
  if (!outcome.resolved) {
    const match = await pool.query('SELECT player1_id,player2_id FROM matches WHERE id=$1', [outcome.matchId]);
    for (const playerId of [match.rows[0].player1_id, match.rows[0].player2_id]) {
      await deliverToUser(playerId, 'match-dispute-result', {
        matchId: outcome.matchId, resolved: false, message: outcome.message
      });
    }
  }
  if (outcome?.matchId) sparringSessions.delete(outcome.matchId);
  return outcome;
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        revision: process.env.RENDER_GIT_COMMIT || 'unknown'
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const displayName = String(body.displayName || '').trim().slice(0, 40);
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || !displayName) return json(res, 400, { error: 'Provide a valid email, display name and password of at least 10 characters' });
      const passwordHash = await hashPassword(password);
      const created = await pool.query('INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id,email,display_name,elo,avatar_id,avatar_url,profile_background_url,profile_background_id,is_admin,active_bot_version', [email, passwordHash, displayName]);
      const user = created.rows[0];
      return json(res, 201, { token: createToken(user, config.jwtSecret), user: publicUser(user) });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const result = await pool.query('SELECT id,email,password_hash,display_name,elo,avatar_id,avatar_url,profile_background_url,profile_background_id,is_admin,active_bot_version FROM users WHERE email=$1', [email]);
      const user = result.rows[0];
      if (!user || !await verifyPassword(String(body.password || ''), user.password_hash)) return json(res, 401, { error: 'Email or password is incorrect' });
      return json(res, 200, { token: createToken(user, config.jwtSecret), user: publicUser(user) });
    }
    if (req.method === 'GET' && url.pathname === '/api/tournaments') {
      await updateTournamentLifecycle();
      const result = await pool.query(
      `SELECT t.id,t.name,t.format,t.description,t.status,t.registration_opens_at,
                t.registration_closes_at,t.tournament_starts_at,t.ends_at,t.max_teams,
                t.group_count,t.current_week,t.total_sprints,t.rules_json,t.created_at,
                count(e.tournament_id)::int AS participant_count,
                count(e.tournament_id)::int AS team_count
         FROM tournaments t LEFT JOIN tournament_entries e ON e.tournament_id=t.id
                WHERE t.format='group_knockout'
                AND t.status IN ('scheduled','registration','grouping','group_stage','group_running','group_complete','knockout','completed')
                GROUP BY t.id ORDER BY CASE t.status
                  WHEN 'scheduled' THEN 0 WHEN 'registration' THEN 1 WHEN 'grouping' THEN 2
                WHEN 'group_stage' THEN 3 WHEN 'group_running' THEN 4
                WHEN 'group_complete' THEN 5 WHEN 'knockout' THEN 6
                WHEN 'completed' THEN 7 ELSE 8 END,t.created_at DESC`
      );
      return json(res, 200, { tournaments: result.rows });
    }
    if (req.method === 'GET' && /^\/api\/tournaments\/[0-9a-f-]+$/i.test(url.pathname)) {
      await updateTournamentLifecycle();
      const tournamentId = url.pathname.split('/')[3];
      const result = await pool.query('SELECT * FROM tournaments WHERE id=$1', [tournamentId]);
      const tournament = result.rows[0];
      if (!tournament) return json(res, 404, { error: 'Tournament not found' });
      const auth = optionalAuthFromHeader(req);
      const [adminResult, participants, ownEntry, matches, finalStandings] = await Promise.all([
        auth
          ? pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub])
          : Promise.resolve({ rows: [] }),
        pool.query('SELECT count(*)::int AS count FROM tournament_entries WHERE tournament_id=$1', [tournamentId]),
        auth
          ? pool.query(
            `SELECT entry.player_id, entry.group_number, entry.points, entry.registered_at,
                    entry.tier, entry.rank_stars, entry.season_points,
                    entry.matches_played, entry.wins, entry.draws, entry.losses,
                    u.elo,
                    CASE WHEN entry.tier='Challenger' THEN (
                      SELECT count(*)::int+1 FROM tournament_entries ahead
                      JOIN users ua ON ua.id=ahead.player_id
                      WHERE ahead.tournament_id=entry.tournament_id AND ahead.tier='Challenger'
                        AND (ahead.season_points>entry.season_points OR
                          (ahead.season_points=entry.season_points AND ua.elo>u.elo) OR
                          (ahead.season_points=entry.season_points AND ua.elo=u.elo AND ahead.wins>entry.wins) OR
                          (ahead.season_points=entry.season_points AND ua.elo=u.elo AND ahead.wins=entry.wins AND ahead.registered_at<entry.registered_at))
                    ) ELSE NULL END AS "privateRank"
             FROM tournament_entries entry
             JOIN users u ON u.id=entry.player_id
             WHERE entry.tournament_id=$1 AND entry.player_id=$2 LIMIT 1`,
            [tournamentId, auth.sub]
          )
          : Promise.resolve({ rows: [] }),
        pool.query(
          `SELECT m.id,m.id AS match_id,m.status,m.seed,m.tournament_phase,
                  m.player1_id,m.player2_id,m.final_step_count AS move_count,
                  fixture.phase,fixture.group_number,fixture.round_number,fixture.leg,
                  m.created_at,m.completed_at,m.winner_id,
                  winner.display_name AS winner,
                  (m.replay_json IS NOT NULL) AS replay_available,
                  u1.display_name AS player1,u2.display_name AS player2
           FROM matches m
           JOIN users u1 ON u1.id=m.player1_id JOIN users u2 ON u2.id=m.player2_id
           LEFT JOIN tournament_fixtures fixture ON fixture.id=m.tournament_fixture_id
           LEFT JOIN users winner ON winner.id=m.winner_id
           WHERE m.tournament_id=$1 AND $2::uuid IS NOT NULL
             AND (m.player1_id=$2 OR m.player2_id=$2 OR EXISTS (
               SELECT 1 FROM users viewer WHERE viewer.id=$2 AND viewer.is_admin
             ))
           ORDER BY m.created_at DESC LIMIT 100`, [tournamentId, auth?.sub || null]
        ),
        tournament.status === 'completed'
          ? pool.query(
            `SELECT e.player_id, u.display_name, u.elo, e.tier, e.rank_stars,
                    e.season_points, e.matches_played, e.wins, e.draws, e.losses
             FROM tournament_entries e JOIN users u ON u.id=e.player_id
             WHERE e.tournament_id=$1 AND e.player_id IS NOT NULL AND e.tier='Challenger'
             ORDER BY e.season_points DESC, u.elo DESC, e.wins DESC, e.registered_at ASC`,
            [tournamentId]
          )
          : Promise.resolve({ rows: [] })
      ]);
      const groupEntries = tournament.format === 'group_knockout'
        ? (await pool.query(
          `SELECT entry.player_id,entry.group_number,entry.registered_at,
                  entry.matches_played,entry.wins,entry.draws,entry.losses,entry.points,
                  participant.display_name,participant.elo,participant.avatar_id,participant.avatar_url
           FROM tournament_entries entry JOIN users participant ON participant.id=entry.player_id
           WHERE entry.tournament_id=$1 AND entry.group_number IS NOT NULL
           ORDER BY entry.group_number,entry.registered_at,entry.player_id`,
          [tournamentId]
        )).rows
        : [];
      const groupFixtures = tournament.format === 'group_knockout'
        ? (await pool.query(
          `SELECT fixture.*,p1.display_name AS player1,p2.display_name AS player2,
                  winner.display_name AS winner
           FROM tournament_fixtures fixture
           JOIN users p1 ON p1.id=fixture.player1_id
           JOIN users p2 ON p2.id=fixture.player2_id
           LEFT JOIN users winner ON winner.id=fixture.winner_id
           WHERE fixture.tournament_id=$1
           ORDER BY fixture.phase,fixture.group_number NULLS LAST,fixture.round_number,
                    fixture.match_number,fixture.leg`,
          [tournamentId]
        )).rows
        : [];
      const calculatedGroupStandings = tournament.format === 'group_knockout'
        ? calculateGroupStandings(groupEntries, groupFixtures)
        : [];
      const groupStandingsPublished = ['group_running', 'group_complete', 'knockout', 'completed'].includes(tournament.status);
      const groups = tournament.format === 'group_knockout'
        ? Array.from({ length: Number(tournament.group_count || 0) }, (_, index) => ({
          group_number: index + 1,
          members: groupEntries.filter(entry => Number(entry.group_number) === index + 1),
          standings: groupStandingsPublished
            ? calculatedGroupStandings.filter(entry => Number(entry.group_number) === index + 1)
            : []
        }))
        : [];
      const rawOwn = ownEntry.rows[0] || null;
      const challengerRank = rawOwn?.privateRank ?? null;
      const motivationBanner = buildTournamentMotivation(rawOwn, challengerRank);
      if (rawOwn) delete rawOwn.privateRank;
      const isCompleted = tournament.status === 'completed';
      const tournamentForViewer = { ...tournament };
      if (!adminResult.rows[0]?.is_admin) delete tournamentForViewer.rules_schedule;
      return json(res, 200, {
        tournament: tournamentForViewer,
        participantCount: participants.rows[0].count,
        ranks: tournamentRanks(),
        myEntry: rawOwn,
        motivationBanner,
        leaderboardHidden: tournament.format === 'group_knockout'
          ? !groupStandingsPublished
          : !isCompleted,
        matches: matches.rows,
        standings: isCompleted ? finalStandings.rows : [],
        finalStandings: isCompleted ? finalStandings.rows : null,
        groups,
        fixtures: groupFixtures,
        groupStandingsPublished
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/tournaments') {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 100);
      const description = String(body.description || '').trim().slice(0, 2000);
      if (body.registrationOpensAt === undefined && body.tournamentStartsAt === undefined) {
        const registrationClosesAt = new Date(body.registrationClosesAt);
        const endsAt = new Date(body.endsAt);
        const maxTeams = Math.min(256, Math.max(2, Number(body.maxTeams) || 64));
        const sprintRules = Array.isArray(body.sprintRules) ? body.sprintRules : DEFAULT_SPRINT_RULES;
        if (!name) return json(res, 400, { error: 'Vui lòng nhập tên giải.' });
        if (sprintRules.length !== 4 || sprintRules.some(rule => !Object.hasOwn(SPRINT_RULE_LAYOUTS, rule))) {
          return json(res, 400, { error: 'Hãy chọn luật hợp lệ cho đủ 4 Sprint.' });
        }
        if (Number.isNaN(registrationClosesAt.getTime()) || registrationClosesAt <= new Date() ||
            Number.isNaN(endsAt.getTime()) || endsAt <= registrationClosesAt) {
          return json(res, 400, { error: 'Thời gian đăng ký và kết thúc giải không hợp lệ.' });
        }
        const legacyTournament = await pool.query(
          `INSERT INTO tournaments(
             name,format,description,status,registration_closes_at,ends_at,max_teams,
             total_sprints,rules_schedule
           ) VALUES($1,'ranked_weekly',$2,'registration',$3,$4,$5,4,$6::jsonb)
           RETURNING *`,
          [name, description, registrationClosesAt, endsAt, maxTeams, JSON.stringify(sprintRules)]
        );
        return json(res, 201, { tournament: legacyTournament.rows[0] });
      }
      const registrationOpensAt = new Date(body.registrationOpensAt);
      const registrationClosesAt = new Date(body.registrationClosesAt);
      const tournamentStartsAt = new Date(body.tournamentStartsAt);
      if (!name) return json(res, 400, { error: 'Vui lòng nhập tên giải.' });
      if (Number.isNaN(registrationOpensAt.getTime()) || Number.isNaN(registrationClosesAt.getTime()) ||
          Number.isNaN(tournamentStartsAt.getTime()) || registrationOpensAt.getTime() < Date.now() - 60000 ||
          registrationClosesAt <= registrationOpensAt || tournamentStartsAt <= registrationClosesAt) {
        return json(res, 400, { error: 'Thời gian cần theo thứ tự: mở đăng ký, đóng đăng ký, bắt đầu giải.' });
      }
      let rules;
      try {
        rules = buildTournamentRules(body.blockedCells, body.moveLimitRule, body.capturedPieceValues);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      const status = registrationOpensAt.getTime() > Date.now() ? 'scheduled' : 'registration';
      const created = await pool.query(
        `INSERT INTO tournaments(
           name,format,description,status,registration_opens_at,registration_closes_at,
           tournament_starts_at,ends_at,max_teams,group_count,rules_json,rules_schedule
         )
         VALUES($1,'group_knockout',$2,$3,$4,$5,$6,$7,$8,NULL,$9::jsonb,'[]'::jsonb)
         RETURNING *`,
        [
          name,
          description,
          status,
          registrationOpensAt,
          registrationClosesAt,
          tournamentStartsAt,
          new Date(tournamentStartsAt.getTime() + 90 * 86400000),
          2147483647,
          JSON.stringify(rules)
        ]
      );
      return json(res, 201, { tournament: created.rows[0] });
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/start-groups$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tournament = await startServerGroupStage(client, url.pathname.split('/')[3]);
        await client.query('COMMIT');
        void tournamentRunner.tick();
        return json(res, 200, { tournament });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/start-knockout$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      const tournamentId = url.pathname.split('/')[3];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tournamentResult = await client.query(
          "SELECT id,status FROM tournaments WHERE id=$1 AND format='group_knockout' FOR UPDATE",
          [tournamentId]
        );
        if (tournamentResult.rows[0]?.status !== 'group_complete') {
          throw Object.assign(new Error('Vòng bảng chưa hoàn tất.'), { status: 409 });
        }
        const remaining = await client.query(
          `SELECT 1 FROM tournament_fixtures
           WHERE tournament_id=$1 AND phase='group' AND status<>'completed' LIMIT 1`,
          [tournamentId]
        );
        if (remaining.rowCount) throw Object.assign(new Error('Vòng bảng chưa hoàn tất.'), { status: 409 });
        const [entrants, fixtures] = await Promise.all([
          client.query(
            `SELECT entry.player_id,entry.group_number,entry.registered_at,participant.display_name
             FROM tournament_entries entry JOIN users participant ON participant.id=entry.player_id
             WHERE entry.tournament_id=$1 AND entry.group_number IS NOT NULL
             ORDER BY entry.group_number,entry.registered_at,entry.player_id`,
            [tournamentId]
          ),
          client.query(
            `SELECT player1_id,player2_id,winner_id,move_count,status
             FROM tournament_fixtures WHERE tournament_id=$1 AND phase='group'`,
            [tournamentId]
          )
        ]);
        const standings = calculateGroupStandings(entrants.rows, fixtures.rows);
        const qualifiers = standings.filter((row, index) =>
          standings.slice(0, index).filter(previous =>
            Number(previous.group_number) === Number(row.group_number)
          ).length < 2
        );
        const openingRound = createKnockoutOpeningRound(qualifiers);
        for (const fixture of openingRound) {
          await client.query(
            `INSERT INTO tournament_fixtures(
               tournament_id,phase,round_number,match_number,leg,player1_id,player2_id,status
             ) VALUES($1,'knockout',$2,$3,1,$4,$5,'pending')`,
            [tournamentId, fixture.roundNumber, fixture.matchNumber, fixture.player1Id, fixture.player2Id]
          );
        }
        await client.query(
          "UPDATE tournaments SET status='knockout' WHERE id=$1 AND status='group_complete'",
          [tournamentId]
        );
        await client.query('COMMIT');
        return json(res, 201, { fixtureCount: openingRound.length });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/groups$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      await updateTournamentLifecycle();
      const tournamentId = url.pathname.split('/')[3];
      const body = await readBody(req);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tournamentResult = await client.query(
          "SELECT id,status,format FROM tournaments WHERE id=$1 FOR UPDATE",
          [tournamentId]
        );
        const tournament = tournamentResult.rows[0];
        if (!tournament || tournament.format !== 'group_knockout' ||
            !['registration', 'grouping'].includes(tournament.status)) {
          throw Object.assign(new Error('Giải không ở trạng thái mở đăng ký hoặc chờ chia bảng.'), { status: 409 });
        }
        const entriesResult = await client.query(
          `SELECT entry.player_id,entry.registered_at,entry.group_number
           FROM tournament_entries entry
           JOIN users ON users.id=entry.player_id
           WHERE entry.tournament_id=$1 AND users.is_admin IS NOT NULL
           ORDER BY entry.registered_at,entry.player_id FOR UPDATE`,
          [tournamentId]
        );
        const groups = distributeTournamentGroups(entriesResult.rows, Number(body.groupCount));
        for (const group of groups) {
          for (const entry of group.entrants) {
            await client.query(
              'UPDATE tournament_entries SET group_number=$1 WHERE tournament_id=$2 AND player_id=$3',
              [group.number, tournamentId, entry.player_id]
            );
          }
        }
        const fixtures = createDoubleRoundRobinFixtures(groups);
        for (const [fixtureIndex, fixture] of fixtures.entries()) {
          await client.query(
            `INSERT INTO tournament_fixtures(
               tournament_id,phase,group_number,round_number,match_number,leg,
               player1_id,player2_id,status
             ) VALUES($1,'group',$2,$3,$4,$5,$6,$7,'pending')`,
            [
              tournamentId,
              fixture.groupNumber,
              fixture.roundNumber,
              fixtureIndex + 1,
              fixture.leg,
              fixture.player1Id,
              fixture.player2Id
            ]
          );
        }
        await client.query(
          "UPDATE tournaments SET status='group_stage',group_count=$1,registration_closes_at=now() WHERE id=$2",
          [groups.length, tournamentId]
        );
        await client.query('COMMIT');
        return json(res, 201, { groupCount: groups.length, fixtureCount: fixtures.length });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/cancel$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      const tournamentId = url.pathname.split('/')[3];
      const result = await pool.query(
        `UPDATE tournaments SET status='cancelled'
         WHERE id=$1 AND status NOT IN ('completed','cancelled') RETURNING *`,
        [tournamentId]
      );
      if (!result.rowCount) throw Object.assign(new Error('Giải không tồn tại hoặc đã kết thúc/hủy.'), { status: 409 });
      await pool.query(
        "UPDATE matches SET status='abandoned',completed_at=now() WHERE tournament_id=$1 AND status='active'",
        [tournamentId]
      );
      await clearTournamentQueues(tournamentId, 0, 1, 2, 3, 4);
      return json(res, 200, { tournament: result.rows[0] });
    }
    if (req.method === 'POST' && url.pathname === '/api/tournaments/cancel-all') {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      const client = await pool.connect();
      let cancelledIds;
      try {
        await client.query('BEGIN');
        const cancelled = await client.query(
          `UPDATE tournaments SET status='cancelled'
           WHERE status NOT IN ('completed','cancelled') RETURNING id`
        );
        cancelledIds = cancelled.rows.map((row) => row.id);
        if (cancelledIds.length) {
          await client.query(
            "UPDATE matches SET status='abandoned',completed_at=now() WHERE tournament_id=ANY($1::uuid[]) AND status='active'",
            [cancelledIds]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      for (const tournamentId of cancelledIds) {
        await clearTournamentQueues(tournamentId, 0, 1, 2, 3, 4);
      }
      return json(res, 200, { cancelledCount: cancelledIds.length });
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/start$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      const tournamentId = url.pathname.split('/')[3];
      const scheduleResult = await pool.query("SELECT rules_schedule,total_sprints FROM tournaments WHERE id=$1 AND status='registration' AND ends_at>now()", [tournamentId]);
      if (!scheduleResult.rowCount) throw Object.assign(new Error('Không tìm thấy giải đang trong giai đoạn đăng ký.'), { status: 409 });
      const result = await pool.query(
        `UPDATE tournaments SET status='qualifying',current_week=1,last_reset_week=1,week_started_at=now(),
           registration_closes_at=LEAST(registration_closes_at,now()),ends_at=now()+(total_sprints * interval '7 days'),rules_json=$2::jsonb
         WHERE id=$1 AND status='registration' AND ends_at>now() RETURNING *`,
        [tournamentId, JSON.stringify(weeklyRules(1, scheduleResult.rows[0].rules_schedule))]
      );
      if (!result.rows[0]) throw Object.assign(new Error('Tournament cannot start in its current state'), { status: 409 });
      await initializeTournamentEntries(tournamentId);
      await clearTournamentQueues(tournamentId, 0, 1);
      return json(res, 200, { tournament: result.rows[0] });
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/advance-sprint$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      const tournamentId = url.pathname.split('/')[3];
      const found = await pool.query("SELECT * FROM tournaments WHERE id=$1 AND status='qualifying'", [tournamentId]);
      const t = found.rows[0];
      if (!t) throw Object.assign(new Error('Giải không ở giai đoạn Thực chiến.'), { status: 409 });
      const prevWeek = Math.max(1, Number(t.current_week) || 1);
      const nextWeek = prevWeek + 1;
      if (nextWeek > t.total_sprints) {
        throw Object.assign(new Error('Đây là Sprint cuối cùng của giải.'), { status: 409 });
      }
      await captureTournamentSprint(tournamentId, prevWeek);
      await applyTournamentSprintResets(tournamentId, prevWeek, nextWeek);
      const nextRules = weeklyRules(nextWeek, t.rules_schedule);
      const updated = await pool.query(
        "UPDATE tournaments SET current_week=$2, last_reset_week=$2, week_started_at=now(), ends_at=now()+((total_sprints-$2+1) * interval '7 days'), rules_json=$3::jsonb WHERE id=$1 RETURNING *",
        [tournamentId, nextWeek, JSON.stringify(nextRules)]
      );
      await clearTournamentQueues(tournamentId, prevWeek, nextWeek);
      return json(res, 200, { tournament: updated.rows[0] });
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/complete$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const admin = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!admin.rows[0]?.is_admin) throw Object.assign(new Error('Tournament organizer permission required'), { status: 403 });
      const tournamentId = url.pathname.split('/')[3];
      const updated = await pool.query(
        "UPDATE tournaments SET status='completed', registration_closes_at=LEAST(registration_closes_at,now()), ends_at=LEAST(ends_at, now()) WHERE id=$1 AND status<>'completed' RETURNING *",
        [tournamentId]
      );
      if (!updated.rows[0]) throw Object.assign(new Error('Giải đấu đã kết thúc hoặc không tồn tại.'), { status: 409 });
      return json(res, 200, { tournament: updated.rows[0] });
    }
    if (req.method === 'GET' && url.pathname === '/api/bots/me') {
      const auth = authFromHeader(req);
      const result = await pool.query(
        `SELECT u.active_bot_version AS version,b.code,b.code_sha256 AS sha256,b.created_at AS "createdAt",
                COALESCE((SELECT json_agg(e.tournament_id) FROM tournament_entries e WHERE e.player_id=u.id),'[]'::json) AS "tournamentIds"
         FROM users u LEFT JOIN user_bot_versions b ON b.user_id=u.id AND b.version=u.active_bot_version WHERE u.id=$1`, [auth.sub]
      );
      return json(res, 200, { bot: result.rows[0] || { version: 0, code: '', sha256: '', tournamentIds: [] } });
    }
    if (req.method === 'POST' && url.pathname === '/api/bots/me') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const code = String(body.code || '');
      if (!code.trim() || code.length > 120000) return json(res, 400, { error: 'Mã Python phải có từ 1 đến 120000 ký tự.' });
      if (!/^\s*def\s+(get_next_move|getNextMove)\s*\(/m.test(code)) return json(res, 400, { error: 'Bot cần định nghĩa hàm get_next_move(my_player_id, game_state).' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const owner = await client.query('SELECT active_bot_version FROM users WHERE id=$1 FOR UPDATE', [auth.sub]);
        if (!owner.rows[0]) throw Object.assign(new Error('Không tìm thấy tài khoản.'), { status: 404 });
        const version = owner.rows[0].active_bot_version + 1;
        const sha256 = createHash('sha256').update(code).digest('hex');
        // Each account owns one current bot slot; saving publishes a new revision
        // into that slot instead of accumulating separately selectable bots.
        await client.query('DELETE FROM user_bot_versions WHERE user_id=$1', [auth.sub]);
        await client.query('INSERT INTO user_bot_versions(user_id,version,code,code_sha256) VALUES($1,$2,$3,$4)', [auth.sub, version, code, sha256]);
        await client.query('UPDATE users SET active_bot_version=$1 WHERE id=$2', [version, auth.sub]);
        await client.query(
          `UPDATE tournament_entries e SET bot_version=$2 FROM tournaments t
           WHERE e.tournament_id=t.id AND e.player_id=$1 AND t.status IN ('registration','qualifying')`, [auth.sub, version]
        );
        await client.query('COMMIT');
        try {
          const activeEntries = await pool.query(
            `SELECT t.id,t.current_week FROM tournament_entries e JOIN tournaments t ON t.id=e.tournament_id
             WHERE e.player_id=$1 AND t.status='qualifying'`, [auth.sub]
          );
          for (const entry of activeEntries.rows) await cancelTournamentQueue(redis, entry.id, auth.sub, auth.sub, entry.current_week, 'ottv2:tournament-player');
          const socket = userSocket(auth.sub);
          if (socket?.tournamentSearch) {
            socket.searchCancelled = true;
            socket.searching = false;
            const timer = searchTimers.get(auth.sub); if (timer) clearTimeout(timer);
            searchTimers.delete(auth.sub);
            socket.tournamentSearch = null;
            send(socket, 'search-cancelled', { message: 'Bot đã cập nhật. Hãy tìm trận lại để dùng phiên bản mới.' });
          }
        } catch (queueError) { console.error('Could not refresh tournament queue after bot update:', queueError.message); }
        return json(res, 201, { version, sha256 });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    if (req.method === 'GET' && url.pathname === '/api/teams') {
      const auth = authFromHeader(req);
      const result = await pool.query(
        `SELECT t.id,t.name,t.captain_id AS "captainId",t.invite_code AS "inviteCode",
                t.active_bot_version AS "activeBotVersion",tm.role,
                COALESCE(bot.code,'') AS "botCode",COALESCE(bot.code_sha256,'') AS "botSha256",
                (SELECT count(*)::int FROM team_members members WHERE members.team_id=t.id) AS "memberCount",
                COALESCE((SELECT json_agg(entry.tournament_id) FROM tournament_entries entry WHERE entry.team_id=t.id),'[]'::json) AS "tournamentIds"
         FROM teams t JOIN team_members tm ON tm.team_id=t.id
         LEFT JOIN team_bot_versions bot ON bot.team_id=t.id AND bot.version=t.active_bot_version
         WHERE tm.user_id=$1 ORDER BY t.created_at DESC`, [auth.sub]
      );
      return json(res, 200, { teams: result.rows });
    }
    if (req.method === 'POST' && url.pathname === '/api/teams') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 60);
      if (name.length < 2) return json(res, 400, { error: 'Tên đội cần ít nhất 2 ký tự.' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const team = await client.query(
          'INSERT INTO teams(name,captain_id,invite_code) VALUES($1,$2,$3) RETURNING id,name,captain_id AS "captainId",invite_code AS "inviteCode",active_bot_version AS "activeBotVersion"',
          [name, auth.sub, randomBytes(5).toString('hex').toUpperCase()]
        );
        await client.query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'captain')", [team.rows[0].id, auth.sub]);
        await client.query('COMMIT');
        return json(res, 201, { team: { ...team.rows[0], role: 'captain', memberCount: 1, botCode: '' } });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    if (req.method === 'POST' && url.pathname === '/api/teams/join') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const inviteCode = String(body.inviteCode || '').trim().toUpperCase();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query('SELECT id,name FROM teams WHERE invite_code=$1 FOR UPDATE', [inviteCode]);
        const team = found.rows[0];
        if (!team) throw Object.assign(new Error('Mã mời đội không hợp lệ.'), { status: 404 });
        const count = await client.query('SELECT count(*)::int AS count FROM team_members WHERE team_id=$1', [team.id]);
        if (count.rows[0].count >= 4) throw Object.assign(new Error('Đội đã đủ tối đa 4 thành viên.'), { status: 409 });
        await client.query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')", [team.id, auth.sub]);
        await client.query('COMMIT');
        return json(res, 200, { team: { id: team.id, name: team.name, role: 'member' } });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    if (req.method === 'POST' && /^\/api\/teams\/[0-9a-f-]+\/bot$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const teamId = url.pathname.split('/')[3];
      const body = await readBody(req);
      const code = String(body.code || '');
      if (!code.trim() || code.length > 120000) return json(res, 400, { error: 'Mã Python phải có từ 1 đến 120000 ký tự.' });
      if (!/^\s*def\s+(get_next_move|getNextMove)\s*\(/m.test(code)) return json(res, 400, { error: 'Bot cần định nghĩa hàm get_next_move(my_player_id, game_state).' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query('SELECT captain_id,active_bot_version FROM teams WHERE id=$1 FOR UPDATE', [teamId]);
        const team = found.rows[0];
        if (!team) throw Object.assign(new Error('Không tìm thấy đội.'), { status: 404 });
        if (team.captain_id !== auth.sub) throw Object.assign(new Error('Chỉ đội trưởng mới được nộp bot.'), { status: 403 });
        const version = team.active_bot_version + 1;
        const codeSha256 = createHash('sha256').update(code).digest('hex');
        await client.query('INSERT INTO team_bot_versions(team_id,version,code,code_sha256,created_by) VALUES($1,$2,$3,$4,$5)', [teamId, version, code, codeSha256, auth.sub]);
        await client.query('UPDATE teams SET active_bot_version=$1 WHERE id=$2', [version, teamId]);
        await client.query('COMMIT');
        return json(res, 201, { version, sha256: codeSha256 });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/copy-entrants$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const tournamentId = url.pathname.split('/')[3];
      const body = await readBody(req);
      const sourceTournamentId = String(body.sourceTournamentId || '');
      const actor = await pool.query('SELECT is_admin FROM users WHERE id=$1', [auth.sub]);
      if (!actor.rows[0]?.is_admin) return json(res, 403, { error: 'Admin access required' });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tournaments = await client.query(
          'SELECT id,format,status FROM tournaments WHERE id=ANY($1::uuid[]) FOR UPDATE',
          [[tournamentId, sourceTournamentId]]
        );
        const target = tournaments.rows.find(row => row.id === tournamentId);
        const source = tournaments.rows.find(row => row.id === sourceTournamentId);
        if (!target || target.format !== 'group_knockout' || target.status !== 'registration' ||
            !source || source.format !== 'group_knockout' || source.id === target.id) {
          throw Object.assign(new Error('Source or target tournament is not eligible for copying entrants'), { status: 409 });
        }
        const targetCount = await client.query(
          'SELECT count(*)::int AS count FROM tournament_entries WHERE tournament_id=$1',
          [target.id]
        );
        if (targetCount.rows[0].count) {
          throw Object.assign(new Error('The target tournament already has entrants'), { status: 409 });
        }
        const sourceEntries = await client.query(
          `SELECT entry.player_id,entry.bot_version,u.elo,
                  (bot.user_id IS NOT NULL) AS has_bot
           FROM tournament_entries entry
           JOIN users u ON u.id=entry.player_id
           LEFT JOIN user_bot_versions bot
             ON bot.user_id=entry.player_id AND bot.version=entry.bot_version
           WHERE entry.tournament_id=$1 AND entry.player_id IS NOT NULL
           ORDER BY entry.registered_at,entry.player_id`,
          [source.id]
        );
        if (!sourceEntries.rowCount ||
            sourceEntries.rows.some(row => !row.bot_version || !row.has_bot)) {
          throw Object.assign(new Error('The source tournament has no entrants or a registered bot version is missing'), { status: 409 });
        }
        for (const entry of sourceEntries.rows) {
          await client.query(
            `INSERT INTO tournament_entries
               (tournament_id,player_id,bot_version,tier,rank_stars,season_points,tournament_elo)
             VALUES($1,$2,$3,'Bronze',0,0,$4)`,
            [target.id, entry.player_id, entry.bot_version, entry.elo]
          );
        }
        await client.query('COMMIT');
        await updateTournamentLifecycle();
        return json(res, 201, { copiedCount: sourceEntries.rowCount });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
    if (req.method === 'POST' && /^\/api\/tournaments\/[0-9a-f-]+\/register$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const tournamentId = url.pathname.split('/')[3];
      await updateTournamentLifecycle();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tournamentResult = await client.query('SELECT * FROM tournaments WHERE id=$1 FOR UPDATE', [tournamentId]);
        const tournament = tournamentResult.rows[0];
        if (!tournament || tournament.status !== 'registration' || new Date(tournament.registration_closes_at) <= new Date()) {
          throw Object.assign(new Error('Giải không nhận đăng ký ở thời điểm này (đã chuyển sang Thực chiến hoặc kết thúc).'), { status: 409 });
        }
        const playerResult = await client.query('SELECT elo, active_bot_version FROM users WHERE id=$1 FOR UPDATE', [auth.sub]);
        const player = playerResult.rows[0];
        if (!player) throw Object.assign(new Error('Không tìm thấy tài khoản.'), { status: 404 });
        const existing = await client.query('SELECT 1 FROM tournament_entries WHERE tournament_id=$1 AND player_id=$2', [tournamentId, auth.sub]);
        if (existing.rowCount) throw Object.assign(new Error('Bạn đã đăng ký giải này rồi.'), { status: 409 });
        const total = await client.query('SELECT count(*)::int AS count FROM tournament_entries WHERE tournament_id=$1', [tournamentId]);
        if (tournament.format !== 'group_knockout' && total.rows[0].count >= tournament.max_teams) {
          throw Object.assign(new Error('Giải đã đủ số người tham gia.'), { status: 409 });
        }
        const inserted = await client.query(
          `INSERT INTO tournament_entries(tournament_id,player_id,bot_version,tier,rank_stars,season_points)
           VALUES($1,$2,$3,$4,0,0) ON CONFLICT (tournament_id,player_id) WHERE player_id IS NOT NULL DO NOTHING RETURNING player_id`,
          // Bronze is a neutral placeholder until registration closes and Elo is used to seed ranks.
          [tournamentId, auth.sub, player.active_bot_version || null, 'Bronze']
        );
        if (!inserted.rowCount) throw Object.assign(new Error('Bạn đã đăng ký giải này rồi.'), { status: 409 });
        await client.query('COMMIT');
        await updateTournamentLifecycle();
        return json(res, 201, { registered: true });
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const auth = authFromHeader(req);
      const result = await pool.query('SELECT id,email,display_name,elo,avatar_id,avatar_url,profile_background_url,profile_background_id,is_admin,active_bot_version FROM users WHERE id=$1', [auth.sub]);
      if (!result.rows[0]) return json(res, 401, { error: 'Account not found' });
      return json(res, 200, { user: publicUser(result.rows[0]) });
    }
    if (req.method === 'PATCH' && url.pathname === '/api/me') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const displayName = body.displayName === undefined ? null : String(body.displayName).trim().slice(0, 40);
      const avatarId = body.avatarId === undefined ? null : String(body.avatarId);
      const avatarDataUrl = body.avatarDataUrl;
      const profileBackgroundDataUrl = body.profileBackgroundDataUrl;
      const profileBackgroundId = body.profileBackgroundId === undefined ? null : String(body.profileBackgroundId);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (displayName !== null && !displayName) return json(res, 400, { error: 'Tên hiển thị không được để trống.' });
      if (avatarId !== null && !PLAYER_AVATAR_IDS.includes(avatarId)) return json(res, 400, { error: 'Diện mạo kỳ thủ không hợp lệ.' });
      if (avatarDataUrl !== undefined && avatarDataUrl !== null && !isAllowedAvatarDataUrl(avatarDataUrl)) return json(res, 400, { error: 'Ảnh đại diện cần là PNG, JPEG hoặc WebP và tối đa 5 MB.' });
      if (profileBackgroundDataUrl !== undefined && profileBackgroundDataUrl !== null && !isAllowedAvatarDataUrl(profileBackgroundDataUrl)) return json(res, 400, { error: 'Ảnh nền cần là PNG, JPEG hoặc WebP và tối đa 5 MB.' });
      if (profileBackgroundId !== null && !PROFILE_BACKGROUND_IDS.includes(profileBackgroundId)) return json(res, 400, { error: 'Ảnh nền hồ sơ không hợp lệ.' });
      if (newPassword && newPassword.length < 10) return json(res, 400, { error: 'Mật khẩu mới cần ít nhất 10 ký tự.' });
      if (Boolean(currentPassword) !== Boolean(newPassword)) return json(res, 400, { error: 'Cần nhập cả mật khẩu hiện tại và mật khẩu mới.' });
      if (displayName === null && avatarId === null && avatarDataUrl === undefined && profileBackgroundId === null && profileBackgroundDataUrl === undefined && !newPassword) return json(res, 400, { error: 'Hãy chọn nội dung cần cập nhật.' });

      const found = await pool.query('SELECT id,email,password_hash,display_name,elo,avatar_id,avatar_url,profile_background_url,profile_background_id,is_admin FROM users WHERE id=$1', [auth.sub]);
      const user = found.rows[0];
      if (!user) return json(res, 401, { error: 'Account not found' });
      if (newPassword && !await verifyPassword(currentPassword, user.password_hash)) {
        return json(res, 400, { error: 'Mật khẩu hiện tại không chính xác.' });
      }
      const nextName = displayName ?? user.display_name;
      const nextAvatarId = avatarId ?? user.avatar_id ?? 'pumpkin';
      const nextAvatarUrl = avatarId !== null
        ? null
        : avatarDataUrl === undefined
        ? user.avatar_url
        : avatarDataUrl || null;
      const nextBackgroundId = profileBackgroundId ?? user.profile_background_id ?? 'castle';
      const nextBackgroundUrl = profileBackgroundId !== null
        ? null
        : profileBackgroundDataUrl === undefined
        ? user.profile_background_url
        : profileBackgroundDataUrl || null;
      if (newPassword) {
        const passwordHash = await hashPassword(newPassword);
        await pool.query('UPDATE users SET display_name=$1,avatar_id=$2,avatar_url=$3,profile_background_id=$4,profile_background_url=$5,password_hash=$6 WHERE id=$7', [nextName, nextAvatarId, nextAvatarUrl, nextBackgroundId, nextBackgroundUrl, passwordHash, auth.sub]);
      } else {
        await pool.query('UPDATE users SET display_name=$1,avatar_id=$2,avatar_url=$3,profile_background_id=$4,profile_background_url=$5 WHERE id=$6', [nextName, nextAvatarId, nextAvatarUrl, nextBackgroundId, nextBackgroundUrl, auth.sub]);
      }
      const updated = await pool.query('SELECT id,email,display_name,elo,avatar_id,avatar_url,profile_background_url,profile_background_id,is_admin,active_bot_version FROM users WHERE id=$1', [auth.sub]);
      return json(res, 200, { user: publicUser(updated.rows[0]) });
    }
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
      const result = await pool.query('SELECT id,display_name,elo,avatar_id,avatar_url FROM users ORDER BY elo DESC,created_at ASC LIMIT 100');
      return json(res, 200, { players: result.rows.map(user => ({ id: user.id, displayName: user.display_name, elo: user.elo, avatarId: user.avatar_id || 'pumpkin', avatarUrl: user.avatar_url || null })) });
    }
    if (req.method === 'GET' && url.pathname === '/api/matches') {
      const auth = authFromHeader(req);
      const result = await pool.query(`SELECT m.id,m.seed,m.status,m.match_type,m.tournament_phase,m.is_sparring,m.winner_id,m.final_state_hash,m.replay_sha256,m.created_at,m.completed_at,
        (m.replay_json IS NOT NULL OR (m.replay_key IS NOT NULL AND $2::boolean)) AS replay_available,
        u1.display_name AS player1,u2.display_name AS player2,m.player1_id,m.player2_id,
        (r.match_id IS NOT NULL AND m.match_type='bot' AND m.tournament_phase IS DISTINCT FROM 'practice' AND NOT m.is_sparring) AS elo_updated,
        CASE
          WHEN r.match_id IS NULL OR m.match_type<>'bot' OR m.tournament_phase='practice' OR m.is_sparring THEN NULL
          WHEN m.player1_id=$1 THEN r.player1_elo_after-r.player1_elo_before
          ELSE r.player2_elo_after-r.player2_elo_before
        END AS elo_delta,
        CASE
          WHEN r.match_id IS NULL OR m.match_type<>'bot' OR m.tournament_phase='practice' OR m.is_sparring THEN NULL
          WHEN m.player1_id=$1 THEN r.player1_elo_before
          ELSE r.player2_elo_before
        END AS elo_before,
        CASE
          WHEN r.match_id IS NULL OR m.match_type<>'bot' OR m.tournament_phase='practice' OR m.is_sparring THEN NULL
          WHEN m.player1_id=$1 THEN r.player1_elo_after
          ELSE r.player2_elo_after
        END AS elo_after
        FROM matches m JOIN users u1 ON u1.id=m.player1_id JOIN users u2 ON u2.id=m.player2_id
        LEFT JOIN match_results r ON r.match_id=m.id
        WHERE m.player1_id=$1 OR m.player2_id=$1 ORDER BY m.created_at DESC LIMIT 50`, [auth.sub, replayStorage.enabled]);
      return json(res, 200, { matches: result.rows });
    }
    if (req.method === 'GET' && /^\/api\/matches\/[0-9a-f-]+\/replay$/i.test(url.pathname)) {
      const auth = authFromHeader(req);
      const matchId = url.pathname.split('/')[3];
      const result = await pool.query('SELECT replay_json,replay_key,player1_id,player2_id FROM matches WHERE id=$1 AND status=\'completed\'', [matchId]);
      const match = result.rows[0];
      if (!match || ![match.player1_id, match.player2_id].includes(auth.sub)) return json(res, 404, { error: 'Replay not found' });
      if (match.replay_json) return json(res, 200, { replay: match.replay_json });
      const downloadUrl = await replayStorage.getUrl(match.replay_key);
      if (!downloadUrl) return json(res, 404, {
        error: 'Trận đấu này không có dữ liệu replay được lưu trên máy chủ.',
        code: 'REPLAY_UNAVAILABLE'
      });
      return json(res, 200, { downloadUrl });
    }
    if (req.method === 'POST' && url.pathname === '/api/match/submit-result') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const result = await submitResult(auth.sub, body);
      if (result.rejectedLate) return json(res, 409, { error: result.error, matchStatus: 'abandoned' });
      return json(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/match/forfeit') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const outcome = await adjudicateMatchForfeit(
        body.matchId,
        auth.sub,
        'player-left-match',
        'Đối thủ đã thoát khỏi bàn đấu — Bạn được xử thắng kỹ thuật ngay lập tức!',
        'Bạn đã rời bàn khi trận đấu chưa kết thúc và bị xử thua kỹ thuật.'
      );
      if (!outcome) return json(res, 404, { error: 'Không tìm thấy trận đấu đang diễn ra.' });
      return json(res, 200, { forfeited: true, matchId: outcome.matchId, winnerId: outcome.winnerId });
    }
    if (req.method === 'POST' && url.pathname === '/api/match/claim-timeout') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const found = await pool.query("SELECT * FROM matches WHERE id=$1 AND status='active'", [body.matchId]);
      const match = found.rows[0];
      if (!match || !canonicalMatchIds(match).includes(auth.sub)) {
        return json(res, 404, { error: 'Không tìm thấy trận đấu đang diễn ra.' });
      }
      const claimantSeat = match.player1_id === auth.sub ? 1 : 2;
      const opponentSeat = claimantSeat === 1 ? 2 : 1;
      const opponentId = opponentSeat === 1 ? match.player1_id : match.player2_id;
      const cs = match.consensus_state || createInitialConsensusState(match.match_type);
      const now = Date.now();
      const consensusAckTimeoutMs = match.match_type === 'bot' ? 30000 : 4500;

      if (!cs.bothReadyAt) {
        const oppReady = opponentSeat === 1 ? cs.p1ReadyAt : cs.p2ReadyAt;
        const myReady = claimantSeat === 1 ? cs.p1ReadyAt : cs.p2ReadyAt;
        if (!oppReady && (now - (cs.createdAtMs || now) >= 15000 || (myReady && now - myReady >= 10000))) {
          const out = await adjudicateMatchForfeit(
            match.id,
            opponentId,
            'setup-timeout',
            'Đối thủ không nạp Bot hoặc không xác nhận sẵn sàng đúng hạn — Bạn được xử thắng kỹ thuật!',
            'Bạn không nạp Bot hoặc không xác nhận sẵn sàng đúng hạn nên bị xử thua kỹ thuật.'
          );
          return json(res, 200, { resolved: Boolean(out), reason: 'setup-timeout', winnerId: out?.winnerId });
        }
        return json(res, 202, { resolved: false, waiting: true });
      }

      if (cs.finalProofs?.[claimantSeat] && !cs.finalProofs?.[opponentSeat] && now - (cs.finalProofAt?.[claimantSeat] || now) >= consensusAckTimeoutMs) {
        if (body.replay) {
          verifyReplay(body.replay, match.seed, match.id, match.tournament_rules || null);
        }
        const out = await adjudicateMatchForfeit(
          match.id,
          opponentId,
          'withheld-final-proof',
          'Đối thủ cố tình không gửi chữ ký xác nhận cuối trận — Bạn được xử thắng kỹ thuật!',
          'Bạn không gửi chữ ký xác nhận kết quả cuối trận đúng hạn nên bị xử thua kỹ thuật.'
        );
        return json(res, 200, { resolved: Boolean(out), reason: 'withheld-final-proof', winnerId: out?.winnerId });
      }

      const currentStep = Number(cs.currentStep || 0);
      if (cs.lastRevealStep === currentStep && cs.acksForPendingStep?.[claimantSeat] && !cs.acksForPendingStep?.[opponentSeat] && now - (cs.lastRevealAt || now) >= consensusAckTimeoutMs) {
        const out = await adjudicateMatchForfeit(
          match.id,
          opponentId,
          'withheld-ack',
          'Đối thủ cố tình ngâm gói xác nhận trạng thái (ACK) — Bạn được xử thắng kỹ thuật ngay lập tức!',
          'Bạn không phản hồi gói xác nhận trạng thái (ACK) đúng hạn nên bị xử thua kỹ thuật.'
        );
        return json(res, 200, { resolved: Boolean(out), reason: 'withheld-ack', winnerId: out?.winnerId });
      }

      const activeTurnSeat = currentStep % 2 === 0 ? 1 : 2;
      const turnTimeoutMs = match.match_type === 'bot' ? 30000 : 45000;
      if (activeTurnSeat === opponentSeat && cs.lastRevealStep !== currentStep && now - (cs.stepStartedAt || now) >= turnTimeoutMs) {
        const out = await adjudicateMatchForfeit(
          match.id,
          opponentId,
          'turn-timeout',
          'Đối thủ treo máy hoặc không gửi nước đi đúng hạn — Bạn được xử thắng kỹ thuật!',
          'Bot hoặc phiên của bạn không gửi nước đi đúng hạn nên bị xử thua kỹ thuật.'
        );
        return json(res, 200, { resolved: Boolean(out), reason: 'turn-timeout', winnerId: out?.winnerId });
      }

      return json(res, 202, { resolved: false, waiting: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/match/claim-disconnect') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      const proof = body.proof;
      if (!proof || proof.kind !== 'disconnect-claim' || !body.signature) return json(res, 400, { error: 'Malformed disconnect claim' });
      const found = await pool.query("SELECT * FROM matches WHERE id=$1 AND status='active'", [proof.matchId]);
      const match = found.rows[0];
      if (!match || !canonicalMatchIds(match).includes(auth.sub)) return json(res, 404, { error: 'Active match not found' });
      const disconnectedId = match.player1_id === auth.sub ? match.player2_id : match.player1_id;
      if (match.disconnected_player_id === disconnectedId && match.disconnected_at && Date.now() - new Date(match.disconnected_at).getTime() >= DISCONNECT_FORFEIT_MS) {
        const out = await adjudicateMatchForfeit(
          match.id,
          disconnectedId,
          'disconnect-timeout',
          'Đối thủ đã mất kết nối quá thời gian quy định — Bạn được xử thắng kỹ thuật!',
          'Bạn đã mất kết nối quá thời gian quy định và bị xử thua kỹ thuật.'
        );
        return json(res, 200, { status: 'adjudicated', winnerId: out?.winnerId });
      }
      return json(res, 202, { status: 'waiting', message: 'Đang chờ xác minh trạng thái mất kết nối của đối thủ.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/match/consensus-dispute') {
      const auth = authFromHeader(req);
      const body = await readBody(req);
      return json(res, 200, await submitConsensusDispute(auth.sub, body));
    }
    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('HTTP request failed:', err.message);
    const duplicateMessage = err.constraint === 'users_email_key' ? 'Email already registered' : 'Thông tin bị trùng hoặc tài khoản đã thuộc một đội.';
    const serverMessage = err.code === '42703' || err.code === '42P01'
      ? 'Cấu trúc database chưa được cập nhật. Hãy khởi động lại backend để chạy migration.'
      : 'Máy chủ không xử lý được yêu cầu. Hãy kiểm tra log backend.';
    return json(res, err.status || (err.code === '23505' ? 409 : 500), {
      error: err.status ? err.message : err.code === '23505' ? duplicateMessage : serverMessage
    });
  }
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', ws => {
  ws.authenticated = false;
  const authTimeout = setTimeout(() => ws.close(4401, 'Authentication timeout'), 5000);
  ws.on('message', async raw => {
    let packet;
    try { packet = JSON.parse(raw.toString()); } catch { return send(ws, 'error', { message: 'Malformed JSON' }); }
    try {
      if (!ws.authenticated) {
        if (packet.type !== 'auth' || typeof packet.token !== 'string') return ws.close(4401, 'Send auth token first');
        const auth = verifyToken(packet.token, config.jwtSecret);
        const userResult = await pool.query('SELECT id,email,display_name,elo,avatar_id,is_admin,active_bot_version FROM users WHERE id=$1', [auth.sub]);
        if (!userResult.rows[0]) return ws.close(4401, 'Unknown account');
        clearTimeout(authTimeout);
        ws.authenticated = true;
        ws.user = userResult.rows[0];
        ws.searchStartedAt = 0;
        const previous = liveSockets.get(ws.user.id);
        liveSockets.set(ws.user.id, ws);
        if (previous && previous !== ws) previous.close(4001, 'Replaced by a newer session');
        await cancelQueue(redis, ws.user.id).catch(() => {});
        await redis.set(`ottv2:presence:${ws.user.id}`, instanceId, { EX: 60 });
        await pool.query("UPDATE matches SET disconnected_player_id=NULL, disconnected_at=NULL WHERE status='active' AND disconnected_player_id=$1", [ws.user.id]);
        send(ws, 'authenticated', { user: publicUser(ws.user) });
        return;
      }
      const userId = ws.user.id;
      if (packet.type === 'find-sparring-match') {
        if (ws.searching) throw Object.assign(new Error('Hãy hủy lượt tìm hiện tại trước khi bắt đầu sparring.'), { status: 409 });
        ws.searching = true;
        ws.searchCancelled = false;
        await createSparringMatch(ws.user, packet.mode === 'bot' ? 'bot' : 'human', packet.tournamentId || null);
      } else if (packet.type === 'find-match' || packet.type === 'find-bot-match') {
        const requestedMode = packet.type === 'find-bot-match' ? 'bot' : 'human';
        if (ws.searching) {
          if (ws.searchMode === requestedMode) {
            send(ws, 'searching', { elo: ws.user.elo, mode: requestedMode });
          } else {
            const activeMode = ws.tournamentSearch ? 'giải đấu' : (ws.searchMode === 'bot' ? 'Bot đấu Bot' : 'Người đấu người');
            send(ws, 'error', {
              mode: requestedMode,
              message: `Tài khoản đang tìm trận ${activeMode}. Hãy hủy lượt tìm hiện tại trước khi đổi chế độ.`
            });
          }
          return;
        }
        ws.searching = true;
        ws.searchCancelled = false;
        ws.searchStartedAt = Date.now();
        ws.searchMode = requestedMode;
        send(ws, 'searching', { elo: ws.user.elo, mode: requestedMode });
        await runSearch(userId, ws.searchMode);
      } else if (packet.type === 'find-tournament-match') {
        if (ws.searching) return;
        if (!/^[0-9a-f-]{36}$/i.test(packet.tournamentId || '')) {
          throw Object.assign(new Error('Mã giải đấu không hợp lệ.'), { status: 400 });
        }
        await updateTournamentLifecycle();
        const result = await pool.query(
          `SELECT t.id,t.name,t.format,t.status,t.registration_closes_at,t.ends_at,t.max_teams,
                  t.current_week,t.rules_json,e.rank_stars,e.tier,u.elo,
                  (SELECT count(*)::int FROM tournament_entries entries WHERE entries.tournament_id=t.id) AS participant_count
           FROM tournaments t JOIN tournament_entries e ON e.tournament_id=t.id
           JOIN users u ON u.id=e.player_id
           WHERE t.id=$1 AND e.player_id=$2`, [packet.tournamentId, userId]
        );
        const entry = result.rows[0];
        if (!entry || entry.status === 'completed' || new Date(entry.ends_at) <= new Date()) {
          throw Object.assign(new Error('Bạn chưa đăng ký hoặc giải đã kết thúc.'), { status: 409 });
        }
        const phase = entry.status === 'registration' ? 'practice' : 'ranked';
        if (phase === 'practice' && (new Date(entry.registration_closes_at) <= new Date() ||
            (entry.format !== 'group_knockout' && entry.participant_count >= entry.max_teams))) {
          throw Object.assign(new Error('Vòng chạy đà đã kết thúc; hãy tìm trận chính thức nếu giải đã mở.'), { status: 409 });
        }
        ws.searching = true;
        ws.searchCancelled = false;
        ws.searchStartedAt = Date.now();
        ws.tournamentSearch = {
          tournamentId: entry.id,
          tournamentName: entry.name,
          teamId: userId,
          individual: true,
          phase,
          elo: phase === 'practice' ? entry.elo : entry.rank_stars * 100,
          tier: phase === 'practice' ? 'Practice' : entry.tier,
          week: phase === 'practice' ? 1 : entry.current_week || 1
        };
        send(ws, 'searching', {
          tournamentId: entry.id, tournament: true, phase,
          tier: entry.tier, week: entry.current_week, rules: phase === 'ranked' ? entry.rules_json : null
        });
        await runTournamentSearch(userId);
      } else if (packet.type === 'cancel-match') {
        ws.searching = false;
        ws.searchCancelled = true;
        const timer = searchTimers.get(userId); if (timer) clearTimeout(timer);
        searchTimers.delete(userId);
        await cancelQueue(redis, userId);
        if (ws.tournamentSearch) {
          await cancelTournamentQueue(redis, ws.tournamentSearch.tournamentId, ws.tournamentSearch.teamId, userId, ws.tournamentSearch.week, tournamentQueueNamespace(ws.tournamentSearch));
          await clearGroupKnockoutReadiness(ws.tournamentSearch.tournamentId, userId);
          ws.tournamentSearch = null;
        }
        send(ws, 'search-cancelled');
      } else if (packet.type === 'leave-match') {
        if (packet.matchId) {
          await adjudicateMatchForfeit(
            packet.matchId,
            userId,
            'player-left-match',
            'Đối thủ đã thoát khỏi bàn đấu — Bạn được xử thắng kỹ thuật ngay lập tức!',
            'Bạn đã rời bàn khi trận đấu chưa kết thúc và bị xử thua kỹ thuật.'
          );
        }
      } else if (packet.type === 'bot-setup-failed' || packet.type === 'bot-fault') {
        if (packet.matchId) {
          await adjudicateMatchForfeit(
            packet.matchId,
            userId,
            'bot-fault',
            'Bot của đối thủ gặp lỗi hoặc quá thời gian xử lý — Bạn được xử thắng kỹ thuật ngay lập tức!',
            `Bot của bạn gặp lỗi thực thi (${String(packet.message || 'Runtime/TLE').slice(0, 80)}) nên bị xử thua kỹ thuật.`
          );
        }
      } else if (packet.type === 'session-key') {
        await registerSessionKey(userId, packet);
        send(ws, 'session-key-accepted', { matchId: packet.matchId });
      } else if (packet.type === 'rtc-disconnected' || packet.type === 'rtc-connected') {
        const found = await pool.query('SELECT id,player1_id,player2_id,status FROM matches WHERE id=$1', [packet.matchId]);
        const match = found.rows[0];
        if (!match || match.status !== 'active' || !canonicalMatchIds(match).includes(userId)) throw new Error('Not authorized for this match');
        if (packet.type === 'rtc-disconnected') {
          const peerId = match.player1_id === userId ? match.player2_id : match.player1_id;
          const peerPresence = await redis.get(`ottv2:presence:${peerId}`);
          if (!peerPresence) {
            await pool.query(
              `UPDATE matches SET disconnected_at=CASE WHEN disconnected_player_id=$1 THEN disconnected_at ELSE now() END,
                 disconnected_player_id=$1 WHERE id=$2 AND status='active'`,
              [peerId, match.id]
            );
          }
        } else {
          await pool.query('UPDATE matches SET disconnected_player_id=NULL, disconnected_at=NULL WHERE id=$1 AND status=\'active\'', [match.id]);
        }
      } else if (packet.type === 'match-relay' && sparringSessions.has(packet.matchId)) {
        await handleSparringRelay(sparringSessions.get(packet.matchId), ws, packet.payload);
      } else if (packet.type === 'signal' || packet.type === 'match-relay') {
        if (!packet.matchId || !packet.payload) throw new Error('Missing signaling payload');
        const result = await pool.query('SELECT id,player1_id,player2_id,player1_key,player2_key,match_type,status FROM matches WHERE id=$1', [packet.matchId]);
        const match = result.rows[0];
        if (!match || match.status !== 'active' || !canonicalMatchIds(match).includes(userId)) throw new Error('Not authorized to signal this match');
        const senderSeat = match.player1_id === userId ? 1 : 2;
        const senderKey = senderSeat === 1 ? match.player1_key : match.player2_key;
        if (packet.type === 'match-relay' && packet.payload && typeof packet.payload === 'object') {
          const p = packet.payload;
          if (['CONSENSUS_COMMIT', 'CONSENSUS_REVEAL', 'CONSENSUS_ACK'].includes(p.type)) {
            const att = p.attestation;
            if (!att?.payload || att.payload.player !== senderSeat || (senderKey && !verifySessionProof(senderKey, att.payload, att.signature))) {
              await adjudicateMatchForfeit(
                match.id,
                userId,
                'invalid-relay-signature',
                'Phát hiện đối thủ gửi gói đồng thuận giả mạo chữ ký — Bạn được xử thắng kỹ thuật ngay lập tức!',
                'Gói đồng thuận của bạn có chữ ký P-256 không hợp lệ nên bị xử thua kỹ thuật.'
              );
              return;
            }
          } else if (p.type === 'FINAL_PROOF') {
            if (p.seat !== senderSeat || (senderKey && !verifySessionProof(senderKey, p.proof, p.signature))) {
              await adjudicateMatchForfeit(
                match.id,
                userId,
                'invalid-final-signature',
                'Phát hiện đối thủ gửi chữ ký kết thúc ván không hợp lệ — Bạn được xử thắng kỹ thuật!',
                'Chữ ký kết thúc ván của bạn không hợp lệ nên bị xử thua kỹ thuật.'
              );
              return;
            }
          }
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const locked = await client.query(
              'SELECT match_type,status,consensus_state FROM matches WHERE id=$1 FOR UPDATE',
              [match.id]
            );
            const lockedMatch = locked.rows[0];
            if (lockedMatch?.status === 'active') {
              const cs = lockedMatch.consensus_state || createInitialConsensusState(lockedMatch.match_type);
              const now = Date.now();
              cs.lastActivityAt = now;
              if (p.type === 'BOT_READY' || (p.type === 'CONSENSUS_HELLO' && p.autoStart)) {
                if (senderSeat === 1 && !cs.p1ReadyAt) cs.p1ReadyAt = now;
                if (senderSeat === 2 && !cs.p2ReadyAt) cs.p2ReadyAt = now;
                if (cs.p1ReadyAt && cs.p2ReadyAt && !cs.bothReadyAt) {
                  cs.bothReadyAt = now;
                  cs.stepStartedAt = now;
                }
              } else if (p.type === 'CONSENSUS_REVEAL' && p.attestation?.payload) {
                cs.lastRevealStep = p.attestation.payload.stepCount;
                cs.lastRevealSeat = senderSeat;
                cs.lastRevealAt = now;
                cs.lastRevealCommit = p.attestation.payload.commit;
              } else if (p.type === 'CONSENSUS_ACK' && p.attestation?.payload) {
                const ackPayload = p.attestation.payload;
                const ackStep = Number(ackPayload.stepCount);
                const currentStep = Number(cs.currentStep || 0);
                if (
                  Number.isSafeInteger(ackStep) &&
                  ackStep >= 1 &&
                  ackStep <= currentStep + 1 &&
                  ackPayload.matchId === match.id &&
                  typeof ackPayload.moveCommit === 'string' &&
                  typeof ackPayload.stateHash === 'string'
                ) {
                  ackReceipt = {
                    matchId: match.id,
                    stepCount: ackStep,
                    stateHash: ackPayload.stateHash,
                  };
                }
                if (ackStep === currentStep + 1 && ackReceipt) {
                  cs.acksForPendingStep = cs.acksForPendingStep || {};
                  cs.acksForPendingStep[senderSeat] = ackPayload.stateHash;
                  if (
                    cs.acksForPendingStep[1] &&
                    cs.acksForPendingStep[2] &&
                    cs.acksForPendingStep[1] === cs.acksForPendingStep[2]
                  ) {
                    cs.currentStep = ackStep;
                    cs.acksForPendingStep = {};
                    cs.lastRevealStep = null;
                    cs.stepStartedAt = now;
                  }
                }
              } else if (p.type === 'FINAL_PROOF' && p.proof) {
                cs.finalProofs = cs.finalProofs || {};
                cs.finalProofAt = cs.finalProofAt || {};
                cs.finalProofs[senderSeat] = { proof: p.proof, signature: p.signature };
                cs.finalProofAt[senderSeat] = now;
              }
              await client.query('UPDATE matches SET consensus_state=$1::jsonb WHERE id=$2', [JSON.stringify(cs), match.id]);
            }
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK');
            throw err;
          } finally {
            client.release();
          }
          if (ackReceipt) send(ws, 'consensus-ack-received', ackReceipt);
        }
        const peerId = match.player1_id === userId ? match.player2_id : match.player1_id;
        const online = await redis.get(`ottv2:presence:${peerId}`);
        if (!online) return send(ws, 'peer-offline', { matchId: packet.matchId });
        await deliverToUser(peerId, packet.type, { matchId: packet.matchId, from: userId, payload: packet.payload });
      } else if (packet.type === 'ping') send(ws, 'pong', { at: Date.now() });
      else send(ws, 'error', { message: 'Unknown message type' });
    } catch (err) {
      if (['find-match', 'find-bot-match', 'find-sparring-match'].includes(packet.type)) {
        ws.searchCancelled = true;
        ws.searching = false;
        const timer = searchTimers.get(ws.user?.id);
        if (timer) clearTimeout(timer);
        searchTimers.delete(ws.user?.id);
        const queueName = ws.searchMode === 'bot' ? 'ottv2:bot-matchmaking' : 'ottv2:matchmaking';
        await cancelQueue(redis, ws.user?.id, queueName).catch(cleanupError => {
          console.error('Could not clear failed matchmaking queue entry:', cleanupError);
        });
      }
      if (packet.type === 'find-tournament-match' && ws.tournamentSearch) {
        const search = ws.tournamentSearch;
        ws.searching = false;
        ws.searchCancelled = true;
        ws.tournamentSearch = null;
        const timer = searchTimers.get(ws.user?.id);
        if (timer) clearTimeout(timer);
        searchTimers.delete(ws.user?.id);
        await cancelTournamentQueue(redis, search.tournamentId, search.teamId, ws.user?.id, search.week, tournamentQueueNamespace(search)).catch(() => {});
      }
      send(ws, 'error', {
        message: err.message,
        ...(['find-match', 'find-bot-match'].includes(packet.type)
          ? { mode: packet.type === 'find-bot-match' ? 'bot' : 'human' }
          : {})
      });
    }
  });
  ws.on('close', async () => {
    clearTimeout(authTimeout);
    if (!ws.user) return;
    const isCurrentSession = liveSockets.get(ws.user.id) === ws;
    if (!isCurrentSession) return;
    liveSockets.delete(ws.user.id);
    ws.searchCancelled = true;
    const timer = searchTimers.get(ws.user.id); if (timer) clearTimeout(timer);
    searchTimers.delete(ws.user.id);
    await cancelQueue(redis, ws.user.id).catch(() => {});
    if (ws.tournamentSearch) {
      await cancelTournamentQueue(redis, ws.tournamentSearch.tournamentId, ws.tournamentSearch.teamId, ws.user.id, ws.tournamentSearch.week, tournamentQueueNamespace(ws.tournamentSearch)).catch(() => {});
      await clearGroupKnockoutReadiness(ws.tournamentSearch.tournamentId, ws.user.id).catch(() => {});
    }
    const presence = await redis.get(`ottv2:presence:${ws.user.id}`).catch(() => null);
    if (presence === instanceId) await redis.del(`ottv2:presence:${ws.user.id}`).catch(() => {});
    const active = await pool.query("SELECT id, player1_id, player2_id FROM matches WHERE status='active' AND is_sparring=FALSE AND (player1_id=$1 OR player2_id=$1)", [ws.user.id]).catch(() => ({ rows: [] }));
    for (const match of active.rows) {
      const peerId = match.player1_id === ws.user.id ? match.player2_id : match.player1_id;
      try {
        const marked = await pool.query(
          `UPDATE matches SET disconnected_at=CASE WHEN disconnected_player_id=$1 THEN disconnected_at ELSE now() END,
             disconnected_player_id=$1 WHERE id=$2 AND status='active' RETURNING id`,
          [ws.user.id, match.id]
        );
        if (marked.rowCount) {
          await deliverToUser(peerId, 'peer-disconnected', { matchId: match.id, disconnectedPlayerId: ws.user.id });
        }
      } catch (error) {
        console.error(`Could not record disconnect for match ${match.id}:`, error.message);
      }
    }
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  for (const [userId, socket] of liveSockets) {
    if (socket.readyState === WebSocket.OPEN) redis.set(`ottv2:presence:${userId}`, instanceId, { EX: 60 }).catch(() => {});
  }
}, 30000);
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

async function main() {
  await redis.connect();
  await redisEvents.connect();
  await redisEvents.pSubscribe('ottv2:user:*', (message, channel) => {
    const userId = channel.slice('ottv2:user:'.length);
    const socket = userSocket(userId);
    if (!socket) return;
    try {
      const event = JSON.parse(message);
      if (event.type === 'match-found') {
        socket.searchCancelled = true;
        socket.searching = false;
        const timer = searchTimers.get(userId); if (timer) clearTimeout(timer);
        searchTimers.delete(userId);
        cancelQueue(redis, userId).catch(() => {});
        if (socket.tournamentSearch) {
          const search = socket.tournamentSearch;
          cancelTournamentQueue(redis, search.tournamentId, search.teamId, userId, search.week, tournamentQueueNamespace(search)).catch(() => {});
          socket.tournamentSearch = null;
        }
      }
      send(socket, event.type, event.data);
    } catch (err) { console.error('Invalid Redis event:', err.message); }
  });
  await pool.query(await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/002_individual_bots.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/003_match_elo_mode.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/004_admin_sprint_rules.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/005_star_rank_system.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/006_tournament_phases_and_standings.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/007_match_disputes.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/008_player_avatar.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/009_legacy_match_modes.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/010_sparring_bot.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/011_tournament_and_dispute_upgrades.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/012_admin_sprints_and_user_elo.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/013_profile_appearance.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/014_profile_background_url.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/015_group_knockout_tournaments.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/016_group_knockout_launch_controls.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../migrations/017_server_tournament_runner.sql', import.meta.url), 'utf8'));
  await updateTournamentLifecycle();
  tournamentLifecycleTimer = setInterval(() => updateTournamentLifecycle().catch(error => {
    console.error('Tournament lifecycle update failed:', error.message);
  }), 60000);
  disconnectForfeitTimer = setInterval(() => processDisconnectedMatches().catch(error => {
    console.error('Disconnected match resolution failed:', error.message);
  }), 1000);
  disconnectForfeitTimer.unref();
  httpServer.listen(config.port, () => console.log(`OTTv2 backend listening on :${config.port}`));
  tournamentRunner.start();
}
async function shutdown() {
  await tournamentRunner.stop();
  clearInterval(heartbeat);
  if (tournamentLifecycleTimer) clearInterval(tournamentLifecycleTimer);
  if (disconnectForfeitTimer) clearInterval(disconnectForfeitTimer);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  await redis.quit().catch(() => {});
  await redisEvents.quit().catch(() => {});
  await pool.end().catch(() => {});
  httpServer.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(err => { console.error('Backend startup failed:', err); process.exit(1); });
