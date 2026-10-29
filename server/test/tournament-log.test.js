import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../server.ts';
import { createToken } from '../src/auth.js';
import { hasKnockoutPlace, tournamentGameOutcome } from '../../src/core/tournamentLog.ts';

test('personal logs only offer knockout to qualifiers and use points per game, not per BO3 series',()=>{
  const detail={tournament:{status:'completed'},fixtures:[{phase:'knockout',round_number:1,player1_id:'a',player2_id:'b'}]};
  assert.equal(hasKnockoutPlace(detail,'a'),true);
  assert.equal(hasKnockoutPlace(detail,'c'),false);
  assert.equal(hasKnockoutPlace({tournament:{status:'group_running'},groups:[{standings:[{player_id:'a'}]}]},'a'),false);
  for(const [winner,ko,group] of [['a','THẮNG · +1 ĐIỂM','THẮNG · +3 ĐIỂM'],['b','THUA · +0 ĐIỂM','THUA · +0 ĐIỂM'],[null,'HÒA · +0.5 ĐIỂM','HÒA · +1 ĐIỂM']]) {
    assert.equal(tournamentGameOutcome({phase:'knockout',winner_id:winner,series_best_of:3},'a'),ko);
    assert.equal(tournamentGameOutcome({phase:'group',winner_id:winner},'a'),group);
  }
});

test('HTTP: phase-specific private logs paginate without omissions and creation enforces both 24-hour gaps',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ott-phase-logs-')),dbPath=path.join(dir,'db.json');
  const tid=randomUUID(),groupId=randomUUID(),knockoutId=randomUUID(),at=new Date().toISOString();
  const users=[0,1,2].map(i=>({id:randomUUID(),email:`phase-${i}@example.invalid`,password_hash:'test',display_name:'Player '+i,elo:1200,is_admin:i===2,active_bot_version:0,created_at:at}));
  const matches=Array.from({length:59},(_,i)=>({id:randomUUID(),seed:123,status:'completed',match_type:'bot',tournament_id:tid,
    tournament_fixture_id:i<56?groupId:knockoutId,tournament_phase:i<56?'group':'knockout',
    player1_id:i===55?users[2].id:users[0].id,player2_id:users[1].id,winner_id:i%3===0?null:i%3===1?users[0].id:users[1].id,
    created_at:at,completed_at:at,player1_bot_code:'SECRET',replay_json:{moves:[]}}));
  fs.writeFileSync(dbPath,JSON.stringify({users,tournaments:[{id:tid,name:'Test',format:'group_knockout',status:'completed'}],
    tournamentEntries:users.map(u=>({tournament_id:tid,player_id:u.id,group_number:1})),
    tournamentFixtures:[{id:groupId,tournament_id:tid,phase:'group',group_number:1,round_number:1},{id:knockoutId,tournament_id:tid,phase:'knockout',round_number:1,player1_id:users[0].id,player2_id:users[1].id}],matches,matchResults:[],botVersions:[],matchDisputes:[]}));
  const server=await startServer({port:0,dbPath,skipVite:true});
  try {
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    const auth=user=>({Authorization:'Bearer '+createToken(user,process.env.JWT_SECRET || 'ottv2-local-dev-secret-key-minimum-32-chars'),'Content-Type':'application/json'});
    const endpoint=`${base}/api/tournaments/${tid}/match-log`;
    assert.equal((await fetch(endpoint)).status,401);
    assert.equal((await fetch(endpoint+'?scope=all',{headers:auth(users[0])})).status,403);
    const read=async query=>{const response=await fetch(endpoint+'?'+query,{headers:auth(users[0])});assert.equal(response.status,200);return response.json();};
    const first=await read('phase=group');assert.equal(first.total,55);assert.equal(first.matches.length,50);
    assert.ok(!JSON.stringify(first).includes('SECRET'));
    const second=await read('phase=group&cursor='+encodeURIComponent(first.nextCursor));
    assert.equal(second.matches.length,5);assert.equal(second.nextCursor,null);
    assert.equal(new Set([...first.matches,...second.matches].map(m=>m.id)).size,55);
    const knockout=await read('phase=knockout');assert.equal(knockout.total,3);
    assert.ok(knockout.matches.every(m=>m.phase==='knockout'));
    assert.equal((await read('phase=group&q='+matches[0].id)).total,1);
    assert.equal((await fetch(endpoint+'?cursor=bad',{headers:auth(users[0])})).status,400);
    const opening=Date.now()+3600000,day=86400000;
    const create=async(closeGap,startGap)=>fetch(base+'/api/tournaments',{method:'POST',headers:auth(users[2]),body:JSON.stringify({
      name:'Gap test',registrationOpensAt:new Date(opening).toISOString(),registrationClosesAt:new Date(opening+closeGap).toISOString(),
      tournamentStartsAt:new Date(opening+closeGap+startGap).toISOString(),blockedCells:[],moveLimitRule:'standard',minElo:0,
    })});
    assert.equal((await create(day-1,day)).status,400);
    assert.equal((await create(day,day-1)).status,400);
    assert.equal((await create(day,day)).status,201);
  } finally {await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
