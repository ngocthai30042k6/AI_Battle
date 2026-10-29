import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  webcrypto,
} from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import type { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { knockoutConfiguration, knockoutStartTime, newKnockoutSeries, recordKnockoutGame } from './server/src/knockout-series.js';
import { minimumTournamentElo, requireTournamentElo } from './server/src/tournament-eligibility.js';
import { playServerBotMatch } from './server/src/server-bot-match.js';
import {
  TOURNAMENT_RANKS,
  applySprintRankReset,
  applyTournamentResult,
  buildTournamentMotivation,
  rankTier,
  tournamentRanks,
} from './server/src/tournament-ranks.js';
import {
  hashCanonical,
  verifyConsensusDispute,
  verifyReplay,
  verifySessionProof,
} from './server/src/replay.js';
import {
  buildTournamentRules,
  calculateGroupStandings,
  createDoubleRoundRobinFixtures,
  createKnockoutOpeningRound,
  createNextKnockoutRound,
  distributeTournamentGroups,
} from './server/src/tournament-format.js';

const require = createRequire(import.meta.url);
const { OTTGameEngine } = require('./shared/OTTGameEngine.js');

const scrypt = promisify(scryptCb);
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ottv2-local-dev-secret-key-minimum-32-chars';
const FIDE_K = Number(process.env.FIDE_K_FACTOR) || 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DISCONNECT_FORFEIT_MS = Number(process.env.DISCONNECT_FORFEIT_MS) || 5000;

type RankTier = 'Bronze' | 'Silver' | 'Gold' | 'Master' | 'Challenger';

const SPRINT_RULE_LAYOUTS: Record<string, { title: string; blockedCells: number[] }> = {
  standard: { title: 'Bàn chuẩn', blockedCells: [] },
  center_blockers: { title: 'Chướng ngại trung tâm', blockedCells: [30, 31, 32, 39, 40, 41, 48, 49, 50] },
  clipped_corners: { title: 'Bàn vát góc', blockedCells: [0, 1, 9, 10, 70, 71, 79, 80] },
  corridor: { title: 'Hành lang vật cản', blockedCells: [22, 24, 38, 40, 42, 56, 58] },
};

const DEFAULT_SPRINT_RULES = ['standard', 'center_blockers', 'clipped_corners', 'corridor'];
const PROFILE_BACKGROUND_IDS = [
  'castle',
  'moonlight',
  'emerald',
  'ocean',
  'sunset',
  'aurora',
  'crimson',
  'ice',
] as const;
const PLAYER_AVATAR_IDS = [
  'pumpkin', 'ghost', 'bat', 'knight', 'fox', 'crown',
  'dragon', 'cat', 'wizard', 'alien', 'skull', 'robot', 'spider', 'unicorn',
] as const;
const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024;

function weeklyRules(week: number, schedule: string[] = DEFAULT_SPRINT_RULES) {
  const sprint = Math.max(1, Number(week) || 1);
  const configured = Array.isArray(schedule) && schedule.length ? schedule : DEFAULT_SPRINT_RULES;
  const layoutId = configured[(sprint - 1) % configured.length];
  const layout = SPRINT_RULE_LAYOUTS[layoutId] || SPRINT_RULE_LAYOUTS.standard;
  return {
    id: `sprint-${sprint}-${layoutId}`,
    week: sprint,
    title: layout.title,
    rows: 9,
    cols: 9,
    blockedCells: [...layout.blockedCells],
  };
}

function calculateElo(rating: number, opponentRating: number, score: number, kFactor = FIDE_K) {
  const expected = 1 / (1 + 10 ** ((opponentRating - rating) / 400));
  return Math.max(100, Math.round(rating + kFactor * (score - expected)));
}

// ── Crypto & Auth Helpers ─────────────────────────────────────
const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password: string, encoded: string) {
  const [scheme, saltText, hashText] = String(encoded).split('$');
  if (scheme !== 'scrypt' || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, 'base64url');
  const actual = (await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createToken(user: { id: string; email: string }, ttlSeconds = 86400 * 7) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: user.id, email: user.email, iat: now, exp: now + ttlSeconds }));
  const unsigned = `${header}.${payload}`;
  const sig = createHmac('sha256', JWT_SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

function verifyToken(token: string): { sub: string; email: string; exp: number } {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw Object.assign(new Error('Phiên đăng nhập không hợp lệ.'), { status: 401 });
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', JWT_SECRET).update(unsigned).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw Object.assign(new Error('Phiên đăng nhập không hợp lệ.'), { status: 401 });
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (!payload?.sub || payload.exp <= Date.now() / 1000) {
    throw Object.assign(new Error('Phiên đăng nhập đã hết hạn.'), { status: 401 });
  }
  return payload;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256Canonical = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

function statePayload(current: any) {
  return {
    board: Array.from(current.board),
    turn: current.turn,
    stepCount: current.stepCount,
    winner: current.winner === 0 ? 0 : current.winner || null,
    seed: current.seed,
    pieceCount: current.pieceCount,
    lastMove: current.lastMove || null,
    ...(current.rules ? { rules: current.rules } : {}),
  };
}

// ── Persistent Store Types ────────────────────────────────────
interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  avatar_id?: string;
  avatar_url?: string;
  profile_background_url?: string;
  profile_background_id?: string;
  elo: number;
  elo_peak?: number;
  is_admin: boolean;
  active_bot_version: number;
  is_system_bot?: boolean;
  created_at: string;
}

interface BotVersionRecord {
  user_id: string;
  version: number;
  code: string;
  code_sha256: string;
  created_at: string;
}

interface TournamentRecord {
  min_elo?: number;
  knockout_starts_at?: string;
  knockout_started_at?: string;
  knockout_rules_json?: any;
  execution_mode?: 'browser' | 'server';
  id: string;
  name: string;
  format: 'ranked_weekly' | 'group_knockout';
  description: string;
  status: 'scheduled' | 'registration' | 'grouping' | 'group_stage' | 'group_running' | 'group_complete' | 'knockout' | 'qualifying' | 'completed' | 'cancelled';
  registration_closes_at: string;
  registration_opens_at?: string;
  tournament_starts_at?: string;
  ends_at: string;
  max_teams: number;
  group_count?: number | null;
  current_week: number;
  last_reset_week?: number;
  week_started_at: string | null;
  rules_json: any;
  rules_schedule: string[];
  created_at: string;
}

interface TournamentEntryRecord {
  bot_code_snapshot?: string;
  bot_sha256_snapshot?: string;
  tournament_id: string;
  player_id: string;
  bot_version: number;
  matches_played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  tournament_elo: number;
  tier: RankTier;
  rank_stars: number;
  season_points: number;
  registered_at: string;
  group_number?: number | null;
}

interface TournamentFixtureRecord {
  series_best_of?: number;
  player1_score?: number;
  player2_score?: number;
  games_played?: number;
  next_first_player_id?: string;
  series_games?: any[];

  id: string;
  tournament_id: string;
  phase: 'group' | 'knockout';
  group_number: number | null;
  round_number: number;
  match_number: number;
  leg: number;
  player1_id: string;
  player2_id: string;
  status: 'pending' | 'active' | 'completed';
  winner_id: string | null;
  move_count: number | null;
  player1_ready_at: string | null;
  player2_ready_at: string | null;
  match_id: string | null;
}

interface ConsensusTrackState {
  createdAtMs: number;
  p1ReadyAt: number | null;
  p2ReadyAt: number | null;
  bothReadyAt: number | null;
  currentStep: number;
  stepStartedAt: number | null;
  lastRevealStep: number | null;
  lastRevealSeat: 1 | 2 | null;
  lastRevealAt: number | null;
  lastRevealCommit: string | null;
  acksForPendingStep: Record<number, string>;
  finalProofs: Record<number, { proof: any; signature: string }>;
  finalProofAt: Record<number, number>;
  lastActivityAt: number;
}

interface MatchRecord {
  execution_mode?: 'browser' | 'server';
  id: string;
  seed: number;
  player1_id: string;
  player2_id: string;
  match_type: 'human' | 'bot';
  status: 'pending' | 'active' | 'completed' | 'disputed' | 'abandoned';
  tournament_id: string | null;
  tournament_phase: 'practice' | 'ranked' | 'group' | 'knockout' | null;
  tournament_rules: any | null;
  tournament_fixture_id?: string | null;
  final_step_count?: number | null;
  is_sparring?: boolean;
  player1_bot_version?: number;
  player2_bot_version?: number;
  player1_bot_code?: string;
  player2_bot_code?: string;
  player1_key: Record<string, unknown> | null;
  player2_key: Record<string, unknown> | null;
  winner_id: string | null;
  final_state_hash: string | null;
  replay_sha256: string | null;
  replay_json: any | null;
  player1_proof: any | null;
  player2_proof: any | null;
  disconnected_player_id?: string | null;
  disconnected_at?: string | null;
  consensus_state?: ConsensusTrackState | null;
  created_at: string;
  completed_at: string | null;
}

interface MatchResultRecord {
  match_id: string;
  player1_elo_before: number;
  player2_elo_before: number;
  player1_elo_after: number;
  player2_elo_after: number;
  result_player1: number;
  created_at: string;
}

interface MatchDisputeRecord {
  match_id: string;
  claimant_id: string;
  offender_id: string | null;
  status: 'adjudicated' | 'needs_review';
  reason: string;
  winner_id: string | null;
  step_count: number;
  expected_state_hash: string;
  created_at: string;
}

interface DatabaseSchema {
  groupKnockoutLifecycleVersion?: number;
  users: UserRecord[];
  botVersions: BotVersionRecord[];
  tournaments: TournamentRecord[];
  tournamentEntries: TournamentEntryRecord[];
  tournamentFixtures: TournamentFixtureRecord[];
  matches: MatchRecord[];
  matchResults: MatchResultRecord[];
  matchDisputes: MatchDisputeRecord[];
}

function createInitialConsensusState(matchType: 'human' | 'bot'): ConsensusTrackState {
  const now = Date.now();
  return {
    createdAtMs: now,
    p1ReadyAt: matchType === 'human' ? now : null,
    p2ReadyAt: matchType === 'human' ? now : null,
    bothReadyAt: matchType === 'human' ? now : null,
    currentStep: 0,
    stepStartedAt: matchType === 'human' ? now : null,
    lastRevealStep: null,
    lastRevealSeat: null,
    lastRevealAt: null,
    lastRevealCommit: null,
    acksForPendingStep: {},
    finalProofs: {},
    finalProofAt: {},
    lastActivityAt: now,
  };
}

const DEFAULT_MINIMAX_PYTHON = `def get_next_move(my_player_id, game_state):
    valid_moves = game_state.get('validMoves', [])
    if not valid_moves:
        return None
    goal_row, goal_col = (0, 8) if my_player_id == 1 else (8, 0)
    best_move = valid_moves[0]
    best_score = float('-inf')
    for move in valid_moves:
        score = 150 if move.get('isAttack') else 0
        distance = abs(move['toRow'] - goal_row) + abs(move['toCol'] - goal_col)
        score -= distance * 10
        score -= abs(move['toRow'] - 4) + abs(move['toCol'] - 4)
        if score > best_score:
            best_score = score
            best_move = move
    return {
        'fromRow': best_move['fromRow'],
        'fromCol': best_move['fromCol'],
        'toRow': best_move['toRow'],
        'toCol': best_move['toCol'],
    }`;

async function createSeedDatabase(): Promise<DatabaseSchema> {
  const now = Date.now();
  const pwHash = await hashPassword('halloween2026');
  const systemBotId = '00000000-0000-4000-8000-000000000001';
  const demoPlayerId = '00000000-0000-4000-8000-000000000002';
  const p2Id = '00000000-0000-4000-8000-000000000003';
  const p3Id = '00000000-0000-4000-8000-000000000004';
  const p4Id = '00000000-0000-4000-8000-000000000005';

  const users: UserRecord[] = [
    {
      id: systemBotId,
      email: 'guardian@ottv2.local',
      password_hash: pwHash,
      display_name: 'Hắc Kỵ Sĩ AI (Sparring)',
      elo: 1320,
      is_admin: false,
      active_bot_version: 1,
      is_system_bot: true,
      created_at: new Date(now - 14 * 86400000).toISOString(),
    },
    {
      id: demoPlayerId,
      email: 'admin@ottv2.local',
      password_hash: pwHash,
      display_name: 'Minh Quân',
      elo: 1685,
      is_admin: false,
      active_bot_version: 2,
      created_at: new Date(now - 12 * 86400000).toISOString(),
    },
    {
      id: p2Id,
      email: 'linhdan@ottv2.local',
      password_hash: pwHash,
      display_name: 'Linh Đan AI',
      elo: 1560,
      is_admin: false,
      active_bot_version: 3,
      created_at: new Date(now - 10 * 86400000).toISOString(),
    },
    {
      id: p3Id,
      email: 'hoangnam@ottv2.local',
      password_hash: pwHash,
      display_name: 'Hoàng Nam · AlphaRPS',
      elo: 1435,
      is_admin: false,
      active_bot_version: 1,
      created_at: new Date(now - 8 * 86400000).toISOString(),
    },
    {
      id: p4Id,
      email: 'thaovy@ottv2.local',
      password_hash: pwHash,
      display_name: 'Thảo Vy · NightOwl',
      elo: 1290,
      is_admin: false,
      active_bot_version: 1,
      created_at: new Date(now - 5 * 86400000).toISOString(),
    },
  ];

  const codeSha = createHash('sha256').update(DEFAULT_MINIMAX_PYTHON).digest('hex');
  const botVersions: BotVersionRecord[] = users.map((u) => ({
    user_id: u.id,
    version: u.active_bot_version,
    code: DEFAULT_MINIMAX_PYTHON,
    code_sha256: codeSha,
    created_at: u.created_at,
  }));

  const t1Id = '11111111-2222-4333-8444-555555555501';
  const t2Id = '11111111-2222-4333-8444-555555555502';
  const sprint2Rules = weeklyRules(2, ['standard', 'center_blockers', 'clipped_corners', 'corridor']);

  const tournaments: TournamentRecord[] = [
    {
      id: t1Id,
      name: 'Halloween Blood Moon Cup 2026',
      format: 'ranked_weekly',
      description:
        'Giải đấu sự kiện Halloween chính thức của OTTv2 chia 2 giai đoạn. Hiện đang ở Giai đoạn Thực chiến — Sprint 2 (Chướng ngại trung tâm). Bảng xếp hạng Thách Đấu được bảo mật cho đến khi giải khép lại!',
      status: 'qualifying',
      registration_closes_at: new Date(now - 8 * 86400000).toISOString(),
      ends_at: new Date(now + 20 * 86400000).toISOString(),
      max_teams: 64,
      current_week: 2,
      last_reset_week: 2,
      week_started_at: new Date(now - 8 * 86400000).toISOString(),
      rules_json: sprint2Rules,
      rules_schedule: ['standard', 'center_blockers', 'clipped_corners', 'corridor'],
      created_at: new Date(now - 12 * 86400000).toISOString(),
    },
    {
      id: t2Id,
      name: 'OTTv2 Open Sprint — Mùa Thu Đông',
      format: 'ranked_weekly',
      description:
        'Mùa giải cá nhân mở rộng dành cho mọi lập trình viên AI. Hiện đang mở cổng đăng ký và Vòng Chạy Đà — Bot đã nộp sẽ tự động ra sân thử nghiệm chiến thuật ngẫu nhiên (không cộng/trừ Sao).',
      status: 'registration',
      registration_closes_at: new Date(now + 5 * 86400000).toISOString(),
      ends_at: new Date(now + 33 * 86400000).toISOString(),
      max_teams: 128,
      current_week: 0,
      last_reset_week: 0,
      week_started_at: null,
      rules_json: {},
      rules_schedule: ['standard', 'clipped_corners', 'center_blockers', 'corridor'],
      created_at: new Date(now - 2 * 86400000).toISOString(),
    },
  ];

  const tournamentEntries: TournamentEntryRecord[] = [
    {
      tournament_id: t1Id,
      player_id: demoPlayerId,
      bot_version: 2,
      matches_played: 32,
      wins: 28,
      draws: 1,
      losses: 3,
      points: 28,
      tournament_elo: 1685,
      tier: 'Challenger',
      rank_stars: 0,
      season_points: 12,
      registered_at: new Date(now - 11 * 86400000).toISOString(),
    },
    {
      tournament_id: t1Id,
      player_id: p2Id,
      bot_version: 3,
      matches_played: 14,
      wins: 10,
      draws: 1,
      losses: 3,
      points: 10,
      tournament_elo: 1560,
      tier: 'Gold',
      rank_stars: 7,
      season_points: 0,
      registered_at: new Date(now - 10 * 86400000).toISOString(),
    },
    {
      tournament_id: t1Id,
      player_id: p3Id,
      bot_version: 1,
      matches_played: 10,
      wins: 6,
      draws: 1,
      losses: 3,
      points: 6,
      tournament_elo: 1435,
      tier: 'Silver',
      rank_stars: 5,
      season_points: 0,
      registered_at: new Date(now - 9 * 86400000).toISOString(),
    },
    {
      tournament_id: t1Id,
      player_id: p4Id,
      bot_version: 1,
      matches_played: 8,
      wins: 4,
      draws: 1,
      losses: 3,
      points: 4,
      tournament_elo: 1290,
      tier: 'Bronze',
      rank_stars: 3,
      season_points: 0,
      registered_at: new Date(now - 9 * 86400000).toISOString(),
    },
    {
      tournament_id: t2Id,
      player_id: p2Id,
      bot_version: 3,
      matches_played: 2,
      wins: 1,
      draws: 0,
      losses: 1,
      points: 0,
      tournament_elo: 1560,
      tier: 'Silver',
      rank_stars: 0,
      season_points: 0,
      registered_at: new Date(now - 86400000).toISOString(),
    },
    {
      tournament_id: t2Id,
      player_id: p3Id,
      bot_version: 1,
      matches_played: 3,
      wins: 2,
      draws: 0,
      losses: 1,
      points: 0,
      tournament_elo: 1435,
      tier: 'Silver',
      rank_stars: 0,
      season_points: 0,
      registered_at: new Date(now - 86400000).toISOString(),
    },
  ];

  return {
    users,
    botVersions,
    tournaments,
    tournamentEntries,
    tournamentFixtures: [],
    matches: [],
    matchResults: [],
    matchDisputes: [],
  };
}

function publicUser(u: UserRecord) {
  const highestElo = Math.max(u.elo, u.elo_peak || u.elo);
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    elo: u.elo,
    avatarId: u.avatar_id || 'pumpkin',
    avatarUrl: u.avatar_url || null,
    profileBackgroundUrl: u.profile_background_url || null,
    profileBackgroundId: PROFILE_BACKGROUND_IDS.includes(
      u.profile_background_id as (typeof PROFILE_BACKGROUND_IDS)[number]
    ) ? u.profile_background_id : 'castle',
    highestElo,
    isAdmin: Boolean(u.is_admin),
    activeBotVersion: u.active_bot_version || 0,
  };
}

function isAllowedAvatarDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_AVATAR_UPLOAD_BYTES * 4 / 3) + 64) return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;

  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > MAX_AVATAR_UPLOAD_BYTES || bytes.toString('base64') !== match[2]) return false;
  if (match[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (match[1] === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  );
}

function pickTacticalBotMove(state: any, botSeat: 1 | 2) {
  const botState = OTTGameEngine.createBotGameState(state, botSeat);
  const validMoves = botState.validMoves || [];
  if (!validMoves.length) return null;
  let best = validMoves[0];
  let bestScore = -Infinity;
  const targetRow = botSeat === 1 ? 0 : 8;
  const targetCol = botSeat === 1 ? 8 : 0;
  for (const m of validMoves) {
    if ((botSeat === 1 && m.to === 8) || (botSeat === 2 && m.to === 72)) {
      return { from: m.from, to: m.to };
    }
    let score = m.isAttack ? 145 : 0;
    score -= (Math.abs(m.toRow - targetRow) + Math.abs(m.toCol - targetCol)) * 12;
    score -= (Math.abs(m.toRow - 4) + absColDelta(m.toCol)) * 2;
    score += (Math.random() - 0.5) * 10;
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return { from: best.from, to: best.to };
}

function absColDelta(col: number) {
  return Math.abs(col - 4);
}

async function signWithWebCrypto(privateKey: CryptoKey, payload: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonical(payload));
  const sig = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encoded);
  return Buffer.from(sig).toString('hex');
}

interface SparringSession {
  matchId: string;
  humanSeat: 1 | 2;
  botSeat: 1 | 2;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  state: any;
  pendingCommits: Map<number, { commit: string; commitAttestation: any }>;
  moves: any[];
  destroyed: boolean;
}

export interface ServerTimeoutOptions {
  disconnectForfeitMs?: number;
  setupTimeoutMs?: number;
  setupPeerReadyTimeoutMs?: number;
  ackTimeoutMs?: number;
  botAckTimeoutMs?: number;
  botTurnTimeoutMs?: number;
  sweepIntervalMs?: number;
}

export interface ServerStartOptions {
  port?: number;
  dbPath?: string;
  skipVite?: boolean;
  testAdminEmails?: string[];
  timeouts?: ServerTimeoutOptions;
}

