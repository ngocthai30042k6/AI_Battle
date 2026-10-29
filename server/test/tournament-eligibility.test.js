import test from 'node:test';
import assert from 'node:assert/strict';
import { minimumTournamentElo, requireTournamentElo } from '../src/tournament-eligibility.js';
test('registration requires the inclusive Elo minimum, with zero meaning unrestricted', () => {
  assert.equal(minimumTournamentElo(undefined),0);
  assert.doesNotThrow(()=>requireTournamentElo({min_elo:1200},{elo:1200}));
  assert.doesNotThrow(()=>requireTournamentElo({min_elo:0},{elo:500}));
  assert.throws(()=>requireTournamentElo({min_elo:1300},{elo:1200}),{status:403});
  for(const value of [-1,10001,1.5,'abc']) assert.throws(()=>minimumTournamentElo(value),{status:400});
});
