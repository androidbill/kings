import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, set, get, update, onValue, runTransaction, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { WORD_CODES } from './wordcodes.js';
import { APP_VERSION } from './version.js';
import { CARD_BACKS, cardBackById } from './cardbacks.js';
import {
  newGame, applyMove, startNextRound, currentPlayer, gridSize, visibleScore,
} from './rules.js';
import { pickBotMove } from './bot.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// Firebase RTDB silently PRUNES any path that resolves to null, {}, or [] — so
// game.revealed:{}, game.holding:null, game.lastTurnRemaining:[] never survive a
// round-trip and come back as `undefined`, which crashes rules.js (`game.revealed[pid]`
// throws on undefined). Every read of a game object coming from Firebase must be
// normalized back to the shape rules.js expects before use.
function normalizeGame(game) {
  if (!game) return game;
  return {
    ...game,
    revealed: game.revealed || {},
    holding: game.holding || null,
    lastTurnRemaining: game.lastTurnRemaining || [],
    caller: game.caller || null,
    lastRoundScores: game.lastRoundScores || null,
    // Drawing the last burn card (a completely normal move) empties this to [], and a
    // reshuffle-starved deck can do the same to drawPile — both get pruned by Firebase.
    burnPile: game.burnPile || [],
    drawPile: game.drawPile || [],
  };
}

// RTDB gives a live client/server clock offset for free — used so the turn timer
// counts down from the SAME instant on every device, immune to a phone's clock drift.
let serverTimeOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => { serverTimeOffset = snap.val() || 0; });
function serverNow() { return Date.now() + serverTimeOffset; }

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

// ---------------------------------------------------------------- sound
const sndSwap = new Audio('audio/card-swap.mp3');
const sndTurn = new Audio('audio/your-turn.mp3');
const sndKing = new Audio('audio/king-found.mp3');
function playSound(audio) {
  try { audio.currentTime = 0; audio.play().catch(() => {}); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- turn-change / King fx tracking
let wasMyTurn = false;
let suppressTurnSound = true; // true right after entering a game so the first render never chimes
let lastSeenRound = null;
let lastSeenBurnTopId = null;
let lastSeenHoldingId = null;

// A drawn or newly-discarded King gets a big spinning showcase — half the screen width
// (capped so it doesn't get absurd on a tablet), matching what was asked for.
function showKingCelebration(card) {
  playSound(sndKing);
  const wrap = document.createElement('div');
  wrap.className = 'king-celebration';
  wrap.innerHTML = `<div class="king-card-face" style="background-image:url('${KING_ART[card.suit]}')"></div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('.king-card-face').addEventListener('animationend', () => wrap.remove());
}

function maybeCelebrateKing(game, myId, curPid) {
  if (game.round !== lastSeenRound) {
    lastSeenRound = game.round;
    lastSeenBurnTopId = null;
    lastSeenHoldingId = null;
  }
  const burnTop = game.burnPile[game.burnPile.length - 1];
  if (burnTop && burnTop.id !== lastSeenBurnTopId) {
    lastSeenBurnTopId = burnTop.id;
    if (burnTop.rank === 'K') showKingCelebration(burnTop);
  }
  if (game.holding && curPid === myId) {
    if (game.holding.card.id !== lastSeenHoldingId) {
      lastSeenHoldingId = game.holding.card.id;
      if (game.holding.card.rank === 'K') showKingCelebration(game.holding.card);
    }
  } else {
    lastSeenHoldingId = null;
  }
}

// A card visually flying from one spot to another with a spin, used for swaps. Reads
// current positions right before the move is sent — the ghost then flies to the target
// on top of whatever the real re-render draws underneath it.
function spawnFlyingCard(card, fromRect, toRect) {
  const el = document.createElement('div');
  const fromCx = fromRect.left + fromRect.width / 2;
  const fromCy = fromRect.top + fromRect.height / 2;
  el.style.left = `${fromCx - 30}px`;
  el.style.top = `${fromCy - 42}px`;
  if (card.rank === 'K') {
    el.className = 'card-face king-face fly-card';
    el.style.backgroundImage = `url('${KING_ART[card.suit]}')`;
  } else {
    const red = RED_SUITS.has(card.suit) ? ' red' : '';
    el.className = `card-face fly-card${red}`;
    el.innerHTML = `<span class="rank">${esc(card.rank)}</span><span class="suit">${SUIT_SYMBOL[card.suit]}</span>`;
  }
  document.body.appendChild(el);
  const toCx = toRect.left + toRect.width / 2;
  const toCy = toRect.top + toRect.height / 2;
  const dx = toCx - fromCx;
  const dy = toCy - fromCy;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(720deg)`;
    });
  });
  setTimeout(() => { el.style.transition = 'opacity 0.12s'; el.style.opacity = '0'; }, 380);
  setTimeout(() => el.remove(), 500);
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
$('kebab-btn').addEventListener('click', () => {
  $('menu-quit').classList.toggle('hidden', $('screen-game').classList.contains('hidden'));
  $('kebab-menu').classList.toggle('hidden');
});
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
$('menu-quit').addEventListener('click', () => { hide($('kebab-menu')); quitGame(); });
$('version-label').textContent = `v${APP_VERSION}`;
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
// Checked on load, on every tab-foreground, and on an interval — a player can be
// mid-game with the tab in the foreground the whole time, so visibilitychange alone
// would never catch a deploy that happens while they're actively playing.
let updateBannerShown = false;
async function checkVersion() {
  if (updateBannerShown) return;
  try {
    const res = await fetch(`version.js?t=${Date.now()}`, { cache: 'no-store' });
    const text = await res.text();
    const match = text.match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (match && match[1] !== APP_VERSION) {
      updateBannerShown = true;
      show($('update-banner'));
    }
  } catch { /* offline */ }
}
checkVersion();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkVersion(); });
setInterval(checkVersion, 2 * 60 * 1000);

