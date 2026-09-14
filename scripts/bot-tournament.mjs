import { newGame, applyMove, startNextRound, currentPlayer } from '../public/rules.js';
import { pickBotMove } from '../public/bot.js';

function playBotGame(numBots, deckCount, layout, seed, difficulties) {
  const ids = difficulties.map((_, i) => `bot${i}`);
  let game = newGame({ playerIds: ids, deckCount, layout, seed });
  let moves = 0;
  const cap = 20000;
  let playPhaseMoves = 0; // consecutive moves in 'play' with no caller yet this round
  while (game.phase !== 'gameOver' && moves++ < cap) {
    if (game.phase === 'roundEnd') { game = startNextRound(game, { seed: seed + moves }); playPhaseMoves = 0; continue; }
    const pid = currentPlayer(game);
    const diff = difficulties[ids.indexOf(pid)];
    // No one has completed their grid after many turns of "real" play — everyone is
    // being too cautious to ever end the round. Force the mover to commit.
    const move = pickBotMove(game, pid, diff, game.phase === 'play' && playPhaseMoves > 150);
    game = applyMove(game, pid, move);
    if (game.phase === 'play') playPhaseMoves++;
  }
  if (moves >= cap) throw new Error('bot game did not terminate');
  return game;
}

const wins = { easy: 0, medium: 0, hard: 0 };
const games = 300;
for (let i = 0; i < games; i++) {
  const difficulties = ['easy', 'medium', 'hard'];
  const game = playBotGame(3, 1, 'rows4', i * 7 + 1, difficulties);
  const survivor = game.order.find((pid) => !game.players[pid].out);
  if (survivor) wins[difficulties[game.order.indexOf(survivor)]]++;
}
console.log(`Over ${games} 3-bot games (easy/medium/hard):`, wins);
console.log('Hard should beat easy/medium noticeably more often than chance (1/3 each) if it is not.');
