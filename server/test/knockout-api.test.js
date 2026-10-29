import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../server.ts';
import { createToken } from '../src/auth.js';

test('HTTP: publish rules and time, edit bot twice, admin launches BO3, Elo blocks registration', {timeout:45000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ott-knockout-api-')),dbPath=path.join(dir,'db.json');
  const tid=randomUUID(),registration=randomUUID(),code='def get_next_move(p,s): return None';
  const users=Array.from({length:16},(_,i)=>({id:randomUUID(),email:`ko-${i}@example.invalid`,password_hash:'test',display_name:'KO '+i,elo:i===1?1500:1200,is_admin:i===0,active_bot_version:1,created_at:new Date().toISOString()}));
  const baseTournament={format:'group_knockout',registration_closes_at:new Date(Date.now()+86400000).toISOString(),ends_at:new Date(Date.now()+86400000*2).toISOString(),max_teams:64,rules_json:{blockedCells:[],moveLimitRule:'standard'},rules_schedule:[],current_week:0};
  const legacy=Array.from({length:8},(_,i)=>({id:randomUUID(),tournament_id:tid,phase:'knockout',group_number:null,round_number:1,match_number:i+1,leg:1,series_best_of:1,player1_id:users[i*2].id,player2_id:users[i*2+1].id,status:'pending',match_id:null}));
  fs.writeFileSync(dbPath,JSON.stringify({users,tournaments:[{...baseTournament,id:tid,name:'KO API',status:'knockout',execution_mode:'server',group_count:8},{...baseTournament,id:registration,name:'Elo API',status:'registration',min_elo:1300}],
    tournamentEntries:users.map((u,i)=>({tournament_id:tid,player_id:u.id,bot_version:1,group_number:Math.floor(i/2)+1,matches_played:0,wins:0,draws:0,losses:0,points:0,registered_at:new Date().toISOString()})),
    tournamentFixtures:[...legacy,...Array.from({length:8},(_,i)=>({id:randomUUID(),tournament_id:tid,phase:'group',group_number:i+1,round_number:1,match_number:1,leg:1,player1_id:users[i*2].id,player2_id:users[i*2+1].id,winner_id:users[i*2].id,status:'completed'}))],
    botVersions:users.map(u=>({user_id:u.id,version:1,code,code_sha256:'0'.repeat(64)})),matches:[],matchResults:[],matchDisputes:[]}));
  const server=await startServer({port:0,dbPath,skipVite:true});
  try{
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    const request=(route,user=users[0],body={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+createToken(user,process.env.JWT_SECRET || 'ottv2-local-dev-secret-key-minimum-32-chars')},body:JSON.stringify(body)});
    assert.equal((await request(`/api/tournaments/${registration}/register`)).status,403);
    assert.equal((await request(`/api/tournaments/${registration}/register`,users[1])).status,201);
    assert.equal((await request(`/api/tournaments/${tid}/prepare-knockout`,users[1])).status,403);
    const prepared=await request(`/api/tournaments/${tid}/prepare-knockout`,users[0],{blockedCells:[1,9],moveLimitRule:'remaining-pieces',knockoutStartsAt:new Date(Date.now()-1000).toISOString()});
    assert.equal(prepared.status,201);
    const configured=JSON.parse(fs.readFileSync(dbPath,'utf8')).tournamentFixtures.filter(f=>f.phase==='knockout');
    assert.deepEqual(configured.map(f=>f.id).sort(),legacy.map(f=>f.id).sort());
    assert.ok(configured.every(f=>f.series_best_of===3));
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(JSON.parse(fs.readFileSync(dbPath,'utf8')).matches.length,0);
    const revised=code+' # saved for knockout';
    assert.equal((await request('/api/bots/me',users[0],{code:revised})).status,201);
    assert.equal((await request(`/api/tournaments/${tid}/start-knockout`)).status,200);
    assert.equal((await request(`/api/tournaments/${tid}/start-knockout`)).status,409);
    const deadline=Date.now()+30000; let saved,series;
    do{
      await new Promise(resolve=>setTimeout(resolve,100));
      saved=JSON.parse(fs.readFileSync(dbPath,'utf8'));
      series=saved.tournamentFixtures.find(f=>f.phase==='knockout' && f.match_number===1);
    }while(series.status!=='completed' && Date.now()<deadline);
    assert.equal(series.status,'completed');
    assert.deepEqual([series.player1_score,series.player2_score].sort(),[0,2]);
    const entry=saved.tournamentEntries.find(e=>e.tournament_id===tid && e.player_id===users[0].id);
    assert.equal(entry.bot_version,2);assert.equal(entry.bot_code_snapshot,revised);
    const games=saved.matches.filter(m=>m.tournament_fixture_id===series.id);
    assert.equal(games.length,2); assert.equal(games[1].player1_id,games[0].player1_id);
    assert.ok(games.every(m=>m.tournament_phase==='knockout' && m.tournament_rules.blockedCells.length===2));
  }finally{await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
