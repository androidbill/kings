import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, set, get, update, onValue, runTransaction, onDisconnect,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { WORD_CODES } from './wordcodes.js';
import { APP_VERSION } from './version.js';
import { CARD_BACKS, cardBackById } from './cardbacks.js';
import {
  newGame, applyMove, startNextRound, currentPlayer, gridSize,
} from './rules.js';
import { pickBotMove } from './bot.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ---------------------------------------------------------------- identity
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
let playerId = localStorage.getItem('kings_pid');
if (!playerId) { playerId = uid(); localStorage.setItem('kings_pid', playerId); }
let myName = localStorage.getItem('kings_name') || '';

// ---------------------------------------------------------------- dom helpers
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SCREENS = ['screen-home', 'screen-join', 'screen-lobby', 'screen-solo-setup', 'screen-game', 'screen-rules'];
function showScreen(id) {
  for (const s of SCREENS) (s === id ? show : hide)($(s));
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), 3000);
}

// ---------------------------------------------------------------- kebab / about
$('kebab-btn').addEventListener('click', () => $('kebab-menu').classList.toggle('hidden'));
document.addEventListener('click', (e) => {
  if (!$('kebab-menu').contains(e.target) && e.target !== $('kebab-btn')) hide($('kebab-menu'));
});
$('menu-refresh').addEventListener('click', async () => {
  toast('Updating…');
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    for (const r of regs || []) await r.unregister();
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
  } catch { /* ignore */ }
  location.reload();
});
$('menu-share').addEventListener('click', async () => {
  const url = location.href.split('?')[0] + (currentRoomCode ? `?room=${currentRoomCode}` : '');
  try {
    if (navigator.share) await navigator.share({ title: 'Kings', url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch { /* cancelled */ }
});
$('menu-about').addEventListener('click', () => { $('about-version').textContent = `Version ${APP_VERSION}`; show($('about-modal')); });
$('about-close').addEventListener('click', () => hide($('about-modal')));

for (const btn of document.querySelectorAll('.back-btn')) {
  btn.addEventListener('click', () => { leaveRoom(); showScreen(btn.dataset.back); });
}

// ---------------------------------------------------------------- install banner
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!$('screen-home').classList.contains('hidden')) show($('install-banner'));
});
$('btn-install').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  hide($('install-banner'));
});

// ---------------------------------------------------------------- version check
async function checkVersion() {
  try {
    const res = await fetch(`version.js?t=${Date.now()}`, { cache: 'no-store' });
    const text = await res.text();
    const match = text.match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (match && match[1] !== APP_VERSION) toast('A new version is available — tap ⋮ → Refresh');
  } catch { /* offline */ }
}
checkVersion();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });

// ---------------------------------------------------------------- service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});
}

// ================================================================== ROOM / ONLINE STATE
let currentRoomCode = null;
let roomUnsub = null;
let latestRoom = null;
let isHost = false;
let soloMode = null; // { botCount, difficulties: [] } when playing solo
let selectedCardBack = localStorage.getItem('kings_cardback') || 'classic';

function roomRef(code, ...path) { return ref(db, ['rooms', code, ...path].join('/')); }

function randomCode() {
  return WORD_CODES[Math.floor(Math.random() * WORD_CODES.length)];
}

async function createRoom(name) {
  myName = name; localStorage.setItem('kings_name', name);
  let code;
  for (let tries = 0; tries < 20; tries++) {
    code = randomCode();
    const snap = await get(roomRef(code));
    if (!snap.exists()) break;
  }
  const room = {
    createdAt: Date.now(),
    hostId: playerId,
    status: 'lobby',
    settings: { deckCount: 1, layout: 'rows4', cardBack: selectedCardBack },
    players: { [playerId]: { name: myName, joinedAt: Date.now() } },
    order: [playerId],
  };
  await set(roomRef(code), room);
  enterRoom(code, true);
}

