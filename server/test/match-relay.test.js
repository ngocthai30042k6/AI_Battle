import test from 'node:test';
import assert from 'node:assert/strict';
import { persistMatchRelay } from '../src/match-relay.js';

test('Bot readiness and ordinary relay packets return without an ACK; ACKs are scoped to their own packet', async()=>{
  let state={currentStep:0,p1ReadyAt:null,p2ReadyAt:null,bothReadyAt:null,acksForPendingStep:{}};
  const client={release(){},async query(sql,values){
    if(sql.startsWith('SELECT'))return {rows:[{match_type:'bot',status:'active',consensus_state:structuredClone(state)}]};
    if(sql.startsWith('UPDATE'))state=JSON.parse(values[0]);
    return {rows:[]};
  }};
  const pool={connect:async()=>client},match={id:'match'};
  const relay=(seat,p)=>persistMatchRelay(pool,match,seat,p,()=>({}));
  assert.equal(await relay(1,{type:'BOT_READY'}),null);
  assert.equal(await relay(2,{type:'BOT_READY'}),null);
  assert.ok(state.p1ReadyAt && state.p2ReadyAt && state.bothReadyAt);
  assert.equal(await relay(1,{type:'CONSENSUS_COMMIT'}),null);
  const ack={type:'CONSENSUS_ACK',attestation:{payload:{matchId:'match',stepCount:1,moveCommit:'commit',stateHash:'hash'}}};
  assert.deepEqual(await relay(1,ack),{matchId:'match',stepCount:1,stateHash:'hash'});
  assert.deepEqual(await relay(2,ack),{matchId:'match',stepCount:1,stateHash:'hash'});
  assert.equal(state.currentStep,1);
  assert.equal(await relay(2,{type:'BOT_READY'}),null);
  assert.equal(await relay(1,{type:'CONSENSUS_ACK',attestation:{payload:{matchId:'other',stepCount:2}}}),null);
});
