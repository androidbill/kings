import { newGame, applyMove, startNextRound, currentPlayer, playerScore } from '../public/rules.js';

function randInt(n) { return Math.floor(Math.random() * n); }

function playRandomGame(numPlayers, deckCount, layout, seed) {
  const ids = Array.from({ length: numPlayers }, (_, i) => `p${i}`);
  let game = newGame({ playerIds: ids, deckCount, layout, seed });
  let moves = 0;
  const cap = 20000;

  while (game.phase !== 'gameOver' && moves++ < cap) {
    if (game.phase === 'roundEnd') {
      game = startNextRound(game, { seed: seed + moves });
      continue;
    }
    const pid = currentPlayer(game);
    if (game.phase === 'reveal') {
      const cols = game.layout === 'rows3' ? 3 : 4;
      game = applyMove(game, pid, { type: 'revealColumn', col: randInt(cols) });
      continue;
    }
    // play / lastTurn
    if (!game.holding) {
      const from = game.burnPile.length && Math.random() < 0.3 ? 'burn' : 'deck';
      game = applyMove(game, pid, { type: 'draw', from });
      continue;
    }
    if (game.holding.from === 'burn' || Math.random() < 0.7) {
      const cells = game.players[pid].cells;
      game = applyMove(game, pid, { type: 'swap', index: randInt(cells.length) });
    } else {
      game = applyMove(game, pid, { type: 'discard' });
    }
  }
  if (moves >= cap) throw new Error('game did not terminate');
  return game;
}

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('FAIL:', msg); }
}

for (const numPlayers of [2, 3, 5, 8]) {
  for (const deckCount of [1, 2]) {
    for (const layout of ['rows3', 'rows4']) {
      const size = layout === 'rows3' ? 6 : 8;
      const totalCards = deckCount * 52;
      if (numPlayers * size + 1 > totalCards) continue; // engine should throw; skip here
      for (let trial = 0; trial < 20; trial++) {
        const seed = numPlayers * 1000 + deckCount * 100 + trial + (layout === 'rows4' ? 50 : 0);
        const game = playRandomGame(numPlayers, deckCount, layout, seed);
        check(game.phase === 'gameOver', `game reached gameOver (${numPlayers}p ${deckCount}deck ${layout})`);
        const remaining = game.order.filter((pid) => !game.players[pid].out);
        // A tied final round can eliminate everyone still standing simultaneously.
        check(remaining.length <= 1, `at most one player remains at game over, got ${remaining.length}`);
        for (const pid of game.order) {
          check(game.players[pid].lives >= 0, 'lives never negative');
          check(game.players[pid].lives <= 4, 'lives never exceed 4');
        }
      }
    }
  }
}

// not-enough-cards should throw
try {
  newGame({ playerIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], deckCount: 1, layout: 'rows4', seed: 1 });
  check(false, 'expected throw for 8 players / 1 deck / rows4 (65 cards needed, 52 available)');
} catch { /* expected */ }

// column matching = 0
{
  const ids = ['a', 'b'];
  let game = newGame({ playerIds: ids, deckCount: 1, layout: 'rows3', seed: 7 });
  game.players.a.cells = [
    { id: 'x1', rank: '5', suit: 'S', faceUp: true }, { id: 'x2', rank: '9', suit: 'H', faceUp: true }, { id: 'x3', rank: 'K', suit: 'D', faceUp: true },
    { id: 'x4', rank: '5', suit: 'C', faceUp: true }, { id: 'x5', rank: '3', suit: 'S', faceUp: true }, { id: 'x6', rank: 'K', suit: 'H', faceUp: true },
  ];
  const score = playerScore(game.players.a.cells, 'rows3');
  check(score === 12, `matching columns score 0 each (col0 5=5 match->0, col1 9+3=12, col2 K+K match->0), got ${score}`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('All engine tests passed.');
}