async function joinRoom(code, name) {
  code = code.trim().toUpperCase();
  const snap = await get(roomRef(code));
  if (!snap.exists()) { toast('Room not found'); return; }
  const room = snap.val();
  if (room.status !== 'lobby') { toast('That game has already started'); return; }
  myName = name; localStorage.setItem('kings_name', name);
  await update(roomRef(code, 'players', playerId), { name: myName, joinedAt: Date.now() });
  await runTransaction(roomRef(code, 'order'), (order) => {
    order = order || [];
    if (!order.includes(playerId)) order.push(playerId);
    return order;
  });
  enterRoom(code, false);
}

function enterRoom(code, hosting) {
  currentRoomCode = code;
  isHost = hosting;
  localStorage.setItem('kings_room', code);
  onDisconnect(roomRef(code, 'players', playerId, 'left')).set(true);
  if (roomUnsub) roomUnsub();
  roomUnsub = onValue(roomRef(code), (snap) => {
    latestRoom = snap.val();
    if (!latestRoom) { toast('Room closed'); leaveRoom(); showScreen('screen-home'); return; }
    isHost = latestRoom.hostId === playerId;
    renderRoom();
  });
}

function leaveRoom() {
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  currentRoomCode = null;
  latestRoom = null;
  soloMode = null;
  localStorage.removeItem('kings_room');
}

function renderRoom() {
  if (!latestRoom) return;
  if (latestRoom.status === 'lobby') { renderLobby(); showScreen('screen-lobby'); return; }
  if (latestRoom.status === 'active' || latestRoom.status === 'ended') { renderGame(); showScreen('screen-game'); return; }
}

// ---------------------------------------------------------------- lobby
function renderLobby() {
  const room = latestRoom;
  $('lobby-code').textContent = currentRoomCode;
  const order = room.order || [];
  $('lobby-players').innerHTML = order.map((pid) => {
    const p = room.players?.[pid];
    if (!p || p.left) return '';
    const hostCls = pid === room.hostId ? ' is-host' : '';
    return `<span class="lobby-player-chip${hostCls}">${esc(p.name || '?')}</span>`;
  }).join('');

  $('set-deck-count').value = String(room.settings.deckCount);
  $('set-layout').value = room.settings.layout;
  renderCardBackPicker($('lobby-cardback-picker'), room.settings.cardBack, isHost, (id) => {
    update(roomRef(currentRoomCode, 'settings'), { cardBack: id });
  });
  $('set-deck-count').disabled = !isHost;
  $('set-layout').disabled = !isHost;

  const activeCount = order.filter((pid) => room.players?.[pid] && !room.players[pid].left).length;
  if (isHost) {
    show($('lobby-start'));
    hide($('lobby-wait-msg'));
    $('lobby-start').disabled = activeCount < 2;
    $('lobby-start').textContent = activeCount < 2 ? 'Waiting for players…' : 'Start Game';
  } else {
    hide($('lobby-start'));
    show($('lobby-wait-msg'));
  }
}

function renderCardBackPicker(container, selectedId, editable, onPick) {
  container.innerHTML = CARD_BACKS.map((b) => {
    const bg = b.file ? `style="background-image:url('${b.file}')"` : '';
    const sel = b.id === selectedId ? ' selected' : '';
    return `<div class="cardback-option${sel}" data-id="${b.id}" title="${esc(b.name)}" ${bg}></div>`;
  }).join('');
  if (editable) {
    for (const el of container.querySelectorAll('.cardback-option')) {
      el.addEventListener('click', () => onPick(el.dataset.id));
    }
  }
}

$('set-deck-count').addEventListener('change', (e) => {
  if (isHost) update(roomRef(currentRoomCode, 'settings'), { deckCount: parseInt(e.target.value, 10) });
});
$('set-layout').addEventListener('change', (e) => {
  if (isHost) update(roomRef(currentRoomCode, 'settings'), { layout: e.target.value });
});

