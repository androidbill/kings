// Kings bot brain — a pure function per difficulty. A bot's move goes through the
// same applyMove() a human tap does, so it cannot see anything a human couldn't:
// its own cells, its own drawn/holding card, and everything already face up on the
// table (every player's revealed cells + the burn pile) — the same "cards already
// seen" a sharp human could track by eye. It never peeks at the draw pile or another
// player's face-down cells.
import { rankValue, RANKS, SUITS, layoutCols } from './rules.js';

function fullDeckComposition(deckCount) {
  const counts = {};
  for (const r of RANKS) counts[r] = SUITS.length * deckCount;
  return counts;
}

// The real skill differentiator: hard bots count every card that has been seen face
// up anywhere on the table (across ALL players, plus the burn pile) to compute the
// true expected value of an unknown card in what's left. Medium bots only count
// their own face-up cells and the burn pile (a human tracking just their own hand).
// Easy bots don't count at all — flat deck-average guess with noise.
function unseenAverage(game, pid, difficulty) {
  if (difficulty === 'easy') return 5.05 + (Math.random() * 3 - 1.5);

  const counts = fullDeckComposition(game.deckCount);
  const consume = (rank) => { if (counts[rank] > 0) counts[rank]--; };

  for (const card of game.burnPile) consume(card.rank);
  if (game.holding) consume(game.holding.card.rank);

  const playersToScan = difficulty === 'hard' ? game.order : [pid];
  for (const otherPid of playersToScan) {
    const p = game.players[otherPid];
    if (!p) continue;
    for (const cell of p.cells) if (cell.faceUp) consume(cell.rank);
  }

  let totalCount = 0, totalValue = 0;
  for (const r of RANKS) { totalCount += counts[r]; totalValue += counts[r] * rankValue(r); }
  return totalCount > 0 ? totalValue / totalCount : 5.05;
}

export function botRevealMove(game, pid, difficulty) {
  const cols = layoutCols(game.layout);
  if (difficulty === 'hard') return { type: 'revealColumn', col: Math.floor(cols / 2) };
  return { type: 'revealColumn', col: Math.floor(Math.random() * cols) };
}

export function botDrawMove(game, pid, difficulty) {
  const burnTop = game.burnPile[game.burnPile.length - 1];
  if (!burnTop) return { type: 'draw', from: 'deck' };

  const cells = game.players[pid].cells;
  const burnVal = rankValue(burnTop.rank);
  const cols = layoutCols(game.layout);

  // Always grab it if it completes a column match (instant zero).
  for (let c = 0; c < cols; c++) {
    const a = cells[c], b = cells[c + cols];
    if ((a.faceUp && a.rank === burnTop.rank) || (b.faceUp && b.rank === burnTop.rank)) {
      return { type: 'draw', from: 'burn' };
    }
  }

  const unseen = unseenAverage(game, pid, difficulty);
  const worstFaceUp = cells.filter((c) => c.faceUp)
    .sort((x, y) => rankValue(y.rank) - rankValue(x.rank))[0];
  const worstKnownVal = worstFaceUp ? rankValue(worstFaceUp.rank) : Infinity;
  // Worth it if the burn card beats either our worst known cell or a typical unknown one.
  if (burnVal < Math.max(worstKnownVal, unseen)) return { type: 'draw', from: 'burn' };
  return { type: 'draw', from: 'deck' };
}

// forceProgress: true means the caller has detected a long stall (no player's
// face-down count has dropped in a while) and this bot should stop being picky and
// commit to flipping something, so a round can never hang forever. Normal play
// never sets this — it only kicks in as a last-resort escape hatch.
export function botActMove(game, pid, difficulty, forceProgress = false) {
  const held = game.holding.card;
  const heldVal = rankValue(held.rank);
  const cells = game.players[pid].cells;
  const cols = layoutCols(game.layout);
  const unseen = unseenAverage(game, pid, difficulty);
  const mustSwap = game.holding.from === 'burn';

  let bestIndex = -1, bestGain = mustSwap ? -Infinity : 0;
  let bestFaceDownIndex = -1, bestFaceDownGain = -Infinity;
  for (let idx = 0; idx < cells.length; idx++) {
    const cell = cells[idx];
    const partnerIdx = idx < cols ? idx + cols : idx - cols;
    const partner = cells[partnerIdx];
    let gain;
    if (partner.faceUp && partner.rank === held.rank) gain = 1000; // instant zero column
    else if (!cell.faceUp) gain = unseen - heldVal;
    else gain = rankValue(cell.rank) - heldVal;

    // Easy bots occasionally misjudge a swap (small noise), simulating imperfect play.
    if (difficulty === 'easy') gain += Math.random() * 2 - 1;

    if (!cell.faceUp && gain > bestFaceDownGain) { bestFaceDownGain = gain; bestFaceDownIndex = idx; }
    if (gain > bestGain) { bestGain = gain; bestIndex = idx; }
  }

  // A real stall was detected — stop optimizing and commit to finishing the grid,
  // even if some other cell would technically be a bigger "gain".
  if (forceProgress && bestFaceDownIndex !== -1) return { type: 'swap', index: bestFaceDownIndex };

  if (bestIndex === -1) return { type: 'discard' };
  return { type: 'swap', index: bestIndex };
}

export function pickBotMove(game, pid, difficulty, forceProgress = false) {
  if (!game.revealed[pid]) return botRevealMove(game, pid, difficulty);
  if (!game.holding) return botDrawMove(game, pid, difficulty);
  return botActMove(game, pid, difficulty, forceProgress);
}
