const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATABASE SETUP ───────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'wizard.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    avatar        TEXT NOT NULL DEFAULT '🧙',
    xp            INTEGER NOT NULL DEFAULT 0,
    level         INTEGER NOT NULL DEFAULT 1,
    streak        INTEGER NOT NULL DEFAULT 0,
    last_win      INTEGER,
    wins          INTEGER NOT NULL DEFAULT 0,
    losses        INTEGER NOT NULL DEFAULT 0,
    counters_ok   INTEGER NOT NULL DEFAULT 0,
    counters_fail INTEGER NOT NULL DEFAULT 0,
    combos        INTEGER NOT NULL DEFAULT 0,
    total_rxn_ms  INTEGER NOT NULL DEFAULT 0,
    rxn_samples   INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// Safely add avatar column for existing DBs that don't have it yet
try {
  db.exec(`ALTER TABLE profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT '🧙'`);
  console.log('avatar column added');
} catch(e) {
  // column already exists — ignore
}

const stmts = {
  findUser:      db.prepare('SELECT * FROM profiles WHERE username = ?'),
  insertUser:    db.prepare('INSERT INTO profiles (username, password_hash, avatar) VALUES (@username, @password_hash, @avatar)'),
  updateProfile: db.prepare(`
    UPDATE profiles SET
      xp=@xp, level=@level, streak=@streak, last_win=@last_win,
      wins=@wins, losses=@losses, counters_ok=@counters_ok,
      counters_fail=@counters_fail, combos=@combos,
      total_rxn_ms=@total_rxn_ms, rxn_samples=@rxn_samples
    WHERE username=@username
  `),
};

function rowToProfile(row) {
  return {
    username: row.username, passwordHash: row.password_hash,
    avatar: row.avatar || '🧙',
    xp: row.xp, level: row.level, streak: row.streak, lastWin: row.last_win,
    stats: {
      wins: row.wins, losses: row.losses,
      countersSuccess: row.counters_ok, countersFail: row.counters_fail,
      combos: row.combos, totalReactionMs: row.total_rxn_ms, reactionSamples: row.rxn_samples,
    },
  };
}

function saveProfile(p) {
  stmts.updateProfile.run({
    username: p.username, xp: p.xp, level: p.level,
    streak: p.streak || 0, last_win: p.lastWin || null,
    wins: p.stats.wins, losses: p.stats.losses,
    counters_ok: p.stats.countersSuccess, counters_fail: p.stats.countersFail,
    combos: p.stats.combos, total_rxn_ms: p.stats.totalReactionMs,
    rxn_samples: p.stats.reactionSamples,
  });
}

// rooms are still ephemeral (in-memory) — they only last one match
const rooms = {};
// track which username created which room, so reconnects can reclaim it
const roomByUser = {}; // username -> code
// track active sessions so socket reconnects can restore state without re-login
const sessionByUser = {}; // username -> { profile snapshot }

// ─── XP & LEVEL CONFIG ────────────────────────────────────────────────────────
const LEVELS = [
  { n: 1, name: 'Novato',    xpRequired: 0,    counterSecs: 2.0 },
  { n: 2, name: 'Aprendiz',  xpRequired: 100,  counterSecs: 2.5 },
  { n: 3, name: 'Iniciado',  xpRequired: 300,  counterSecs: 3.0 },
  { n: 4, name: 'Experto',   xpRequired: 700,  counterSecs: 3.5 },
  { n: 5, name: 'Maestro',   xpRequired: 1500, counterSecs: 4.5 },
];

// XP awarded per match event
const XP_TABLE = {
  win:             50,
  loss:            10,   // participation points
  counter_success: 8,
  counter_fail:   -2,
  combo:           5,
  streak_3:       25,   // bonus for 3-win streak
  streak_5:       60,
  reaction_fast:  10,   // avg reaction < 1.2s
  reaction_ok:     4,   // avg reaction < 2.0s
};

function calcLevel(xp) {
  let lvl = LEVELS[0];
  for (const l of LEVELS) { if (xp >= l.xpRequired) lvl = l; }
  return lvl;
}