$('lobby-start').addEventListener('click', async () => {
  const room = latestRoom;
  const order = (room.order || []).filter((pid) => room.players?.[pid] && !room.players[pid].left);
  const size = gridSize(room.settings.layout);
  if (order.length * size + 1 > room.settings.deckCount * 52) {
    toast(`Not enough cards for ${order.length} players — add a deck or use a smaller grid`);
    return;
  }
  const game = newGame({ playerIds: order, deckCount: room.settings.deckCount, layout: room.settings.layout, seed: Date.now() % 2147483647 });
  await update(roomRef(currentRoomCode), { status: 'active', order, game });
});

// ---------------------------------------------------------------- moves (online)
async function sendMove(move) {
  if (soloMode) { applySoloMove(move); return; }
  const gref = roomRef(currentRoomCode, 'game');
  let result;
  await runTransaction(gref, (game) => {
    if (!game) return game;
    try { result = applyMove(game, playerId, move); return result; }
    catch (err) { result = { error: err.message }; return game; }
  });
  if (result?.error) toast(result.error);
}

async function requestNextRound() {
  if (soloMode) { soloState = startNextRound(soloState, { seed: Date.now() % 2147483647 }); renderSoloGame(); scheduleBotTurn(); return; }
  const gref = roomRef(currentRoomCode, 'game');
  await runTransaction(gref, (game) => {
    if (!game || game.phase !== 'roundEnd') return game;
    return startNextRound(game, { seed: Date.now() % 2147483647 });
  });
}

// ================================================================== SOLO MODE
let soloState = null;
let soloIds = [];
let soloBotDifficulty = {};
let botTimer = null;

function startSolo({ botCount, difficulties, deckCount, layout }) {
  soloIds = ['you', ...difficulties.map((_, i) => `bot${i + 1}`)];
  soloBotDifficulty = {};
  difficulties.forEach((d, i) => { soloBotDifficulty[`bot${i + 1}`] = d; });
  playerId = 'you';
  myName = 'You';
  soloMode = { botCount, difficulties };
  currentRoomCode = null;
  soloState = newGame({ playerIds: soloIds, deckCount, layout, seed: Date.now() % 2147483647 });
  soloPlayPhaseMoves = 0;
  showScreen('screen-game');
  renderSoloGame();
  scheduleBotTurn();
}

let soloPlayPhaseMoves = 0;
function applySoloMove(move) {
  try {
    const before = soloState.phase;
    soloState = applyMove(soloState, 'you', move);
    if (soloState.phase === 'play' && before === 'play') soloPlayPhaseMoves++; else soloPlayPhaseMoves = 0;
  } catch (err) { toast(err.message); return; }
  renderSoloGame();
  scheduleBotTurn();
}

function scheduleBotTurn() {
  clearTimeout(botTimer);
  if (!soloState || soloState.phase === 'gameOver' || soloState.phase === 'roundEnd') return;
  const pid = currentPlayer(soloState);
  if (pid === 'you') return;
  botTimer = setTimeout(() => {
    const diff = soloBotDifficulty[pid];
    const before = soloState.phase;
    const forceProgress = soloState.phase === 'play' && soloPlayPhaseMoves > 150;
    const move = pickBotMove(soloState, pid, diff, forceProgress);
    try { soloState = applyMove(soloState, pid, move); }
    catch { /* shouldn't happen; skip */ }
    if (soloState.phase === 'play' && before === 'play') soloPlayPhaseMoves++; else soloPlayPhaseMoves = 0;
    renderSoloGame();
    scheduleBotTurn();
  }, 600 + Math.random() * 500);
}

function renderSoloGame() {
  renderGameCommon(soloState, soloIds, 'you', { [playerId]: { name: 'You' }, ...Object.fromEntries(soloIds.slice(1).map((id, i) => [id, { name: `Bot ${i + 1} (${soloBotDifficulty[id]})` }])) }, selectedCardBack);
}

// ================================================================== GAME RENDERING (shared)
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED_SUITS = new Set(['H', 'D']);

