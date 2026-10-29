import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEloRatedMatch } from '../../shared/matchRating.mjs';
import { getMatchFormatLabel, getMatchEloLabel } from '../../src/core/backendClient.ts';
import { startServer } from '../../server.ts';
import { createToken } from '../src/auth.js';

test('only standalone ranked bot games affect Elo; all tournament formats use Đấu Giải',()=>{
  const ranked={match_type:'bot',tournament_phase:'ranked',winner_id:'p1',elo_delta:10,elo_before:1200,elo_after:1210};
  assert.equal(isEloRatedMatch(ranked),true);
  assert.match(getMatchEloLabel(ranked,'p1'),/\+10 Elo/);
  for(const fields of [{tournament_id:'cup'},{tournament_phase:'group'},{tournament_phase:'knockout'},{tournament_id:'legacy',tournament_phase:'ranked'}]) {
    const game={...ranked,...fields};
    assert.equal(isEloRatedMatch(game),false);
    assert.equal(getMatchFormatLabel(game),game.tournament_phase === 'group' ? 'Đấu Giải (Vòng bảng)' : game.tournament_phase === 'knockout' ? 'Đấu Giải (Knock-Out)' : 'Đấu Giải');
    assert.equal(getMatchEloLabel(game,'p1'),null);
  }
  assert.equal(isEloRatedMatch({...ranked,is_sparring:true}),false);
  assert.equal(isEloRatedMatch({...ranked,match_type:'human'}),false);
  assert.equal(isEloRatedMatch({...ranked,tournament_phase:'practice'}),false);
  assert.equal(getMatchFormatLabel(ranked),'Bot VS Bot');
});

test('HTTP: a tournament forfeit keeps Elo but a ranked forfeit still changes it',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ott-rating-')),dbPath=path.join(dir,'db.json');
  const tid=randomUUID(),fid=randomUUID(),groupId=randomUUID(),rankedId=randomUUID(),now=new Date().toISOString();
  const users=[0,1].map(i=>({id:randomUUID(),email:`rating-${i}@example.invalid`,password_hash:'test',display_name:'Player '+i,elo:i?1600:1100,is_admin:false,active_bot_version:0,created_at:now}));
  const baseMatch={seed:123,status:'active',match_type:'bot',player1_id:users[0].id,player2_id:users[1].id,created_at:now};
  fs.writeFileSync(dbPath,JSON.stringify({users,tournaments:[{id:tid,format:'group_knockout',status:'group_running',execution_mode:'browser',name:'Test',tournament_starts_at:now,ends_at:new Date(Date.now()+86400000).toISOString()}],
    tournamentEntries:users.map(u=>({tournament_id:tid,player_id:u.id,group_number:1,matches_played:0,points:0,wins:0,draws:0,losses:0})),
    tournamentFixtures:[{id:fid,tournament_id:tid,phase:'group',group_number:1,round_number:1,match_number:1,leg:1,player1_id:users[0].id,player2_id:users[1].id,status:'active',match_id:groupId}],
    matches:[{...baseMatch,id:groupId,tournament_id:tid,tournament_fixture_id:fid,tournament_phase:'group'},{...baseMatch,id:rankedId,tournament_phase:'ranked'}],matchResults:[],botVersions:[],matchDisputes:[]}));
  const server=await startServer({port:0,dbPath,skipVite:true});
  try {
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    const headers={Authorization:'Bearer '+createToken(users[0],process.env.JWT_SECRET || 'ottv2-local-dev-secret-key-minimum-32-chars'),'Content-Type':'application/json'};
    const forfeit=id=>fetch(base+'/api/match/forfeit',{method:'POST',headers,body:JSON.stringify({matchId:id})});
    assert.equal((await forfeit(groupId)).status,200);
    let saved=JSON.parse(fs.readFileSync(dbPath,'utf8'));
    assert.deepEqual(saved.users.filter(u=>users.some(original=>original.id===u.id)).map(u=>u.elo),[1100,1600]);
    assert.equal(saved.tournamentFixtures[0].winner_id,users[1].id);
    assert.equal(saved.tournamentEntries.find(e=>e.player_id===users[1].id).points,3);
    assert.equal((await forfeit(rankedId)).status,200);
    saved=JSON.parse(fs.readFileSync(dbPath,'utf8'));
    assert.ok(saved.users.find(u=>u.id===users[0].id).elo<1100);
    assert.ok(saved.users.find(u=>u.id===users[1].id).elo>1600);
    const history=(await (await fetch(base+'/api/matches',{headers})).json()).matches;
    assert.equal(history.find(m=>m.id===groupId).elo_updated,false);
    assert.equal(history.find(m=>m.id===groupId).elo_delta,null);
    assert.equal(history.find(m=>m.id===rankedId).elo_updated,true);
  } finally {await server.close();fs.rmSync(dir,{recursive:true,force:true});}
});
