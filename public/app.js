import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, set, get, update, onValue, runTransaction, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { WORD_CODES } from './wordcodes.js';
import { APP_VERSION } from './version.js';
import { CARD_BACKS, cardBackById } from './cardbacks.js';
import { THEMES, themeById, applyTheme } from './themes.js';
import {
  newGame, applyMove, startNextRound, currentPlayer, gridSize, visibleScore, layoutCols,
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

// ---------------------------------------------------------------- shoutouts (HexColony-style)
// A big centered pill announcing something worth looking up for — pops in, holds,
// fades. Same visual language as HexColony's shoutout.
let shoutTimer = null;
function shoutout(msg, accent, duration = 2200) {
  const box = $('shoutout');
  const card = $('shoutout-card');
  card.textContent = msg;
  card.style.setProperty('--c', accent || 'var(--gold)');
  show(box);
  // Removing the class and reading layout before re-adding it is what restarts the
  // CSS animation — otherwise a second shoutout right after the first never replays.
  card.classList.remove('show');
  void card.offsetWidth;
  card.classList.add('show');
  clearTimeout(shoutTimer);
  shoutTimer = setTimeout(() => { card.classList.remove('show'); hide(box); }, duration);
}

// ---------------------------------------------------------------- turn-change / King fx tracking
let wasMyTurn = false;
let suppressTurnSound = true; // true right after entering a game so the first render never chimes
let lastAnnouncedPid = null;
let lastSeenRound = null;
let lastSeenBurnTopId = null;
let lastSeenHoldingId = null;
let lastSeenCaller = null;
let celebratedKingIds = new Set(); // a King already shown once (drawn or discarded) doesn't re-celebrate on pickup
let roundEndKey = null;
let roundEndRevealAt = null;
let roundEndTimer = null;

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

function maybeCelebrateKing(game, myId, curPid, names) {
  if (game.round !== lastSeenRound) {
    lastSeenRound = game.round;
    lastSeenBurnTopId = null;
    lastSeenHoldingId = null;
    lastSeenCaller = null;
    celebratedKingIds = new Set();
  }
  const burnTop = game.burnPile[game.burnPile.length - 1];
  if (burnTop && burnTop.id !== lastSeenBurnTopId) {
    lastSeenBurnTopId = burnTop.id;
    if (burnTop.rank === 'K' && !celebratedKingIds.has(burnTop.id)) {
      celebratedKingIds.add(burnTop.id);
      showKingCelebration(burnTop);
      shoutout('A King appears!', 'var(--gold)');
    }
  }
  if (game.holding && curPid === myId) {
    if (game.holding.card.id !== lastSeenHoldingId) {
      lastSeenHoldingId = game.holding.card.id;
      if (game.holding.card.rank === 'K' && !celebratedKingIds.has(game.holding.card.id)) {
        celebratedKingIds.add(game.holding.card.id);
        showKingCelebration(game.holding.card);
        shoutout('You found a King!', 'var(--gold)');
      }
    }
  } else {
    lastSeenHoldingId = null;
  }
  if (game.caller && game.caller !== lastSeenCaller) {
    lastSeenCaller = game.caller;
    const label = game.caller === myId ? 'You are' : `${names[game.caller]?.name || 'Someone'} is`;
    shoutout(`${label} all face up!`, 'var(--danger)');
  }
}

// A card visually flying from one spot to another with a spin, used for swaps. Reads
// current positions right before the move is sent — the ghost then flies to the target
// on top of whatever the real re-render draws underneath it.
function spawnFlyingCard(card, fromRect, toRect) {
  const el = document.createElement('div');
  const fromCx = fromRect.left + fromRect.width / 2;
  const fromCy = fromRect.top + fromRect.height / 2;
  el.style.left = `${fromCx - 34}px`;
  el.style.top = `${fromCy - 48}px`;
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
let selectedCardBack = localStorage.getItem('kings_cardback') || 'crown';
let selectedTheme = localStorage.getItem('kings_theme') || 'classic';
applyTheme(selectedTheme);

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
    settings: { deckCount: 1, layout: 'rows4', cardBack: selectedCardBack, turnSeconds: 30, theme: selectedTheme },
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
  lastSeenRound = null; lastSeenBurnTopId = null; lastSeenHoldingId = null; lastAnnouncedPid = null;
  roundEndKey = null; roundEndRevealAt = null; clearTimeout(roundEndTimer);
  celebratedKingIds = new Set();
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
  applyTheme(selectedTheme); // a joined room's theme shouldn't stick around after leaving
}

async function quitGame() {
  if (soloMode) {
    clearTimeout(botTimer);
    clearInterval(turnTimerInterval);
    hide($('turn-timer'));
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
function deckHintText(playerCount) {
  return playerCount >= 4
    ? '4+ players need 2 decks — 2 rows of 4 or 5 works best.'
    : 'For 1-3 players, 1 deck with 2 rows of 3 is recommended.';
}

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
  const roomTheme = room.settings.theme || 'classic';
  applyTheme(roomTheme);
  renderThemeDropdown('lobby', roomTheme, isHost, (id) => {
    applyTheme(id);
    update(roomRef(currentRoomCode, 'settings'), { theme: id });
  });
  $('set-deck-count').disabled = !isHost;
  $('set-layout').disabled = !isHost;
  $('set-turn-seconds').disabled = !isHost;

  const activeCount = order.filter((pid) => room.players?.[pid] && !room.players[pid].left).length;
  $('lobby-deck-hint').textContent = deckHintText(activeCount || 1);
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

function swatchStyle(t) { return `background:linear-gradient(135deg, ${t.gold}, ${t.goldDark})`; }

// A custom dropdown, not a native <select> — options need a color swatch circle,
// which <option> elements can't render.
function renderThemeDropdown(prefix, selectedId, editable, onPick) {
  const btn = $(`${prefix}-theme-btn`);
  const list = $(`${prefix}-theme-list`);
  const t = themeById(selectedId);
  btn.innerHTML = `<span class="theme-swatch" style="${swatchStyle(t)}"></span><span class="theme-text"><span class="theme-name">${esc(t.name)}</span></span><span class="theme-caret">▾</span>`;
  btn.disabled = !editable;
  list.innerHTML = THEMES.map((th) => `<div class="theme-dropdown-option${th.id === selectedId ? ' selected' : ''}" data-id="${th.id}">
    <span class="theme-swatch" style="${swatchStyle(th)}"></span>
    <span class="theme-text"><span class="theme-name">${esc(th.name)}</span><span class="theme-desc">${esc(th.desc)}</span></span>
  </div>`).join('');
  btn.onclick = () => { if (editable) list.classList.toggle('hidden'); };
  for (const opt of list.querySelectorAll('.theme-dropdown-option')) {
    opt.onclick = () => { hide(list); onPick(opt.dataset.id); };
  }
}
document.addEventListener('click', (e) => {
  for (const list of document.querySelectorAll('.theme-dropdown-list')) {
    if (!list.classList.contains('hidden') && !list.parentElement.contains(e.target)) hide(list);
  }
});

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
  if (order.length >= 4 && room.settings.deckCount < 2) {
    toast('4+ players need 2 decks — change Deck count in the settings above');
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
// treatment as HexColony's board-timer pill. Handles both online (server-synced via
// RTDB's clock offset) and solo (plain local Date.now(), single device, no sync needed).
function tickTurnTimer() {
  const timerEl = $('turn-timer');

  if (soloMode) {
    const game = soloState;
    if (!game || (game.phase !== 'play' && game.phase !== 'lastTurn') || !soloTurnStartedAt) {
      hide(timerEl);
      return;
    }
    const remainingMs = soloTurnStartedAt + soloTurnSeconds * 1000 - Date.now();
    const curPid = currentPlayer(game);
    const mine = curPid === 'you';
    renderTimerPill(timerEl, remainingMs, mine);
    // Bots already move on their own fast timer — this fallback only ever needs to
    // cover the human sitting on a decision too long.
    if (mine && remainingMs <= 0 && !autoPlayBusy) {
      autoPlayBusy = true;
      (async () => applySoloMove(pickBotMove(game, 'you', 'medium', true)))()
        .catch((err) => console.error('solo turn-timeout auto-play failed', err))
        .finally(() => { autoPlayBusy = false; });
    }
    return;
  }

  const room = latestRoom;
  const game = room?.game;
  if (!room || room.status !== 'active' || !game || (game.phase !== 'play' && game.phase !== 'lastTurn')) {
    hide(timerEl);
    return;
  }
  const turnSeconds = room.settings?.turnSeconds || 30;
  const startedAt = typeof room.turnStartedAt === 'number' ? room.turnStartedAt : null;
  if (!startedAt) { hide(timerEl); return; }

  const remainingMs = startedAt + turnSeconds * 1000 - serverNow();
  const curPid = currentPlayer(game);
  const mine = curPid === playerId;
  renderTimerPill(timerEl, remainingMs, mine);

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

function renderTimerPill(timerEl, remainingMs, mine) {
  const secs = Math.max(0, Math.ceil(remainingMs / 1000));
  show(timerEl);
  timerEl.textContent = String(secs);
  timerEl.classList.toggle('mine', mine);
  timerEl.classList.toggle('urgent', secs <= 5);
}

async function requestNextRound() {
  if (soloMode) { soloState = startNextRound(soloState, { seed: Date.now() % 2147483647 }); soloTurnStartedAt = Date.now(); renderSoloGame(); scheduleBotTurn(); return; }
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
let currentBotTurnPid = null; // which bot the "thinking" delay has already been paid for this turn
let soloTurnSeconds = 30;
let soloTurnStartedAt = null;

function startSolo({ botCount, difficulties, deckCount, layout, turnSeconds }) {
  soloIds = ['you', ...difficulties.map((_, i) => `bot${i + 1}`)];
  soloBotDifficulty = {};
  difficulties.forEach((d, i) => { soloBotDifficulty[`bot${i + 1}`] = d; });
  playerId = 'you';
  myName = 'You';
  soloMode = { botCount, difficulties };
  currentRoomCode = null;
  suppressTurnSound = true;
  lastSeenRound = null; lastSeenBurnTopId = null; lastSeenHoldingId = null; lastAnnouncedPid = null;
  roundEndKey = null; roundEndRevealAt = null; clearTimeout(roundEndTimer);
  celebratedKingIds = new Set();
  soloTurnSeconds = turnSeconds || 30;
  soloTurnStartedAt = Date.now();
  currentBotTurnPid = null;
  soloState = newGame({ playerIds: soloIds, deckCount, layout, seed: Date.now() % 2147483647 });
  soloPlayPhaseMoves = 0;
  showScreen('screen-game');
  renderSoloGame();
  scheduleBotTurn();
  clearInterval(turnTimerInterval);
  turnTimerInterval = setInterval(tickTurnTimer, 1000);
}

let soloPlayPhaseMoves = 0;
function applySoloMove(move) {
  try {
    const before = soloState.phase;
    const beforePid = currentPlayer(soloState);
    soloState = applyMove(soloState, beforePid, move);
    if (soloState.phase === 'play' && before === 'play') soloPlayPhaseMoves++; else soloPlayPhaseMoves = 0;
    if (currentPlayer(soloState) !== beforePid || soloState.phase === 'roundEnd' || soloState.phase === 'gameOver') {
      soloTurnStartedAt = Date.now();
    }
  } catch (err) { toast(err.message); return; }
  renderSoloGame();
  scheduleBotTurn();
}

function scheduleBotTurn() {
  clearTimeout(botTimer);
  if (!soloState || soloState.phase === 'gameOver' || soloState.phase === 'roundEnd') return;
  const pid = currentPlayer(soloState);
  if (pid === 'you') { currentBotTurnPid = null; return; }
  // Only the first action of a bot's turn gets the "thinking" pause — reveal, draw,
  // and act all happen back-to-back quickly once that's paid, so a full bot turn
  // doesn't take 3x as long as it feels like it should.
  const isFirstActionThisTurn = pid !== currentBotTurnPid;
  currentBotTurnPid = pid;
  const delay = isFirstActionThisTurn ? 2000 + Math.random() * 500 : 200;
  botTimer = setTimeout(() => {
    const diff = soloBotDifficulty[pid];
    const before = soloState.phase;
    const forceProgress = soloState.phase === 'play' && soloPlayPhaseMoves > 150;
    const move = pickBotMove(soloState, pid, diff, forceProgress);
    try { soloState = applyMove(soloState, pid, move); }
    catch { /* shouldn't happen; skip */ }
    if (soloState.phase === 'play' && before === 'play') soloPlayPhaseMoves++; else soloPlayPhaseMoves = 0;
    if (currentPlayer(soloState) !== pid || soloState.phase === 'roundEnd' || soloState.phase === 'gameOver') {
      soloTurnStartedAt = Date.now();
      currentBotTurnPid = null;
    }
    renderSoloGame();
    scheduleBotTurn();
  }, delay);
}

function renderSoloGame() {
  renderGameCommon(soloState, soloIds, 'you', { [playerId]: { name: 'You' }, ...Object.fromEntries(soloIds.slice(1).map((id, i) => [id, { name: `Bot ${i + 1} (${soloBotDifficulty[id]})` }])) }, selectedCardBack);
  if (soloState.phase === 'gameOver') clearSoloSave();
  else saveSoloState();
}

function saveSoloState() {
  try {
    localStorage.setItem('kings_solo_save', JSON.stringify({ soloState, soloIds, soloBotDifficulty, cardBack: selectedCardBack, turnSeconds: soloTurnSeconds }));
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
    soloTurnSeconds = saved.turnSeconds || 30;
    soloTurnStartedAt = Date.now();
    showScreen('screen-game');
    renderSoloGame();
    scheduleBotTurn();
    clearInterval(turnTimerInterval);
    turnTimerInterval = setInterval(tickTurnTimer, 1000);
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
  const cols = layoutCols(game.layout);
  const me = game.players[myId];

  $('game-round-info').textContent = `Round ${game.round}`;
  const curPid = currentPlayer(game);
  const isMyTurn = curPid === myId && game.phase !== 'roundEnd' && game.phase !== 'gameOver';
  $('game-turn-info').textContent = game.phase === 'roundEnd' || game.phase === 'gameOver'
    ? '' : (isMyTurn ? 'Your turn' : `${esc(names[curPid]?.name || '?')}'s turn`);

  if (suppressTurnSound) { suppressTurnSound = false; wasMyTurn = isMyTurn; }
  else { if (isMyTurn && !wasMyTurn) playSound(sndTurn); wasMyTurn = isMyTurn; }
  maybeCelebrateKing(game, myId, curPid, names);

  // player rail — every player's name + running score, active player's pill pulses
  const isActivePhase = game.phase !== 'roundEnd' && game.phase !== 'gameOver';
  if (isActivePhase && curPid !== lastAnnouncedPid) {
    lastAnnouncedPid = curPid;
    // Bots don't get shouted about — a solo table of one human doesn't need to be
    // told the bot it's already watching just took its turn.
    if (!(soloMode && curPid !== myId)) {
      shoutout(curPid === myId ? 'Your turn' : `${names[curPid]?.name || '?'}'s turn`, 'var(--gold)');
    }
  }
  $('player-rail').innerHTML = order.map((pid) => {
    const p = game.players[pid];
    if (!p) return '';
    const vs = visibleScore(p.cells, game.layout);
    const scoreLabel = String(vs.total);
    const isTurn = isActivePhase && pid === curPid;
    const label = pid === myId ? 'You' : (names[pid]?.name || '?');
    return `<div class="rail-pill${p.out ? ' is-out' : ''}${isTurn ? ' active-turn' : ''}">
      <span class="rail-name">${esc(label)}</span>
      <span class="rail-score">${scoreLabel} pts</span>
    </div>`;
  }).join('');

  // opponents strip
  const others = order.filter((pid) => pid !== myId);
  $('opponents').innerHTML = others.map((pid) => {
    const p = game.players[pid];
    if (!p) return '';
    const isTurn = isActivePhase && pid === curPid;
    const outCls = p.out ? ' is-out' : '';
    const gridCols = layoutCols(game.layout);
    const cells = p.cells.map((c) => cardMiniHtml(c, cardBackId)).join('');
    return `<div class="opponent${outCls}">
      <div class="opponent-lives">${'❤'.repeat(Math.max(0, p.lives))}</div>
      <div class="opponent-grid${isTurn ? ' active-turn' : ''}" style="grid-template-columns:repeat(${gridCols},1fr)">${cells}</div>
    </div>`;
  }).join('');

  // piles — table-center shares #my-grid's column count so the deck lines up over
  // the leftmost column and the discard pile over the rightmost.
  const tableCenter = document.querySelector('.table-center');
  tableCenter.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  $('pile-burn').style.gridColumn = String(cols);
  $('holding-slot').style.gridColumn = `2 / ${cols}`;

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
  const myScoreLabel = `${myVs.total} pts`;
  const myBase = names[myId]?.name || 'You';
  $('my-name').textContent = me?.out ? `${myBase} (out) — ${myScoreLabel}` : `${myBase} — ${myScoreLabel}`;
  const myGrid = $('my-grid');
  myGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  myGrid.classList.toggle('active-turn', isMyTurn);
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

  // round end / game over overlays — held back 3s after the round actually ends so
  // everyone gets a moment to see the fully revealed table before it's covered up.
  const endKey = (game.phase === 'roundEnd' || game.phase === 'gameOver') ? `${game.round}:${game.phase}` : null;
  let showEndOverlay = false;
  if (endKey) {
    if (endKey !== roundEndKey) {
      roundEndKey = endKey;
      roundEndRevealAt = Date.now() + 3000;
      clearTimeout(roundEndTimer);
      roundEndTimer = setTimeout(() => { if (soloMode) renderSoloGame(); else renderGame(); }, 3000);
    }
    showEndOverlay = Date.now() >= roundEndRevealAt;
  } else {
    roundEndKey = null;
  }

  if (game.phase === 'roundEnd' && showEndOverlay) {
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

  if (game.phase === 'gameOver' && showEndOverlay) {
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
function pickSoloCardBack(id) {
  selectedCardBack = id; localStorage.setItem('kings_cardback', id);
  renderCardBackPicker($('solo-cardback-picker'), selectedCardBack, true, pickSoloCardBack);
}
function pickSoloTheme(id) {
  selectedTheme = id; localStorage.setItem('kings_theme', id);
  applyTheme(id);
  renderThemeDropdown('solo', selectedTheme, true, pickSoloTheme);
}
function updateSoloDeckHint() {
  const botCount = parseInt($('solo-bot-count').value, 10);
  $('solo-deck-hint').textContent = deckHintText(botCount + 1);
}
$('btn-solo').addEventListener('click', () => {
  const savedDiff = localStorage.getItem('kings_solo_diff');
  // Older builds stored a per-bot JSON array here — fall back cleanly if so.
  $('solo-bot-difficulty').value = ['easy', 'medium', 'hard'].includes(savedDiff) ? savedDiff : 'medium';
  renderCardBackPicker($('solo-cardback-picker'), selectedCardBack, true, pickSoloCardBack);
  renderThemeDropdown('solo', selectedTheme, true, pickSoloTheme);
  updateSoloDeckHint();
  showScreen('screen-solo-setup');
});
$('solo-bot-count').addEventListener('change', updateSoloDeckHint);
$('solo-start').addEventListener('click', () => {
  const botCount = parseInt($('solo-bot-count').value, 10);
  const difficulty = $('solo-bot-difficulty').value;
  const difficulties = Array.from({ length: botCount }, () => difficulty);
  localStorage.setItem('kings_solo_diff', difficulty);
  const deckCount = parseInt($('solo-deck-count').value, 10);
  const layout = $('solo-layout').value;
  const size = gridSize(layout);
  if ((botCount + 1) * size + 1 > deckCount * 52) {
    toast('Not enough cards for that many players — add a deck or use a smaller grid');
    return;
  }
  if (botCount + 1 >= 4 && deckCount < 2) {
    toast('4+ players need 2 decks — change Deck count above');
    return;
  }
  const turnSeconds = parseInt($('solo-turn-seconds').value, 10);
  startSolo({ botCount, difficulties, deckCount, layout, turnSeconds });
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