function xpToNextLevel(xp) {
  const current = calcLevel(xp);
  const next = LEVELS.find(l => l.n === current.n + 1);
  if (!next) return null;
  return { needed: next.xpRequired - xp, nextName: next.name, nextXp: next.xpRequired };
}

function awardXP(profile, events) {
  let gained = 0;
  const log = [];

  for (const ev of events) {
    const pts = XP_TABLE[ev] || 0;
    if (pts !== 0) { gained += pts; log.push({ event: ev, pts }); }
  }

  profile.xp = Math.max(0, profile.xp + gained);
  const newLevel = calcLevel(profile.xp);
  const leveledUp = newLevel.n > profile.level;
  profile.level = newLevel.n;

  return { gained, log, leveledUp, newLevel };
}

// ─── SPELL DATA (server-authoritative) ────────────────────────────────────────
const PATH_MULTS = {
  destructor: { dmg: 1.3, heal: 1.0 },
  guardian:   { dmg: 0.9, heal: 1.6 },
  trickster:  { dmg: 1.1, heal: 1.0 },
};
const SPELLS = {
  // básicos — clic y voz
  aturdir:   { dmg: 25, heal: 0 },
  expulsar:  { dmg: 20, heal: 0 },
  sanar:     { dmg: 0,  heal: 20 },
  escudo:    { dmg: 0,  heal: 0,  shield: true },
  // poderosos — solo voz
  destruir:  { dmg: 45, heal: 0 },
  quemar:    { dmg: 35, heal: 0 },
  restaurar: { dmg: 0,  heal: 30 },
  confundir: { dmg: 15, heal: 0,  stun: true },
  desgarrar: { dmg: 40, heal: 0 },
};
const CAST_SECS = 4; // fixed time to choose a spell each turn

const COUNTER_PHRASES = [
  'Avis Oppugno','Finite Incantatem','Riddikulus','Obliviate',
  'Nox Eternum','Serpensortia','Deletrius','Fumos Duo',
  'Aguamenti Maxima','Incendio Tria','Alohomora Bis','Flipendo Tria',
  'Locomotor Mortis','Tarantallegra','Impedimenta','Rictusempra',
];

function makeCode() { return Math.random().toString(36).substring(2,6).toUpperCase(); }

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeRoomState() {
  return {
    players: [
      { hp:100, shield:false, stun:false, path:null, username:null,
        countersOk:0, countersFail:0, combos:0, reactionTimes:[], spellCastAt:0 },
      { hp:100, shield:false, stun:false, path:null, username:null,
        countersOk:0, countersFail:0, combos:0, reactionTimes:[], spellCastAt:0 },
    ],
    turn: 0,
    phase: 'battle',
    counterFor: null, counterDmg: 0, counterPhrase: '', counterDeadline: 0,
    castDeadline: 0,
  };
}

