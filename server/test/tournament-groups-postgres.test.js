import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { organizeTournamentGroups, getTournamentGroupEntries, getTournamentFixturePreview } from '../src/tournament-groups.js';
import { calculateGroupStandings } from '../src/tournament-format.js';

test('Postgres: bulk organize 1,000 entrants, bounded detail, atomic failure and safe retry', {
  skip: !process.env.OTTV2_TEST_DB_URL, timeout: 180000,
}, async t => {
  const schema = 'groups_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.OTTV2_TEST_DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.OTTV2_TEST_DB_URL, options: `-c search_path=${schema},public`, max: 2 });
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    const tournamentId = randomUUID();
    await pool.query(`INSERT INTO tournaments(id,name,format,status,registration_closes_at,ends_at)
      VALUES($1,'Isolated 1000-player test','group_knockout','registration',now()+interval '1 day',now()+interval '30 days')`, [tournamentId]);
    await pool.query(`INSERT INTO users(email,password_hash,display_name)
      SELECT 'bulk-test-'||n||'@example.invalid','test-only','Bot '||n FROM generate_series(1,1000) AS n`);
    await pool.query(`INSERT INTO tournament_entries(tournament_id,player_id)
      SELECT $1,id FROM users WHERE email LIKE 'bulk-test-%'`, [tournamentId]);
    const client = await pool.connect();
    let queries = 0;
    const counted = { query: (...args) => { queries++; return client.query(...args); } };
    let result;
    const start = performance.now();
    try {
      await client.query('BEGIN');
      result = await organizeTournamentGroups(counted, tournamentId, 8);
      await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    const organizeMs = Math.round(performance.now()-start);
    assert.deepEqual(result, { groupCount: 8, fixtureCount: 124000 });
    assert.equal(queries, 17); // lock + entries + bulk assignment + 13 inserts + publish
    assert.deepEqual((await pool.query('SELECT count(*)::int AS n FROM tournament_entries WHERE tournament_id=$1 GROUP BY group_number', [tournamentId])).rows.map(r=>r.n), Array(8).fill(125));
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM (
      SELECT player1_id,player2_id FROM tournament_fixtures WHERE tournament_id=$1
      GROUP BY player1_id,player2_id HAVING count(*)<>1) bad`, [tournamentId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM tournament_fixtures f
      JOIN tournament_entries a ON a.player_id=f.player1_id AND a.tournament_id=f.tournament_id
      JOIN tournament_entries b ON b.player_id=f.player2_id AND b.tournament_id=f.tournament_id
      WHERE f.tournament_id=$1 AND (a.group_number<>b.group_number OR a.group_number<>f.group_number
        OR NOT EXISTS(SELECT 1 FROM tournament_fixtures reverse WHERE reverse.tournament_id=f.tournament_id
          AND reverse.player1_id=f.player2_id AND reverse.player2_id=f.player1_id AND reverse.leg<>f.leg))`, [tournamentId])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM (
      SELECT round_number,player_id FROM (
        SELECT round_number,player1_id AS player_id FROM tournament_fixtures WHERE tournament_id=$1
        UNION ALL SELECT round_number,player2_id FROM tournament_fixtures WHERE tournament_id=$1
      ) sides GROUP BY round_number,player_id HAVING count(*)>1) bad`, [tournamentId])).rows[0].n, 0);
    // A retried HTTP request must preserve the already published draw.
    const before = await pool.query('SELECT player_id,group_number FROM tournament_entries WHERE tournament_id=$1 ORDER BY player_id', [tournamentId]);
    const retry = await pool.connect();
    try { await retry.query('BEGIN'); assert.deepEqual(await organizeTournamentGroups(retry,tournamentId,8),result); await retry.query('COMMIT'); }
    finally { retry.release(); }
    assert.deepEqual((await pool.query('SELECT player_id,group_number FROM tournament_entries WHERE tournament_id=$1 ORDER BY player_id', [tournamentId])).rows,before.rows);
    // Completed results, not the truncated fixture preview, determine ranking.
    await pool.query(`UPDATE tournament_fixtures SET status='completed',winner_id=CASE WHEN match_number%3=0 THEN NULL
      WHEN match_number%3=1 THEN player1_id ELSE player2_id END,move_count=match_number+10
      WHERE tournament_id=$1 AND (match_number<=12 OR match_number IN (105,50001,124000))`, [tournamentId]);
    const finalists = (await pool.query('SELECT player_id FROM tournament_entries WHERE tournament_id=$1 ORDER BY player_id LIMIT 2',[tournamentId])).rows;
    await pool.query(`INSERT INTO tournament_fixtures(tournament_id,phase,round_number,match_number,player1_id,player2_id,status,winner_id,move_count)
      VALUES($1,'knockout',1,1,$2,$3,'completed',$2,9)`,[tournamentId,finalists[0].player_id,finalists[1].player_id]);
    const detailStart = performance.now();
    const ranked = await getTournamentGroupEntries(pool,tournamentId);
    const preview = await getTournamentFixturePreview(pool,tournamentId);
    const detailMs = Math.round(performance.now()-detailStart);
    assert.equal(ranked.length,1000);
    assert.equal(preview.length,101);
    assert.equal(preview.filter(f=>f.phase==='knockout').length,1);
    assert.ok(ranked.every(row => !('password_hash' in row) && !('bot_code_snapshot' in row)));
    const completed = (await pool.query("SELECT * FROM tournament_fixtures WHERE tournament_id=$1 AND status='completed'",[tournamentId])).rows;
    const reference = calculateGroupStandings(ranked,completed);
    const stats = rows => rows.map(r=>[r.player_id,r.points,r.wins,r.draws,r.losses,r.matchesPlayed,r.moveDifference]);
    assert.deepEqual(stats(ranked),stats(reference));
    const bytes = Buffer.byteLength(JSON.stringify({ groups: ranked, fixtures: preview }));
    assert.ok(bytes < 1000000);
    const failedId = randomUUID();
    await pool.query(`INSERT INTO tournaments(id,name,format,status,registration_closes_at,ends_at)
      VALUES($1,'Atomic failure','group_knockout','registration',now(),now()+interval '1 day')`,[failedId]);
    await pool.query('INSERT INTO tournament_entries(tournament_id,player_id) SELECT $1,id FROM users LIMIT 32',[failedId]);
    const failing = await pool.connect();
    try {
      await failing.query('BEGIN');
      await assert.rejects(organizeTournamentGroups({query:(sql,args)=>sql.startsWith('INSERT INTO tournament_fixtures')
        ? Promise.reject(new Error('Injected write failure')) : failing.query(sql,args)}, failedId,8),/Injected write failure/);
      await failing.query('ROLLBACK');
    } finally { failing.release(); }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM tournament_entries WHERE tournament_id=$1 AND group_number IS NOT NULL',[failedId])).rows[0].n,0);
    assert.equal((await pool.query('SELECT status FROM tournaments WHERE id=$1',[failedId])).rows[0].status,'registration');
    t.diagnostic(JSON.stringify({ entrants:1000,fixtures:124000,organizeMs,queries,detailMs,detailBytes:bytes }));
  } finally {
    await pool.end();
    assert.match(schema,/^groups_test_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
