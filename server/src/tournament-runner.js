import { randomUUID, randomInt, createHash } from 'node:crypto';
import { playServerBotMatch } from './server-bot-match.js';
import { calculateElo } from './elo.js';
import { preparePythonRuntime } from './python-bot.js';

export async function startServerGroupStage(client, tournamentId) {
  const found = await client.query("SELECT * FROM tournaments WHERE id=$1 AND format='group_knockout' FOR UPDATE", [tournamentId]);
  const tournament = found.rows[0];
  if (!tournament || !(tournament.status === 'group_stage' ||
      (tournament.status === 'group_running' && tournament.execution_mode === 'browser'))) {
    throw Object.assign(new Error('Giải chưa sẵn sàng khởi chạy vòng bảng.'), { status: 409 });
  }
  if ((await client.query("SELECT 1 FROM tournament_fixtures WHERE tournament_id=$1 AND phase='group' AND status<>'pending' LIMIT 1", [tournamentId])).rowCount) {
    throw Object.assign(new Error('Vòng bảng đã có trận đang chạy hoặc hoàn tất; không thể khởi chạy lại.'), { status: 409 });
  }
  const field = await client.query(`SELECT e.player_id,u.active_bot_version,b.code,b.code_sha256
    FROM tournament_entries e JOIN users u ON u.id=e.player_id
    LEFT JOIN user_bot_versions b ON b.user_id=u.id AND b.version=u.active_bot_version
    WHERE e.tournament_id=$1 ORDER BY e.player_id FOR UPDATE OF e,u`, [tournamentId]);
  if (!field.rows.length || field.rows.some(row => !row.code?.trim())) {
    throw Object.assign(new Error('Mỗi đấu thủ phải lưu Bot Python trước khi khởi chạy vòng bảng.'), { status: 409 });
  }
  const fixtures = await client.query("SELECT 1 FROM tournament_fixtures WHERE tournament_id=$1 AND phase='group' LIMIT 1", [tournamentId]);
  if (!fixtures.rowCount) throw Object.assign(new Error('Giải chưa có lịch vòng bảng.'), { status: 409 });
  for (const row of field.rows) {
    await client.query(`UPDATE tournament_entries SET bot_version=$3,bot_code_snapshot=$4,bot_sha256_snapshot=$5
      WHERE tournament_id=$1 AND player_id=$2`, [tournamentId, row.player_id, row.active_bot_version, row.code, row.code_sha256]);
  }
  return (await client.query(`UPDATE tournaments SET status='group_running',tournament_starts_at=now(),execution_mode='server'
    WHERE id=$1 RETURNING *`, [tournamentId])).rows[0];
}

