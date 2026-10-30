import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { playServerBotMatch } from '../server/src/server-bot-match.js';

// Measures fresh, isolated Python runtimes plus game/replay computation locally.
// Does not include PostgreSQL, object storage, queue time or production load.
const games=Number(process.argv[2] || 12);
if (!Number.isInteger(games) || games<2 || games>100) throw new Error('Usage: node scripts/benchmark-server-matches.mjs [games: 2..100]');
const code="def get_next_move(p,s):\n return s['validMoves'][0]";
const strategy=process.argv[3] || 'first';
if (!['first','attack'].includes(strategy)) throw new Error('Strategy must be first or attack');
const attack=`def get_next_move(p,s):
 goal=s['specialCells']['myWinIndex']
 def score(m):
  if m['to']==goal: return 1000000
  capture=100000 if m['isAttack'] and s['opponentPieceCounts'].get(m['targetType'],3)<=1 else 71 if m['isAttack'] else 0
  return capture-4*(abs(m['toRow']-goal//9)+abs(m['toCol']-goal%9))+(m['from']*131+m['to']*47+s['stepCount']*17+977)%29
 return max(s['validMoves'],key=score)
`;
// Optional baseline implementation for controlled before/after measurements.
const createBot=process.env.BENCHMARK_BOT_MODULE ? (await import(pathToFileURL(process.env.BENCHMARK_BOT_MODULE))).createPythonBot : undefined;
const baselineBot=process.env.BENCHMARK_BASELINE_MODULE ? (await import(pathToFileURL(process.env.BENCHMARK_BASELINE_MODULE))).createPythonBot : null;
const samples=[], baseline=[];
const cpuStart=process.cpuUsage();
let peakRss=0;
const memoryTimer=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},10);
async function measure(index, factory) {
  const start=performance.now();
  const botCode=strategy==='attack'?attack:code;
  const result=await playServerBotMatch({matchId:'benchmark-'+index,seed:20261029+index,codes:[botCode,botCode]},factory);
  const json=Buffer.from(JSON.stringify(result.replay));
  assert.equal(result.fault,null,'A forfeit must not be counted as a faster game');
  return {ms:Math.round(performance.now()-start),moves:result.moveCount,
    ...result.timings,winner:result.winner,finalHash:result.finalHash,
    movesHash:createHash('sha256').update(JSON.stringify(result.replay.moves.map(m=>m.move))).digest('hex'),
    replayBytes:json.length,gzipBytes:gzipSync(json).length,fault:result.fault};
}
try {
for(let index=0;index<games;index++) {
  // Alternate order to reduce thermal/background-load bias. Both run exactly
  // the same seeds/code; fail the benchmark on a changed move or final result.
  if (baselineBot && index%2===0) baseline.push(await measure(index,baselineBot));
  samples.push(await measure(index,createBot));
  if (baselineBot && index%2!==0) baseline.push(await measure(index,baselineBot));
  if (baselineBot) for (const key of ['moves','winner','finalHash','movesHash']) assert.equal(samples[index][key],baseline[index][key],`Game ${index}: ${key} differs`);
}
} finally { clearInterval(memoryTimer); }
function summarize(samples) {
const warm=samples.slice(1),times=warm.map(s=>s.ms).sort((a,b)=>a-b);
return {
  coldStartMs:samples[0].ms,
  warmMeanMs:Math.round(times.reduce((a,b)=>a+b,0)/times.length),
  warmP95Ms:times[Math.ceil(times.length*.95)-1],
  warmLoadMs:Math.round(warm.reduce((n,s)=>n+s.loadMs,0)/warm.length),
  warmMovesMs:Math.round(warm.reduce((n,s)=>n+s.movesMs,0)/warm.length),
};
}
console.log(JSON.stringify({
  workload:`Two deterministic ${strategy} bots; full games; no database I/O`,
  node:process.version,platform:process.platform,games,
  ...summarize(samples),
  ...(baselineBot ? {baseline:summarize(baseline),equivalentResults:true,
    reductionPercent:Math.round(100*(1-summarize(samples).warmMeanMs/summarize(baseline).warmMeanMs))} : {}),
  cpuMs:Object.values(process.cpuUsage(cpuStart)).reduce((a,b)=>a+b,0)/1000,
  peakRssMB:Math.round(peakRss/1048576),
  rssMB:Math.round(process.memoryUsage().rss/1048576),samples,
  ...(baselineBot ? {baselineSamples:baseline} : {}),
},null,2));
