import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { Pool } from 'pg';
import { prepareServerKnockout } from '../src/knockout-series.js';

test('Postgres: reconfigure a legacy pending bracket in place, refusing any already played game', {
  skip:!process.env.OTTV2_TEST_DB_URL,timeout:90000,
},async()=>{
  const schema='prepare_test_'+randomUUID().replaceAll('-','');
  const db=new Pool({connectionString:process.env.OTTV2_TEST_DB_URL,max:1});
  await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`SET search_path=${schema},public`);
  try{
    const root=new URL('../migrations/',import.meta.url);
    for(const file of (await readdir(root)).filter(f=>f.endsWith('.sql')).sort()) await db.query(await readFile(new URL(file,root),'utf8'));
    const id=randomUUID(),players=Array.from({length:16},()=>randomUUID());
    await db.query(`INSERT INTO users(id,email,password_hash,display_name)
      SELECT id,id::text||'@example.invalid','test','Test' FROM unnest($1::uuid[]) AS id`,[players]);
    await db.query(`INSERT INTO tournaments(id,name,format,status,registration_closes_at,ends_at,rules_json,group_count)
      VALUES($1,'Legacy prepare test','group_knockout','group_complete',now(),now()+interval '1 day','{}',8)`,[id]);
    await db.query(`INSERT INTO tournament_entries(tournament_id,player_id,group_number)
      SELECT $1,id,((ordinality-1)/2)::int+1 FROM unnest($2::uuid[]) WITH ORDINALITY AS p(id,ordinality)`,[id,players]);
    for(let i=0;i<8;i++) await db.query(`INSERT INTO tournament_fixtures(tournament_id,phase,group_number,round_number,match_number,player1_id,player2_id,winner_id,status)
      VALUES($1,'group',$2,1,1,$3,$4,$3,'completed')`,[id,i+1,players[2*i],players[2*i+1]]);
    const startsAt=new Date(Date.now()+3600000).toISOString();
    await db.query('BEGIN');await prepareServerKnockout(db,id,{knockoutStartsAt:startsAt});await db.query('COMMIT');
    const initial=(await db.query("SELECT id FROM tournament_fixtures WHERE phase='knockout' ORDER BY match_number")).rows.map(f=>f.id);
    await db.query("UPDATE tournament_fixtures SET series_best_of=1 WHERE phase='knockout'");
    await db.query('BEGIN');await prepareServerKnockout(db,id,{knockoutStartsAt:startsAt,blockedCells:[2,18],moveLimitRule:'remaining-pieces'});await db.query('COMMIT');
    const configured=(await db.query("SELECT * FROM tournament_fixtures WHERE phase='knockout' ORDER BY match_number")).rows;
    assert.deepEqual(configured.map(f=>f.id),initial);
    assert.ok(configured.every(f=>f.series_best_of===3 && f.next_first_player_id));
    await db.query('UPDATE tournament_fixtures SET leg=2 WHERE id=$1',[initial[0]]);
    await db.query('BEGIN');await assert.rejects(prepareServerKnockout(db,id,{knockoutStartsAt:startsAt}),/đã có trận/);await db.query('ROLLBACK');
  }finally{
    assert.match(schema,/^prepare_test_[a-f0-9]{32}$/);
    await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();
  }
});