// A database session lock owns the running fixture. A restarted instance can
// recover an interrupted match only after its previous owner has disconnected.
export function createTournamentRunner({ pool, completeFixture, updateEntries, fideK = 20, play = playServerBotMatch, onError = console.error }) {
  let busy = false, stopping = false, timer;
  async function tick() {
    if (busy || stopping) return;
    busy = true;
    let client, ownsLock = false, fixture, match;
    try {
      client = await pool.connect();
      ownsLock = (await client.query("SELECT pg_try_advisory_lock(80261029, 1) AS locked")).rows[0].locked;
      if (!ownsLock) return;
      await client.query('BEGIN');
      // No other server runner can be active while this session owns the lock.
      await client.query(`UPDATE tournament_fixtures f SET status='pending',match_id=NULL
        FROM matches m,tournaments t WHERE f.match_id=m.id AND f.tournament_id=t.id
          AND t.execution_mode='server' AND t.status IN ('group_running','knockout')
          AND m.execution_mode='server' AND f.status='active'
          AND m.status='pending'`);
      await client.query(`UPDATE matches m SET status='abandoned',completed_at=now()
        WHERE m.execution_mode='server' AND m.status='pending'
        AND NOT EXISTS(SELECT 1 FROM tournament_fixtures f WHERE f.match_id=m.id)`);
      const next = await client.query(`SELECT f.*,
          CASE WHEN f.phase='knockout' THEN COALESCE(t.knockout_rules_json,t.rules_json) ELSE t.rules_json END AS rules_json,
          e1.bot_code_snapshot AS code1,e2.bot_code_snapshot AS code2,
          e1.bot_version AS version1,e2.bot_version AS version2
        FROM tournament_fixtures f JOIN tournaments t ON t.id=f.tournament_id
        JOIN tournament_entries e1 ON e1.tournament_id=t.id AND e1.player_id=f.player1_id
        JOIN tournament_entries e2 ON e2.tournament_id=t.id AND e2.player_id=f.player2_id
        WHERE t.execution_mode='server' AND ((t.status='group_running' AND f.phase='group' AND t.ends_at>now())
          OR (t.status='knockout' AND f.phase='knockout' AND t.knockout_started_at IS NOT NULL)) AND f.status='pending'
        ORDER BY f.round_number,f.match_number,f.leg LIMIT 1 FOR UPDATE OF f,t`);
      fixture = next.rows[0];
      if (!fixture) { await client.query('COMMIT'); return; }
      await preparePythonRuntime();
      if (!fixture.code1 || !fixture.code2) throw new Error('Missing locked bot code');
      const reverse = fixture.phase === 'knockout' && fixture.next_first_player_id === fixture.player2_id;
      const first = reverse ? fixture.player2_id : fixture.player1_id;
      const second = reverse ? fixture.player1_id : fixture.player2_id;
      const codes = reverse ? [fixture.code2, fixture.code1] : [fixture.code1, fixture.code2];
      const id = randomUUID(), seed = randomInt(1, 0x7fffffff);
      match = (await client.query(`INSERT INTO matches(id,seed,player1_id,player2_id,status,match_type,
        tournament_id,tournament_phase,tournament_rules,tournament_fixture_id,execution_mode,
        player1_bot_version,player2_bot_version,player1_bot_code,player2_bot_code)
        VALUES($1,$2,$3,$4,'pending','bot',$5,$12,$6::jsonb,$7,'server',$8,$9,$10,$11) RETURNING *`,
      [id, seed, first, second, fixture.tournament_id, JSON.stringify(fixture.rules_json),
        fixture.id, reverse ? fixture.version2 : fixture.version1, reverse ? fixture.version1 : fixture.version2,
        ...codes, fixture.phase])).rows[0];
      await client.query("UPDATE tournament_fixtures SET status='active',match_id=$2 WHERE id=$1", [fixture.id, id]);
      await client.query('COMMIT');
      const result = await play({ matchId: id, seed, rules: fixture.rules_json, codes });
      await client.query('BEGIN');
      const current = (await client.query('SELECT status FROM tournaments WHERE id=$1 FOR UPDATE', [fixture.tournament_id])).rows[0];
      if (current?.status !== (fixture.phase === 'group' ? 'group_running' : 'knockout') || stopping) {
        await client.query("UPDATE matches SET status='abandoned',completed_at=now() WHERE id=$1", [id]);
        await client.query("UPDATE tournament_fixtures SET status='pending',match_id=NULL WHERE id=$1 AND status='active'", [fixture.id]);
        await client.query('COMMIT'); return;
      }
      const score1 = result.winner === 1 ? 1 : result.winner === 2 ? 0 : 0.5;
      const users = (await client.query('SELECT id,elo FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [[match.player1_id, match.player2_id]])).rows;
      const user1 = users.find(u => u.id === match.player1_id), user2 = users.find(u => u.id === match.player2_id);
      const elo1 = calculateElo(user1.elo, user2.elo, score1, fideK);
      const elo2 = calculateElo(user2.elo, user1.elo, 1 - score1, fideK);
      await client.query('UPDATE users SET elo=$2 WHERE id=$1', [user1.id, elo1]);
      await client.query('UPDATE users SET elo=$2 WHERE id=$1', [user2.id, elo2]);
      await client.query(`INSERT INTO match_results(match_id,player1_elo_before,player2_elo_before,player1_elo_after,player2_elo_after,result_player1)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, user1.elo, user2.elo, elo1, elo2, score1]);
      await updateEntries(client, match, score1);
      await completeFixture(client, match, score1, result.moveCount);
      const replayJson = JSON.stringify(result.replay);
      await client.query(`UPDATE matches SET status='completed',winner_id=$2,final_step_count=$3,
        final_state_hash=$4,replay_json=$5::jsonb,replay_sha256=$6,completed_at=now() WHERE id=$1`,
      [id, result.winner === 1 ? user1.id : result.winner === 2 ? user2.id : null, result.moveCount,
        result.finalHash, replayJson, createHash('sha256').update(replayJson).digest('hex')]);
      await client.query('COMMIT');
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      onError('Server tournament runner:', error);
      // Leave interrupted pending matches recoverable on the next tick.
    } finally {
      if (ownsLock) await client.query('SELECT pg_advisory_unlock(80261029, 1)').catch(() => {});
      client?.release(); busy = false;
    }
  }
  return {
    start() { timer = setInterval(() => void tick(), 1000); timer.unref(); void tick(); },
    tick,
    async stop() { stopping = true; clearInterval(timer); while (busy) await new Promise(r => setTimeout(r, 50)); },
  };
}
