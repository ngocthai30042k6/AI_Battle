import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../server.ts';
import { createToken } from '../src/auth.js';

test('admin starts offline group games through HTTP; no player websocket is connected', { timeout: 45000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ott-offline-api-'));
  const dbPath = path.join(dir, 'db.json');
  const p1 = randomUUID(), p2 = randomUUID(), tournamentId = randomUUID();
  const code = "def get_next_move(p,s):\n return s['validMoves'][0]";
  const users = [p1, p2].map((id, index) => ({ id, email: `bot-${index}@example.invalid`, password_hash: 'test',
    display_name: 'Test '+index, elo: 1200, is_admin: index === 0, active_bot_version: 1 }));
  const original = { users, tournaments: [{ id: tournamentId, name: 'Offline test', format: 'group_knockout',
    status: 'group_stage', registration_closes_at: new Date().toISOString(), ends_at: new Date(Date.now()+86400000).toISOString(),
    max_teams: 64, rules_json: {}, rules_schedule: [], current_week: 0 }],
    tournamentEntries: users.map(u => ({ tournament_id: tournamentId, player_id: u.id, bot_version: 1,
      group_number: 1, matches_played: 0, wins: 0, draws: 0, losses: 0, points: 0, tier: 'Bronze', rank_stars: 0, season_points: 0 })),
    tournamentFixtures: [[p1,p2],[p2,p1]].map(([first, second], i) => ({ id: randomUUID(), tournament_id: tournamentId,
      phase: 'group', group_number: 1, round_number: i+1, match_number: i+1, leg: i+1,
      player1_id: first, player2_id: second, status: 'pending', match_id: null })),
    botVersions: users.map(u => ({ user_id: u.id, version: 1, code, code_sha256: '0'.repeat(64) })),
    matches: [], matchResults: [], matchDisputes: [] };
  fs.writeFileSync(dbPath, JSON.stringify(original));
  const server = await startServer({ port: 0, dbPath, skipVite: true });
  try {
    const base = 'http://127.0.0.1:'+server.httpServer.address().port;
    const token = createToken(users[0], process.env.JWT_SECRET || 'ottv2-local-dev-secret-key-minimum-32-chars');
    const unauth = await fetch(`${base}/api/tournaments/${tournamentId}/start-groups`, { method: 'POST' });
    assert.equal(unauth.status, 401);
    const response = await fetch(`${base}/api/tournaments/${tournamentId}/start-groups`, {
      method: 'POST', headers: { Authorization: 'Bearer '+token },
    });
    assert.equal(response.status, 200);
    const started = await response.json();
    assert.equal(started.tournament.execution_mode, 'server');
    let saved;
    const deadline = Date.now()+35000;
    do {
      await new Promise(r => setTimeout(r, 200));
      saved = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    } while (saved.tournaments[0].status !== 'group_complete' && Date.now()<deadline);
    assert.equal(saved.tournaments[0].status, 'group_complete');
    assert.equal(saved.matchResults.length, 2);
    assert.deepEqual(saved.matches.map(m => [m.player1_id,m.player2_id]), [[p1,p2],[p2,p1]]);
    assert.ok(saved.matches.every(m => m.status === 'completed' && m.replay_json.moves.length > 0));
    const detail = await (await fetch(`${base}/api/tournaments/${tournamentId}`)).json();
    assert.ok(detail.groups.every(group => group.members.every(member => !('bot_code_snapshot' in member))));
    const secondStart = await fetch(`${base}/api/tournaments/${tournamentId}/start-groups`, {
      method: 'POST', headers: { Authorization: 'Bearer '+token },
    });
    assert.equal(secondStart.status, 409);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