function cardBackStyle(cardBackId) {
  const b = cardBackById(cardBackId);
  return b.file ? `background-image:url('${b.file}')` : '';
}

function renderGame() {
  if (!latestRoom || !latestRoom.game) return;
  const room = latestRoom;
  const names = room.players || {};
  renderGameCommon(room.game, room.order, playerId, names, room.settings.cardBack);
}

function renderGameCommon(game, order, myId, names, cardBackId) {
  const cols = game.layout === 'rows3' ? 3 : 4;
  const me = game.players[myId];

  $('game-round-info').textContent = `Round ${game.round}`;
  const curPid = currentPlayer(game);
  const isMyTurn = curPid === myId && game.phase !== 'roundEnd' && game.phase !== 'gameOver';
  $('game-turn-info').textContent = game.phase === 'roundEnd' || game.phase === 'gameOver'
    ? '' : (isMyTurn ? 'Your turn' : `${esc(names[curPid]?.name || '?')}'s turn`);

  // opponents strip
  const others = order.filter((pid) => pid !== myId);
  $('opponents').innerHTML = others.map((pid) => {
    const p = game.players[pid];
    if (!p) return '';
    const isTurn = pid === curPid ? ' is-turn' : '';
    const outCls = p.out ? ' is-out' : '';
    const gridCols = game.layout === 'rows3' ? 3 : 4;
    const cells = p.cells.map((c) => cardMiniHtml(c, cardBackId)).join('');
    return `<div class="opponent${isTurn}${outCls}">
      <div class="opponent-name">${esc(names[pid]?.name || '?')}</div>
      <div class="opponent-lives">${'❤'.repeat(Math.max(0, p.lives))}</div>
      <div class="opponent-grid" style="grid-template-columns:repeat(${gridCols},1fr)">${cells}</div>
    </div>`;
  }).join('');

  // piles
  const drawCount = game.drawPile.length;
  $('deck-count').textContent = drawCount;
  const deckPile = $('pile-deck');
  deckPile.classList.toggle('disabled', !(isMyTurn && !game.holding));
  const backStyle = cardBackStyle(cardBackId);
  deckPile.querySelector('.card-back').setAttribute('style', backStyle);

  const burnTop = game.burnPile[game.burnPile.length - 1];
  const burnPile = $('pile-burn');
  burnPile.innerHTML = burnTop ? cardFaceHtml(burnTop) : '<div class="card-back" style="visibility:hidden"></div>';
  burnPile.classList.toggle('disabled', !(isMyTurn && !game.holding && game.burnPile.length > 0));

  const holdingSlot = $('holding-slot');
  if (game.holding && curPid === myId) {
    holdingSlot.innerHTML = cardFaceHtml(game.holding.card);
    show(holdingSlot);
  } else hide(holdingSlot);

  // act prompt
  let prompt = '';
  if (game.phase === 'reveal') {
    prompt = curPid === myId ? 'Pick one column to flip face up' : `Waiting on ${esc(names[curPid]?.name || '?')}`;
  } else if (isMyTurn) {
    if (!game.holding) prompt = 'Draw from the deck or the burn pile';
    else if (game.holding.from === 'burn') prompt = 'Tap one of your cards to swap it in';
    else prompt = 'Tap a card to swap, or discard';
  } else if (game.phase !== 'roundEnd' && game.phase !== 'gameOver') {
    prompt = `Waiting on ${esc(names[curPid]?.name || '?')}`;
  }
  if (game.phase === 'lastTurn' && curPid !== game.caller) prompt += ' (final turn!)';
  $('act-prompt').textContent = prompt;

  // my grid
  $('my-name').textContent = me?.out ? `${names[myId]?.name || 'You'} (out)` : (names[myId]?.name || 'You');
  const myGrid = $('my-grid');
  myGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  myGrid.innerHTML = me.cells.map((c, idx) => {
    const canRevealCol = game.phase === 'reveal' && curPid === myId;
    const canSwap = isMyTurn && game.holding;
    let inner;
    if (c.faceUp) {
      const red = RED_SUITS.has(c.suit) ? ' red' : '';
      inner = `<div class="card-face${red}${canSwap ? ' swap-target' : ''}"><span class="rank">${esc(c.rank)}</span><span class="suit">${SUIT_SYMBOL[c.suit]}</span></div>`;
    } else {
      inner = `<div class="card-back${canRevealCol ? ' reveal-target' : ''}" style="${backStyle}"></div>`;
    }
    return `<div class="cell-wrap" data-idx="${idx}">${inner}</div>`;
  }).join('');

  wireGameInteractions(game, myId, isMyTurn, cols);

  // round end / game over overlays
  if (game.phase === 'roundEnd') {
    show($('round-end-panel'));
    $('round-end-scores').innerHTML = order.filter((pid) => game.lastRoundScores[pid] !== undefined).map((pid) => {
      const score = game.lastRoundScores[pid];
      const maxScore = Math.max(...Object.values(game.lastRoundScores));
      const isLoser = score === maxScore;
      return `<div class="score-row${isLoser ? ' is-loser' : ''}">
        <span>${esc(names[pid]?.name || '?')}</span>
        <span>${score} pts</span>
        <span class="lives">${'❤'.repeat(Math.max(0, game.players[pid].lives))}</span>
      </div>`;
    }).join('');
    const iAmHostOrSolo = soloMode || isHost;
    $('round-end-next').classList.toggle('hidden', !iAmHostOrSolo);
    $('round-end-wait').classList.toggle('hidden', !!iAmHostOrSolo);
  } else hide($('round-end-panel'));

  if (game.phase === 'gameOver') {
    show($('gameover-panel'));
    const survivor = order.find((pid) => !game.players[pid].out);
    $('gameover-title').textContent = survivor
      ? (survivor === myId ? 'You Win!' : `${esc(names[survivor]?.name || '?')} Wins!`)
      : 'Everyone is out — no winner';
    $('gameover-standings').innerHTML = order.map((pid) => {
      const p = game.players[pid];
      return `<div class="score-row"><span>${esc(names[pid]?.name || '?')}</span><span>${'❤'.repeat(Math.max(0, p.lives))}${p.out ? ' (out)' : ''}</span></div>`;
    }).join('');
  } else hide($('gameover-panel'));
}

