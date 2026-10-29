import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startServer } from '../../server.ts';
import { createToken } from '../src/auth.js';

for (const phase of ['group', 'knockout']) {
  test(`HTTP: admin pauses/resumes ${phase}; pause survives restart without resetting scores or bot code`, { timeout: 45000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ott-pause-api-'));
    const dbPath = path.join(dir, 'db.json'), tid = randomUUID();
    const users = [0,1].map(i => ({ id:randomUUID(),email:`pause-${i}@example.invalid`,password_hash:'test',
      display_name:`Pause ${i}`,elo:1200,is_admin:i===0,active_bot_version:1 }));
    const [p1,p2] = users.map(u=>u.id), code = 'def get_next_move(p,s): return None';
    const now = new Date().toISOString();
    fs.writeFileSync(dbPath, JSON.stringify({ users,
      tournaments:[{id:tid,name:'Pause test',format:'group_knockout',execution_mode:'server',
        status:phase==='group'?'group_running':'knockout',knockout_started_at:phase==='knockout'?now:null,
        execution_paused_at:now,registration_closes_at:now,ends_at:new Date(Date.now()+86400000).toISOString(),rules_json:{},current_week:0}],
      tournamentEntries:users.map(u=>({tournament_id:tid,player_id:u.id,group_number:1,bot_version:1,
        bot_code_snapshot:code,matches_played:0,wins:0,draws:0,losses:0,points:0})),
      tournamentFixtures:(phase==='group'?[[p1,p2],[p2,p1]]:[[p1,p2]]).map(([a,b],i)=>({
        id:randomUUID(),tournament_id:tid,phase,group_number:phase==='group'?1:null,round_number:1,
        match_number:i+1,leg:1,player1_id:a,player2_id:b,status:'pending',match_id:null,
        series_best_of:phase==='group'?1:3,next_first_player_id:a,games_played:0,player1_score:0,player2_score:0,series_games:[]})),
      botVersions:users.map(u=>({user_id:u.id,version:1,code:'raise Exception("Later edit must not be used")',code_sha256:'0'.repeat(64)})),
      matches:[],matchResults:[],matchDisputes:[] }));
    let server;
    const saved = () => JSON.parse(fs.readFileSync(dbPath,'utf8'));
    try {
      for (let restart=0;restart<2;restart++) {
        server=await startServer({port:0,dbPath,skipVite:true});
        await new Promise(resolve=>setTimeout(resolve,1100));
        assert.equal(saved().matches.length,0);
        if (!restart) await server.close();
      }
      const base='http://127.0.0.1:'+server.httpServer.address().port;
      const request=(action,user)=>fetch(`${base}/api/tournaments/${tid}/${action}`,{method:'POST',headers:user?
        {Authorization:'Bearer '+createToken(user,process.env.JWT_SECRET || 'ottv2-local-dev-secret-key-minimum-32-chars')}: {}});
      assert.equal((await request('resume')).status,401);
      assert.equal((await request('resume',users[1])).status,403);
      assert.equal((await request('pause',users[1])).status,403);
      assert.equal((await request('pause',users[0])).status,200);
      assert.equal(saved().tournaments[0].execution_paused_at,now);
      assert.equal((await request('resume',users[0])).status,200);
      const deadline=Date.now()+25000;
      while(saved().tournaments[0].status===(phase==='group'?'group_running':'knockout') && Date.now()<deadline) {
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      const result=saved();
      assert.equal(result.tournaments[0].status,phase==='group'?'group_complete':'completed');
      assert.equal(result.tournaments[0].execution_paused_at,null);
      assert.equal(result.matchResults.length,2);
      assert.ok(result.matches.every(m=>m.status==='completed' && m.player1_bot_code===code));
      assert.deepEqual(result.users.filter(u=>[p1,p2].includes(u.id)).map(u=>u.elo),[1200,1200]);
      assert.equal((await request('resume',users[0])).status,409);
    } finally {
      await server?.close();
      fs.rmSync(dir,{recursive:true,force:true});
    }
  });
}