$('update-refresh').addEventListener('click', async () => {
  $('update-refresh').textContent = 'Updating…';
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    for (const r of regs || []) await r.unregister();
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
  } catch { /* ignore */ }
  location.reload();
});

// ---------------------------------------------------------------- service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});
}

// ================================================================== ROOM / ONLINE STATE
let currentRoomCode = null;
let roomUnsub = null;
let latestRoom = null;
let isHost = false;
let turnTimerInterval = null;
let autoPlayBusy = false; // prevents overlapping timeout-fallback transactions while one is in flight
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
    settings: { deckCount: 1, layout: 'rows4', cardBack: selectedCardBack, turnSeconds: 30 },
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
  suppressTurnSound = true;
  lastSeenRound = null; lastSeenBurnTopId = null; lastSeenHoldingId = null;
  localStorage.setItem('kings_room', code);
  update(roomRef(code, 'players', playerId), { left: false }).catch(() => {});
  onDisconnect(roomRef(code, 'players', playerId, 'left')).set(true);
  if (roomUnsub) roomUnsub();
  clearInterval(turnTimerInterval);
  turnTimerInterval = setInterval(tickTurnTimer, 1000);
  roomUnsub = onValue(roomRef(code), (snap) => {
    latestRoom = snap.val();
    if (!latestRoom) { toast('Room closed'); leaveRoom(); showScreen('screen-home'); return; }
    if (latestRoom.game) latestRoom.game = normalizeGame(latestRoom.game);
    isHost = latestRoom.hostId === playerId;
    renderRoom();
  });
}

function leaveRoom() {
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  clearInterval(turnTimerInterval);
  hide($('turn-timer'));
  currentRoomCode = null;
  latestRoom = null;
  soloMode = null;
  localStorage.removeItem('kings_room');
}

