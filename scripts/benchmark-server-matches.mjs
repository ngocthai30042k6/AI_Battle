import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { playServerBotMatch } from '../server/src/server-bot-match.js';

// Measures fresh, isolated Python runtimes plus game/replay computation locally.
// Does not include PostgreSQL, object storage, queue time or production load.
const games=Number(process.argv[2] || 12);
if (!Number.isInteger(games) || games<2 || games>100) throw new Error('Usage: node scripts/benchmark-server-matches.mjs [games: 2..100]');
const code="def get_next_move(p,s):\n return s['validMoves'][0]";
const samples=[];
for(let index=0;index<games;index++) {
  const start=performance.now();
  const result=await playServerBotMatch({matchId:'benchmark-'+index,seed:20261029+index,codes:[code,code]});
  const json=Buffer.from(JSON.stringify(result.replay));
  samples.push({ms:Math.round(performance.now()-start),moves:result.moveCount,
    replayBytes:json.length,gzipBytes:gzipSync(json).length,fault:result.fault});
}
const warm=samples.slice(1),times=warm.map(s=>s.ms).sort((a,b)=>a-b);
console.log(JSON.stringify({
  workload:'Two bots choosing the first valid move; full games; no database I/O',
  coldStartMs:samples[0].ms,
  warmMeanMs:Math.round(times.reduce((a,b)=>a+b,0)/times.length),
  warmP95Ms:times[Math.ceil(times.length*.95)-1],
  rssMB:Math.round(process.memoryUsage().rss/1048576),samples,
},null,2));