// Emit turn_change with a fresh shuffled spell order and cast deadline
function emitTurnChange(code, room, io) {
  const pi = room.state.turn;
  const playerPath = room.state.players[pi].path;
  const PATH_SPELLS = {
    destructor: ['aturdir','destruir','expulsar','quemar'],
    guardian:   ['escudo','sanar','expulsar','restaurar'],
    trickster:  ['confundir','expulsar','aturdir','desgarrar'],
  };
  const spells = PATH_SPELLS[playerPath] || PATH_SPELLS.destructor;
  const spellOrder = shuffle(spells);
  const deadline = Date.now() + CAST_SECS * 1000;
  room.state.castDeadline = deadline;

  io.to(code).emit('turn_change', {
    turn: pi,
    spellOrder,       // shuffled order for the attacker to see
    castSecs: CAST_SECS,
    castDeadline: deadline,
  });

  // Auto-skip if attacker doesn't cast in time
  setTimeout(() => {
    if (room.state.phase === 'battle' && room.state.turn === pi && room.state.castDeadline === deadline) {
      const ti = pi === 0 ? 1 : 0;
      room.state.turn = ti;
      io.to(code).emit('turn_skipped', { skipped: pi });
      emitTurnChange(code, room, io);
    }
  }, (CAST_SECS + 0.5) * 1000);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  socket.on('register', async ({ username, password, avatar }) => {
    const u = username.trim().toLowerCase();
    if (!u || u.length < 2 || u.length > 20) {
      socket.emit('auth_error', { msg: 'Nombre: 2–20 caracteres' }); return;
    }
    if (!password || password.length < 3) {
      socket.emit('auth_error', { msg: 'Contraseña: mínimo 3 caracteres' }); return;
    }
    if (stmts.findUser.get(u)) {
      socket.emit('auth_error', { msg: 'Ese nombre ya existe — inicia sesión' }); return;
    }
    const hash = await bcrypt.hash(password, 8);
    const av = avatar && avatar.length <= 8 ? avatar : '🧙';
    stmts.insertUser.run({ username: u, password_hash: hash, avatar: av });
    const profile = rowToProfile(stmts.findUser.get(u));
    socket.username = u;
    socket.emit('auth_ok', publicProfile(profile));
    console.log('registered:', u);
  });

  socket.on('login', async ({ username, password }) => {
    const u = username.trim().toLowerCase();
    const row = stmts.findUser.get(u);
    if (!row) { socket.emit('auth_error', { msg: 'Usuario no encontrado' }); return; }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) { socket.emit('auth_error', { msg: 'Contraseña incorrecta' }); return; }
    socket.username = u;
    sessionByUser[u] = true;
    // restore room membership if user reconnects while waiting
    const pendingCode = roomByUser[u];
    if (pendingCode && rooms[pendingCode] && rooms[pendingCode].sockets[1] === null) {
      const room = rooms[pendingCode];
      // cancel pending delete timeout
      if (room._deleteTO) {
        clearTimeout(room._deleteTO);
        room._deleteTO = null;
        console.log(`[${INSTANCE_ID}] Cancelled delete timeout for room ${pendingCode} on login`);
      }
      room.sockets[0] = socket;
      socket.roomCode = pendingCode;
      socket.playerIndex = 0;
      socket.join(pendingCode);
      console.log(`[${INSTANCE_ID}] Restored ${u} to room ${pendingCode} after login`);
    }
    socket.emit('auth_ok', publicProfile(rowToProfile(row)));
    console.log('login:', u);
  });

  // ─── RECONNECT ─────────────────────────────────────────────────────────────
  // Called by client when socket reconnects but user already has a local session
  socket.on('reconnect_session', ({ username }) => {
    if (!username) return;
    const u = username.trim().toLowerCase();
    const row = stmts.findUser.get(u);
    if (!row) { socket.emit('session_invalid'); return; }
    socket.username = u;
    sessionByUser[u] = true;
    // restore room if waiting
    const pendingCode = roomByUser[u];
    if (pendingCode && rooms[pendingCode]) {
      const room = rooms[pendingCode];
      const pi = room.state.players.findIndex(p => p.username === u);
      if (pi >= 0) {
        // cancel pending delete timeout
        if (room._deleteTO) {
          clearTimeout(room._deleteTO);
          room._deleteTO = null;
          console.log(`[${INSTANCE_ID}] Cancelled delete timeout for room ${pendingCode}`);
        }
        room.sockets[pi] = socket;
        socket.roomCode = pendingCode;
        socket.playerIndex = pi;
        socket.join(pendingCode);
        console.log(`[${INSTANCE_ID}] Session restored for ${u} in room ${pendingCode} player ${pi}`);
        // cancel any pending delete
        if (room._deleteTO) { clearTimeout(room._deleteTO); room._deleteTO = null; }
        // notify opponent that player is back
        const oppIdx = pi === 0 ? 1 : 0;
        if (room.sockets[oppIdx]) {
          room.sockets[oppIdx].emit('opponent_reconnected');
        }
        // if duel was in progress, send state to reconnected player
        if (room.sockets[0] && room.sockets[1]) {
          const p0row = stmts.findUser.get(room.state.players[0].username);
          const p1row = stmts.findUser.get(room.state.players[1].username);
          const p0 = p0row ? rowToProfile(p0row) : null;
          const p1 = p1row ? rowToProfile(p1row) : null;
          socket.emit('session_restored', {
            profile: publicProfile(row),
            inDuel: room.state.phase !== 'gameover',
            yourIndex: pi,
            yourLevel: calcLevel(rowToProfile(row).xp).n,
            oppLevel: calcLevel((pi===0?p1:p0)?.xp||0).n,
            oppName: room.state.players[pi===0?1:0].username,
            oppAvatar: (pi===0?p1:p0)?.avatar || '🧙',
            state: room.state,
          });
          return;
        }
      }
    }
    // no active room — just restore profile
    socket.emit('session_restored', { profile: publicProfile(rowToProfile(row)), inDuel: false });
  });

  socket.on('update_avatar', ({ avatar }) => {
    if (!socket.username) { socket.emit('error', { msg: 'Inicia sesión primero' }); return; }
    const valid = ['🧙','🧙‍♀️','🧝','🧝‍♀️','👸','🤴','🧚','🐱','👹','🧟','🐲','🦉'];
    const av = valid.includes(avatar) ? avatar : '🧙';
    db.prepare('UPDATE profiles SET avatar=? WHERE username=?').run(av, socket.username);
    const row = stmts.findUser.get(socket.username);
    socket.emit('avatar_updated', publicProfile(rowToProfile(row)));
  });

  // ─── LOBBY ────────────────────────────────────────────────────────────────
  socket.on('create_room', ({ path }) => {
    if (!socket.username) { socket.emit('error', { msg: 'Inicia sesión primero' }); return; }
    const row = stmts.findUser.get(socket.username);
    const profile = row ? rowToProfile(row) : null;
    if (!profile) { socket.emit('error', { msg: 'Perfil no encontrado' }); return; }
    const level = calcLevel(profile.xp);
    const code = makeCode();  // already uppercase
    const state = makeRoomState();
    state.players[0].path = path;
    state.players[0].username = socket.username;
    // clear any old room for this user before creating new one
    const oldCode = roomByUser[socket.username];
    if (oldCode && rooms[oldCode]) {
      clearTimeout(rooms[oldCode]._deleteTO);
      deleteRoom(oldCode);
    }
    rooms[code] = { sockets: [socket, null], state };
    socket.join(code);
    socket.roomCode = code;
    socket.playerIndex = 0;
    roomByUser[socket.username] = code;
    console.log(`[${INSTANCE_ID}] room created: ${code} | total rooms: ${Object.keys(rooms).length}`);
    socket.emit('room_created', { code, level: level.n });
  });

  socket.on('join_room', ({ code, path }) => {
    if (!socket.username) { socket.emit('error', { msg: 'Inicia sesión primero' }); return; }
    const normalCode = (code || '').trim().toUpperCase();
    console.log(`[${INSTANCE_ID}] join attempt: ${normalCode} | existing rooms:`, Object.keys(rooms));
    const room = rooms[normalCode];
    if (!room) {
      console.log(`[${INSTANCE_ID}] Room ${normalCode} NOT FOUND — this may be a multi-instance issue`);
      socket.emit('error', { msg: `Sala no encontrada (${normalCode}) — verifica el código` });
      return;
    }
    if (room.sockets[1]) { socket.emit('error', { msg: 'Sala llena' }); return; }

    const r1 = stmts.findUser.get(socket.username);
    const r0 = stmts.findUser.get(room.state.players[0].username);
    const p1 = r1 ? rowToProfile(r1) : null;
    const p0 = r0 ? rowToProfile(r0) : null;

    // clear any pending room the joiner had
    const joinerOldCode = roomByUser[socket.username];
    if (joinerOldCode && joinerOldCode !== normalCode && rooms[joinerOldCode]) {
      clearTimeout(rooms[joinerOldCode]._deleteTO);
      deleteRoom(joinerOldCode);
    }
    room.sockets[1] = socket;
    room.state.players[1].path = path;
    room.state.players[1].username = socket.username;
    socket.join(code.toUpperCase());
    socket.roomCode = code.toUpperCase();
    socket.playerIndex = 1;

    // Kick off first turn timer
    emitTurnChange(code, room, io);

    // Send each player their own index + opponent info
    room.sockets[0].emit('duel_start', {
      yourIndex: 0,
      yourLevel: calcLevel(p0.xp).n,
      oppLevel: calcLevel(p1.xp).n,
      oppName: socket.username,
      oppAvatar: p1 ? (p1.avatar||'🧙‍♀️') : '🧙‍♀️',
      state: room.state,
    });
    room.sockets[1].emit('duel_start', {
      yourIndex: 1,
      yourLevel: calcLevel(p1.xp).n,
      oppLevel: calcLevel(p0.xp).n,
      oppName: room.state.players[0].username,
      oppAvatar: p0 ? (p0.avatar||'🧙') : '🧙',
      state: room.state,
    });
  });

  // ─── COMBAT ───────────────────────────────────────────────────────────────
  socket.on('cast_spell', ({ spell }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.state.phase !== 'battle') return;
    const pi = socket.playerIndex;
    const ti = pi === 0 ? 1 : 0;
    if (room.state.turn !== pi) { socket.emit('not_your_turn'); return; }

    const s = SPELLS[spell];
    if (!s) return;
    const mults = PATH_MULTS[room.state.players[pi].path] || { dmg:1, heal:1 };

    // Record cast time for reaction tracking
    room.state.players[pi].spellCastAt = Date.now();

    if (s.shield) {
      room.state.players[pi].shield = true;
      io.to(code).emit('spell_result', { caster:pi, spell, effect:'shield' });
      room.state.turn = ti;
      emitTurnChange(code, room, io);
      return;
    }
    if (s.stun) {
      let dmg = Math.round(s.dmg * mults.dmg);
      if (room.state.players[ti].shield) { dmg = Math.floor(dmg*.5); room.state.players[ti].shield = false; }
      room.state.players[ti].hp = Math.max(0, room.state.players[ti].hp - dmg);
      room.state.players[ti].stun = true;
      io.to(code).emit('spell_result', { caster:pi, spell, effect:'stun', dmg });
      checkWin(code, room); if (room.state.phase !== 'gameover') { room.state.turn = ti; emitTurnChange(code, room, io); }
      return;
    }
    if (s.heal > 0) {
      const h = Math.round(s.heal * mults.heal);
      room.state.players[pi].hp = Math.min(100, room.state.players[pi].hp + h);
      io.to(code).emit('spell_result', { caster:pi, spell, effect:'heal', heal:h });
      room.state.turn = ti; emitTurnChange(code, room, io);
      return;
    }
    if (s.dmg > 0) {
      const rawDmg = Math.round(s.dmg * mults.dmg);
      const targetUsername = room.state.players[ti].username;
      const targetRow = stmts.findUser.get(targetUsername);
      const targetProfile = targetRow ? rowToProfile(targetRow) : null;
      const targetLevel = targetProfile ? calcLevel(targetProfile.xp) : LEVELS[0];
      const secs = targetLevel.counterSecs;
      const phrase = COUNTER_PHRASES[Math.floor(Math.random()*COUNTER_PHRASES.length)];

      room.state.phase = 'counter';
      room.state.counterFor = ti;
      room.state.counterDmg = rawDmg;
      room.state.counterPhrase = phrase;
      room.state.counterDeadline = Date.now() + secs*1000;

      io.to(code).emit('spell_result', { caster:pi, spell, effect:'attack', rawDmg });
      room.sockets[ti].emit('counter_challenge', { phrase, secs, rawDmg });
      room.sockets[pi].emit('counter_pending', { secs });

      setTimeout(() => {
        if (room.state.phase === 'counter') resolveCounter(code, room, false);
      }, (secs + 1.5) * 1000);
    }
  });

  socket.on('counter_attempt', ({ success, reactionMs }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.state.phase !== 'counter') return;
    if (socket.playerIndex !== room.state.counterFor) return;
    // Record reaction time
    if (reactionMs && reactionMs > 0) {
      room.state.players[socket.playerIndex].reactionTimes.push(reactionMs);
    }
    resolveCounter(code, room, success);
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const pi = socket.playerIndex;
    const bothConnected = room.sockets.filter(Boolean).length >= 2;
    console.log(`[${INSTANCE_ID}] disconnect: player ${pi} left room ${code} | phase: ${room.state.phase} | both: ${bothConnected}`);

    // null out this socket slot so reconnect can reclaim it
    room.sockets[pi] = null;

    if (bothConnected) {
      // Duel was in progress — give opponent 60s grace to reconnect
      room._deleteTO = setTimeout(() => {
        if (rooms[code]) {
          io.to(code).emit('opponent_disconnected');
          deleteRoom(code);
        }
      }, 60000);
      console.log(`[${INSTANCE_ID}] Room ${code}: duel paused, waiting 60s for reconnect`);
    } else {
      // Only 1 player was in room (waiting for rival) — keep room alive 30 min
      // so creator can reconnect and share the same code
      room._deleteTO = setTimeout(() => {
        if (rooms[code]) {
          console.log(`[${INSTANCE_ID}] Room ${code} expired after 30min`);
          deleteRoom(code);
        }
      }, 30 * 60 * 1000);
      console.log(`[${INSTANCE_ID}] Room ${code} kept alive 30min for reconnect`);
    }
  });
});