async function quitGame() {
  if (soloMode) {
    clearTimeout(botTimer);
    clearSoloSave();
    soloMode = null;
    soloState = null;
    showScreen('screen-home');
    return;
  }
  if (isHost && currentRoomCode) {
    if (!confirm('Quit this game for everyone and return to the lobby?')) return;
    await update(roomRef(currentRoomCode), { status: 'lobby', game: null });
  } else if (currentRoomCode) {
    await update(roomRef(currentRoomCode, 'players', playerId), { left: true }).catch(() => {});
  }
  leaveRoom();
  showScreen('screen-home');
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
  $('set-turn-seconds').value = String(room.settings.turnSeconds || 30);
  renderCardBackPicker($('lobby-cardback-picker'), room.settings.cardBack, isHost, (id) => {
    update(roomRef(currentRoomCode, 'settings'), { cardBack: id });
  });
  $('set-deck-count').disabled = !isHost;
  $('set-layout').disabled = !isHost;
  $('set-turn-seconds').disabled = !isHost;

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
$('set-turn-seconds').addEventListener('change', (e) => {
  if (isHost) update(roomRef(currentRoomCode, 'settings'), { turnSeconds: parseInt(e.target.value, 10) });
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
  await update(roomRef(currentRoomCode), { status: 'active', order, game, turnStartedAt: serverTimestamp() });
});

// ---------------------------------------------------------------- moves (online)
// actingPid defaults to the local player, but the turn-timeout fallback below also
// calls this on behalf of another (unresponsive) player, since there's no server
// function to do it authoritatively on the Spark plan.
async function sendMove(move, actingPid = playerId) {
  if (soloMode) { applySoloMove(move); return; }
  const gref = roomRef(currentRoomCode, 'game');
  let result;
  let turnEnded = false;
  await runTransaction(gref, (game) => {
    if (!game) return game;
    try {
      result = applyMove(normalizeGame(game), actingPid, move);
      turnEnded = currentPlayer(result) !== actingPid || result.phase === 'roundEnd' || result.phase === 'gameOver';
      return result;
    } catch (err) { result = { error: err.message }; return game; }
  });
  if (result?.error) { if (actingPid === playerId) toast(result.error); return; }
  if (turnEnded) await update(roomRef(currentRoomCode), { turnStartedAt: serverTimestamp() });
}

// Bare number, tabular-nums, gold when it's yours, pulsing red under 5s — same
// treatment as HexColony's board-timer pill.
function tickTurnTimer() {
  const room = latestRoom;
  const timerEl = $('turn-timer');
  const game = room?.game;
  if (!room || room.status !== 'active' || !game || (game.phase !== 'play' && game.phase !== 'lastTurn')) {
    hide(timerEl);
    return;
  }
  const turnSeconds = room.settings?.turnSeconds || 30;
  const startedAt = typeof room.turnStartedAt === 'number' ? room.turnStartedAt : null;
  if (!startedAt) { hide(timerEl); return; }

  const remainingMs = startedAt + turnSeconds * 1000 - serverNow();
  const secs = Math.max(0, Math.ceil(remainingMs / 1000));
  const curPid = currentPlayer(game);
  const mine = curPid === playerId;

  show(timerEl);
  timerEl.textContent = String(secs);
  timerEl.classList.toggle('mine', mine);
  timerEl.classList.toggle('urgent', secs <= 5);

  if (remainingMs <= 0 && !autoPlayBusy) {
    // pickBotMove runs synchronously — if it ever throws, autoPlayBusy must still be
    // released, or one bad game state permanently wedges the timeout fallback.
    const actingPid = mine ? playerId : (remainingMs <= -5000 ? curPid : null);
    if (actingPid) {
      autoPlayBusy = true;
      (async () => sendMove(pickBotMove(game, actingPid, 'medium', true), actingPid))()
        .catch((err) => console.error('turn-timeout auto-play failed', err))
        .finally(() => { autoPlayBusy = false; });
    }
  }
}

async function requestNextRound() {
  if (soloMode) { soloState = startNextRound(soloState, { seed: Date.now() % 2147483647 }); renderSoloGame(); scheduleBotTurn(); return; }
  const gref = roomRef(currentRoomCode, 'game');
  await runTransaction(gref, (game) => {
    if (!game || game.phase !== 'roundEnd') return game;
    return startNextRound(normalizeGame(game), { seed: Date.now() % 2147483647 });
  });
  await update(roomRef(currentRoomCode), { turnStartedAt: serverTimestamp() });
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
  suppressTurnSound = true;
  lastSeenRound = null; lastSeenBurnTopId = null; lastSeenHoldingId = null;
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
  }, 2000 + Math.random() * 500);
}

