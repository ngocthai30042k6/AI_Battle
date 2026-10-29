import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendClient } from '../../src/core/backendClient.ts';

test('ranked handshake delivered before the arena mounts is replayed to its listeners', async () => {
  const client=new BackendClient();
  client.handleWsPacket({type:'match-found',match:{id:'ranked-1'}});
  client.handleWsPacket({type:'peer-session-key',matchId:'ranked-1',publicKey:{x:'peer-key'}});
  client.handleWsPacket({type:'match-relay',matchId:'ranked-1',payload:{type:'CONSENSUS_HELLO',seat:2}});
  client.handleWsPacket({type:'match-relay',matchId:'ranked-1',payload:{type:'BOT_READY'}});
  const keys=[],data=[];
  client.on('peer-session-key',packet=>keys.push(packet));
  client.on('peer-data',packet=>data.push(packet));
  await new Promise(resolve=>queueMicrotask(resolve));
  assert.equal(keys[0].publicKey.x,'peer-key');
  assert.deepEqual(data.map(p=>p.type),['CONSENSUS_HELLO','BOT_READY']);
  client.handleWsPacket({type:'match-relay',matchId:'old-match',payload:{type:'CONSENSUS_COMMIT'}});
  assert.equal(data.length,2);
});
