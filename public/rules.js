// Kings (Golf-style card game) — pure game engine. No DOM, no network.
// applyMove(game, playerId, move) clones, validates, returns the next state (or throws).

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['S', 'H', 'D', 'C'];

export function rankValue(rank) {
  if (rank === 'K') return 0;
  if (rank === 'A') return 1;
  if (rank === 'J' || rank === 'Q') return 10;
  return parseInt(rank, 10);
}

function freshDeck(deckCount) {
  const cards = [];
  let id = 0;
  for (let d = 0; d < deckCount; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ id: `${rank}${suit}-${id++}`, rank, suit });
      }
    }
  }
  return cards;
}

// Deterministic-shuffle-by-seed so every client computes the same deal from the
// same seed instead of trusting a shuffle done on one device.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(cards, seed) {
  const rng = mulberry32(seed);
  const arr = cards.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function gridSize(layout) {
  return layout === 'rows3' ? 6 : 8; // rows3 = 2x3, rows4 = 2x4
}

// ---------------------------------------------------------------- setup

export function newGame({ playerIds, deckCount, layout, seed }) {
  if (playerIds.length < 2 || playerIds.length > 8) throw new Error('need 2-8 players');
  const size = gridSize(layout);
  const deck = shuffle(freshDeck(deckCount), seed);
  if (deck.length < playerIds.length * size + 1) throw new Error('not enough cards for this many players/deck count');

  const players = {};
  let cursor = 0;
  for (const pid of playerIds) {
    const cells = deck.slice(cursor, cursor + size).map((c) => ({ ...c, faceUp: false }));
    cursor += size;
    players[pid] = { cells, lives: 4, out: false };
  }
  const burnTop = deck[cursor++];
  const drawPile = deck.slice(cursor);

  const game = {
    layout,
    deckCount,
    order: playerIds.slice(),
    players,
    drawPile,
    burnPile: [burnTop],
    phase: 'reveal', // 'reveal' -> 'play' -> 'lastTurn' -> 'roundEnd' -> 'gameOver'
    dealer: 0, // index into order
    turnIndex: 0, // index into order (skips eliminated players) — set below to left of dealer
    revealed: {}, // playerId -> true once they've done their reveal flip
    caller: null, // playerId who went all-face-up first
    lastTurnRemaining: [], // playerIds still owed a final turn
    round: 1,
    lastRoundScores: null,
    holding: null, // { card, from: 'deck'|'burn' } — card the current player has drawn
  };
  game.turnIndex = nextTurnIndex(game, game.dealer);
  return game;
}

function activeOrder(game) {
  return game.order.filter((pid) => !game.players[pid].out);
}

function nextTurnIndex(game, fromIndex) {
  const order = game.order;
  const n = order.length;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    if (!game.players[order[idx]].out) return idx;
  }
  return fromIndex;
}

export function currentPlayer(game) {
  return game.order[game.turnIndex];
}

function columnIndices(layout, col) {
  const cols = layout === 'rows3' ? 3 : 4;
  if (col < 0 || col >= cols) throw new Error('bad column');
  return [col, col + cols]; // top row 0..cols-1, bottom row cols..2*cols-1
}

function allFaceUp(cells) {
  return cells.every((c) => c.faceUp);
}

function clone(game) {
  return JSON.parse(JSON.stringify(game));
}

// ---------------------------------------------------------------- moves

export function applyMove(gameIn, pid, move) {
  const game = clone(gameIn);
  if (game.phase === 'gameOver') throw new Error('game is over');
  if (game.players[pid]?.out) throw new Error('player is out');

  if (game.phase === 'reveal') return applyReveal(game, pid, move);
  if (game.phase === 'play' || game.phase === 'lastTurn') return applyPlay(game, pid, move);
  throw new Error(`no moves accepted in phase ${game.phase}`);
}

function applyReveal(game, pid, move) {
  if (currentPlayer(game) !== pid) throw new Error('not your turn');
  if (move.type !== 'revealColumn') throw new Error('must reveal a column');
  const cols = columnIndices(game.layout, move.col);
  const cells = game.players[pid].cells;
  for (const i of cols) cells[i].faceUp = true;
  game.revealed[pid] = true;

  const order = activeOrder(game);
  const doneCount = order.filter((p) => game.revealed[p]).length;
  if (doneCount >= order.length) {
    game.phase = 'play';
    game.turnIndex = nextTurnIndex(game, game.dealer);
  } else {
    game.turnIndex = nextTurnIndex(game, game.turnIndex);
  }
  return game;
}

