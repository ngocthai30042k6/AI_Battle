import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../server.ts';
import { createToken } from '../src/auth.js';
import { qualifiedForKnockout } from '../src/knockout-public.js';
import { orderedFinalists, knockoutRoundLabel, localCalendarDay, knockoutNoticeKey } from '../../src/core/knockoutPresentation.ts';

test('qualification uses final top two before preparation and opening participants afterwards', () => {
  const entries=['a','b','c'].map((player_id,i)=>({player_id,group_number:1,registered_at:String(i)}));
  const fixtures=['b','c'].map(winner=>({phase:'group',status:'completed',player1_id:winner,player2_id:'a',winner_id:winner,move_count:10}));
  assert.equal(qualifiedForKnockout('c',{status:'group_complete'},entries,fixtures),true);
  assert.equal(qualifiedForKnockout('b',{status:'group_complete'},entries,fixtures),true);
  assert.equal(qualifiedForKnockout('a',{status:'group_complete'},entries,fixtures),false);
  const opening=[{phase:'knockout',round_number:1,player1_id:'a',player2_id:'c'}];
  assert.equal(qualifiedForKnockout('a',{status:'knockout'},entries,opening),true);
  assert.equal(qualifiedForKnockout('b',{status:'knockout'},entries,opening),false);
  assert.equal(qualifiedForKnockout('a',{status:'completed'},entries,opening),false);
  assert.equal(qualifiedForKnockout('c',{status:'group_running'},entries,fixtures),false);
});

test('second-seat champion moves above runner up, with score and identity preserved', () => {
  const final={status:'completed',player1_id:'a',player2_id:'b',player1:'First',player2:'Second',player1_score:1,player2_score:2,winner_id:'b'};
  assert.deepEqual(orderedFinalists(final),{decided:true,players:[{id:'b',name:'Second',score:2},{id:'a',name:'First',score:1}]});
  assert.equal(orderedFinalists({...final,status:'active'}).decided,false);
  assert.equal(orderedFinalists(undefined).decided,false);
  assert.equal(knockoutRoundLabel(32,1),'Vòng 1/32');
  assert.equal(knockoutRoundLabel(32,6),'Chung kết');
  assert.notEqual(localCalendarDay(new Date(2026,9,29,23,59)),localCalendarDay(new Date(2026,9,30,0,0)));
  assert.notEqual(knockoutNoticeKey('a','cup'),knockoutNoticeKey('b','cup'));
});

test('HTTP: guests see every knockout game/replay while group and ranked replays stay private', {timeout:15000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ott-ko-public-')),dbPath=path.join(dir,'db.json');
  const tid=randomUUID(),cancelledId=randomUUID();
  const users=Array.from({length:3},(_,i)=>({id:randomUUID(),email:`public-${i}@example.invalid`,password_hash:'test',display_name:'Player '+i,elo:1200,is_admin:false,active_bot_version:0,created_at:new Date().toISOString()}));
  const fixtures=['knockout','group'].map(phase=>({id:randomUUID(),tournament_id:tid,phase,round_number:1,match_number:1,leg:1,player1_id:users[0].id,player2_id:users[1].id,status:'completed',winner_id:users[1].id}));
  const replay={format:'ottv2-replay-v1',moves:[]};
  const matches=[...fixtures.map(f=>({id:randomUUID(),tournament_id:tid,tournament_fixture_id:f.id,tournament_phase:f.phase})),{id:randomUUID(),tournament_phase:'knockout'}]
    .map(m=>({...m,player1_id:users[0].id,player2_id:users[1].id,status:'completed',created_at:new Date().toISOString(),replay_json:replay}));
  fs.writeFileSync(dbPath,JSON.stringify({users,tournaments:[{id:tid,name:'Public Cup',format:'group_knockout',status:'knockout',group_count:8,ends_at:new Date(Date.now()+86400000).toISOString()},{id:cancelledId,name:'Cancelled',format:'group_knockout',status:'cancelled'}],
    tournamentFixtures:fixtures,tournamentEntries:users.map((u,i)=>({tournament_id:tid,player_id:u.id,group_number:1,registered_at:String(i),bot_code_snapshot:'SECRET BOT SOURCE'})),matches,botVersions:[],matchResults:[],matchDisputes:[]}));
  const server=await startServer({port:0,dbPath,skipVite:true});
  try {
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    const headers=user=>({Authorization:'Bearer '+createToken(user,process.env.JWT_SECRET || 'ottv2-local-dev-secret-key-minimum-32-chars')});
    const result=await fetch(base+`/api/tournaments/${tid}/knockout-matches`);
    assert.equal(result.status,200);
    const data=await result.json(); assert.equal(data.matches.length,1);assert.equal(data.matches[0].id,matches[0].id);
    assert.ok(!JSON.stringify(data).includes('SECRET'));assert.equal(data.matches[0].replay_available,true);
    for(const options of [{},{headers:headers(users[2])}]) {
      assert.equal((await fetch(base+`/api/matches/${matches[0].id}/replay`,options)).status,200);
      for(const match of matches.slice(1)) assert.equal((await fetch(base+`/api/matches/${match.id}/replay`,options)).status,404);
    }
    assert.equal((await fetch(base+`/api/matches/${matches[1].id}/replay`,{headers:headers(users[0])})).status,200);
    assert.equal((await fetch(base+'/api/me/knockout-notices')).status,401);
    const eligible=await (await fetch(base+'/api/me/knockout-notices',{headers:headers(users[1])})).json();
    assert.deepEqual(eligible.notices.map(n=>n.id),[tid]);
    const eliminated=await (await fetch(base+'/api/me/knockout-notices',{headers:headers(users[2])})).json();
    assert.deepEqual(eliminated.notices,[]);
    assert.deepEqual((await (await fetch(base+`/api/tournaments/${cancelledId}/knockout-matches`)).json()).matches,[]);
  } finally { await server.close();fs.rmSync(dir,{recursive:true,force:true}); }
});