function cardFaceHtml(card) {
  const red = RED_SUITS.has(card.suit) ? ' red' : '';
  return `<div class="card-face${red}"><span class="rank">${esc(card.rank)}</span><span class="suit">${SUIT_SYMBOL[card.suit]}</span></div>`;
}
function cardMiniHtml(cell, cardBackId) {
  if (!cell.faceUp) return `<div class="mini-card" style="${cardBackStyle(cardBackId)}"></div>`;
  const red = RED_SUITS.has(cell.suit) ? ' red' : '';
  return `<div class="mini-card faceup${red}">${esc(cell.rank)}</div>`;
}

function wireGameInteractions(game, myId, isMyTurn, cols) {
  $('pile-deck').onclick = () => { if (isMyTurn && !game.holding) sendMove({ type: 'draw', from: 'deck' }); };
  $('pile-burn').onclick = () => { if (isMyTurn && !game.holding && game.burnPile.length) sendMove({ type: 'draw', from: 'burn' }); };

  for (const el of document.querySelectorAll('#my-grid .cell-wrap')) {
    el.onclick = () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (game.phase === 'reveal' && currentPlayer(game) === myId) {
        const col = idx % cols;
        sendMove({ type: 'revealColumn', col });
      } else if (isMyTurn && game.holding) {
        sendMove({ type: 'swap', index: idx });
      }
    };
  }
}

$('round-end-next').addEventListener('click', () => requestNextRound());
$('gameover-home').addEventListener('click', () => { leaveRoom(); showScreen('screen-home'); });