// ─── COUNTER RESOLUTION ───────────────────────────────────────────────────────
function resolveCounter(code, room, success) {
  const ti = room.state.counterFor;
  const pi = ti === 0 ? 1 : 0;
  const rawDmg = room.state.counterDmg;

  if (success) {
    const rebound = Math.floor(rawDmg * 0.5);
    room.state.players[pi].hp = Math.max(0, room.state.players[pi].hp - rebound);
    room.state.players[ti].countersOk++;
    io.to(code).emit('counter_result', { success:true, rebound, defender:ti });
  } else {
    let dmg = rawDmg;
    if (room.state.players[ti].shield) { dmg = Math.floor(dmg*.5); room.state.players[ti].shield = false; }
    room.state.players[ti].hp = Math.max(0, room.state.players[ti].hp - dmg);
    room.state.players[ti].countersFail++;
    io.to(code).emit('counter_result', { success:false, dmg, defender:ti });
  }

  room.state.phase = 'battle';
  room.state.counterFor = null;
  checkWin(code, room);
  if (room.state.phase !== 'gameover') {
    room.state.turn = ti;
    emitTurnChange(code, room, io);
  }
}

// ─── WIN / XP RESOLUTION ──────────────────────────────────────────────────────
function deleteRoom(code) {
  delete rooms[code];
  for (const [u, c] of Object.entries(roomByUser)) {
    if (c === code) delete roomByUser[u];
  }
  console.log(`[${INSTANCE_ID}] Room ${code} deleted`);
}