function renderSoloGame() {
  renderGameCommon(soloState, soloIds, 'you', { [playerId]: { name: 'You' }, ...Object.fromEntries(soloIds.slice(1).map((id, i) => [id, { name: `Bot ${i + 1} (${soloBotDifficulty[id]})` }])) }, selectedCardBack);
  if (soloState.phase === 'gameOver') clearSoloSave();
  else saveSoloState();
}

function saveSoloState() {
  try {
    localStorage.setItem('kings_solo_save', JSON.stringify({ soloState, soloIds, soloBotDifficulty, cardBack: selectedCardBack }));
  } catch { /* storage unavailable */ }
}
function clearSoloSave() {
  try { localStorage.removeItem('kings_solo_save'); } catch { /* storage unavailable */ }
}
function resumeSoloSave() {
  try {
    const saved = JSON.parse(localStorage.getItem('kings_solo_save'));
    if (!saved?.soloState || saved.soloState.phase === 'gameOver') return false;
    soloState = saved.soloState;
    soloIds = saved.soloIds;
    soloBotDifficulty = saved.soloBotDifficulty;
    selectedCardBack = saved.cardBack || selectedCardBack;
    playerId = 'you';
    myName = 'You';
    soloMode = { botCount: soloIds.length - 1, difficulties: Object.values(soloBotDifficulty) };
    soloPlayPhaseMoves = 0;
    showScreen('screen-game');
    renderSoloGame();
    scheduleBotTurn();
    return true;
  } catch { return false; }
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

  if (suppressTurnSound) { suppressTurnSound = false; wasMyTurn = isMyTurn; }
  else { if (isMyTurn && !wasMyTurn) playSound(sndTurn); wasMyTurn = isMyTurn; }
  maybeCelebrateKing(game, myId, curPid);

  // opponents strip
  const others = order.filter((pid) => pid !== myId);
  $('opponents').innerHTML = others.map((pid) => {
    const p = game.players[pid];
    if (!p) return '';
    const isTurn = pid === curPid ? ' is-turn' : '';
    const outCls = p.out ? ' is-out' : '';
    const gridCols = game.layout === 'rows3' ? 3 : 4;
    const cells = p.cells.map((c) => cardMiniHtml(c, cardBackId)).join('');
    const vs = visibleScore(p.cells, game.layout);
    const scoreLabel = `${vs.total}${vs.hiddenCount ? ` +${vs.hiddenCount}?` : ''}`;
    return `<div class="opponent${isTurn}${outCls}">
      <div class="opponent-name">${esc(names[pid]?.name || '?')}</div>
      <div class="opponent-score">${scoreLabel} pts</div>
      <div class="opponent-lives">${'❤'.repeat(Math.max(0, p.lives))}</div>
      <div class="opponent-grid" style="grid-template-columns:repeat(${gridCols},1fr)">${cells}</div>
    </div>`;
  }).join('');

  // piles
  const canDrawNow = isMyTurn && game.revealed[myId] && !game.holding;
  const drawCount = game.drawPile.length;
  $('deck-count').textContent = drawCount;
  const deckPile = $('pile-deck');
  deckPile.classList.toggle('disabled', !canDrawNow);
  const backStyle = cardBackStyle(cardBackId);
  deckPile.querySelector('.card-back').setAttribute('style', backStyle);

  const burnTop = game.burnPile[game.burnPile.length - 1];
  const burnPile = $('pile-burn');
  burnPile.innerHTML = burnTop ? cardFaceHtml(burnTop) : '<div class="card-back" style="visibility:hidden"></div>';
  const canDiscardNow = isMyTurn && game.holding && game.holding.from !== 'burn';
  burnPile.classList.toggle('disabled', !((canDrawNow && game.burnPile.length > 0) || canDiscardNow));

  const holdingSlot = $('holding-slot');
  if (game.holding && curPid === myId) {
    holdingSlot.innerHTML = cardFaceHtml(game.holding.card);
    show(holdingSlot);
  } else hide(holdingSlot);

  // act prompt
  let prompt = '';
  if (isMyTurn && !game.revealed[myId]) {
    prompt = 'Pick one column to flip face up, then take your turn';
  } else if (isMyTurn) {
    if (!game.holding) prompt = 'Draw from the deck or the burn pile';
    else if (game.holding.from === 'burn') prompt = 'Tap one of your cards to swap it in';
    else prompt = 'Tap a card to swap it in, or tap the discard pile';
  } else if (game.phase !== 'roundEnd' && game.phase !== 'gameOver') {
    prompt = `Waiting on ${esc(names[curPid]?.name || '?')}`;
  }
  if (game.phase === 'lastTurn' && curPid !== game.caller) prompt += ' (final turn!)';
  $('act-prompt').textContent = prompt;

  // my grid
  const myVs = visibleScore(me.cells, game.layout);
  const myScoreLabel = `${myVs.total}${myVs.hiddenCount ? ` +${myVs.hiddenCount}?` : ''} pts`;
  const myBase = names[myId]?.name || 'You';
  $('my-name').textContent = me?.out ? `${myBase} (out) — ${myScoreLabel}` : `${myBase} — ${myScoreLabel}`;
  const myGrid = $('my-grid');
  myGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  myGrid.innerHTML = me.cells.map((c, idx) => {
    const canRevealCol = isMyTurn && !game.revealed[myId];
    const canSwap = isMyTurn && game.holding;
    let inner;
    if (c.faceUp) {
      if (c.rank === 'K') {
        inner = `<div class="card-face king-face${canSwap ? ' swap-target' : ''}" style="background-image:url('${KING_ART[c.suit]}')"></div>`;
      } else {
        const red = RED_SUITS.has(c.suit) ? ' red' : '';
        inner = `<div class="card-face${red}${canSwap ? ' swap-target' : ''}"><span class="rank">${esc(c.rank)}</span><span class="suit">${SUIT_SYMBOL[c.suit]}</span></div>`;
      }
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

const KING_ART = { S: 'kingart/S.jpg', H: 'kingart/H.jpg', D: 'kingart/D.jpg', C: 'kingart/C.jpg' };

function cardFaceHtml(card) {
  const red = RED_SUITS.has(card.suit) ? ' red' : '';
  if (card.rank === 'K') return `<div class="card-face king-face" style="background-image:url('${KING_ART[card.suit]}')"></div>`;
  return `<div class="card-face${red}"><span class="rank">${esc(card.rank)}</span><span class="suit">${SUIT_SYMBOL[card.suit]}</span></div>`;
}
function cardMiniHtml(cell, cardBackId) {
  if (!cell.faceUp) return `<div class="mini-card" style="${cardBackStyle(cardBackId)}"></div>`;
  const red = RED_SUITS.has(cell.suit) ? ' red' : '';
  return `<div class="mini-card faceup${red}">${esc(cell.rank)}</div>`;
}

function wireGameInteractions(game, myId, isMyTurn, cols) {
  const me = game.players[myId];
  const canDraw = isMyTurn && game.revealed[myId] && !game.holding;
  $('pile-deck').onclick = () => { if (canDraw) sendMove({ type: 'draw', from: 'deck' }); };
  $('pile-burn').onclick = () => {
    if (isMyTurn && game.holding) {
      if (game.holding.from === 'burn') toast("You must swap in a card taken from the burn pile");
      else sendMove({ type: 'discard' });
    } else if (canDraw && game.burnPile.length) {
      sendMove({ type: 'draw', from: 'burn' });
    }
  };

  for (const el of document.querySelectorAll('#my-grid .cell-wrap')) {
    el.onclick = () => {
      const idx = parseInt(el.dataset.idx, 10);
      if (isMyTurn && !game.revealed[myId]) {
        const col = idx % cols;
        sendMove({ type: 'revealColumn', col });
      } else if (isMyTurn && game.holding) {
        const heldCard = game.holding.card;
        const removedCard = me.cells[idx];
        const holdingEl = document.querySelector('#holding-slot .card-face');
        const cellEl = el.querySelector('.card-face, .card-back');
        const burnEl = $('pile-burn');
        if (holdingEl && cellEl) {
          const fromRect = holdingEl.getBoundingClientRect();
          const toRect = cellEl.getBoundingClientRect();
          spawnFlyingCard(heldCard, fromRect, toRect);
          if (burnEl) spawnFlyingCard(removedCard, toRect, burnEl.getBoundingClientRect());
        }
        playSound(sndSwap);
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
  if (resumeSoloSave()) return;
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
