import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { startServerGroupStage, createTournamentRunner } from '../src/tournament-runner.js';
import { playServerBotMatch } from '../src/server-bot-match.js';

test('Postgres: snapshot bots, run both seats offline, recover restart and commit results once', {
  skip: !process.env.OTTV2_TEST_DB_URL, timeout: 90000,
}, async () => {
  const schema = 'runner_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.OTTV2_TEST_DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.OTTV2_TEST_DB_URL,
    options: `-c search_path=${schema},public`, max: 3 });
  let runner;
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    const tournamentId = randomUUID(), p1 = randomUUID(), p2 = randomUUID(), fixture1 = randomUUID(), fixture2 = randomUUID();
    const code = "def get_next_move(player,state):\n return state['validMoves'][0]";
    for (const id of [p1, p2]) {
      await pool.query('INSERT INTO users(id,email,password_hash,display_name,active_bot_version) VALUES($1,$2,$3,$4,1)', [id, id+'@example.invalid', 'test-only', id]);
      await pool.query('INSERT INTO user_bot_versions(user_id,version,code,code_sha256) VALUES($1,1,$2,$3)', [id, code, '0'.repeat(64)]);
    }
    await pool.query(`INSERT INTO tournaments(id,name,format,status,registration_closes_at,ends_at)
      VALUES($1,'Isolated runner test','group_knockout','group_stage',now(),now()+interval '1 day')`, [tournamentId]);
    for (const id of [p1, p2]) await pool.query('INSERT INTO tournament_entries(tournament_id,player_id,bot_version,group_number) VALUES($1,$2,1,1)', [tournamentId, id]);
    for (const [id, first, second, leg] of [[fixture1, p1, p2, 1], [fixture2, p2, p1, 2]]) {
      await pool.query(`INSERT INTO tournament_fixtures(id,tournament_id,phase,group_number,round_number,match_number,leg,player1_id,player2_id)
        VALUES($1,$2,'group',1,$3,$3,$3,$4,$5)`, [id, tournamentId, leg, first, second]);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await startServerGroupStage(client, tournamentId);
      await client.query('COMMIT');
    } finally { client.release(); }
    // Later edits must not change the code already locked for this tournament.
    await pool.query('UPDATE user_bot_versions SET code=$1', ['raise RuntimeError("edited after start")']);
    const oldMatch = randomUUID();
    await pool.query(`INSERT INTO matches(id,seed,player1_id,player2_id,status,tournament_id,tournament_fixture_id,execution_mode)
      VALUES($1,1,$2,$3,'pending',$4,$5,'server')`, [oldMatch, p1, p2, tournamentId, fixture1]);
    await pool.query("UPDATE tournament_fixtures SET status='active',match_id=$2 WHERE id=$1", [fixture1, oldMatch]);
    const played = [];
    const errors = [];
    runner = createTournamentRunner({ pool, onError: (...args) => errors.push(args),
      play: async game => {
        assert.deepEqual(game.codes, [code, code]);
        played.push(game);
        return playServerBotMatch({ ...game, maxPlies: 4 });
      },
      updateEntries: async (db, match, score) => {
        for (const [id, s] of [[match.player1_id, score], [match.player2_id, 1-score]]) {
          await db.query(`UPDATE tournament_entries SET matches_played=matches_played+1,
            points=points+$3,draws=draws+1 WHERE tournament_id=$1 AND player_id=$2`, [match.tournament_id, id, s === 0.5 ? 1 : s === 1 ? 3 : 0]);
        }
      },
      completeFixture: async (db, match, score, moves) => {
        await db.query("UPDATE tournament_fixtures SET status='completed',move_count=$2 WHERE id=$1", [match.tournament_fixture_id, moves]);
        await db.query(`UPDATE tournaments SET status='group_complete' WHERE id=$1 AND NOT EXISTS(
          SELECT 1 FROM tournament_fixtures WHERE tournament_id=$1 AND status<>'completed')`, [match.tournament_id]);
      },
    });
    // Concurrent calls within one server must not claim the same fixture twice.
    await Promise.all([runner.tick(), runner.tick()]);
    // A started runner drains its queue without waiting for another manual tick.
    runner.start();
    const deadline=Date.now()+30000;
    while ((await pool.query('SELECT status FROM tournaments WHERE id=$1',[tournamentId])).rows[0].status!=='group_complete' && Date.now()<deadline) {
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    await runner.stop();
    await runner.tick();
    assert.deepEqual(errors, []);
    assert.equal(played.length, 2);
    const results = (await pool.query("SELECT player1_id,player2_id,status,replay_json FROM matches WHERE status='completed' ORDER BY created_at")).rows;
    assert.deepEqual(results.map(m => [m.player1_id,m.player2_id]), [[p1,p2],[p2,p1]]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM match_results')).rows[0].n, 2);
    assert.equal((await pool.query('SELECT status FROM matches WHERE id=$1', [oldMatch])).rows[0].status, 'abandoned');
    assert.equal((await pool.query('SELECT status FROM tournaments WHERE id=$1', [tournamentId])).rows[0].status, 'group_complete');
    assert.ok(results.every(m => m.replay_json.moves.length > 0));
    assert.deepEqual((await pool.query('SELECT matches_played,points FROM tournament_entries')).rows,
      [{ matches_played: 2, points: 2 }, { matches_played: 2, points: 2 }]);
    // Repeat startup migrations: formats, phases and results must survive.
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    assert.equal((await pool.query('SELECT format,status FROM tournaments WHERE id=$1', [tournamentId])).rows[0].format, 'group_knockout');
  } finally {
    await runner?.stop(); await pool.end();
    assert.match(schema, /^runner_test_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
