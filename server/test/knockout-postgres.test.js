import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { createTournamentRunner } from '../src/tournament-runner.js';
import { prepareServerKnockout, startServerKnockout, completeServerKnockoutGame } from '../src/knockout-series.js';
import { updateGroupEntryScore } from '../src/group-entry-score.js';
import { registerMatchSessionKey } from '../src/session-key.js';
import { setTournamentPaused } from '../src/tournament-pause.js';

test('Postgres: custom BO3 bracket, loser starts, restart recovery, draws, advancement and champion', {
  skip: !process.env.OTTV2_TEST_DB_URL, timeout: 300000,
}, async () => {
  const schema = 'knockout_test_' + randomUUID().replaceAll('-', '');
  const admin = new Pool({ connectionString: process.env.OTTV2_TEST_DB_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.OTTV2_TEST_DB_URL, options: `-c search_path=${schema},public`, max: 3 });
  let runner;
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
      await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    }
    const tid = randomUUID(), ids = Array.from({ length: 16 }, () => randomUUID());
    await pool.query(`INSERT INTO tournaments(id,name,format,status,registration_closes_at,ends_at,rules_json,group_count)
      VALUES($1,'Isolated BO3 test','group_knockout','group_complete',now(),now()+interval '1 day',$2,8)`, [tid,{ blockedCells: [],moveLimitRule:'standard' }]);
    const code = 'def get_next_move(p,s): return s["validMoves"][0]';
    for (let i = 0; i < ids.length; i++) {
      await pool.query("INSERT INTO users(id,email,password_hash,display_name,active_bot_version) VALUES($1,$2,$3,'Test',1)", [ids[i],ids[i]+'@example.invalid','test']);
      await pool.query('INSERT INTO user_bot_versions(user_id,version,code,code_sha256) VALUES($1,1,$2,$3)', [ids[i],code,'0'.repeat(64)]);
      await pool.query(`INSERT INTO tournament_entries(tournament_id,player_id,bot_version,group_number,bot_code_snapshot)
        VALUES($1,$2,1,$3,$4)`, [tid,ids[i],Math.floor(i/2)+1,code]);
    }
    for (let i = 0; i < 8; i++) await pool.query(`INSERT INTO tournament_fixtures(tournament_id,phase,group_number,round_number,match_number,
      player1_id,player2_id,winner_id,status) VALUES($1,'group',$2,1,1,$3,$4,$3,'completed')`,[tid,i+1,ids[2*i],ids[2*i+1]]);
    const pairings = Array.from({ length: 8 },(_,i) => [ids[i],ids[15-i]]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assert.rejects(prepareServerKnockout(client,tid,{ pairings:[...pairings.slice(1),pairings[1]] }), /đúng một lần/);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      const start = await prepareServerKnockout(client,tid,{ pairings,blockedCells:[1,9],moveLimitRule:'remaining-pieces',knockoutStartsAt:new Date(Date.now()+3600000).toISOString() });
      assert.equal(start.fixtureCount,8);
      await client.query('COMMIT');
      await client.query('BEGIN');
      await assert.rejects(startServerKnockout(client,tid), /Chưa đến giờ/);
      await client.query('ROLLBACK');
      const idleErrors=[];
      const idle=createTournamentRunner({pool,lockKey:randomInt(2,2147483647),updateEntries:async()=>{},completeFixture:async()=>{},onError:(...e)=>idleErrors.push(e),play:async()=>{throw new Error('Started before admin');}});
      await idle.tick(); await idle.stop(); assert.deepEqual(idleErrors,[]);
      assert.equal((await client.query('SELECT count(*)::int AS n FROM matches')).rows[0].n,0);
      // A second bot edit after groups but before launch is the code to freeze.
      const revised=code+' # second submission';
      await client.query('UPDATE user_bot_versions SET code=$1',[revised]);
      await client.query("UPDATE tournaments SET knockout_starts_at=now()-interval '1 second' WHERE id=$1",[tid]);
      await client.query('BEGIN'); await startServerKnockout(client,tid); await client.query('COMMIT');
      await client.query('BEGIN'); await assert.rejects(startServerKnockout(client,tid),/khởi chạy lại/); await client.query('ROLLBACK');
    } finally { client.release(); }
    const opening = (await pool.query("SELECT * FROM tournament_fixtures WHERE phase='knockout' ORDER BY match_number")).rows;
    assert.deepEqual(opening.map(f => [f.player1_id,f.player2_id]),pairings);
    const interrupted = randomUUID();
    // The first player's random choice must survive a restart before game one.
    await pool.query(`INSERT INTO matches(id,seed,player1_id,player2_id,tournament_id,tournament_fixture_id,status,execution_mode)
      VALUES($1,1,$2,$3,$4,$5,'pending','server')`,[interrupted,opening[0].next_first_player_id,
      opening[0].next_first_player_id===ids[0]?ids[15]:ids[0],tid,opening[0].id]);
    await pool.query("UPDATE tournament_fixtures SET status='active',match_id=$2 WHERE id=$1",[opening[0].id,interrupted]);
    const key1={kty:'EC',crv:'P-256',x:'first-x',y:'first-y'},key2={kty:'EC',crv:'P-256',x:'second-x',y:'second-y'};
    const sent=[],deliver=async(id,type,data)=>sent.push({id,type,data});
    await registerMatchSessionKey(pool,ids[0],{matchId:interrupted,publicKey:key1},deliver);
    await registerMatchSessionKey(pool,ids[15],{matchId:interrupted,publicKey:key2},deliver);
    assert.equal(sent.length,3);
    assert.deepEqual(sent.find(e=>e.id===ids[0] && e.data.playerId===ids[15]).data.publicKey,key2);
    assert.deepEqual(sent.find(e=>e.id===ids[15] && e.data.playerId===ids[0]).data.publicKey,key1);
    await pool.query("UPDATE user_bot_versions SET code='raise RuntimeError()'");
    const played = [],errors = [];
    const pause = async paused => {
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await setTournamentPaused(db,tid,paused);
        await db.query('COMMIT');
      } catch(error) {await db.query('ROLLBACK'); throw error;}
      finally {db.release();}
    };
    const options = { pool, lockKey:randomInt(2,2147483647), onError:(...args)=>errors.push(args), updateEntries:updateGroupEntryScore,
      play:async game => {
        const match = (await pool.query('SELECT * FROM matches WHERE id=$1',[game.matchId])).rows[0];
        const fixture = (await pool.query('SELECT * FROM tournament_fixtures WHERE id=$1',[match.tournament_fixture_id])).rows[0];
        assert.deepEqual(game.codes,[code+' # second submission',code+' # second submission']);
        assert.deepEqual(game.rules.blockedCells,[1,9]); assert.equal(game.rules.moveLimitRule,'remaining-pieces');
        assert.equal(match.player1_id,fixture.next_first_player_id);
        let winner = fixture.player1_id;
        if (fixture.id===opening[0].id && fixture.games_played===1) winner=fixture.player2_id;
        if (fixture.id===opening[1].id) winner=fixture.games_played<4?null:fixture.player2_id;
        played.push({ fixture:fixture.id,first:match.player1_id,winner });
        if (played.length === 1) await pause(true);
        return { winner:winner===null?0:winner===match.player1_id?1:2,moveCount:25,finalHash:'test',
          replay:{ format:'test',result:{winner} } };
      },
      completeFixture:async(db,match,score,moves)=>{
        const f=(await db.query('SELECT * FROM tournament_fixtures WHERE id=$1 FOR UPDATE',[match.tournament_fixture_id])).rows[0];
        await completeServerKnockoutGame(db,f,match,score===1?match.player1_id:score===0?match.player2_id:null,moves);
      },
    };
    runner=createTournamentRunner(options);
    await runner.tick(); await runner.stop(); // Restart after a committed score.
    runner=createTournamentRunner(options);
    await runner.tick();
    assert.equal(played.length,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM match_results')).rows[0].n,1);
    await pause(false);
    for(let i=0;i<45;i++) {
      await Promise.all([runner.tick(),runner.tick()]);
      if((await pool.query('SELECT status FROM tournaments WHERE id=$1',[tid])).rows[0].status==='completed') break;
    }
    assert.deepEqual(errors,[]);
    const all=(await pool.query("SELECT * FROM tournament_fixtures WHERE phase='knockout' ORDER BY round_number,match_number")).rows;
    assert.equal(all.length,15); assert.ok(all.every(f=>f.status==='completed' && f.winner_id));
    assert.deepEqual([Number(all[0].player1_score),Number(all[0].player2_score)],[2,1]);
    assert.deepEqual([Number(all[1].player1_score),Number(all[1].player2_score)],[2,3]);
    assert.equal(all[1].games_played,5);
    assert.ok(all.slice(2).every(f=>Number(f.player1_score)===2 && Number(f.player2_score)===0));
    assert.equal(played.length,34);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM match_results')).rows[0].n,34);
    assert.equal((await pool.query('SELECT sum(draws)::int AS n FROM tournament_entries')).rows[0].n,8);
    assert.equal((await pool.query('SELECT status FROM matches WHERE id=$1',[interrupted])).rows[0].status,'abandoned');
    for(const fixture of all) {
      const games=played.filter(g=>g.fixture===fixture.id);
      for(let i=1;i<games.length;i++) {
        const prev=games[i-1];
        const expected=prev.winner ? (prev.winner===fixture.player1_id?fixture.player2_id:fixture.player1_id)
          : (prev.first===fixture.player1_id?fixture.player2_id:fixture.player1_id);
        assert.equal(games[i].first,expected);
      }
    }
    await runner.tick(); assert.equal(played.length,34);
    const t=(await pool.query('SELECT * FROM tournaments WHERE id=$1',[tid])).rows[0];
    assert.equal(t.status,'completed'); assert.deepEqual(t.rules_json.blockedCells,[]);
    // Repeat migrations without changing the finished bracket or its scores.
    for (const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file,migrations),'utf8'));
    assert.equal((await pool.query('SELECT status FROM tournaments WHERE id=$1',[tid])).rows[0].status,'completed');
  } finally {
    await runner?.stop(); await pool.end();
    assert.match(schema,/^knockout_test_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
