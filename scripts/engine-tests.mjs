import { newGame, applyMove, startNextRound, currentPlayer, playerScore, visibleScore } from '../public/rules.js';

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
    if (!game.revealed[pid]) {
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

// a player's remaining face-down cells reveal immediately after THEIR final turn,
// not only once every other player has also finished
{
  const ids = ['a', 'b', 'c'];
  let game = newGame({ playerIds: ids, deckCount: 1, layout: 'rows3', seed: 42 });
  // hand-craft: 'a' has already revealed and is about to complete their grid (one
  // face-down cell left); b and c haven't taken their first turn yet this round.
  game.phase = 'play';
  game.turnIndex = game.order.indexOf('a');
  game.revealed = { a: true };
  game.players.a.cells = [
    { id: 'x1', rank: '5', suit: 'S', faceUp: true }, { id: 'x2', rank: '9', suit: 'H', faceUp: true }, { id: 'x3', rank: '2', suit: 'D', faceUp: false },
    { id: 'x4', rank: '5', suit: 'C', faceUp: true }, { id: 'x5', rank: '3', suit: 'S', faceUp: true }, { id: 'x6', rank: 'K', suit: 'H', faceUp: true },
  ];
  game.players.b.cells = game.players.b.cells.map((c) => ({ ...c, faceUp: false }));
  game.drawPile.push({ id: 'draw1', rank: '4', suit: 'C' });
  game = applyMove(game, 'a', { type: 'draw', from: 'deck' });
  game = applyMove(game, 'a', { type: 'swap', index: 2 }); // completes a's grid -> caller, lastTurn begins
  check(game.phase === 'lastTurn', 'completing a grid moves phase to lastTurn');
  check(game.caller === 'a', 'a is recorded as caller');
  check(game.lastTurnRemaining.includes('b') && game.lastTurnRemaining.includes('c'), 'b and c owed a final turn');
  check(game.players.b.cells.every((c) => !c.faceUp), "b's hand is still hidden before their final turn");

  // b hasn't revealed yet this round — their final turn is reveal-then-play, same
  // as a normal first turn, and afterward their whole hand reveals regardless.
  game.drawPile.push({ id: 'draw2', rank: '9', suit: 'D' });
  game = applyMove(game, 'b', { type: 'revealColumn', col: 0 });
  check(game.phase === 'lastTurn' && currentPlayer(game) === 'b', "b's reveal doesn't end their turn — they still owe a draw/act");
  game = applyMove(game, 'b', { type: 'draw', from: 'deck' });
  game = applyMove(game, 'b', { type: 'discard' });
  check(game.players.b.cells.every((c) => c.faceUp), "b's whole hand reveals right after b's final turn, even though b only discarded");
  check(game.phase === 'lastTurn', 'round is not over yet — c still owed a final turn');
  check(game.players.c.cells.some((c) => !c.faceUp), "c's hand is untouched until c's own final turn");
}

// a player's first turn is reveal-then-play in one turn, not a separate go-around
{
  const ids = ['a', 'b', 'c'];
  let game = newGame({ playerIds: ids, deckCount: 1, layout: 'rows4', seed: 5 });
  const first = currentPlayer(game);
  check(!game.revealed[first], 'nobody has revealed yet at round start');
  try {
    applyMove(game, first, { type: 'draw', from: 'deck' });
    check(false, 'drawing before revealing should throw');
  } catch { /* expected */ }
  game = applyMove(game, first, { type: 'revealColumn', col: 0 });
  check(currentPlayer(game) === first, "revealing doesn't pass the turn — same player continues");
  check(game.revealed[first], 'player marked revealed after their reveal move');
  try {
    applyMove(game, first, { type: 'revealColumn', col: 1 });
    check(false, 'revealing a second column on the same turn should throw');
  } catch { /* expected */ }
  game = applyMove(game, first, { type: 'draw', from: 'deck' });
  game = applyMove(game, first, { type: 'discard' });
  check(currentPlayer(game) !== first, "turn passes to the next player only after reveal + a full play action");
  const second = currentPlayer(game);
  check(!game.revealed[second], 'second player has not revealed yet — their turn also starts with a reveal');
}

// visibleScore only counts what's currently face up
{
  const cells = [
    { rank: '5', suit: 'S', faceUp: true }, { rank: '9', suit: 'H', faceUp: false }, { rank: 'K', suit: 'D', faceUp: true },
    { rank: '5', suit: 'C', faceUp: true }, { rank: '3', suit: 'S', faceUp: false }, { rank: 'K', suit: 'H', faceUp: true },
  ];
  const vs = visibleScore(cells, 'rows3');
  // col0: 5(up)+9(down) -> only 5 counts = 5; col1: K+3 both partial... wait col1 is index1&4
  // columns for rows3: col0=[0,3]=5,5 match->0; col1=[1,4]=9(down),3(down)->0 visible; col2=[2,5]=K,K match->0
  check(vs.total === 0, `visibleScore: col0 5/5 both up match->0, col1 both hidden->0, col2 K/K both up match->0, got ${vs.total}`);
  check(vs.hiddenCount === 2, `visibleScore counts 2 hidden cells, got ${vs.hiddenCount}`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log('All engine tests passed.');
}