export async function startServer(options: ServerStartOptions = {}) {
  const port = options.port !== undefined ? options.port : DEFAULT_PORT;
  const disconnectForfeitMs = options.timeouts?.disconnectForfeitMs ?? DISCONNECT_FORFEIT_MS;
  const setupTimeoutMs = options.timeouts?.setupTimeoutMs ?? 35000;
  const setupPeerReadyTimeoutMs = options.timeouts?.setupPeerReadyTimeoutMs ?? 25000;
  const ackTimeoutMs = options.timeouts?.ackTimeoutMs ?? 4500;
  const botAckTimeoutMs = options.timeouts?.botAckTimeoutMs ?? 30000;
  const botTurnTimeoutMs = options.timeouts?.botTurnTimeoutMs ?? 30000;
  const sweepIntervalMs = options.timeouts?.sweepIntervalMs ?? 500;
  const dbPath =
    options.dbPath ||
    process.env.OTTV2_DB_PATH ||
    path.join(path.resolve(process.cwd(), 'data'), 'local-db.json');
  const dataDir = path.dirname(dbPath);

  let db: DatabaseSchema;

  function saveDb() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
    } catch (err) {
      console.error('Could not persist local DB:', err);
    }
  }

  function recordEloPeak(user: UserRecord, rating: number) {
    user.elo_peak = Math.max(user.elo_peak || user.elo, rating);
  }

  async function initDb() {
    try {
      if (fs.existsSync(dbPath)) {
        const parsed = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.tournaments)) {
          db = parsed;
          db.matches = Array.isArray(db.matches) ? db.matches : [];
          db.matchResults = Array.isArray(db.matchResults) ? db.matchResults : [];
          db.matchDisputes = Array.isArray(db.matchDisputes) ? db.matchDisputes : [];
          db.tournamentFixtures = Array.isArray(db.tournamentFixtures) ? db.tournamentFixtures : [];
          const rankedMatchesById = new Map(
            db.matches
              .filter(
                (match) =>
                  match.match_type === 'bot' &&
                  match.tournament_phase !== 'practice' &&
                  !match.is_sparring
              )
              .map((match) => [match.id, match])
          );
          const historicalPeakByUser = new Map<string, number>();
          for (const result of db.matchResults) {
            const match = rankedMatchesById.get(result.match_id);
            if (!match) continue;
            const player1Peak = Math.max(result.player1_elo_before, result.player1_elo_after);
            const player2Peak = Math.max(result.player2_elo_before, result.player2_elo_after);
            historicalPeakByUser.set(
              match.player1_id,
              Math.max(historicalPeakByUser.get(match.player1_id) || 0, player1Peak)
            );
            historicalPeakByUser.set(
              match.player2_id,
              Math.max(historicalPeakByUser.get(match.player2_id) || 0, player2Peak)
            );
          }
          let eloPeaksMigrated = false;
          for (const user of db.users) {
            const highestElo = Math.max(
              user.elo,
              user.elo_peak || user.elo,
              historicalPeakByUser.get(user.id) || 0
            );
            if (user.elo_peak !== highestElo) eloPeaksMigrated = true;
            user.elo_peak = highestElo;
          }
          for (const t of db.tournaments) {
            if (t.last_reset_week === undefined) {
              t.last_reset_week = t.status === 'qualifying' ? Math.max(1, t.current_week || 1) : 0;
            }
          }
          for (const e of db.tournamentEntries) {
            if (e.draws === undefined) e.draws = 0;
            if (e.tier === 'Challenger') e.rank_stars = 0;
          }
          let groupLifecycleMigrated = false;
          if (db.groupKnockoutLifecycleVersion !== 1) {
            db.groupKnockoutLifecycleVersion = 1;
            groupLifecycleMigrated = true;
          }
          // Ensure demo accounts p3/p4 are registered in t1Id if t1Id exists so demo testing works seamlessly
          const t1 = db.tournaments.find((t) => t.id === '11111111-2222-4333-8444-555555555501');
          if (t1 && t1.status === 'qualifying') {
            for (const uid of [
              '00000000-0000-4000-8000-000000000004',
              '00000000-0000-4000-8000-000000000005',
            ]) {
              const usr = db.users.find((u) => u.id === uid);
              if (
                usr &&
                !db.tournamentEntries.some(
                  (en) => en.tournament_id === t1.id && en.player_id === usr.id
                )
              ) {
                db.tournamentEntries.push({
                  tournament_id: t1.id,
                  player_id: usr.id,
                  bot_version: usr.active_bot_version || 1,
                  matches_played: 0,
                  wins: 0,
                  draws: 0,
                  losses: 0,
                  points: 0,
                  tournament_elo: usr.elo,
                  tier: 'Bronze',
                  rank_stars: 0,
                  season_points: 0,
                  registered_at: new Date().toISOString(),
                });
              }
            }
          }
          if (eloPeaksMigrated || groupLifecycleMigrated) saveDb();
          return;
        }
      }
    } catch {
      // Recreate on corrupt JSON
    }
    db = await createSeedDatabase();
    db.groupKnockoutLifecycleVersion = 1;
    for (const user of db.users) {
      if (options.testAdminEmails?.includes(user.email)) user.is_admin = true;
    }
    saveDb();
  }

  await initDb();

  // ── Live Sockets & Queues ────────────────────────────────────
  interface AuthedSocket extends WebSocket {
    authenticated?: boolean;
    userId?: string;
    queueMode?: 'human' | 'bot' | 'tournament' | null;
    tournamentId?: string | null;
    searchStartedAt?: number;
  }

  const liveSockets = new Map<string, AuthedSocket>();
  const humanQueue = new Set<string>();
  const botQueue = new Set<string>();
  const tournamentQueue = new Map<string, Set<string>>();
  const sparringSessions = new Map<string, SparringSession>();

  const sendWs = (ws: WebSocket | undefined, type: string, data: Record<string, unknown> = {}) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...data }));
    }
  };

  function clearUserQueues(userId: string) {
    humanQueue.delete(userId);
    botQueue.delete(userId);
    for (const set of tournamentQueue.values()) {
      set.delete(userId);
    }
  }

  function clearTournamentWaiters(tournamentId: string) {
    const q = tournamentQueue.get(tournamentId);
    if (q) q.clear();
  }

  function abandonActiveTournamentMatches(tournamentId: string, reasonMessage: string) {
    for (const m of db.matches) {
      if (m.tournament_id === tournamentId && m.status === 'active') {
        m.status = 'abandoned';
        m.completed_at = new Date().toISOString();
        sparringSessions.delete(m.id);
        sendWs(liveSockets.get(m.player1_id), 'match-aborted', {
          matchId: m.id,
          message: reasonMessage,
        });
        sendWs(liveSockets.get(m.player2_id), 'match-aborted', {
          matchId: m.id,
          message: reasonMessage,
        });
      }
    }
  }

  function initializeStageBEntries(tournamentId: string) {
    for (const entry of db.tournamentEntries.filter((e) => e.tournament_id === tournamentId)) {
      const u = db.users.find((usr) => usr.id === entry.player_id);
      const startElo = u?.elo ?? entry.tournament_elo ?? 1200;
      entry.tournament_elo = startElo;
      entry.tier = rankTier(startElo) as RankTier;
      entry.rank_stars = 0;
      entry.season_points = 0;
      entry.matches_played = 0;
      entry.wins = 0;
      entry.draws = 0;
      entry.losses = 0;
      entry.points = 0;
    }
  }

  function applySprintResetsToEntries(tournament: TournamentRecord, targetWeek: number) {
    const startResetWeek = Math.max(1, tournament.last_reset_week || tournament.current_week || 1);
    const steps = Math.max(0, targetWeek - startResetWeek);
    if (steps <= 0) return;
    for (const entry of db.tournamentEntries.filter((e) => e.tournament_id === tournament.id)) {
      let tier: RankTier = entry.tier;
      let stars = entry.rank_stars;
      let seasonPoints = entry.season_points;
      for (let s = 0; s < steps; s++) {
        const res = applySprintRankReset(tier, stars, seasonPoints);
        tier = res.tier as RankTier;
        stars = res.stars;
        seasonPoints = res.seasonPoints;
      }
      entry.tier = tier;
      entry.rank_stars = stars;
      entry.season_points = seasonPoints;
    }
    tournament.last_reset_week = targetWeek;
  }

  function updateTournamentLifecycle() {
    const now = Date.now();
    let dirty = false;
    for (const t of db.tournaments) {
      if (t.format === 'group_knockout') {
        for (const fixture of db.tournamentFixtures) {
          if (fixture.tournament_id !== t.id || fixture.status !== 'active') continue;
          const linkedMatch = db.matches.find((match) => match.id === fixture.match_id);
          if (!linkedMatch || linkedMatch.status === 'abandoned') {
            fixture.status = 'pending';
            fixture.match_id = null;
            fixture.player1_ready_at = null;
            fixture.player2_ready_at = null;
            dirty = true;
          }
        }
        const opensAt = new Date(t.registration_opens_at || t.created_at).getTime();
        const closesAt = new Date(t.registration_closes_at).getTime();
        const entryCount = db.tournamentEntries.filter((entry) => entry.tournament_id === t.id).length;
        if (t.status === 'scheduled' && now >= opensAt) {
          t.status = 'registration';
          dirty = true;
        }
        if (t.status === 'registration' && now >= closesAt) {
          t.status = 'grouping';
          dirty = true;
        }
        continue;
      }
      const endMs = new Date(t.ends_at).getTime();
      const regCloseMs = new Date(t.registration_closes_at).getTime();
      const entryCount = db.tournamentEntries.filter(
        (e) => e.tournament_id === t.id && !db.users.find((u) => u.id === e.player_id)?.is_system_bot
      ).length;

      if (t.status !== 'completed' && now >= endMs) {
        t.status = 'completed';
        clearTournamentWaiters(t.id);
        abandonActiveTournamentMatches(
          t.id,
          'Giải đấu đã khép lại trước khi ván đấu hoàn tất; trận được hủy không tính kết quả.'
        );
        dirty = true;
      } else if (t.status === 'registration' && (now >= regCloseMs || entryCount >= t.max_teams)) {
        t.status = 'qualifying';
        t.current_week = 1;
        t.last_reset_week = 1;
        t.week_started_at = new Date(now).toISOString();
        t.rules_json = weeklyRules(1, t.rules_schedule);
        initializeStageBEntries(t.id);
        clearTournamentWaiters(t.id);
        abandonActiveTournamentMatches(
          t.id,
          'Vòng Chạy Đà đã kết thúc để chuyển sang Thực chiến Sprint 1; ván đấu luyện tập đã được đóng.'
        );
        dirty = true;
      } else if (t.status === 'qualifying' && t.week_started_at) {
        const startMs = new Date(t.week_started_at).getTime();
        const computedWeek = Math.max(1, Math.floor((now - startMs) / WEEK_MS) + 1);
        if (computedWeek > t.current_week) {
          applySprintResetsToEntries(t, computedWeek);
          t.current_week = computedWeek;
          t.rules_json = weeklyRules(computedWeek, t.rules_schedule);
          clearTournamentWaiters(t.id);
          abandonActiveTournamentMatches(
            t.id,
            `Giải đấu đã bước sang Sprint ${computedWeek} và xét lại hạng (×2/3); ván đấu thuộc Sprint cũ bị hủy.`
          );
          dirty = true;
        }
      }
    }
    if (dirty) saveDb();
  }

  function tournamentGroupStandings(tournamentId: string) {
    const entries = db.tournamentEntries
      .filter((entry) => entry.tournament_id === tournamentId && entry.group_number)
      .map(({ bot_code_snapshot, bot_sha256_snapshot, ...entry }) => ({
        ...entry,
        display_name: db.users.find((user) => user.id === entry.player_id)?.display_name || 'Đấu thủ',
        avatar_id: db.users.find((user) => user.id === entry.player_id)?.avatar_id || 'pumpkin',
        avatar_url: db.users.find((user) => user.id === entry.player_id)?.avatar_url || null,
      }));
    return calculateGroupStandings(
      entries,
      db.tournamentFixtures.filter((fixture) =>
        fixture.tournament_id === tournamentId && fixture.phase === 'group'
      )
    );
  }

  function createTournamentFixture(
    tournamentId: string,
    fixture: Omit<TournamentFixtureRecord, 'id' | 'tournament_id' | 'winner_id' | 'move_count' | 'player1_ready_at' | 'player2_ready_at' | 'match_id'>
  ) {
    return {
      ...fixture,
      id: randomUUID(),
      tournament_id: tournamentId,
      winner_id: null,
      move_count: null,
      player1_ready_at: null,
      player2_ready_at: null,
      match_id: null,
    } satisfies TournamentFixtureRecord;
  }

  function advanceGroupKnockoutTournament(tournament: TournamentRecord) {
    const fixtures = db.tournamentFixtures.filter((fixture) => fixture.tournament_id === tournament.id);
    if (tournament.status === 'group_running') {
      const groupFixtures = fixtures.filter((fixture) => fixture.phase === 'group');
      if (!groupFixtures.length || groupFixtures.some((fixture) => fixture.status !== 'completed')) return;
      tournament.status = 'group_complete';
      return;
    }
    if (tournament.status !== 'knockout') return;
    const knockoutFixtures = fixtures.filter((fixture) => fixture.phase === 'knockout');
    const roundNumber = Math.max(...knockoutFixtures.map((fixture) => fixture.round_number));
    const currentRound = knockoutFixtures.filter((fixture) => fixture.round_number === roundNumber);
    if (!currentRound.length || currentRound.some((fixture) => fixture.status !== 'completed' || !fixture.winner_id)) return;
    const winners = currentRound
      .sort((first, second) => first.match_number - second.match_number)
      .map((fixture) => fixture.winner_id as string);
    if (winners.length === 1) {
      tournament.status = 'completed';
      return;
    }
    const nextRound = createNextKnockoutRound(winners, roundNumber + 1);
    db.tournamentFixtures.push(
      ...nextRound.map((fixture) => createTournamentFixture(tournament.id, {
        ...newKnockoutSeries(fixture.player1Id, fixture.player2Id),
        phase: 'knockout',
        group_number: null,
        round_number: fixture.roundNumber,
        match_number: fixture.matchNumber,
        leg: 1,
        player1_id: fixture.player1Id,
        player2_id: fixture.player2Id,
        status: 'pending',
      }))
    );
  }

  function completeTournamentFixture(match: MatchRecord, winnerId: string | null, moveCount: number) {
    if (!match.tournament_fixture_id || !match.tournament_id) return;
    const fixture = db.tournamentFixtures.find((item) =>
      item.id === match.tournament_fixture_id && item.tournament_id === match.tournament_id
    );
    const tournament = db.tournaments.find((item) => item.id === match.tournament_id);
    if (!fixture || !tournament) return;
    if (fixture.status !== 'active' || fixture.match_id !== match.id) return;
    fixture.move_count = moveCount;
    if (fixture.phase === 'knockout' && fixture.series_best_of === 3) {
      const seriesResult = recordKnockoutGame(fixture, match, winnerId, moveCount);
      Object.assign(fixture, seriesResult);
      fixture.leg = (fixture.games_played || 0) + 1;
      if (seriesResult.status !== 'completed') fixture.match_id = null;
      advanceGroupKnockoutTournament(tournament);
      return;
    }
    if (fixture.phase === 'knockout' && !winnerId) {
      fixture.leg += 1;
      fixture.status = 'pending';
      fixture.player1_ready_at = null;
      fixture.player2_ready_at = null;
      fixture.match_id = null;
      return;
    }
    fixture.winner_id = winnerId;
    fixture.status = 'completed';
    advanceGroupKnockoutTournament(tournament);
  }

  function isCurrentGroupKnockoutFixture(
    match: MatchRecord,
    tournament: TournamentRecord | undefined,
    fixture: TournamentFixtureRecord | undefined
  ) {
    const expectedStatus = match.tournament_phase === 'group'
      ? 'group_running'
      : match.tournament_phase === 'knockout'
      ? 'knockout'
      : null;
    return Boolean(
      expectedStatus &&
      tournament?.format === 'group_knockout' &&
      tournament.status === expectedStatus &&
      tournament.tournament_starts_at !== undefined &&
      new Date(tournament.tournament_starts_at).getTime() <= Date.now() &&
      fixture?.tournament_id === tournament.id &&
      fixture.phase === match.tournament_phase &&
      fixture.status === 'active' &&
      fixture.match_id === match.id &&
      [fixture.player1_id, fixture.player2_id].includes(match.player1_id) &&
      [fixture.player1_id, fixture.player2_id].includes(match.player2_id)
    );
  }

  function getPendingTournamentFixture(tournament: TournamentRecord, playerId: string) {
    if (tournament.execution_mode === 'server' && ['group_running', 'knockout'].includes(tournament.status)) return null;
    if (
      tournament.format !== 'group_knockout' ||
      !['group_running', 'knockout'].includes(tournament.status) ||
      (tournament.status === 'knockout' && tournament.tournament_starts_at &&
        new Date(tournament.tournament_starts_at).getTime() > Date.now())
    ) return null;

    const entry = db.tournamentEntries.find((item) =>
      item.tournament_id === tournament.id && item.player_id === playerId
    );
    if (!entry) return null;
    const fixtures = db.tournamentFixtures.filter((fixture) =>
      fixture.tournament_id === tournament.id &&
      fixture.phase === (tournament.status === 'group_running' ? 'group' : 'knockout') &&
      (fixture.phase !== 'group' || fixture.group_number === entry.group_number) &&
      (fixture.player1_id === playerId || fixture.player2_id === playerId)
    );
    if (!fixtures.length) return null;
    let recoveredAbandonedFixture = false;
    for (const fixture of fixtures) {
      if (fixture.status !== 'active') continue;
      const linkedMatch = db.matches.find((match) => match.id === fixture.match_id);
      if (!linkedMatch || linkedMatch.status === 'abandoned') {
        fixture.status = 'pending';
        fixture.match_id = null;
        fixture.player1_ready_at = null;
        fixture.player2_ready_at = null;
        recoveredAbandonedFixture = true;
      }
    }
    if (recoveredAbandonedFixture) saveDb();
    if (db.matches.some((match) =>
      match.tournament_id === tournament.id &&
      match.status === 'active' &&
      (match.player1_id === playerId || match.player2_id === playerId)
    )) return null;
    const round = Math.min(...fixtures
      .filter((fixture) => fixture.status !== 'completed')
      .map((fixture) => fixture.round_number));
    if (!Number.isFinite(round)) return null;
    const currentRound = fixtures.filter((fixture) =>
      fixture.round_number === round && fixture.status !== 'completed'
    );
    if (currentRound.some((fixture) => fixture.status === 'active')) return null;
    return currentRound.find((fixture) => fixture.status === 'pending') || null;
  }

  function applyTournamentScoreForMatch(match: MatchRecord, score1: number) {
    const updates = new Map<
      string,
      { tier: RankTier; stars: number; seasonPoints: number; phase: 'practice' | 'ranked' | 'group' | 'knockout' | null }
    >();
    if (!match.tournament_id || match.is_sparring) return updates;

    const e1 = db.tournamentEntries.find(
      (e) => e.tournament_id === match.tournament_id && e.player_id === match.player1_id
    );
    const e2 = db.tournamentEntries.find(
      (e) => e.tournament_id === match.tournament_id && e.player_id === match.player2_id
    );

    for (const [entry, sc] of [
      [e1, score1],
      [e2, 1 - score1],
    ] as const) {
      if (!entry) continue;
      entry.matches_played += 1;
      if (sc === 1) entry.wins += 1;
      else if (sc === 0.5) entry.draws = (entry.draws || 0) + 1;
      else entry.losses += 1;

      if (match.tournament_phase === 'ranked') {
        const prog = applyTournamentResult(entry.tier, entry.rank_stars, entry.season_points, sc);
        entry.tier = prog.tier as RankTier;
        entry.rank_stars = prog.stars;
        entry.season_points = prog.seasonPoints;
        entry.points = entry.wins;
      } else if (['group', 'knockout'].includes(match.tournament_phase || '')) {
        const tournament = db.tournaments.find((item) => item.id === match.tournament_id);
        if (tournament?.format === 'group_knockout') {
          entry.points = entry.wins * 3 + entry.draws;
        }
      }
      updates.set(entry.player_id, {
        tier: entry.tier,
        stars: entry.rank_stars,
        seasonPoints: entry.season_points,
        phase: match.tournament_phase,
      });
    }
    return updates;
  }

  function adjudicateMatchForfeit(
    matchId: string,
    offenderId: string,
    reasonCode: string,
    winnerMessage: string,
    loserMessage: string
  ) {
    const match = db.matches.find((m) => m.id === matchId && m.status === 'active');
    if (!match || (match.player1_id !== offenderId && match.player2_id !== offenderId)) {
      return null;
    }

    const u1 = db.users.find((u) => u.id === match.player1_id);
    const u2 = db.users.find((u) => u.id === match.player2_id);
    if (!u1 || !u2) return null;

    const winnerId = offenderId === match.player1_id ? match.player2_id : match.player1_id;
    const score1 = winnerId === match.player1_id ? 1 : 0;
    const eloUpdated =
      match.match_type === 'bot' &&
      match.tournament_phase !== 'practice' &&
      !match.is_sparring;

    const p1Before = u1.elo;
    const p2Before = u2.elo;
    const p1After = eloUpdated ? calculateElo(p1Before, p2Before, score1) : p1Before;
    const p2After = eloUpdated ? calculateElo(p2Before, p1Before, 1 - score1) : p2Before;

    if (eloUpdated) {
      u1.elo = p1After;
      u2.elo = p2After;
      recordEloPeak(u1, p1After);
      recordEloPeak(u2, p2After);
    }

    const tournamentUpdates = applyTournamentScoreForMatch(match, score1);

    match.status = 'completed';
    match.winner_id = winnerId;
    match.final_step_count = match.consensus_state?.currentStep || 0;
    completeTournamentFixture(match, winnerId, match.final_step_count);
    match.disconnected_player_id = null;
    match.disconnected_at = null;
    match.completed_at = new Date().toISOString();

    if (!db.matchResults.some((r) => r.match_id === match.id)) {
      db.matchResults.push({
        match_id: match.id,
        player1_elo_before: p1Before,
        player2_elo_before: p2Before,
        player1_elo_after: p1After,
        player2_elo_after: p2After,
        result_player1: score1,
        created_at: match.completed_at,
      });
    }

    const spar = sparringSessions.get(match.id);
    if (spar) {
      spar.destroyed = true;
      sparringSessions.delete(match.id);
    }
    saveDb();

    const winnerPlayer: 1 | 2 = winnerId === match.player1_id ? 1 : 2;
    const offenderPlayer: 1 | 2 = offenderId === match.player1_id ? 1 : 2;

    for (const pid of [match.player1_id, match.player2_id]) {
      const isP1 = pid === match.player1_id;
      const isWinner = pid === winnerId;
      sendWs(liveSockets.get(pid), 'match-forfeited', {
        matchId: match.id,
        winnerId,
        winnerPlayer,
        offenderId,
        offenderPlayer,
        reason: reasonCode,
        message: isWinner ? winnerMessage : loserMessage,
        eloUpdated,
        eloBefore: isP1 ? p1Before : p2Before,
        eloAfter: isP1 ? p1After : p2After,
        tournamentUpdate: tournamentUpdates.get(pid) || null,
      });
    }

    return {
      matchId: match.id,
      winnerId,
      winnerPlayer,
      offenderId,
      offenderPlayer,
      reason: reasonCode,
      eloUpdated,
      p1Before,
      p1After,
      p2Before,
      p2After,
      tournamentUpdates,
    };
  }

  function processDisconnectedMatches() {
    const now = Date.now();
    for (const match of db.matches) {
      if (
        match.status !== 'active' ||
        !match.disconnected_player_id ||
        !match.disconnected_at ||
        match.is_sparring
      ) {
        continue;
      }
      const discMs = new Date(match.disconnected_at).getTime();
      if (now - discMs < disconnectForfeitMs) continue;

      const p1Online = liveSockets.get(match.player1_id)?.readyState === WebSocket.OPEN;
      const p2Online = liveSockets.get(match.player2_id)?.readyState === WebSocket.OPEN;
      if (!p1Online && !p2Online) {
        match.status = 'abandoned';
        match.completed_at = new Date().toISOString();
        match.disconnected_player_id = null;
        match.disconnected_at = null;
        saveDb();
        continue;
      }

      if (liveSockets.get(match.disconnected_player_id)?.readyState === WebSocket.OPEN) {
        match.disconnected_player_id = null;
        match.disconnected_at = null;
        saveDb();
        continue;
      }

      adjudicateMatchForfeit(
        match.id,
        match.disconnected_player_id,
        'disconnect-timeout',
        'Đối thủ đã mất kết nối hoặc thoát trận — Bạn được xử thắng kỹ thuật ngay lập tức!',
        'Bạn đã ngắt kết nối quá thời gian quy định nên bị xử thua kỹ thuật.'
      );
    }
  }

  function getAuthUser(req: Request): UserRecord {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      throw Object.assign(new Error('Vui lòng đăng nhập để thực hiện thao tác này.'), { status: 401 });
    }
    const payload = verifyToken(header.slice(7));
    const user = db.users.find((u) => u.id === payload.sub);
    if (!user) throw Object.assign(new Error('Không tìm thấy tài khoản.'), { status: 401 });
    return user;
  }

  function getOptionalAuthUser(req: Request): UserRecord | null {
    try {
      return getAuthUser(req);
    } catch {
      return null;
    }
  }

  function getActiveUserBot(userId: string): { version: number; code: string } | null {
    const usr = db.users.find((u) => u.id === userId);
    if (!usr || !usr.active_bot_version) return null;
    const rec = db.botVersions.find(
      (b) => b.user_id === userId && b.version === usr.active_bot_version
    );
    if (!rec || !rec.code.trim()) return null;
    return { version: rec.version, code: rec.code };
  }

  function computeChallengerStandings(tournamentId: string) {
    return db.tournamentEntries
      .filter((e) => e.tournament_id === tournamentId && e.tier === 'Challenger')
      .map((e) => {
        const u = db.users.find((usr) => usr.id === e.player_id);
        return {
          player_id: e.player_id,
          display_name: u?.display_name || 'Kỳ thủ',
          tier: e.tier,
          rank_stars: 0,
          season_points: e.season_points,
          matches_played: e.matches_played,
          wins: e.wins,
          draws: e.draws || 0,
          losses: e.losses,
          elo: u?.elo ?? e.tournament_elo,
          registered_at: e.registered_at,
        };
      })
      .sort(
        (a, b) =>
          b.season_points - a.season_points ||
          b.elo - a.elo ||
          b.wins - a.wins ||
          a.registered_at.localeCompare(b.registered_at)
      );
  }

  // ── Express HTTP App ──────────────────────────────────────────
  const app = express();
  const httpServer = http.createServer(app);

  app.use(express.json({ limit: '8mb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, mode: 'local-embedded', timestamp: new Date().toISOString() });
  });

  app.post('/api/auth/register', async (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const displayName = String(req.body?.displayName || '').trim().slice(0, 40);
      if (!email.includes('@')) {
        res.status(400).json({ error: 'Địa chỉ email không hợp lệ.' });
        return;
      }
      if (password.length < 10) {
        res.status(400).json({ error: 'Mật khẩu phải có ít nhất 10 ký tự.' });
        return;
      }
      if (!displayName) {
        res.status(400).json({ error: 'Vui lòng nhập tên hiển thị.' });
        return;
      }
      if (db.users.some((u) => u.email === email)) {
        res.status(409).json({ error: 'Email này đã được đăng ký.' });
        return;
      }
      const user: UserRecord = {
        id: randomUUID(),
        email,
        password_hash: await hashPassword(password),
        display_name: displayName,
        avatar_id: 'pumpkin',
        elo: 1200,
        is_admin: false,
        active_bot_version: 0,
        elo_peak: 1200,
        created_at: new Date().toISOString(),
      };
      db.users.push(user);
      saveDb();
      res.status(201).json({ token: createToken(user), user: publicUser(user) });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || 'Lỗi đăng ký tài khoản.' });
    }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const user = db.users.find((u) => u.email === email && !u.is_system_bot);
      if (!user || !(await verifyPassword(password, user.password_hash))) {
        res.status(401).json({ error: 'Email hoặc mật khẩu không chính xác.' });
        return;
      }
      res.json({ token: createToken(user), user: publicUser(user) });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message || 'Lỗi đăng nhập.' });
    }
  });

  app.get('/api/me', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      res.json({ user: publicUser(user) });
    } catch (err: any) {
      res.status(err.status || 401).json({ error: err.message });
    }
  });

  app.patch('/api/me', async (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const displayName =
        req.body?.displayName === undefined ? null : String(req.body.displayName).trim().slice(0, 40);
      const avatarId = req.body?.avatarId === undefined ? null : String(req.body.avatarId);
      const currentPassword = String(req.body?.currentPassword || '');
      const newPassword = String(req.body?.newPassword || '');
      const confirmNewPassword = String(req.body?.confirmNewPassword || '');

      if (displayName !== null && !displayName) {
        res.status(400).json({ error: 'Tên hiển thị không được để trống.' });
        return;
      }
      const avatarDataUrl =
        req.body?.avatarDataUrl === undefined ? undefined : req.body.avatarDataUrl;
      const profileBackgroundId =
        req.body?.profileBackgroundId === undefined ? undefined : req.body.profileBackgroundId;
      if (
        avatarDataUrl !== undefined &&
        avatarDataUrl !== null &&
        !isAllowedAvatarDataUrl(avatarDataUrl)
      ) {
        res.status(400).json({ error: 'Ảnh đại diện cần là PNG, JPEG hoặc WebP và tối đa 5 MB.' });
        return;
      }
      if (
        profileBackgroundId !== undefined &&
        !PROFILE_BACKGROUND_IDS.includes(profileBackgroundId)
      ) {
        res.status(400).json({ error: 'Ảnh nền hồ sơ không hợp lệ.' });
        return;
      }
      const profileBackgroundDataUrl =
        req.body?.profileBackgroundDataUrl === undefined
          ? undefined
          : req.body.profileBackgroundDataUrl;
      if (
        profileBackgroundDataUrl !== undefined &&
        profileBackgroundDataUrl !== null &&
        !isAllowedAvatarDataUrl(profileBackgroundDataUrl)
      ) {
        res.status(400).json({ error: 'Ảnh nền cần là PNG, JPEG hoặc WebP và tối đa 5 MB.' });
        return;
      }
      if (
        avatarId !== null &&
        !PLAYER_AVATAR_IDS.includes(avatarId as (typeof PLAYER_AVATAR_IDS)[number])
      ) {
        res.status(400).json({ error: 'Diện mạo kỳ thủ không hợp lệ.' });
        return;
      }
      if (newPassword && newPassword.length < 10) {
        res.status(400).json({ error: 'Mật khẩu mới cần ít nhất 10 ký tự.' });
        return;
      }
      if (newPassword && newPassword !== confirmNewPassword) {
        res.status(400).json({ error: 'Mật khẩu mới nhập lại không khớp.' });
        return;
      }
      if (Boolean(currentPassword) !== Boolean(newPassword)) {
        res.status(400).json({ error: 'Cần nhập cả mật khẩu hiện tại và mật khẩu mới.' });
        return;
      }
      if (
        displayName === null &&
        avatarId === null &&
        avatarDataUrl === undefined &&
        profileBackgroundId === undefined &&
        profileBackgroundDataUrl === undefined &&
        !newPassword
      ) {
        res.status(400).json({ error: 'Hãy chọn nội dung cần cập nhật.' });
        return;
      }
      if (newPassword && !(await verifyPassword(currentPassword, user.password_hash))) {
        res.status(400).json({ error: 'Mật khẩu hiện tại không chính xác.' });
        return;
      }
      if (displayName !== null) user.display_name = displayName;
      if (avatarId !== null) {
        user.avatar_id = avatarId;
        user.avatar_url = undefined;
      } else if (avatarDataUrl !== undefined) {
        user.avatar_url = avatarDataUrl || undefined;
      }
      if (profileBackgroundDataUrl !== undefined) {
        user.profile_background_url = profileBackgroundDataUrl || undefined;
      }
      if (profileBackgroundId !== undefined) {
        user.profile_background_id = profileBackgroundId;
        user.profile_background_url = undefined;
      }
      if (newPassword) user.password_hash = await hashPassword(newPassword);
      saveDb();
      res.json({ user: publicUser(user) });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/bots/me', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const bot = db.botVersions.find((b) => b.user_id === user.id && b.version === user.active_bot_version);
      const tournamentIds = db.tournamentEntries
        .filter((e) => e.player_id === user.id)
        .map((e) => e.tournament_id);
      res.json({
        bot: bot
          ? {
              version: bot.version,
              code: bot.code,
              sha256: bot.code_sha256,
              createdAt: bot.created_at,
              tournamentIds,
            }
          : { version: 0, code: '', sha256: '', tournamentIds },
      });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/bots/me', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const code = String(req.body?.code || '');
      if (!code.trim() || code.length > 120000) {
        res.status(400).json({ error: 'Mã Python phải có từ 1 đến 120000 ký tự.' });
        return;
      }
      if (!/^\s*def\s+(get_next_move|getNextMove)\s*\(/m.test(code)) {
        res.status(400).json({ error: 'Bot cần định nghĩa hàm get_next_move(my_player_id, game_state).' });
        return;
      }
      const version = (user.active_bot_version || 0) + 1;
      const sha256 = createHash('sha256').update(code).digest('hex');
      db.botVersions = db.botVersions.filter((b) => b.user_id !== user.id);
      db.botVersions.push({
        user_id: user.id,
        version,
        code,
        code_sha256: sha256,
        created_at: new Date().toISOString(),
      });
      user.active_bot_version = version;
      for (const entry of db.tournamentEntries.filter((e) => e.player_id === user.id)) {
        const t = db.tournaments.find((tour) => tour.id === entry.tournament_id);
        if (t && ['registration', 'qualifying'].includes(t.status)) {
          entry.bot_version = version;
        }
      }
      const sock = liveSockets.get(user.id);
      if (sock?.queueMode === 'tournament') {
        clearUserQueues(user.id);
        sock.queueMode = null;
        sendWs(sock, 'search-cancelled', {
          message: 'Bot đã cập nhật. Hãy bấm Tìm trận lại để xuất chiến phiên bản mới.',
        });
      }
      saveDb();
      res.status(201).json({ version, sha256 });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/leaderboard', (_req: Request, res: Response) => {
    const players = [...db.users]
      .sort((a, b) => b.elo - a.elo || a.created_at.localeCompare(b.created_at))
      .slice(0, 100)
      .map((u) => ({
        id: u.id,
        displayName: u.display_name,
        elo: u.elo,
        avatarId: u.avatar_id || 'pumpkin',
        avatarUrl: u.avatar_url || null,
        isSystemBot: Boolean(u.is_system_bot),
      }));
    res.json({ players });
  });

  app.get('/api/matches', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const matches = db.matches
        .filter((m) => m.player1_id === user.id || m.player2_id === user.id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 50)
        .map((m) => {
          const u1 = db.users.find((u) => u.id === m.player1_id);
          const u2 = db.users.find((u) => u.id === m.player2_id);
          const mr = db.matchResults.find((r) => r.match_id === m.id);
          return {
            id: m.id,
            seed: m.seed,
            status: m.status,
            match_type: m.match_type,
            tournament_phase: m.tournament_phase,
            is_sparring: Boolean(m.is_sparring),
            elo_updated: Boolean(
              mr &&
                m.match_type === 'bot' &&
                m.tournament_phase !== 'practice' &&
                !m.is_sparring
            ),
            winner_id: m.winner_id,
            final_state_hash: m.final_state_hash,
            replay_sha256: m.replay_sha256,
            created_at: m.created_at,
            completed_at: m.completed_at,
            replay_available: Boolean(m.replay_json),
            player1: u1?.display_name || 'Player 1',
            player2: u2?.display_name || 'Player 2',
            player1_id: m.player1_id,
            player2_id: m.player2_id,
            elo_delta:
              mr &&
              m.match_type === 'bot' &&
              m.tournament_phase !== 'practice' &&
              !m.is_sparring
                ? m.player1_id === user.id
                  ? mr.player1_elo_after - mr.player1_elo_before
                  : mr.player2_elo_after - mr.player2_elo_before
                : null,
            elo_before:
              mr &&
              m.match_type === 'bot' &&
              m.tournament_phase !== 'practice' &&
              !m.is_sparring
                ? m.player1_id === user.id
                  ? mr.player1_elo_before
                  : mr.player2_elo_before
                : null,
            elo_after:
              mr &&
              m.match_type === 'bot' &&
              m.tournament_phase !== 'practice' &&
              !m.is_sparring
                ? m.player1_id === user.id
                  ? mr.player1_elo_after
                  : mr.player2_elo_after
                : null,
          };
        });
      res.json({ matches });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/matches/:id/replay', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const match = db.matches.find((m) => m.id === req.params.id && m.status === 'completed');
      if (!match || (match.player1_id !== user.id && match.player2_id !== user.id)) {
        res.status(404).json({ error: 'Không tìm thấy dữ liệu replay của trận đấu này.' });
        return;
      }
      if (!match.replay_json) {
        res.status(404).json({
          error: 'Trận đấu này kết thúc bằng xử thắng kỹ thuật nên không có bản ghi nước đi đầy đủ.',
          code: 'REPLAY_UNAVAILABLE',
        });
        return;
      }
      res.json({ replay: match.replay_json });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/tournaments', (_req: Request, res: Response) => {
    updateTournamentLifecycle();
    const list = db.tournaments
      .filter((tournament) => tournament.format === 'group_knockout' && tournament.status !== 'cancelled')
      .slice()
      .sort((a, b) => {
        const order = (s: string) =>
          ['scheduled', 'registration', 'grouping', 'group_stage', 'group_running', 'group_complete', 'knockout', 'qualifying'].indexOf(s) === -1
            ? 6
            : ['scheduled', 'registration', 'grouping', 'group_stage', 'group_running', 'group_complete', 'knockout', 'qualifying'].indexOf(s);
        return order(a.status) - order(b.status) || b.created_at.localeCompare(a.created_at);
      })
      .map((t) => ({
        ...t,
        participant_count: db.tournamentEntries.filter((e) => e.tournament_id === t.id).length,
      }));
    res.json({ tournaments: list });
  });

  app.get('/api/tournaments/:id', (req: Request, res: Response) => {
    updateTournamentLifecycle();
    const t = db.tournaments.find((tour) => tour.id === req.params.id);
    if (!t) {
      res.status(404).json({ error: 'Không tìm thấy giải đấu.' });
      return;
    }
    const authUser = getOptionalAuthUser(req);
    const entries = db.tournamentEntries.filter((e) => e.tournament_id === t.id);
    const ownEntry = authUser ? entries.find((e) => e.player_id === authUser.id) || null : null;

    const myMatches = authUser
      ? db.matches
          .filter(
            (m) =>
              m.tournament_id === t.id &&
              (authUser.is_admin ||
                m.player1_id === authUser.id ||
                m.player2_id === authUser.id)
          )
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((m) => {
            const u1 = db.users.find((u) => u.id === m.player1_id);
            const u2 = db.users.find((u) => u.id === m.player2_id);
            const fixture = db.tournamentFixtures.find(
              (item) => item.id === m.tournament_fixture_id
            );
            return {
              id: m.id,
              match_id: m.id,
              status: m.status,
              tournament_phase: m.tournament_phase,
              phase: fixture?.phase || m.tournament_phase,
              group_number: fixture?.group_number ?? null,
              round_number: fixture?.round_number ?? null,
              leg: fixture?.leg ?? null,
              player1_id: m.player1_id,
              player2_id: m.player2_id,
              is_sparring: Boolean(m.is_sparring),
              winner_id: m.winner_id,
              winner: m.winner_id
                ? db.users.find((u) => u.id === m.winner_id)?.display_name || null
                : null,
              move_count: m.final_step_count ?? null,
              created_at: m.created_at,
              completed_at: m.completed_at,
              replay_available: Boolean(m.replay_json),
              player1: u1?.display_name || 'Player 1',
              player2: u2?.display_name || 'Player 2',
            };
          })
      : [];

    const challengerStandings = computeChallengerStandings(t.id);
    let privateChallengerRank: number | null = null;
    if (ownEntry && ownEntry.tier === 'Challenger') {
      const idx = challengerStandings.findIndex((row) => row.player_id === ownEntry.player_id);
      privateChallengerRank = idx >= 0 ? idx + 1 : challengerStandings.length + 1;
    }

    const motivationBanner = buildTournamentMotivation(ownEntry, privateChallengerRank);
    const isCompleted = t.status === 'completed';
    const groupEntries = entries
      .filter((entry) => entry.group_number)
      .map(({ bot_code_snapshot, bot_sha256_snapshot, ...entry }) => ({
        ...entry,
        display_name: db.users.find((u) => u.id === entry.player_id)?.display_name || 'Đấu thủ',
        avatar_id: db.users.find((u) => u.id === entry.player_id)?.avatar_id || 'pumpkin',
        avatar_url: db.users.find((u) => u.id === entry.player_id)?.avatar_url || null,
      }));
    const groupFixtures = db.tournamentFixtures
      .filter((fixture) => fixture.tournament_id === t.id)
      .map((fixture) => ({
        ...fixture,
        player1: db.users.find((u) => u.id === fixture.player1_id)?.display_name || 'Đấu thủ',
        player2: db.users.find((u) => u.id === fixture.player2_id)?.display_name || 'Đấu thủ',
        winner: fixture.winner_id
          ? db.users.find((u) => u.id === fixture.winner_id)?.display_name || null
          : null,
      }));
    const groupStandings = t.format === 'group_knockout'
      ? tournamentGroupStandings(t.id)
      : [];

    res.json({
      tournament: t,
      participantCount: entries.length,
      ranks: tournamentRanks(),
      myEntry: ownEntry
        ? {
            ...ownEntry,
            elo: authUser?.elo ?? ownEntry.tournament_elo,
          }
        : null,
      motivationBanner,
      leaderboardHidden: !isCompleted,
      matches: myMatches,
      standings: isCompleted ? challengerStandings : [],
      finalStandings: isCompleted ? challengerStandings : null,
      groups: t.format === 'group_knockout'
        ? Array.from({ length: t.group_count || 0 }, (_, index) => ({
            group_number: index + 1,
            members: groupEntries.filter((entry) => entry.group_number === index + 1),
            standings: ['group_running', 'group_complete', 'knockout', 'completed'].includes(t.status)
              ? groupStandings.filter((entry) => entry.group_number === index + 1)
              : [],
          }))
        : [],
      fixtures: groupFixtures,
      groupStandingsPublished: ['group_running', 'group_complete', 'knockout', 'completed'].includes(t.status),
    });
  });

  app.post('/api/tournaments', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức (Admin) để tạo giải đấu.' });
        return;
      }
      const name = String(req.body?.name || '').trim().slice(0, 100);
      const description = String(req.body?.description || '').trim().slice(0, 2000);
      if (req.body?.registrationOpensAt === undefined && req.body?.tournamentStartsAt === undefined) {
        if (!name) {
          res.status(400).json({ error: 'Vui lòng nhập tên giải đấu.' });
          return;
        }
        const registrationClosesAt = new Date(req.body?.registrationClosesAt);
        const endsAt = new Date(req.body?.endsAt);
        const maxTeams = Math.min(256, Math.max(2, Number(req.body?.maxTeams) || 64));
        const sprintRules: string[] = Array.isArray(req.body?.sprintRules)
          ? req.body.sprintRules
          : DEFAULT_SPRINT_RULES;
        if (sprintRules.length !== 4 || sprintRules.some((rule) => !SPRINT_RULE_LAYOUTS[rule])) {
          res.status(400).json({ error: 'Hãy chọn luật hợp lệ cho đủ 4 Sprint.' });
          return;
        }
        if (Number.isNaN(registrationClosesAt.getTime()) || registrationClosesAt <= new Date()) {
          res.status(400).json({ error: 'Thời điểm đóng đăng ký phải nằm trong tương lai.' });
          return;
        }
        if (Number.isNaN(endsAt.getTime()) || endsAt <= registrationClosesAt) {
          res.status(400).json({ error: 'Thời điểm kết thúc giải phải sau thời điểm đóng đăng ký.' });
          return;
        }
        const legacyTournament: TournamentRecord = {
          id: randomUUID(),
          name,
          format: 'ranked_weekly',
          description,
          status: 'registration',
          registration_closes_at: registrationClosesAt.toISOString(),
          ends_at: endsAt.toISOString(),
          max_teams: maxTeams,
          current_week: 0,
          last_reset_week: 0,
          week_started_at: null,
          rules_json: {},
          rules_schedule: sprintRules,
          created_at: new Date().toISOString(),
        };
        db.tournaments.unshift(legacyTournament);
        saveDb();
        res.status(201).json({ tournament: legacyTournament });
        return;
      }
      const registrationOpensAt = new Date(req.body?.registrationOpensAt);
      const minElo = minimumTournamentElo(req.body?.minElo);
      const registrationClosesAt = new Date(req.body?.registrationClosesAt);
      const tournamentStartsAt = new Date(req.body?.tournamentStartsAt);

      if (!name) {
        res.status(400).json({ error: 'Vui lòng nhập tên giải đấu.' });
        return;
      }
      if (
        Number.isNaN(registrationOpensAt.getTime()) ||
        Number.isNaN(registrationClosesAt.getTime()) ||
        Number.isNaN(tournamentStartsAt.getTime()) ||
        registrationOpensAt.getTime() < Date.now() - 60000 ||
        registrationClosesAt <= registrationOpensAt ||
        tournamentStartsAt <= registrationClosesAt
      ) {
        res.status(400).json({
          error: 'Thời gian cần theo thứ tự: mở đăng ký (không ở quá khứ), đóng đăng ký, bắt đầu giải.',
        });
        return;
      }
      let rules;
      try {
        rules = buildTournamentRules(
          req.body?.blockedCells,
          req.body?.moveLimitRule,
          req.body?.capturedPieceValues
        );
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }

      const created: TournamentRecord = {
        id: randomUUID(),
        name,
        format: 'group_knockout',
        description,
        status: registrationOpensAt.getTime() > Date.now() ? 'scheduled' : 'registration',
        registration_opens_at: registrationOpensAt.toISOString(),
        registration_closes_at: registrationClosesAt.toISOString(),
        tournament_starts_at: tournamentStartsAt.toISOString(),
        ends_at: new Date(tournamentStartsAt.getTime() + 90 * 86400000).toISOString(),
        max_teams: 2147483647,
        min_elo: minElo,
        group_count: null,
        current_week: 0,
        last_reset_week: 0,
        week_started_at: null,
        rules_json: rules,
        rules_schedule: [],
        created_at: new Date().toISOString(),
      };
      db.tournaments.unshift(created);
      saveDb();
      res.status(201).json({ tournament: created });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/groups', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để chia bảng.' });
        return;
      }
      updateTournamentLifecycle();
      const tournament = db.tournaments.find((item) => item.id === req.params.id);
      if (!tournament || tournament.format !== 'group_knockout' ||
          !['registration', 'grouping'].includes(tournament.status)) {
        res.status(409).json({ error: 'Giải không ở trạng thái mở đăng ký hoặc chờ chia bảng.' });
        return;
      }
      const entries = db.tournamentEntries.filter((entry) => entry.tournament_id === tournament.id);
      let groups: Array<{ number: number; entrants: TournamentEntryRecord[] }>;
      try {
        groups = distributeTournamentGroups(entries, Number(req.body?.groupCount)) as Array<{
          number: number;
          entrants: TournamentEntryRecord[];
        }>;
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }
      for (const group of groups) {
        for (const entry of group.entrants) entry.group_number = group.number;
      }
      tournament.group_count = groups.length;
      db.tournamentFixtures.push(
        ...(createDoubleRoundRobinFixtures(groups) as Array<{
          phase: 'group';
          groupNumber: number;
          roundNumber: number;
          leg: number;
          player1Id: string;
          player2Id: string;
          status: 'pending';
        }>).map((fixture, fixtureIndex) =>
          createTournamentFixture(tournament.id, {
            phase: 'group',
            group_number: fixture.groupNumber,
            round_number: fixture.roundNumber,
            match_number: fixtureIndex + 1,
            leg: fixture.leg,
            player1_id: fixture.player1Id,
            player2_id: fixture.player2Id,
            status: 'pending',
          })
        )
      );
      tournament.status = 'group_stage';
      tournament.registration_closes_at = new Date().toISOString();
      saveDb();
      res.status(201).json({ tournament, groups });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/start-groups', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để khởi chạy vòng bảng.' });
        return;
      }
      const tournament = db.tournaments.find((item) => item.id === req.params.id);
      const fixtures = db.tournamentFixtures.filter((item) =>
        item.tournament_id === req.params.id && item.phase === 'group'
      );
      if (!tournament || tournament.format !== 'group_knockout' ||
          !(tournament.status === 'group_stage' ||
            (tournament.status === 'group_running' && tournament.execution_mode !== 'server')) ||
          !fixtures.length || fixtures.some(fixture => fixture.status !== 'pending')) {
        res.status(409).json({ error: 'Giải chưa được chia bảng hoặc vòng bảng đã khởi chạy.' });
        return;
      }
      const entries = db.tournamentEntries.filter(entry => entry.tournament_id === tournament.id);
      const bots = entries.map(entry => getActiveUserBot(entry.player_id));
      if (!entries.length || bots.some(bot => !bot?.code?.trim())) {
        res.status(409).json({ error: 'Mỗi đấu thủ phải lưu Bot Python trước khi khởi chạy vòng bảng.' });
        return;
      }
      entries.forEach((entry, index) => {
        entry.bot_code_snapshot = bots[index]!.code;
        entry.bot_sha256_snapshot = createHash('sha256').update(bots[index]!.code).digest('hex');
        entry.bot_version = bots[index]!.version;
      });
      tournament.execution_mode = 'server';
      tournament.status = 'group_running';
      tournament.tournament_starts_at = new Date().toISOString();
      saveDb();
      res.json({ tournament });
      void runLocalGroupFixture();
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/prepare-knockout', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để khởi chạy knock-out.' });
        return;
      }
      const tournament = db.tournaments.find((item) => item.id === req.params.id);
      const groupFixtures = db.tournamentFixtures.filter((item) =>
        item.tournament_id === req.params.id && item.phase === 'group'
      );
      const existingKnockout = db.tournamentFixtures.filter(f => f.tournament_id === req.params.id && f.phase === 'knockout');
      if (!tournament || tournament.format !== 'group_knockout' ||
          !(tournament.status === 'group_complete' || (tournament.status === 'knockout' && !tournament.knockout_started_at)) || !groupFixtures.length ||
          existingKnockout.some(f => f.status !== 'pending' || f.games_played || f.match_id || f.round_number !== 1 || f.leg > 1) ||
          groupFixtures.some((fixture) => fixture.status !== 'completed')) {
        res.status(409).json({ error: 'Vòng bảng chưa hoàn tất.' });
        return;
      }
      const standings = tournamentGroupStandings(tournament.id);
      const qualifiers = standings.filter((_, index) =>
        standings.slice(0, index)
          .filter((row) => row.group_number === standings[index].group_number).length < 2
      );
      const config = knockoutConfiguration(qualifiers, tournament.rules_json, req.body);
      const openingRound = config.fixtures;
      if (existingKnockout.length && existingKnockout.length !== openingRound.length) {
        res.status(409).json({ error: 'Nhánh cũ không khớp số đấu thủ vượt qua vòng bảng.' }); return;
      }
      tournament.knockout_starts_at = knockoutStartTime(req.body?.knockoutStartsAt).toISOString();
      tournament.knockout_started_at = undefined;
      tournament.knockout_rules_json = config.rules;
      tournament.execution_mode = 'server';
      const configuredFixtures = openingRound.map((fixture, i) => ({ ...createTournamentFixture(tournament.id, {
          ...newKnockoutSeries(fixture.player1Id, fixture.player2Id),
          phase: 'knockout',
          group_number: null,
          round_number: fixture.roundNumber,
          match_number: fixture.matchNumber,
          leg: 1,
          player1_id: fixture.player1Id,
          player2_id: fixture.player2Id,
          status: 'pending',
        }), ...(existingKnockout[i] ? { id: existingKnockout[i].id } : {}) }));
      db.tournamentFixtures = db.tournamentFixtures.filter(f => f.tournament_id !== tournament.id || f.phase !== 'knockout');
      db.tournamentFixtures.push(...configuredFixtures);
      tournament.status = 'knockout';
      saveDb();
      res.status(201).json({ tournament, fixtureCount: openingRound.length });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/start-knockout', (req: Request, res: Response) => {
    try {
      const actor = getAuthUser(req);
      if (!actor.is_admin) { res.status(403).json({ error: 'Cần quyền Ban Tổ Chức.' }); return; }
      const t = db.tournaments.find(item => item.id === req.params.id);
      if (t?.status !== 'knockout' || t.knockout_started_at) {
        res.status(409).json({ error: 'Cần phân nhánh knock-out trước; vòng đã chạy không thể khởi chạy lại.' }); return;
      }
      if (!t.knockout_starts_at || new Date(t.knockout_starts_at).getTime() > Date.now()) {
        res.status(409).json({ error: 'Chưa đến giờ bắt đầu vòng knock-out; người chơi vẫn có thể cập nhật Bot.' }); return;
      }
      const fixtures = db.tournamentFixtures.filter(f => f.tournament_id === t.id && f.phase === 'knockout');
      if (!fixtures.length || fixtures.some(f => f.status !== 'pending' || f.games_played)) {
        res.status(409).json({ error: 'Nhánh knock-out không sẵn sàng.' }); return;
      }
      const ids = [...new Set(fixtures.flatMap(f => [f.player1_id, f.player2_id]))];
      const bots = ids.map(id => getActiveUserBot(id));
      if (bots.some(b => !b?.code?.trim())) {
        res.status(409).json({ error: 'Mỗi đấu thủ knock-out phải có code Bot đã lưu.' }); return;
      }
      ids.forEach((id, i) => {
        const entry = db.tournamentEntries.find(e => e.tournament_id === t.id && e.player_id === id)!;
        entry.bot_code_snapshot = bots[i]!.code; entry.bot_version = bots[i]!.version;
        entry.bot_sha256_snapshot = createHash('sha256').update(bots[i]!.code).digest('hex');
      });
      t.knockout_started_at = new Date().toISOString(); t.execution_mode = 'server';
      saveDb(); res.json({ started: true }); void runLocalGroupFixture();
    } catch (err: any) { res.status(err.status || 500).json({ error: err.message }); }
  });

  app.post('/api/tournaments/cancel-all', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để hủy giải đấu.' });
        return;
      }
      const activeTournaments = db.tournaments.filter(
        (tournament) => !['completed', 'cancelled'].includes(tournament.status)
      );
      for (const tournament of activeTournaments) {
        tournament.status = 'cancelled';
        clearTournamentWaiters(tournament.id);
        abandonActiveTournamentMatches(tournament.id, 'Ban Tổ Chức đã hủy tất cả giải đấu.');
      }
      if (activeTournaments.length) saveDb();
      res.json({ cancelledCount: activeTournaments.length });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/cancel', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để hủy giải đấu.' });
        return;
      }
      const tournament = db.tournaments.find((item) => item.id === req.params.id);
      if (!tournament || ['completed', 'cancelled'].includes(tournament.status)) {
        res.status(409).json({ error: 'Giải không tồn tại hoặc đã kết thúc/hủy.' });
        return;
      }
      tournament.status = 'cancelled';
      clearTournamentWaiters(tournament.id);
      abandonActiveTournamentMatches(tournament.id, 'Ban Tổ Chức đã hủy giải đấu.');
      saveDb();
      res.json({ tournament });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/start', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để bắt đầu vòng Thực chiến.' });
        return;
      }
      const t = db.tournaments.find((tour) => tour.id === req.params.id);
      if (!t || t.status !== 'registration') {
        res.status(409).json({ error: 'Giải đấu không ở giai đoạn Mở đăng ký / Chạy đà.' });
        return;
      }
      t.status = 'qualifying';
      t.current_week = 1;
      t.last_reset_week = 1;
      t.week_started_at = new Date().toISOString();
      t.rules_json = weeklyRules(1, t.rules_schedule);
      initializeStageBEntries(t.id);
      clearTournamentWaiters(t.id);
      abandonActiveTournamentMatches(
        t.id,
        'Ban Tổ Chức đã mở Vòng Thực Chiến Sprint 1; các trận Chạy Đà đang dở được đóng lại.'
      );
      saveDb();
      res.json({ tournament: t });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/advance-sprint', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để chuyển Sprint.' });
        return;
      }
      const t = db.tournaments.find((tour) => tour.id === req.params.id);
      if (!t || t.status !== 'qualifying') {
        res.status(409).json({ error: 'Giải đấu không ở giai đoạn Thực chiến.' });
        return;
      }
      const nextWeek = Math.max(1, t.current_week || 1) + 1;
      applySprintResetsToEntries(t, nextWeek);
      t.current_week = nextWeek;
      t.week_started_at = new Date(Date.now() - (nextWeek - 1) * WEEK_MS).toISOString();
      t.rules_json = weeklyRules(nextWeek, t.rules_schedule);
      clearTournamentWaiters(t.id);
      abandonActiveTournamentMatches(
        t.id,
        `Ban Tổ Chức đã chuyển sang Sprint ${nextWeek} và áp dụng xét hạng ×2/3; trận thuộc Sprint cũ bị hủy.`
      );
      saveDb();
      res.json({ tournament: t });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/complete', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để kết thúc giải và công bố BXH.' });
        return;
      }
      const t = db.tournaments.find((tour) => tour.id === req.params.id);
      if (!t || t.status === 'completed') {
        res.status(409).json({ error: 'Giải đấu đã kết thúc hoặc không tồn tại.' });
        return;
      }
      t.status = 'completed';
      const nowIso = new Date().toISOString();
      if (new Date(t.ends_at) > new Date()) {
        t.ends_at = nowIso;
      }
      clearTournamentWaiters(t.id);
      abandonActiveTournamentMatches(
        t.id,
        'Giải đấu đã kết thúc để công bố Bảng Xếp Hạng Thách Đấu chung cuộc.'
      );
      saveDb();
      res.json({ tournament: t });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/copy-entrants', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      if (!user.is_admin) {
        res.status(403).json({ error: 'Cần quyền Ban Tổ Chức để sao chép đấu thủ.' });
        return;
      }
      const target = db.tournaments.find((item) => item.id === req.params.id);
      const sourceId = req.body?.sourceTournamentId;
      const source = db.tournaments.find((item) => item.id === sourceId);
      if (!target || target.format !== 'group_knockout' || target.status !== 'registration' ||
          !source || source.format !== 'group_knockout' || source.id === target.id) {
        res.status(409).json({ error: 'Giải nguồn hoặc giải đích không hợp lệ để sao chép đấu thủ.' });
        return;
      }
      const sourceEntries = db.tournamentEntries.filter((entry) => entry.tournament_id === source.id);
      const targetEntries = db.tournamentEntries.filter((entry) => entry.tournament_id === target.id);
      if (!sourceEntries.length || targetEntries.length) {
        res.status(409).json({ error: 'Giải nguồn chưa có đấu thủ hoặc giải đích đã có đấu thủ.' });
        return;
      }
      const sourceBots = sourceEntries.map((entry) => {
        const player = db.users.find((candidate) => candidate.id === entry.player_id);
        const bot = db.botVersions.find((candidate) =>
          candidate.user_id === entry.player_id && candidate.version === entry.bot_version
        );
        if (!player || !bot) {
          throw Object.assign(new Error('Có đấu thủ không còn tài khoản hoặc phiên bản bot đã đăng ký.'), {
            status: 409,
          });
        }
        requireTournamentElo(target, player);
        return { entry, player };
      });
      const registeredAt = new Date().toISOString();
      const copiedEntries: TournamentEntryRecord[] = sourceBots.map(({ entry, player }) => ({
        tournament_id: target.id,
        player_id: entry.player_id,
        bot_version: entry.bot_version,
        matches_played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        points: 0,
        tournament_elo: player.elo,
        tier: 'Bronze',
        rank_stars: 0,
        season_points: 0,
        registered_at: registeredAt,
      }));
      db.tournamentEntries.push(...copiedEntries);
      saveDb();
      res.status(201).json({ copiedCount: sourceBots.length });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/tournaments/:id/register', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      updateTournamentLifecycle();
      const t = db.tournaments.find((tour) => tour.id === req.params.id);
      if (!t) {
        res.status(404).json({ error: 'Không tìm thấy giải đấu.' });
        return;
      }
      const existing = db.tournamentEntries.find(
        (e) => e.tournament_id === t.id && e.player_id === user.id
      );
      if (existing) {
        res.json({ entry: existing, alreadyRegistered: true });
        return;
      }
      if (t.status !== 'registration' || new Date(t.registration_closes_at) <= new Date()) {
        res.status(409).json({
          error:
            'Giải đấu đã đóng cổng đăng ký (đang ở Giai đoạn Thực chiến hoặc đã kết thúc). Hãy chọn giải đang Mở đăng ký!',
        });
        return;
      }
      requireTournamentElo(t, user);
      if (!getActiveUserBot(user.id)) {
        res.status(400).json({ error: 'Cần lưu một Bot hợp lệ trước khi đăng ký giải đấu.' });
        return;
      }
      const count = db.tournamentEntries.filter((e) => e.tournament_id === t.id).length;
      if (t.format !== 'group_knockout' && count >= t.max_teams) {
        res.status(409).json({ error: 'Giải đấu đã đủ số lượng người chơi tối đa.' });
        return;
      }
      const entry: TournamentEntryRecord = {
        tournament_id: t.id,
        player_id: user.id,
        bot_version: user.active_bot_version || 0,
        matches_played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        points: 0,
        tournament_elo: user.elo,
        // Placeholder only during registration; Elo determines the starting rank at closure.
        tier: 'Bronze',
        rank_stars: 0,
        season_points: 0,
        registered_at: new Date().toISOString(),
      };
      db.tournamentEntries.push(entry);
      updateTournamentLifecycle();
      saveDb();
      res.status(201).json({ entry });
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/match/submit-result', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      updateTournamentLifecycle();
      const body = req.body || {};
      const match = db.matches.find((m) => m.id === body.matchId);
      if (!match || (match.player1_id !== user.id && match.player2_id !== user.id)) {
        res.status(404).json({ error: 'Không tìm thấy trận đấu của bạn.' });
        return;
      }
      if (match.status === 'completed') {
        const mr = db.matchResults.find((r) => r.match_id === match.id);
        const ownEntry = match.tournament_id
          ? db.tournamentEntries.find(
              (e) => e.tournament_id === match.tournament_id && e.player_id === user.id
            )
          : null;
        res.json({
          alreadySubmitted: true,
          matchId: match.id,
          winnerId: match.winner_id,
          finalStateHash: match.final_state_hash,
          elo: mr
            ? {
                player1: { before: mr.player1_elo_before, after: mr.player1_elo_after },
                player2: { before: mr.player2_elo_before, after: mr.player2_elo_after },
              }
            : null,
          eloUpdated:
            match.match_type === 'bot' &&
            match.tournament_phase !== 'practice' &&
            !match.is_sparring,
          tournamentUpdate: ownEntry
            ? {
                tier: ownEntry.tier,
                stars: ownEntry.rank_stars,
                seasonPoints: ownEntry.season_points,
                phase: match.tournament_phase,
              }
            : null,
          replaySha256: match.replay_sha256,
        });
        return;
      }
      if (match.status !== 'active') {
        res.status(409).json({ error: 'Trận đấu không còn ở trạng thái đang diễn ra.' });
        return;
      }

      if (match.tournament_id && !match.is_sparring) {
        const t = db.tournaments.find((tour) => tour.id === match.tournament_id);
        const practiceOpen =
          match.tournament_phase === 'practice' &&
          t?.status === 'registration' &&
          new Date(t.registration_closes_at) > new Date();
        const rankedOpen =
          match.tournament_phase === 'ranked' &&
          t?.status === 'qualifying' &&
          new Date(t.ends_at) > new Date() &&
          Number(match.tournament_rules?.week) === Number(t.current_week);
        const fixture = match.tournament_fixture_id
          ? db.tournamentFixtures.find((item) =>
              item.id === match.tournament_fixture_id && item.tournament_id === match.tournament_id
            )
          : undefined;
        const groupKnockoutOpen = isCurrentGroupKnockoutFixture(match, t, fixture);
        if (!practiceOpen && !rankedOpen && !groupKnockoutOpen) {
          match.status = 'abandoned';
          saveDb();
          res.status(409).json({
            error:
              'Giai đoạn hoặc Sprint của giải đấu đã kết thúc trước khi nộp kết quả; trận bị hủy và không tính điểm.',
            matchStatus: 'abandoned',
          });
          return;
        }
      }

      const p1 = body.proofs?.player1;
      const p2 = body.proofs?.player2;
      if (!p1?.proof || !p1.signature || !p2?.proof || !p2.signature) {
        res.status(400).json({ error: 'Thiếu chữ ký xác nhận kết quả của cả 2 người chơi.' });
        return;
      }
      if (!match.player1_key || !match.player2_key) {
        res.status(409).json({ error: 'Khóa phiên P-256 chưa được đăng ký đầy đủ.' });
        return;
      }

      const validProofShape = (pr: any) =>
        pr &&
        pr.matchId === match.id &&
        pr.roomId === match.id &&
        Number.isInteger(pr.stepCount) &&
        pr.stepCount >= 1 &&
        /^[0-9a-f]{64}$/i.test(pr.stateHash || '') &&
        [0, 1, 2].includes(pr.winner);

      if (
        !validProofShape(p1.proof) ||
        !validProofShape(p2.proof) ||
        p1.proof.winner !== p2.proof.winner ||
        p1.proof.stepCount !== p2.proof.stepCount ||
        p1.proof.stateHash !== p2.proof.stateHash
      ) {
        res.status(409).json({ error: 'Bằng chứng kết thúc ván giữa hai người chơi mâu thuẫn nhau.' });
        return;
      }

      if (
        !verifySessionProof(match.player1_key, p1.proof, p1.signature) ||
        !verifySessionProof(match.player2_key, p2.proof, p2.signature)
      ) {
        res.status(400).json({ error: 'Chữ ký xác thực kết quả không hợp lệ.' });
        return;
      }

      const replayResult = verifyReplay(
        body.replay,
        match.seed,
        match.id,
        match.tournament_rules || null
      );
      if (
        replayResult.finalHash !== p1.proof.stateHash ||
        replayResult.stepCount !== p1.proof.stepCount ||
        replayResult.winner !== p1.proof.winner
      ) {
        res.status(400).json({ error: 'Kết quả Replay không khớp với bằng chứng ký số.' });
        return;
      }

      const u1 = db.users.find((u) => u.id === match.player1_id)!;
      const u2 = db.users.find((u) => u.id === match.player2_id)!;
      const score1 = replayResult.winner === 1 ? 1 : replayResult.winner === 2 ? 0 : 0.5;
      const eloUpdated =
        match.match_type === 'bot' &&
        match.tournament_phase !== 'practice' &&
        !match.is_sparring;
      const u1Before = u1.elo;
      const u2Before = u2.elo;
      const u1After = eloUpdated ? calculateElo(u1Before, u2Before, score1) : u1Before;
      const u2After = eloUpdated ? calculateElo(u2Before, u1Before, 1 - score1) : u2Before;

      if (eloUpdated) {
        u1.elo = u1After;
        u2.elo = u2After;
        recordEloPeak(u1, u1After);
        recordEloPeak(u2, u2After);
      }

      const tournamentUpdates = applyTournamentScoreForMatch(match, score1);
      const replayChecksum = sha256Canonical(body.replay);
      match.status = 'completed';
      match.winner_id =
        replayResult.winner === 1 ? u1.id : replayResult.winner === 2 ? u2.id : null;
      match.final_step_count = replayResult.stepCount;
      completeTournamentFixture(match, match.winner_id, replayResult.stepCount);
      match.final_state_hash = replayResult.finalHash;
      match.replay_sha256 = replayChecksum;
      match.replay_json = body.replay;
      match.player1_proof = p1;
      match.player2_proof = p2;
      match.completed_at = new Date().toISOString();

      db.matchResults.push({
        match_id: match.id,
        player1_elo_before: u1Before,
        player2_elo_before: u2Before,
        player1_elo_after: u1After,
        player2_elo_after: u2After,
        result_player1: score1,
        created_at: match.completed_at,
      });

      const spar = sparringSessions.get(match.id);
      if (spar) {
        spar.destroyed = true;
        sparringSessions.delete(match.id);
      }
      saveDb();

      res.json({
        matchId: match.id,
        winnerId: match.winner_id,
        winner: replayResult.winner,
        drawReason: replayResult.drawReason || null,
        finalStateHash: match.final_state_hash,
        elo: {
          player1: { before: u1Before, after: u1After },
          player2: { before: u2Before, after: u2After },
        },
        eloUpdated,
        tournamentUpdate: tournamentUpdates.get(user.id) || null,
        replaySha256: replayChecksum,
      });
    } catch (err: any) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/match/forfeit', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const matchId = String(req.body?.matchId || '');
      const outcome = adjudicateMatchForfeit(
        matchId,
        user.id,
        'player-left-match',
        'Đối thủ đã thoát khỏi bàn đấu — Bạn được xử thắng kỹ thuật ngay lập tức!',
        'Bạn đã rời bàn khi trận đấu chưa kết thúc và bị xử thua kỹ thuật.'
      );
      if (!outcome) {
        res.status(404).json({ error: 'Không tìm thấy trận đấu đang diễn ra.' });
        return;
      }
      res.json({ forfeited: true, matchId: outcome.matchId, winnerId: outcome.winnerId });
    } catch (err: any) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/match/claim-timeout', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const matchId = String(req.body?.matchId || '');
      const match = db.matches.find((m) => m.id === matchId && m.status === 'active');
      if (!match || (match.player1_id !== user.id && match.player2_id !== user.id)) {
        res.status(404).json({ error: 'Không tìm thấy trận đấu đang diễn ra.' });
        return;
      }
      const claimantSeat: 1 | 2 = match.player1_id === user.id ? 1 : 2;
      const opponentSeat: 1 | 2 = claimantSeat === 1 ? 2 : 1;
      const opponentId = opponentSeat === 1 ? match.player1_id : match.player2_id;
      const cs = match.consensus_state || createInitialConsensusState(match.match_type);
      const now = Date.now();
      const consensusAckTimeoutMs = match.match_type === 'bot' ? botAckTimeoutMs : ackTimeoutMs;

      // 1. Setup / Readiness timeout
      if (!cs.bothReadyAt) {
        const oppReady = opponentSeat === 1 ? cs.p1ReadyAt : cs.p2ReadyAt;
        const myReady = claimantSeat === 1 ? cs.p1ReadyAt : cs.p2ReadyAt;
        if (!oppReady && (now - cs.createdAtMs >= setupTimeoutMs || (myReady && now - myReady >= setupPeerReadyTimeoutMs))) {
          const out = adjudicateMatchForfeit(
            match.id,
            opponentId,
            'setup-timeout',
            'Đối thủ không nạp Bot hoặc không xác nhận sẵn sàng đúng hạn — Bạn được xử thắng kỹ thuật!',
            'Bạn không nạp Bot hoặc không xác nhận sẵn sàng đúng hạn nên bị xử thua kỹ thuật.'
          );
          res.json({ resolved: Boolean(out), reason: 'setup-timeout', winnerId: out?.winnerId });
          return;
        }
        res.status(202).json({ resolved: false, waiting: true });
        return;
      }

      // 2. Withheld FINAL_PROOF timeout after terminal state
      if (
        cs.finalProofs?.[claimantSeat] &&
        !cs.finalProofs?.[opponentSeat] &&
        now - (cs.finalProofAt?.[claimantSeat] || now) >= consensusAckTimeoutMs
      ) {
        if (req.body?.replay) {
          verifyReplay(req.body.replay, match.seed, match.id, match.tournament_rules || null);
        }
        const out = adjudicateMatchForfeit(
          match.id,
          opponentId,
          'withheld-final-proof',
          'Đối thủ cố tình không gửi chữ ký xác nhận cuối trận — Bạn được xử thắng kỹ thuật!',
          'Bạn không gửi chữ ký xác nhận kết quả cuối trận đúng hạn nên bị xử thua kỹ thuật.'
        );
        res.json({ resolved: Boolean(out), reason: 'withheld-final-proof', winnerId: out?.winnerId });
        return;
      }

      // 3. Withheld CONSENSUS_ACK timeout
      const currentStep = Number(cs.currentStep || 0);
      if (
        cs.lastRevealStep === currentStep &&
        cs.acksForPendingStep?.[claimantSeat] &&
        !cs.acksForPendingStep?.[opponentSeat] &&
        now - (cs.lastRevealAt || now) >= consensusAckTimeoutMs
      ) {
        const out = adjudicateMatchForfeit(
          match.id,
          opponentId,
          'withheld-ack',
          'Đối thủ cố tình ngâm gói xác nhận trạng thái (ACK) — Bạn được xử thắng kỹ thuật ngay lập tức!',
          'Bạn không phản hồi gói xác nhận trạng thái (ACK) đúng hạn nên bị xử thua kỹ thuật.'
        );
        res.json({ resolved: Boolean(out), reason: 'withheld-ack', winnerId: out?.winnerId });
        return;
      }

      // 4. Turn / Stalled Bot timeout
      const activeTurnSeat: 1 | 2 = currentStep % 2 === 0 ? 1 : 2;
      const turnTimeoutMs = match.match_type === 'bot' ? botTurnTimeoutMs : 45000;
      if (
        activeTurnSeat === opponentSeat &&
        cs.lastRevealStep !== currentStep &&
        now - (cs.stepStartedAt || now) >= turnTimeoutMs
      ) {
        const out = adjudicateMatchForfeit(
          match.id,
          opponentId,
          'turn-timeout',
          'Đối thủ treo máy hoặc không gửi nước đi đúng hạn — Bạn được xử thắng kỹ thuật!',
          'Bot hoặc phiên của bạn không gửi nước đi đúng hạn nên bị xử thua kỹ thuật.'
        );
        res.json({ resolved: Boolean(out), reason: 'turn-timeout', winnerId: out?.winnerId });
        return;
      }

      res.status(202).json({ resolved: false, waiting: true });
    } catch (err: any) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/match/claim-disconnect', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const proof = req.body?.proof;
      if (!proof || proof.kind !== 'disconnect-claim' || !req.body?.signature) {
        res.status(400).json({ error: 'Biên bản báo mất kết nối không hợp lệ.' });
        return;
      }
      const match = db.matches.find((m) => m.id === proof.matchId && m.status === 'active');
      if (!match || (match.player1_id !== user.id && match.player2_id !== user.id)) {
        res.status(404).json({ error: 'Không tìm thấy trận đấu đang diễn ra.' });
        return;
      }
      const disconnectedId = match.player1_id === user.id ? match.player2_id : match.player1_id;
      if (
        match.disconnected_player_id === disconnectedId &&
        match.disconnected_at &&
        Date.now() - new Date(match.disconnected_at).getTime() >= disconnectForfeitMs
      ) {
        const out = adjudicateMatchForfeit(
          match.id,
          disconnectedId,
          'disconnect-timeout',
          'Đối thủ đã mất kết nối quá thời gian quy định — Bạn được xử thắng kỹ thuật!',
          'Bạn đã mất kết nối quá thời gian quy định nên bị xử thua kỹ thuật.'
        );
        res.json({ status: 'adjudicated', winnerId: out?.winnerId });
        return;
      }
      res.status(202).json({
        status: 'waiting',
        message: 'Đang chờ đối chiếu trạng thái kết nối của đối thủ.',
      });
    } catch (err: any) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  app.post('/api/match/consensus-dispute', (req: Request, res: Response) => {
    try {
      const user = getAuthUser(req);
      const report = req.body?.report;
      const evidence = req.body?.evidence;
      const proof = report?.payload;

      if (
        !proof ||
        proof.kind !== 'consensus-dispute' ||
        typeof report?.signature !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(proof.evidenceHash || '')
      ) {
        res.status(400).json({ error: 'Biên bản tranh chấp đồng thuận không hợp lệ.' });
        return;
      }

      const match = db.matches.find((m) => m.id === proof.matchId);
      if (!match || (match.player1_id !== user.id && match.player2_id !== user.id)) {
        res.status(404).json({ error: 'Không tìm thấy trận đấu thuộc tài khoản của bạn.' });
        return;
      }

      if (match.status !== 'active') {
        const prior = db.matchDisputes.find((d) => d.match_id === match.id);
        if (prior) {
          const mr = db.matchResults.find((r) => r.match_id === match.id);
          res.json({
            matchId: match.id,
            resolved: prior.status === 'adjudicated',
            winnerId: prior.winner_id,
            winnerPlayer:
              prior.winner_id === match.player1_id
                ? 1
                : prior.winner_id === match.player2_id
                ? 2
                : null,
            offenderPlayer:
              prior.offender_id === match.player1_id
                ? 1
                : prior.offender_id === match.player2_id
                ? 2
                : null,
            eloUpdated: prior.status === 'adjudicated' && match.match_type === 'bot' && !match.is_sparring,
            player1EloAfter: mr?.player1_elo_after,
            player2EloAfter: mr?.player2_elo_after,
            message: 'Biên bản tranh chấp của trận này đã được phân xử trước đó.',
          });
          return;
        }
        res.status(409).json({ error: 'Trận đấu đã kết thúc trước khi gửi biên bản tranh chấp.' });
        return;
      }

      if (!match.player1_key || !match.player2_key) {
        res.status(409).json({ error: 'Khóa phiên của cả 2 phía chưa được đăng ký đầy đủ.' });
        return;
      }

      const claimantSeat: 1 | 2 = match.player1_id === user.id ? 1 : 2;
      const claimantKey = claimantSeat === 1 ? match.player1_key : match.player2_key;

      if (
        proof.claimantSeat !== claimantSeat ||
        evidence?.matchId !== match.id ||
        hashCanonical(evidence) !== proof.evidenceHash
      ) {
        res.status(400).json({ error: 'Dữ liệu bằng chứng không khớp với biên bản ký số.' });
        return;
      }

      if (!verifySessionProof(claimantKey, proof, report.signature)) {
        res.status(400).json({ error: 'Chữ ký biên bản tranh chấp không hợp lệ.' });
        return;
      }

      const verdict = verifyConsensusDispute(evidence, match);
      if (!verdict.adjudicated || !verdict.offenderSeat) {
        match.status = 'disputed';
        match.completed_at = new Date().toISOString();
        db.matchDisputes.push({
          match_id: match.id,
          claimant_id: user.id,
          offender_id: null,
          status: 'needs_review',
          reason: verdict.reason,
          winner_id: null,
          step_count: verdict.stepCount,
          expected_state_hash: verdict.expectedHash,
          created_at: match.completed_at,
        });
        saveDb();
        res.json({
          matchId: match.id,
          resolved: false,
          message: 'Đã ghi nhận tranh chấp để kiểm tra thủ công.',
        });
        return;
      }

      const offenderId = verdict.offenderSeat === 1 ? match.player1_id : match.player2_id;
      const winnerId = verdict.offenderSeat === 1 ? match.player2_id : match.player1_id;
      const winnerPlayer: 1 | 2 = verdict.offenderSeat === 1 ? 2 : 1;
      const score1 = winnerId === match.player1_id ? 1 : 0;

      const u1 = db.users.find((u) => u.id === match.player1_id)!;
      const u2 = db.users.find((u) => u.id === match.player2_id)!;
      const eloUpdated =
        match.match_type === 'bot' &&
        match.tournament_phase !== 'practice' &&
        !match.is_sparring;
      const p1Before = u1.elo;
      const p2Before = u2.elo;
      const p1After = eloUpdated ? calculateElo(p1Before, p2Before, score1) : p1Before;
      const p2After = eloUpdated ? calculateElo(p2Before, p1Before, 1 - score1) : p2Before;

      if (eloUpdated) {
        u1.elo = p1After;
        u2.elo = p2After;
        recordEloPeak(u1, p1After);
        recordEloPeak(u2, p2After);
      }

      const tournamentUpdates = applyTournamentScoreForMatch(match, score1);
      const completedAt = new Date().toISOString();
      match.status = 'completed';
      match.winner_id = winnerId;
      match.final_step_count = verdict.stepCount;
      completeTournamentFixture(match, winnerId, verdict.stepCount);
      match.final_state_hash = verdict.expectedHash;
      match.completed_at = completedAt;

      if (!db.matchResults.some((r) => r.match_id === match.id)) {
        db.matchResults.push({
          match_id: match.id,
          player1_elo_before: p1Before,
          player2_elo_before: p2Before,
          player1_elo_after: p1After,
          player2_elo_after: p2After,
          result_player1: score1,
          created_at: completedAt,
        });
      }

      db.matchDisputes.push({
        match_id: match.id,
        claimant_id: user.id,
        offender_id: offenderId,
        status: 'adjudicated',
        reason: verdict.reason,
        winner_id: winnerId,
        step_count: verdict.stepCount,
        expected_state_hash: verdict.expectedHash,
        created_at: completedAt,
      });

      saveDb();

      const winnerMsg =
        verdict.reason === 'signed-final-proof-mismatch'
          ? 'Phát hiện đối thủ ký sai lệch kết quả cuối trận — Bạn được xử thắng kỹ thuật ngay lập tức!'
          : verdict.reason === 'signed-illegal-move'
          ? 'Đối thủ gửi nước đi bất hợp pháp — Bạn được xử thắng kỹ thuật ngay lập tức!'
          : 'Phát hiện sai lệch mã băm trạng thái (Hash Mismatch) từ phía đối thủ — Bạn được xử thắng kỹ thuật ngay lập tức!';
      const loserMsg =
        'Phiên của bạn gửi dữ liệu trạng thái hoặc chữ ký sai lệch với luật tất định nên bị xử thua kỹ thuật.';

      for (const pid of [match.player1_id, match.player2_id]) {
        const isP1 = pid === match.player1_id;
        const isWinner = pid === winnerId;
        sendWs(liveSockets.get(pid), 'match-dispute-result', {
          matchId: match.id,
          resolved: true,
          winnerId,
          winnerPlayer,
          offenderPlayer: verdict.offenderSeat,
          reason: verdict.reason,
          eloUpdated,
          eloBefore: isP1 ? p1Before : p2Before,
          eloAfter: isP1 ? p1After : p2After,
          tournamentUpdate: tournamentUpdates.get(pid) || null,
          message: isWinner ? winnerMsg : loserMsg,
        });
      }

      res.json({
        matchId: match.id,
        resolved: true,
        winnerId,
        winnerPlayer,
        offenderPlayer: verdict.offenderSeat,
        reason: verdict.reason,
        eloUpdated,
        eloBefore: claimantSeat === 1 ? p1Before : p2Before,
        eloAfter: claimantSeat === 1 ? p1After : p2After,
        player1EloAfter: p1After,
        player2EloAfter: p2After,
        tournamentUpdate: tournamentUpdates.get(user.id) || null,
        message: user.id === winnerId ? winnerMsg : loserMsg,
      });
    } catch (err: any) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // ── Match Pairing Helper ──────────────────────────────────────
  function pairPlayers(
    u1: UserRecord,
    u2: UserRecord,
    matchType: 'human' | 'bot',
    tournament: TournamentRecord | null = null,
    isSparring = false,
    fixture: TournamentFixtureRecord | null = null
  ) {
    const firstIsP1 = Math.random() < 0.5;
    const p1 = firstIsP1 ? u1 : u2;
    const p2 = firstIsP1 ? u2 : u1;
    const seed = randomInt(100000, 2147483000);
    const phase = fixture
      ? fixture.phase
      : tournament
      ? tournament.status === 'registration'
        ? 'practice'
        : 'ranked'
      : null;
    const rules =
      fixture && tournament
        ? tournament.rules_json
        : tournament?.status === 'qualifying'
        ? tournament.rules_json || weeklyRules(tournament.current_week || 1, tournament.rules_schedule)
        : null;

    const p1Bot = matchType === 'bot' ? getActiveUserBot(p1.id) : null;
    const p2Bot = matchType === 'bot' ? getActiveUserBot(p2.id) : null;

    const match: MatchRecord = {
      id: randomUUID(),
      seed,
      player1_id: p1.id,
      player2_id: p2.id,
      match_type: matchType,
      status: 'active',
      tournament_id: tournament?.id || null,
      tournament_phase: phase,
      tournament_rules: rules,
      tournament_fixture_id: fixture?.id || null,
      is_sparring: isSparring,
      player1_bot_version: p1Bot?.version,
      player2_bot_version: p2Bot?.version,
      player1_bot_code: p1Bot?.code,
      player2_bot_code: p2Bot?.code,
      player1_key: null,
      player2_key: null,
      winner_id: null,
      final_state_hash: null,
      replay_sha256: null,
      replay_json: null,
      player1_proof: null,
      player2_proof: null,
      disconnected_player_id: null,
      disconnected_at: null,
      consensus_state: createInitialConsensusState(matchType),
      created_at: new Date().toISOString(),
      completed_at: null,
    };
    if (fixture) {
      fixture.status = 'active';
      fixture.match_id = match.id;
      fixture.player1_ready_at = new Date().toISOString();
      fixture.player2_ready_at = new Date().toISOString();
    }
    db.matches.push(match);
    saveDb();

    const baseMatchPayload = {
      id: match.id,
      seed: match.seed,
      pieceCount: 9,
      mode: matchType,
      tournamentId: match.tournament_id,
      tournamentPhase: match.tournament_phase,
      isSparring,
      rules: match.tournament_rules,
      player1: { id: p1.id, displayName: p1.display_name, elo: p1.elo },
      player2: { id: p2.id, displayName: p2.display_name, elo: p2.elo },
    };

    const ws1 = liveSockets.get(p1.id);
    const ws2 = liveSockets.get(p2.id);
    if (ws1) {
      ws1.queueMode = null;
      sendWs(ws1, 'match-found', {
        role: 'player1',
        seat: 1,
        match: baseMatchPayload,
        opponent: { id: p2.id, displayName: p2.display_name, elo: p2.elo },
        ...(p1Bot ? { myBotCode: p1Bot.code, myBotVersion: p1Bot.version } : {}),
      });
    }
    if (ws2) {
      ws2.queueMode = null;
      sendWs(ws2, 'match-found', {
        role: 'player2',
        seat: 2,
        match: baseMatchPayload,
        opponent: { id: p1.id, displayName: p1.display_name, elo: p1.elo },
        ...(p2Bot ? { myBotCode: p2Bot.code, myBotVersion: p2Bot.version } : {}),
      });
    }
    return match;
  }

  // ── Server-Side Sparring Bot Controller ──────────────────────
  async function handleSparringRelay(session: SparringSession, humanWs: AuthedSocket, packet: any) {
    if (session.destroyed) return;
    const match = db.matches.find((m) => m.id === session.matchId && m.status === 'active');
    if (!match) return;

    const sendToHuman = (payload: Record<string, unknown>) => {
      sendWs(humanWs, 'match-relay', {
        matchId: session.matchId,
        from: '00000000-0000-4000-8000-000000000001',
        payload,
      });
    };

    const triggerBotMoveIfNeeded = async () => {
      if (
        session.destroyed ||
        OTTGameEngine.isGameOver(session.state) ||
        session.state.turn !== session.botSeat
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
      if (session.destroyed || OTTGameEngine.isGameOver(session.state)) return;
      const move = pickTacticalBotMove(session.state, session.botSeat);
      if (!move) return;

      const stepIdx = session.state.stepCount;
      const nonce = randomBytes(32).toString('hex');
      const commit = sha256Canonical({
        matchId: session.matchId,
        stepCount: stepIdx,
        player: session.botSeat,
        move,
        nonce,
      });
      const commitPayload = {
        kind: 'move-commit',
        matchId: session.matchId,
        stepCount: stepIdx,
        player: session.botSeat,
        hash: commit,
      };
      const commitSig = await signWithWebCrypto(session.privateKey, commitPayload);
      sendToHuman({
        type: 'CONSENSUS_COMMIT',
        attestation: { payload: commitPayload, signature: commitSig },
      });

      const revealPayload = {
        kind: 'move-reveal',
        matchId: session.matchId,
        stepCount: stepIdx,
        player: session.botSeat,
        move,
        nonce,
        commit,
      };
      const revealSig = await signWithWebCrypto(session.privateKey, revealPayload);
      session.state = OTTGameEngine.applyMove(session.state, move);
      const stateHash = sha256Canonical(statePayload(session.state));
      const ackPayload = {
        kind: 'state-ack',
        matchId: session.matchId,
        stepCount: session.state.stepCount,
        player: session.botSeat,
        moveCommit: commit,
        stateHash,
      };
      const ackSig = await signWithWebCrypto(session.privateKey, ackPayload);

      sendToHuman({
        type: 'CONSENSUS_REVEAL',
        attestation: { payload: revealPayload, signature: revealSig },
      });
      sendToHuman({
        type: 'CONSENSUS_ACK',
        attestation: { payload: ackPayload, signature: ackSig },
      });

      if (OTTGameEngine.isGameOver(session.state)) {
        const finalProof = {
          matchId: session.matchId,
          roomId: session.matchId,
          stepCount: session.state.stepCount,
          stateHash,
          winner: session.state.winner,
        };
        const finalSig = await signWithWebCrypto(session.privateKey, finalProof);
        sendToHuman({
          type: 'FINAL_PROOF',
          seat: session.botSeat,
          proof: finalProof,
          signature: finalSig,
        });
      }
    };

    if (packet.type === 'BOT_READY') {
      const cs = match.consensus_state || createInitialConsensusState(match.match_type);
      const now = Date.now();
      cs.p1ReadyAt = now;
      cs.p2ReadyAt = now;
      cs.bothReadyAt = now;
      cs.stepStartedAt = now;
      match.consensus_state = cs;
      sendToHuman({ type: 'BOT_READY', botLabel: 'Hắc Kỵ Sĩ AI (Minimax)' });
      await triggerBotMoveIfNeeded();
      return;
    }

    if (packet.type === 'CONSENSUS_HELLO') {
      sendToHuman({
        type: 'CONSENSUS_HELLO',
        seat: session.botSeat,
        publicKey: session.publicJwk,
      });
      if (packet.autoStart) {
        await triggerBotMoveIfNeeded();
      }
      return;
    }

    if (packet.type === 'CONSENSUS_COMMIT') {
      const att = packet.attestation;
      if (att?.payload) {
        session.pendingCommits.set(att.payload.stepCount, {
          commit: att.payload.hash,
          commitAttestation: att,
        });
      }
      return;
    }

    if (packet.type === 'CONSENSUS_REVEAL') {
      const att = packet.attestation;
      const p = att?.payload;
      if (!p || p.player !== session.humanSeat) return;
      session.state = OTTGameEngine.applyMove(session.state, {
        from: p.move.from,
        to: p.move.to,
      });
      const stateHash = sha256Canonical(statePayload(session.state));
      const ackPayload = {
        kind: 'state-ack',
        matchId: session.matchId,
        stepCount: session.state.stepCount,
        player: session.botSeat,
        moveCommit: p.commit,
        stateHash,
      };
      const ackSig = await signWithWebCrypto(session.privateKey, ackPayload);
      sendToHuman({
        type: 'CONSENSUS_ACK',
        attestation: { payload: ackPayload, signature: ackSig },
      });

      if (OTTGameEngine.isGameOver(session.state)) {
        const finalProof = {
          matchId: session.matchId,
          roomId: session.matchId,
          stepCount: session.state.stepCount,
          stateHash,
          winner: session.state.winner,
        };
        const finalSig = await signWithWebCrypto(session.privateKey, finalProof);
        sendToHuman({
          type: 'FINAL_PROOF',
          seat: session.botSeat,
          proof: finalProof,
          signature: finalSig,
        });
      } else {
        await triggerBotMoveIfNeeded();
      }
    }
  }

  // ── WebSocket Server (/ws) ────────────────────────────────────
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 256 * 1024 });

  wss.on('connection', (ws: AuthedSocket) => {
    ws.authenticated = false;
    const authTimer = setTimeout(() => ws.close(4401, 'Authentication timeout'), 8000);

    ws.on('message', async (raw) => {
      let packet: any;
      try {
        packet = JSON.parse(raw.toString());
      } catch {
        sendWs(ws, 'error', { message: 'Dữ liệu JSON không hợp lệ.' });
        return;
      }

      try {
        if (!ws.authenticated) {
          if (packet.type !== 'auth' || typeof packet.token !== 'string') {
            ws.close(4401, 'Send auth token first');
            return;
          }
          const auth = verifyToken(packet.token);
          const user = db.users.find((u) => u.id === auth.sub);
          if (!user) {
            ws.close(4401, 'Unknown account');
            return;
          }
          clearTimeout(authTimer);
          ws.authenticated = true;
          ws.userId = user.id;
          const prev = liveSockets.get(user.id);
          liveSockets.set(user.id, ws);
          if (prev && prev !== ws) prev.close(4001, 'Replaced by newer session');

          // Clear disconnect marker if player reconnected within grace window
          let clearedDisconnect = false;
          for (const m of db.matches) {
            if (m.status === 'active' && m.disconnected_player_id === user.id) {
              m.disconnected_player_id = null;
              m.disconnected_at = null;
              clearedDisconnect = true;
            }
          }
          if (clearedDisconnect) saveDb();

          sendWs(ws, 'authenticated', { user: publicUser(user) });
          return;
        }

        const user = db.users.find((u) => u.id === ws.userId)!;

        if (packet.type === 'find-match' || packet.type === 'find-bot-match') {
          clearUserQueues(user.id);
          const mode: 'human' | 'bot' = packet.type === 'find-bot-match' ? 'bot' : 'human';
          const targetQueue = mode === 'bot' ? botQueue : humanQueue;

          let bestOpponent: UserRecord | null = null;
          let bestGap = Infinity;
          for (const candidateId of targetQueue) {
            if (candidateId === user.id) continue;
            const candSock = liveSockets.get(candidateId);
            if (!candSock || candSock.readyState !== WebSocket.OPEN) {
              targetQueue.delete(candidateId);
              continue;
            }
            const candUser = db.users.find((u) => u.id === candidateId);
            if (!candUser) continue;
            const gap = Math.abs(candUser.elo - user.elo);
            if (gap < bestGap) {
              bestGap = gap;
              bestOpponent = candUser;
            }
          }

          if (bestOpponent) {
            targetQueue.delete(bestOpponent.id);
            pairPlayers(user, bestOpponent, mode, null, false);
          } else {
            targetQueue.add(user.id);
            ws.queueMode = mode;
            ws.searchStartedAt = Date.now();
            sendWs(ws, 'searching', { elo: user.elo, mode });
          }
        } else if (packet.type === 'find-tournament-match') {
          clearUserQueues(user.id);
          updateTournamentLifecycle();
          const t = db.tournaments.find((tour) => tour.id === packet.tournamentId);
          if (t?.format === 'group_knockout') {
            const entry = db.tournamentEntries.find((item) =>
              item.tournament_id === t.id && item.player_id === user.id
            );
            if (!entry) {
              sendWs(ws, 'error', { message: 'Bạn cần đăng ký giải đấu trước khi tìm trận.' });
              return;
            }
            if (!getActiveUserBot(user.id)) {
              sendWs(ws, 'error', { message: 'Bạn cần lưu Bot Python hợp lệ trước khi thi đấu.' });
              return;
            }
            const fixture = getPendingTournamentFixture(t, user.id);
            if (!fixture) {
              sendWs(ws, 'error', {
                message: t.status === 'grouping'
                  ? 'Ban Tổ Chức chưa chia bảng.'
                  : t.status === 'scheduled' || t.status === 'registration'
                  ? 'Giải chưa đến giờ thi đấu.'
                  : 'Hiện chưa có trận hợp lệ của bạn để ghép.',
              });
              return;
            }
            const queue = tournamentQueue.get(t.id) || new Set<string>();
            tournamentQueue.set(t.id, queue);
            let opponent: UserRecord | null = null;
            for (const candidateId of [...queue]) {
              if (candidateId === user.id) continue;
              const candidateSocket = liveSockets.get(candidateId);
              if (!candidateSocket || candidateSocket.readyState !== WebSocket.OPEN) {
                queue.delete(candidateId);
                continue;
              }
              const candidateFixture = getPendingTournamentFixture(t, candidateId);
              if (candidateFixture?.id !== fixture.id) continue;
              const candidate = db.users.find((item) => item.id === candidateId);
              if (candidate && getActiveUserBot(candidateId)) {
                opponent = candidate;
                break;
              }
            }
            if (opponent) {
              queue.delete(user.id);
              queue.delete(opponent.id);
              pairPlayers(user, opponent, 'bot', t, false, fixture);
            } else {
              queue.add(user.id);
              ws.queueMode = 'tournament';
              ws.tournamentId = t.id;
              ws.searchStartedAt = Date.now();
              sendWs(ws, 'searching', {
                mode: 'tournament',
                tournament: true,
                tournamentId: t.id,
                phase: fixture.phase,
                groupNumber: fixture.group_number,
                round: fixture.round_number,
                rules: t.rules_json,
              });
            }
            return;
          }
          if (!t || !['registration', 'qualifying'].includes(t.status)) {
            sendWs(ws, 'error', { message: 'Giải đấu hiện không mở ghép trận.' });
            return;
          }
          const entry = db.tournamentEntries.find(
            (e) => e.tournament_id === t.id && e.player_id === user.id
          );
          if (!entry) {
            sendWs(ws, 'error', { message: 'Bạn cần bấm Đăng ký tham gia giải trước khi tìm trận.' });
            return;
          }
          const myBot = getActiveUserBot(user.id);
          if (!myBot) {
            sendWs(ws, 'error', {
              message: 'Bạn cần lưu Bot Python trong Phòng Lab trước khi tìm trận giải đấu.',
            });
            return;
          }

          const qSet = tournamentQueue.get(t.id) || new Set<string>();
          tournamentQueue.set(t.id, qSet);

          const validCandidates: UserRecord[] = [];
          for (const candidateId of [...qSet]) {
            if (candidateId === user.id) continue;
            const candSock = liveSockets.get(candidateId);
            if (!candSock || candSock.readyState !== WebSocket.OPEN) {
              qSet.delete(candidateId);
              continue;
            }
            const candEntry = db.tournamentEntries.find(
              (e) => e.tournament_id === t.id && e.player_id === candidateId
            );
            const candUser = db.users.find((u) => u.id === candidateId);
            if (!candEntry || !candUser || !getActiveUserBot(candidateId)) {
              qSet.delete(candidateId);
              continue;
            }
            if (t.status === 'registration') {
              // Stage A (Chạy đà): random pairing across ALL waiting registered players
              validCandidates.push(candUser);
            } else if (candEntry.tier === entry.tier) {
              // Stage B (Thực chiến): strictly same rank tier in current Sprint week
              validCandidates.push(candUser);
            }
          }

          if (validCandidates.length > 0) {
            const chosen =
              t.status === 'registration'
                ? validCandidates[randomInt(0, validCandidates.length)]
                : validCandidates[0];
            qSet.delete(chosen.id);
            pairPlayers(user, chosen, 'bot', t, false);
          } else {
            qSet.add(user.id);
            ws.queueMode = 'tournament';
            ws.tournamentId = t.id;
            ws.searchStartedAt = Date.now();
            sendWs(ws, 'searching', {
              elo: user.elo,
              mode: 'tournament',
              tournament: true,
              tournamentId: t.id,
              phase: t.status === 'registration' ? 'practice' : 'ranked',
              tier: entry.tier,
              week: t.current_week,
              rules: t.status === 'qualifying' ? t.rules_json : null,
            });
          }
        } else if (packet.type === 'find-sparring-match') {
          clearUserQueues(user.id);
          updateTournamentLifecycle();
          const mode: 'human' | 'bot' = packet.mode === 'human' ? 'human' : 'bot';
          const t = packet.tournamentId
            ? db.tournaments.find((tour) => tour.id === packet.tournamentId) || null
            : null;
          if (t && !getActiveUserBot(user.id)) {
            sendWs(ws, 'error', {
              message: 'Bạn cần lưu Bot Python trong Phòng Lab trước khi chạy thử nghiệm giải đấu.',
            });
            return;
          }
          const sysBot = db.users.find((u) => u.is_system_bot)!;
          const match = pairPlayers(user, sysBot, mode, t, true);

          const kp = await webcrypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify']
          );
          const publicJwk = (await webcrypto.subtle.exportKey('jwk', kp.publicKey)) as Record<
            string,
            unknown
          >;

          const humanSeat: 1 | 2 = match.player1_id === user.id ? 1 : 2;
          const botSeat: 1 | 2 = humanSeat === 1 ? 2 : 1;
          if (botSeat === 1) match.player1_key = publicJwk;
          else match.player2_key = publicJwk;
          if (match.consensus_state) {
            if (botSeat === 1) match.consensus_state.p1ReadyAt = Date.now();
            else match.consensus_state.p2ReadyAt = Date.now();
          }
          saveDb();

          sparringSessions.set(match.id, {
            matchId: match.id,
            humanSeat,
            botSeat,
            privateKey: kp.privateKey,
            publicJwk,
            state: OTTGameEngine.createGame(match.seed, 9, match.tournament_rules || null),
            pendingCommits: new Map(),
            moves: [],
            destroyed: false,
          });

          sendWs(ws, 'sparring-ready', { matchId: match.id, botSeat, publicKey: publicJwk });
        } else if (packet.type === 'cancel-match') {
          clearUserQueues(user.id);
          ws.queueMode = null;
          sendWs(ws, 'search-cancelled', {});
        } else if (packet.type === 'leave-match') {
          if (packet.matchId) {
            adjudicateMatchForfeit(
              String(packet.matchId),
              user.id,
              'player-left-match',
              'Đối thủ đã thoát khỏi bàn đấu — Bạn được xử thắng kỹ thuật ngay lập tức!',
              'Bạn đã rời bàn khi trận đấu chưa kết thúc và bị xử thua kỹ thuật.'
            );
          }
        } else if (packet.type === 'bot-setup-failed' || packet.type === 'bot-fault') {
          if (packet.matchId) {
            adjudicateMatchForfeit(
              String(packet.matchId),
              user.id,
              'bot-fault',
              'Bot của đối thủ gặp lỗi thực thi hoặc quá thời gian (TLE) — Bạn được xử thắng kỹ thuật ngay lập tức!',
              `Bot của bạn gặp lỗi (${String(packet.message || 'Runtime/TLE').slice(0, 80)}) nên bị xử thua kỹ thuật.`
            );
          }
        } else if (packet.type === 'session-key') {
          const match = db.matches.find((m) => m.id === packet.matchId && m.status === 'active');
          if (!match || (match.player1_id !== user.id && match.player2_id !== user.id)) {
            sendWs(ws, 'error', { message: 'Không tìm thấy trận đấu đang diễn ra.' });
            return;
          }
          const key = packet.publicKey;
          if (
            !key ||
            key.kty !== 'EC' ||
            key.crv !== 'P-256' ||
            typeof key.x !== 'string' ||
            typeof key.y !== 'string'
          ) {
            sendWs(ws, 'error', { message: 'Khóa phiên phải là khóa ECDSA P-256 hợp lệ.' });
            return;
          }
          if (match.player1_id === user.id) match.player1_key = key;
          else if (match.player2_id === user.id) match.player2_key = key;
          saveDb();
          sendWs(ws, 'session-key-accepted', { matchId: match.id });
          const peerId = match.player1_id === user.id ? match.player2_id : match.player1_id;
          const peerWs = liveSockets.get(peerId);
          if (peerWs && peerWs.readyState === WebSocket.OPEN) {
            sendWs(peerWs, 'peer-session-key', {
              matchId: match.id,
              playerId: user.id,
              publicKey: key,
            });
          }
          // If opponent key is already registered in this match, immediately deliver it to this player
          const existingPeerKey = match.player1_id === user.id ? match.player2_key : match.player1_key;
          if (existingPeerKey) {
            sendWs(ws, 'peer-session-key', {
              matchId: match.id,
              playerId: peerId,
              publicKey: existingPeerKey,
            });
          }
        } else if (packet.type === 'signal' || packet.type === 'match-relay') {
          const match = db.matches.find((m) => m.id === packet.matchId && m.status === 'active');
          if (!match || (match.player1_id !== user.id && match.player2_id !== user.id)) return;

          const senderSeat: 1 | 2 = match.player1_id === user.id ? 1 : 2;
          const senderKey = senderSeat === 1 ? match.player1_key : match.player2_key;

          if (packet.type === 'match-relay' && packet.payload && typeof packet.payload === 'object') {
            const p = packet.payload;
            // Verify ECDSA signature on signed consensus messages immediately at relay
            if (['CONSENSUS_COMMIT', 'CONSENSUS_REVEAL', 'CONSENSUS_ACK'].includes(p.type)) {
              const att = p.attestation;
              if (
                !att?.payload ||
                att.payload.player !== senderSeat ||
                (senderKey && !verifySessionProof(senderKey, att.payload, att.signature))
              ) {
                adjudicateMatchForfeit(
                  match.id,
                  user.id,
                  'invalid-relay-signature',
                  'Phát hiện đối thủ gửi gói đồng thuận giả mạo chữ ký — Bạn được xử thắng kỹ thuật ngay lập tức!',
                  'Gói đồng thuận của bạn có chữ ký P-256 không hợp lệ nên bị xử thua kỹ thuật.'
                );
                return;
              }
            } else if (p.type === 'FINAL_PROOF') {
              if (
                p.seat !== senderSeat ||
                !p.proof ||
                (senderKey && !verifySessionProof(senderKey, p.proof, p.signature))
              ) {
                adjudicateMatchForfeit(
                  match.id,
                  user.id,
                  'invalid-final-signature',
                  'Phát hiện đối thủ gửi chữ ký kết thúc ván không hợp lệ — Bạn được xử thắng kỹ thuật ngay lập tức!',
                  'Chữ ký kết thúc ván của bạn không hợp lệ nên bị xử thua kỹ thuật.'
                );
                return;
              }
            }

            // Update server consensus progress tracker for stall/withheld-ACK detection
            const cs = match.consensus_state || createInitialConsensusState(match.match_type);
            const now = Date.now();
            let ackReceipt: { matchId: string; stepCount: number; stateHash: string } | null = null;
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
            match.consensus_state = cs;
            if (ackReceipt) sendWs(ws, 'consensus-ack-received', ackReceipt);
          }

          const spar = sparringSessions.get(match.id);
          if (spar && packet.type === 'match-relay') {
            await handleSparringRelay(spar, ws, packet.payload);
            return;
          }

          const peerId = match.player1_id === user.id ? match.player2_id : match.player1_id;
          const peerSocket = liveSockets.get(peerId);
          if (!peerSocket || peerSocket.readyState !== WebSocket.OPEN) {
            sendWs(ws, 'peer-offline', { matchId: match.id });
            return;
          }
          sendWs(peerSocket, packet.type, {
            matchId: match.id,
            from: user.id,
            payload: packet.payload,
          });
        } else if (packet.type === 'ping') {
          sendWs(ws, 'pong', { at: Date.now() });
        }
      } catch (err: any) {
        sendWs(ws, 'error', { message: err.message || 'Lỗi xử lý WebSocket.' });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!ws.userId) return;
      if (liveSockets.get(ws.userId) !== ws) return;

      clearUserQueues(ws.userId);
      liveSockets.delete(ws.userId);

      // Mark any active non-sparring match as disconnected so the 5s forfeit timer starts
      let marked = false;
      for (const m of db.matches) {
        if (
          m.status === 'active' &&
          !m.is_sparring &&
          (m.player1_id === ws.userId || m.player2_id === ws.userId)
        ) {
          if (!m.disconnected_player_id) {
            m.disconnected_player_id = ws.userId;
            m.disconnected_at = new Date().toISOString();
            marked = true;
          }
          const peerId = m.player1_id === ws.userId ? m.player2_id : m.player1_id;
          sendWs(liveSockets.get(peerId), 'peer-disconnected', {
            matchId: m.id,
            disconnectedPlayerId: ws.userId,
          });
        }
      }
      if (marked) saveDb();
    });
  });

  let localRunnerBusy = false;
  let localRunnerStopped = false;
  async function runLocalGroupFixture() {
    if (localRunnerBusy || localRunnerStopped) return;
    localRunnerBusy = true;
    try {
      for (const match of db.matches.filter(m => m.execution_mode === 'server' && m.status === 'pending')) {
        match.status = 'abandoned';
        const fixture = db.tournamentFixtures.find(f => f.match_id === match.id);
        if (fixture?.status === 'active') { fixture.status = 'pending'; fixture.match_id = null; }
      }
      const fixture = db.tournamentFixtures.filter(f => f.status === 'pending')
        .sort((a, b) => a.round_number - b.round_number || a.match_number - b.match_number)
        .find(f => db.tournaments.some(t => t.id === f.tournament_id && t.execution_mode === 'server' &&
          t.status === (f.phase === 'group' ? 'group_running' : 'knockout') && (f.phase === 'group' || Boolean(t.knockout_started_at))));
      if (!fixture) return;
      const tournament = db.tournaments.find(t => t.id === fixture.tournament_id)!;
      const reversed = fixture.phase === 'knockout' && fixture.next_first_player_id === fixture.player2_id;
      const first = db.users.find(u => u.id === (reversed ? fixture.player2_id : fixture.player1_id))!;
      const second = db.users.find(u => u.id === (reversed ? fixture.player1_id : fixture.player2_id))!;
      const rules = fixture.phase === 'knockout' ? tournament.knockout_rules_json || tournament.rules_json : tournament.rules_json;
      const entry1 = db.tournamentEntries.find(e => e.tournament_id === tournament.id && e.player_id === first.id)!;
      const entry2 = db.tournamentEntries.find(e => e.tournament_id === tournament.id && e.player_id === second.id)!;
      const match: MatchRecord = { id: randomUUID(), seed: randomInt(1, 0x7fffffff),
        player1_id: first.id, player2_id: second.id, match_type: 'bot', status: 'pending', execution_mode: 'server',
        tournament_id: tournament.id, tournament_phase: fixture.phase, tournament_rules: rules,
        tournament_fixture_id: fixture.id, player1_bot_version: entry1.bot_version, player2_bot_version: entry2.bot_version,
        player1_bot_code: entry1.bot_code_snapshot, player2_bot_code: entry2.bot_code_snapshot,
        player1_key: null, player2_key: null, winner_id: null, final_state_hash: null, replay_sha256: null,
        replay_json: null, player1_proof: null, player2_proof: null, created_at: new Date().toISOString(), completed_at: null };
      fixture.status = 'active'; fixture.match_id = match.id; db.matches.push(match); saveDb();
      const result = await playServerBotMatch({ matchId: match.id, seed: match.seed, rules,
        codes: [entry1.bot_code_snapshot, entry2.bot_code_snapshot] });
      if (localRunnerStopped || tournament.status !== (fixture.phase === 'group' ? 'group_running' : 'knockout')) return;
      const score1 = result.winner === 1 ? 1 : result.winner === 2 ? 0 : 0.5;
      const before1 = first.elo, before2 = second.elo;
      const after1 = calculateElo(before1, before2, score1), after2 = calculateElo(before2, before1, 1 - score1);
      first.elo = after1; second.elo = after2;
      recordEloPeak(first, after1); recordEloPeak(second, after2);
      applyTournamentScoreForMatch(match, score1);
      match.status = 'completed'; match.winner_id = result.winner === 1 ? first.id : result.winner === 2 ? second.id : null;
      match.final_step_count = result.moveCount; match.final_state_hash = result.finalHash; match.replay_json = result.replay;
      match.replay_sha256 = createHash('sha256').update(JSON.stringify(result.replay)).digest('hex');
      match.completed_at = new Date().toISOString();
      db.matchResults.push({ match_id: match.id, player1_elo_before: before1, player2_elo_before: before2,
        player1_elo_after: after1, player2_elo_after: after2, result_player1: score1, created_at: match.completed_at });
      completeTournamentFixture(match, match.winner_id, result.moveCount); saveDb();
    } catch (error) { console.error('Local tournament runner failed:', error); }
    finally { localRunnerBusy = false; }
  }
  const localRunnerTimer = setInterval(() => void runLocalGroupFixture(), 1000);
  localRunnerTimer.unref();

  const disconnectSweepTimer = setInterval(() => {
    try {
      processDisconnectedMatches();
    } catch (err) {
      console.error('Disconnect sweep error:', err);
    }
  }, sweepIntervalMs);
  disconnectSweepTimer.unref();

  const lifecycleSweepTimer = setInterval(() => {
    try {
      updateTournamentLifecycle();
    } catch (err) {
      console.error('Tournament lifecycle sweep error:', err);
    }
  }, 30000);
  lifecycleSweepTimer.unref();

  // ── Vite Middleware (Dev) or Static Serve (Prod) ──────────────
  if (!options.skipVite && process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (!options.skipVite) {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  await new Promise<void>((resolve) => {
    httpServer.listen(port, '0.0.0.0', () => {
      const addr = httpServer.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      if (process.env.OTTV2_SKIP_AUTOSTART !== '1') {
        console.log(`OTTv2 Full-Stack Server listening on http://0.0.0.0:${boundPort}`);
      }
      resolve();
    });
  });

  const close = async () => {
    localRunnerStopped = true;
    clearInterval(localRunnerTimer);
    clearInterval(disconnectSweepTimer);
    clearInterval(lifecycleSweepTimer);
    for (const spar of sparringSessions.values()) spar.destroyed = true;
    sparringSessions.clear();
    for (const client of wss.clients) client.close(1001, 'Server closing');
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { app, httpServer, wss, close };
}

if (process.env.OTTV2_SKIP_AUTOSTART !== '1') {
  startServer().catch((err) => {
    console.error('Failed to start OTTv2 server:', err);
    process.exit(1);
  });
}