function checkWin(code, room) {
  const [p0, p1] = room.state.players;
  if (p0.hp > 0 && p1.hp > 0) return;
  const winnerIdx = p0.hp > 0 ? 0 : 1;
  const loserIdx  = winnerIdx === 0 ? 1 : 0;

  room.state.phase = 'gameover';

  const winnerUsername = room.state.players[winnerIdx].username;
  const loserUsername  = room.state.players[loserIdx].username;
  const wRow = stmts.findUser.get(winnerUsername);
  const lRow = stmts.findUser.get(loserUsername);
  const wp = wRow ? rowToProfile(wRow) : null;
  const lp = lRow ? rowToProfile(lRow) : null;

  // Build XP event lists
  const winnerEvents = ['win'];
  const loserEvents  = ['loss'];

  // Counters
  for (let i = 0; i < room.state.players[winnerIdx].countersOk;   i++) winnerEvents.push('counter_success');
  for (let i = 0; i < room.state.players[winnerIdx].countersFail;  i++) winnerEvents.push('counter_fail');
  for (let i = 0; i < room.state.players[loserIdx].countersOk;    i++) loserEvents.push('counter_success');
  for (let i = 0; i < room.state.players[loserIdx].countersFail;   i++) loserEvents.push('counter_fail');

  // Combos
  for (let i = 0; i < room.state.players[winnerIdx].combos; i++) winnerEvents.push('combo');
  for (let i = 0; i < room.state.players[loserIdx].combos;  i++) loserEvents.push('combo');

  // Reaction time bonuses
  function avgReaction(times) {
    if (!times.length) return null;
    return times.reduce((a,b) => a+b, 0) / times.length;
  }
  const wAvg = avgReaction(room.state.players[winnerIdx].reactionTimes);
  const lAvg = avgReaction(room.state.players[loserIdx].reactionTimes);
  if (wAvg !== null) { if (wAvg < 1200) winnerEvents.push('reaction_fast'); else if (wAvg < 2000) winnerEvents.push('reaction_ok'); }
  if (lAvg !== null) { if (lAvg < 1200) loserEvents.push('reaction_fast'); else if (lAvg < 2000) loserEvents.push('reaction_ok'); }

  // Streak
  if (wp) {
    wp.stats.wins++;
    wp.streak = (wp.streak || 0) + 1;
    if (wp.streak === 3) winnerEvents.push('streak_3');
    if (wp.streak === 5) winnerEvents.push('streak_5');
    wp.lastWin = Date.now();
  }
  if (lp) {
    lp.stats.losses++;
    lp.streak = 0;
    lp.stats.countersSuccess += room.state.players[loserIdx].countersOk;
    lp.stats.countersFail    += room.state.players[loserIdx].countersFail;
  }
  if (wp) {
    wp.stats.countersSuccess += room.state.players[winnerIdx].countersOk;
    wp.stats.countersFail    += room.state.players[winnerIdx].countersFail;
  }

  // Award XP
  const winnerXP = wp ? awardXP(wp, winnerEvents) : null;
  const loserXP  = lp ? awardXP(lp, loserEvents)  : null;

  // Reaction stats
  if (wp && wAvg !== null) {
    wp.stats.totalReactionMs  += wAvg * room.state.players[winnerIdx].reactionTimes.length;
    wp.stats.reactionSamples  += room.state.players[winnerIdx].reactionTimes.length;
  }
  if (lp && lAvg !== null) {
    lp.stats.totalReactionMs  += lAvg * room.state.players[loserIdx].reactionTimes.length;
    lp.stats.reactionSamples  += room.state.players[loserIdx].reactionTimes.length;
  }

  // Persist updated profiles to SQLite
  if (wp) saveProfile(wp);
  if (lp) saveProfile(lp);

  // Send game_over with full XP breakdown to each player
  if (room.sockets[winnerIdx]) {
    room.sockets[winnerIdx].emit('game_over', {
      winner: winnerIdx,
      xpResult: winnerXP,
      newProfile: wp ? publicProfile(wp) : null,
    });
  }
  if (room.sockets[loserIdx]) {
    room.sockets[loserIdx].emit('game_over', {
      winner: winnerIdx,
      xpResult: loserXP,
      newProfile: lp ? publicProfile(lp) : null,
    });
  }

  // Clean up room after game ends — delay 5s so sockets receive game_over first
  setTimeout(() => deleteRoom(code), 5000);
}

function publicProfile(p, pendingRoom) {
  const level = calcLevel(p.xp);
  const next = xpToNextLevel(p.xp);
  const avatar = p.avatar || '🧙';
  const pending = pendingRoom || roomByUser[p.username] || null;
  const avgReaction = p.stats.reactionSamples > 0
    ? Math.round(p.stats.totalReactionMs / p.stats.reactionSamples)
    : null;
  return {
    username: p.username,
    avatar,
    pendingRoom: pending,
    xp: p.xp,
    level: level.n,
    levelName: level.name,
    counterSecs: level.counterSecs,
    next,
    streak: p.streak,
    stats: { ...p.stats, avgReactionMs: avgReaction },
  };
}

const PORT = process.env.PORT || 3000;
const INSTANCE_ID = Math.random().toString(36).substring(2,6).toUpperCase();
server.listen(PORT, () => {
  console.log(`Wizard Duel v2 running on port ${PORT} — instance ${INSTANCE_ID}`);
});

// Log active rooms every 30s so we can debug missing rooms
setInterval(() => {
  const codes = Object.keys(rooms);
  if(codes.length > 0) console.log(`[${INSTANCE_ID}] Active rooms:`, codes);
}, 30000);
