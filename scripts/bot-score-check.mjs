import { newGame, applyMove, currentPlayer } from '../public/rules.js';
import { pickBotMove } from '../public/bot.js';

function playOneRound(difficulties, deckCount, layout, seed) {
  const ids = difficulties.map((_, i) => `bot${i}`);
  let game = newGame({ playerIds: ids, deckCount, layout, seed });
  let moves = 0;
  while (game.phase !== 'roundEnd' && game.phase !== 'gameOver' && moves++ < 20000) {
    const pid = currentPlayer(game);
    const diff = difficulties[ids.indexOf(pid)];
    const move = pickBotMove(game, pid, diff);
    game = applyMove(game, pid, move);
  }
  return { scores: game.lastRoundScores, ids, difficulties };
}

const totals = { easy: 0, medium: 0, hard: 0 };
const counts = { easy: 0, medium: 0, hard: 0 };
const N = 2000;
for (let i = 0; i < N; i++) {
  const difficulties = ['easy', 'medium', 'hard'];
  const { scores, ids } = playOneRound(difficulties, 1, 'rows4', i * 13 + 3);
  ids.forEach((pid, idx) => {
    totals[difficulties[idx]] += scores[pid];
    counts[difficulties[idx]]++;
  });
}
for (const d of ['easy', 'medium', 'hard']) {
  console.log(`${d}: avg score ${(totals[d] / counts[d]).toFixed(2)} over ${counts[d]} rounds (lower is better)`);
}