function applyPlay(game, pid, move) {
  if (currentPlayer(game) !== pid) throw new Error('not your turn');

  if (move.type === 'draw') {
    if (game.holding) throw new Error('already holding a card, must play it first');
    if (move.from === 'deck') {
      if (game.drawPile.length === 0) reshuffleBurnIntoDraw(game);
      if (game.drawPile.length === 0) throw new Error('no cards left to draw');
      const card = game.drawPile.pop();
      game.holding = { card, from: 'deck' };
    } else if (move.from === 'burn') {
      if (game.burnPile.length === 0) throw new Error('burn pile is empty');
      const card = game.burnPile.pop();
      game.holding = { card, from: 'burn' };
    } else {
      throw new Error('bad draw source');
    }
    return game;
  }

  if (!game.holding) throw new Error('must draw before acting');

  if (move.type === 'discard') {
    if (game.holding.from === 'burn') throw new Error('a burn-pile card must be swapped in');
    game.burnPile.push(game.holding.card);
    game.holding = null;
    advanceTurnAfterAction(game, pid);
    return game;
  }

  if (move.type === 'swap') {
    const cells = game.players[pid].cells;
    if (move.index < 0 || move.index >= cells.length) throw new Error('bad cell index');
    const removed = cells[move.index];
    cells[move.index] = { ...game.holding.card, faceUp: true };
    game.burnPile.push({ id: removed.id, rank: removed.rank, suit: removed.suit });
    game.holding = null;
    checkAllFaceUp(game, pid);
    advanceTurnAfterAction(game, pid);
    return game;
  }

  throw new Error(`unknown move ${move.type}`);
}

function reshuffleBurnIntoDraw(game) {
  if (game.burnPile.length <= 1) return; // keep the visible top card
  const top = game.burnPile.pop();
  game.drawPile = shuffle(game.burnPile, Date.now() % 2147483647);
  game.burnPile = [top];
}

function checkAllFaceUp(game, pid) {
  if (game.caller) return; // someone already called it
  if (allFaceUp(game.players[pid].cells)) {
    game.caller = pid;
    game.phase = 'lastTurn';
    game.lastTurnRemaining = activeOrder(game).filter((p) => p !== pid);
  }
}

function advanceTurnAfterAction(game, pid) {
  if (game.phase === 'lastTurn') {
    game.lastTurnRemaining = game.lastTurnRemaining.filter((p) => p !== pid);
    if (game.lastTurnRemaining.length === 0) {
      finishRound(game);
      return;
    }
  }
  game.turnIndex = nextTurnIndex(game, game.turnIndex);
}

// ---------------------------------------------------------------- scoring

export function columnScore(cells, layout, col) {
  const [a, b] = columnIndices(layout, col);
  const ca = cells[a];
  const cb = cells[b];
  if (ca.rank === cb.rank) return 0;
  return rankValue(ca.rank) + rankValue(cb.rank);
}

export function playerScore(cells, layout) {
  const cols = layout === 'rows3' ? 3 : 4;
  let total = 0;
  for (let c = 0; c < cols; c++) total += columnScore(cells, layout, c);
  return total;
}

function finishRound(game) {
  // reveal everything for scoring
  for (const pid of game.order) {
    if (game.players[pid].out) continue;
    for (const cell of game.players[pid].cells) cell.faceUp = true;
  }
  const scores = {};
  for (const pid of activeOrder(game)) scores[pid] = playerScore(game.players[pid].cells, game.layout);

  const maxScore = Math.max(...Object.values(scores));
  const losers = Object.keys(scores).filter((pid) => scores[pid] === maxScore);
  for (const pid of losers) {
    game.players[pid].lives -= 1;
    if (game.players[pid].lives <= 0) game.players[pid].out = true;
  }

  game.lastRoundScores = scores;
  const remaining = activeOrder(game);
  game.phase = remaining.length <= 1 ? 'gameOver' : 'roundEnd';
}

// ---------------------------------------------------------------- next round

export function startNextRound(gameIn, { seed } = {}) {
  const game = clone(gameIn);
  if (game.phase !== 'roundEnd') throw new Error('round is not over');
  const remaining = activeOrder(game);
  const size = gridSize(game.layout);
  const deck = shuffle(freshDeck(game.deckCount), seed);
  if (deck.length < remaining.length * size + 1) throw new Error('not enough cards for this many players/deck count');

  let cursor = 0;
  for (const pid of remaining) {
    game.players[pid].cells = deck.slice(cursor, cursor + size).map((c) => ({ ...c, faceUp: false }));
    cursor += size;
  }
  const burnTop = deck[cursor++];
  game.drawPile = deck.slice(cursor);
  game.burnPile = [burnTop];
  game.phase = 'reveal';
  game.revealed = {};
  game.caller = null;
  game.lastTurnRemaining = [];
  game.holding = null;
  game.round += 1;
  game.dealer = nextTurnIndex(game, game.dealer);
  game.turnIndex = nextTurnIndex(game, game.dealer);
  return game;
}
