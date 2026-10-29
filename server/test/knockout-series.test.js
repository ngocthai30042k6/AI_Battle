import test from 'node:test';
import assert from 'node:assert/strict';
import { knockoutConfiguration, newKnockoutSeries, recordKnockoutGame } from '../src/knockout-series.js';

function fixture() {
  return { player1_id: 'A', player2_id: 'B', ...newKnockoutSeries('A', 'B') };
}
function game(f, winner) {
  const first = f.next_first_player_id;
  return { ...f, ...recordKnockoutGame(f, { id: String(f.games_played), player1_id: first, player2_id: first === 'A' ? 'B' : 'A' }, winner, 25) };
}
test('BO3 ends 2–0 and the losing player starts the next game', () => {
  let f = fixture();
  assert.ok(['A', 'B'].includes(f.next_first_player_id));
  f = game(f, 'A');
  assert.equal(f.status, 'pending'); assert.equal(f.next_first_player_id, 'B');
  f = game(f, 'A');
  assert.equal(f.status, 'completed'); assert.equal(f.winner_id, 'A');
  assert.deepEqual([f.player1_score, f.player2_score], [2, 0]);
});
test('loser starts games two and three, even when seats are reversed', () => {
  let f = fixture(); f.next_first_player_id = 'B';
  f = game(f, 'A'); f = game(f, 'B');
  assert.equal(f.next_first_player_id, 'A'); assert.equal(f.status, 'pending');
  f = game(f, 'B');
  assert.equal(f.winner_id, 'B');
  assert.deepEqual([f.player1_score, f.player2_score], [1, 2]);
  assert.deepEqual(f.series_games.map(g => g.firstPlayerId), ['B', 'B', 'A']);
});
test('draws score 0.5, swap the first player, and tied BO3 plays extra games', () => {
  let f = fixture(); f.next_first_player_id = 'A';
  f = game(f, null);
  assert.equal(f.next_first_player_id, 'B');
  assert.deepEqual([f.player1_score, f.player2_score], [.5, .5]);
  f = game(f, null); f = game(f, null);
  assert.equal(f.games_played, 3); assert.equal(f.status, 'pending');
  f = game(f, null); assert.equal(f.status, 'pending');
  f = game(f, 'B');
  assert.equal(f.games_played, 5); assert.equal(f.winner_id, 'B');
  assert.deepEqual([f.player1_score, f.player2_score], [2, 3]);
});
test('a 1.5–0.5 lead needs game three; 2–1 on points advances the leader', () => {
  let f = game(game(fixture(), 'A'), null);
  assert.equal(f.status, 'pending');
  f = game(f, null);
  assert.equal(f.winner_id, 'A'); assert.deepEqual([f.player1_score, f.player2_score], [2, 1]);
});
test('custom bracket uses each qualifier once and validates separate knockout rules', () => {
  const qualified = Array.from({ length: 16 }, (_, i) => ({ player_id: 'p'+i, group_number: Math.floor(i / 2) + 1 }));
  const pairings = Array.from({ length: 8 }, (_, i) => ['p'+i, 'p'+(15-i)]);
  const base = { blockedCells: [], moveLimitRule: 'standard' };
  const configured = knockoutConfiguration(qualified, base, { pairings, blockedCells: [1,9], moveLimitRule: 'remaining-pieces' });
  assert.deepEqual(configured.fixtures.map(f => [f.player1Id,f.player2Id]), pairings);
  assert.deepEqual(configured.rules.blockedCells, [1,9]); assert.equal(configured.rules.moveLimit, 25);
  assert.deepEqual(base.blockedCells, []);
  assert.throws(() => knockoutConfiguration(qualified, base, { pairings: [...pairings.slice(1),pairings[1]] }), /đúng một lần/);
  assert.throws(() => knockoutConfiguration(qualified, base, { blockedCells: [8] }), /ô đích/);
});