// discard action: tapping the holding card discards it (only valid if not from burn)
$('holding-slot').addEventListener('click', () => {
  const game = soloMode ? soloState : latestRoom?.game;
  if (!game?.holding) return;
  if (game.holding.from === 'burn') { toast("You must swap in a card taken from the burn pile"); return; }
  sendMove({ type: 'discard' });
});

// ================================================================== HOME / NAV
$('btn-host').addEventListener('click', () => {
  showScreen('screen-join');
  $('screen-join').dataset.mode = 'host';
  $('join-code').classList.add('hidden');
  $('join-name').value = myName;
  $('join-submit').textContent = 'Create Room';
});
$('btn-join').addEventListener('click', () => {
  showScreen('screen-join');
  $('screen-join').dataset.mode = 'join';
  $('join-code').classList.remove('hidden');
  $('join-name').value = myName;
  $('join-submit').textContent = 'Join';
});
$('join-submit').addEventListener('click', async () => {
  const name = $('join-name').value.trim() || 'Player';
  if ($('screen-join').dataset.mode === 'host') await createRoom(name);
  else {
    const code = $('join-code').value.trim();
    if (!code) { toast('Enter a room code'); return; }
    await joinRoom(code, name);
  }
});
$('btn-rules').addEventListener('click', () => showScreen('screen-rules'));

// ---------------------------------------------------------------- solo setup
function renderSoloBotOptions() {
  const count = parseInt($('solo-bot-count').value, 10);
  const saved = JSON.parse(localStorage.getItem('kings_solo_diff') || '["medium","medium","medium"]');
  $('solo-bot-difficulties').innerHTML = Array.from({ length: count }, (_, i) => `
    <label>Bot ${i + 1} difficulty
      <select data-bot-idx="${i}">
        <option value="easy"${saved[i] === 'easy' ? ' selected' : ''}>Easy</option>
        <option value="medium"${(!saved[i] || saved[i] === 'medium') ? ' selected' : ''}>Medium</option>
        <option value="hard"${saved[i] === 'hard' ? ' selected' : ''}>Hard</option>
      </select>
    </label>`).join('');
}
function pickSoloCardBack(id) {
  selectedCardBack = id; localStorage.setItem('kings_cardback', id);
  renderCardBackPicker($('solo-cardback-picker'), selectedCardBack, true, pickSoloCardBack);
}
$('btn-solo').addEventListener('click', () => {
  renderSoloBotOptions();
  renderCardBackPicker($('solo-cardback-picker'), selectedCardBack, true, pickSoloCardBack);
  showScreen('screen-solo-setup');
});
$('solo-bot-count').addEventListener('change', renderSoloBotOptions);
$('solo-start').addEventListener('click', () => {
  const botCount = parseInt($('solo-bot-count').value, 10);
  const difficulties = Array.from({ length: botCount }, (_, i) => {
    const sel = document.querySelector(`[data-bot-idx="${i}"]`);
    return sel ? sel.value : 'medium';
  });
  localStorage.setItem('kings_solo_diff', JSON.stringify(difficulties));
  const deckCount = parseInt($('solo-deck-count').value, 10);
  const layout = $('solo-layout').value;
  const size = gridSize(layout);
  if ((botCount + 1) * size + 1 > deckCount * 52) {
    toast('Not enough cards for that many players — add a deck or use a smaller grid');
    return;
  }
  startSolo({ botCount, difficulties, deckCount, layout });
});

// ---------------------------------------------------------------- boot / resume
(function boot() {
  const params = new URLSearchParams(location.search);
  const roomFromLink = params.get('room');
  const savedRoom = localStorage.getItem('kings_room');
  const roomToResume = roomFromLink || savedRoom;
  if (roomToResume && myName) {
    get(roomRef(roomToResume)).then((snap) => {
      if (snap.exists()) {
        const room = snap.val();
        if (room.players?.[playerId]) { enterRoom(roomToResume, room.hostId === playerId); return; }
      }
      showScreen('screen-home');
    }).catch(() => showScreen('screen-home'));
  } else {
    showScreen('screen-home');
  }
})();
