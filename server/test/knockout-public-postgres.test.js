import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { getKnockoutNotices, getPublicKnockoutMatches, getReplayForViewer } from '../src/knockout-public.js';

test('Postgres: public knockout games, private replays and qualification notices use real schema', {
  skip: !process.env.OTTV2_TEST_DB_URL, timeout:90000,
},async()=>{
  const schema='ko_public_test_'+randomUUID().replaceAll('-','');
  const admin=new Pool({connectionString:process.env.OTTV2_TEST_DB_URL});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool=new Pool({connectionString:process.env.OTTV2_TEST_DB_URL,options:`-c search_path=${schema},public`,max:3});
  try {
    const migrations=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file,migrations),'utf8'));
    const users=Array.from({length:3},()=>randomUUID()),tid=randomUUID(),ko=randomUUID(),group=randomUUID();
    for(const id of users) await pool.query('INSERT INTO users(id,email,password_hash,display_name) VALUES($1,$2,$3,$4)',[id,id+'@example.invalid','test','Player '+id]);
    await pool.query(`INSERT INTO tournaments(id,name,format,status,registration_closes_at,ends_at)
      VALUES($1,'Public test','group_knockout','group_complete',now(),now()+interval '1 day')`,[tid]);
    for(const id of users) await pool.query('INSERT INTO tournament_entries(tournament_id,player_id,group_number) VALUES($1,$2,1)',[tid,id]);
    await pool.query(`INSERT INTO tournament_fixtures(id,tournament_id,phase,group_number,round_number,match_number,player1_id,player2_id,status,winner_id,move_count)
      VALUES($1,$2,'group',1,1,1,$3,$4,'completed',$3,12)`,[group,tid,users[0],users[1]]);
    const eliminated=users[2];
    // Give the second player a win too; the third player remains outside top two.
    await pool.query(`INSERT INTO tournament_fixtures(tournament_id,phase,group_number,round_number,match_number,player1_id,player2_id,status,winner_id,move_count)
      VALUES($1,'group',1,2,2,$2,$3,'completed',$2,12)`,[tid,users[1],eliminated]);
    assert.deepEqual((await getKnockoutNotices(pool,users[0])).map(n=>n.id),[tid]);
    assert.deepEqual(await getKnockoutNotices(pool,eliminated),[]);
    await pool.query(`INSERT INTO tournament_fixtures(id,tournament_id,phase,round_number,match_number,player1_id,player2_id)
      VALUES($1,$2,'knockout',1,1,$3,$4)`,[ko,tid,users[0],users[1]]);
    await pool.query("UPDATE tournaments SET status='knockout' WHERE id=$1",[tid]);
    const games=[];
    for(const [fixture,phase] of [[ko,'knockout'],[ko,'knockout'],[group,'group'],[null,null]]) {
      const id=randomUUID();games.push(id);
      await pool.query(`INSERT INTO matches(id,seed,player1_id,player2_id,status,tournament_id,tournament_fixture_id,tournament_phase,replay_json)
        VALUES($1,1,$2,$3,'completed',$4,$5,$6,$7::jsonb)`,[id,users[0],users[1],fixture?tid:null,fixture,phase,JSON.stringify({format:'ottv2-replay-v1',moves:[]})]);
    }
    const publicGames=await getPublicKnockoutMatches(pool,tid,false);
    assert.deepEqual(publicGames.map(g=>g.id).sort(),games.slice(0,2).sort());
    assert.ok(publicGames.every(g=>g.replay_available));
    assert.ok(await getReplayForViewer(pool,games[0],undefined));
    assert.ok(await getReplayForViewer(pool,games[0],eliminated));
    assert.equal(await getReplayForViewer(pool,games[2],undefined),null);
    assert.equal(await getReplayForViewer(pool,games[3],eliminated),null);
    assert.ok(await getReplayForViewer(pool,games[2],users[0]));
    assert.deepEqual((await getKnockoutNotices(pool,users[1])).map(n=>n.id),[tid]);
    assert.deepEqual(await getKnockoutNotices(pool,eliminated),[]);
    await pool.query("UPDATE tournaments SET status='completed' WHERE id=$1",[tid]);
    assert.deepEqual(await getKnockoutNotices(pool,users[0]),[]);
    assert.equal((await getPublicKnockoutMatches(pool,tid,false)).length,2);
    await pool.query("UPDATE tournaments SET status='cancelled' WHERE id=$1",[tid]);
    assert.equal((await getPublicKnockoutMatches(pool,tid,false)).length,0);
    assert.equal(await getReplayForViewer(pool,games[0],eliminated),null);
  } finally { await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end(); }
});
