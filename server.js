const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATABASE SETUP (sql.js — pure JS, no native compilation needed) ─────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'wizard.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db;

function saveDb() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) { console.error('DB save error:', e.message); }
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    console.log('Loaded existing DB from', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('Created new DB at', DB_PATH);
  }

  db.run(`
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
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    )
  `);

  try { db.run(`ALTER TABLE profiles ADD COLUMN avatar TEXT NOT NULL DEFAULT '🧙'`); }
  catch(e) { /* already exists */ }

  saveDb();
  // Auto-save every 30 seconds
  setInterval(saveDb, 30000);
}

// ─── DB HELPERS (replicate better-sqlite3 API) ───────────────────────────────
const stmts = {
  findUser(username) {
    const res = db.exec('SELECT * FROM profiles WHERE username = ?', [username]);
    if (!res.length || !res[0].values.length) return null;
    const cols = res[0].columns;
    const row = res[0].values[0];
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  },
  insertUser({ username, password_hash, avatar }) {
    db.run('INSERT INTO profiles (username, password_hash, avatar) VALUES (?, ?, ?)',
      [username, password_hash, avatar || '🧙']);
    saveDb();
  },
  updateProfile(p) {
    db.run(`UPDATE profiles SET
      xp=?, level=?, streak=?, last_win=?,
      wins=?, losses=?, counters_ok=?, counters_fail=?,
      combos=?, total_rxn_ms=?, rxn_samples=?
      WHERE username=?`,
      [p.xp, p.level, p.streak||0, p.last_win||null,
       p.wins, p.losses, p.counters_ok, p.counters_fail,
       p.combos, p.total_rxn_ms, p.rxn_samples,
       p.username]);
    saveDb();
  },
  updateAvatar(username, avatar) {
    db.run('UPDATE profiles SET avatar=? WHERE username=?', [avatar, username]);
    saveDb();
  },
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
  stmts.updateProfile({
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
  aturdir:   { dmg: 25, heal: 0,  cost: 25, power: 1 },
  expulsar:  { dmg: 20, heal: 0,  cost: 20, power: 1 },
  sanar:     { dmg: 0,  heal: 20, cost: 25, power: 0 },
  escudo:    { dmg: 0,  heal: 0,  cost: 30, power: 0, shield: true },
  destruir:  { dmg: 45, heal: 0,  cost: 50, power: 2 },
  quemar:    { dmg: 35, heal: 0,  cost: 40, power: 2 },
  restaurar: { dmg: 0,  heal: 30, cost: 35, power: 0 },
  confundir: { dmg: 15, heal: 0,  cost: 25, power: 1, stun: true },
  desgarrar: { dmg: 40, heal: 0,  cost: 45, power: 2 },
};

const MAX_ENERGY = 100;
const ENERGY_REGEN = 12; // per second
const CAST_SECS = 4; // fixed time to choose a spell each turn

const COUNTER_PHRASES = [
  '¡Esquiva!','¡Refleja!','¡Barrera!','¡Detente!',
  '¡Bloquea!','¡Para!','¡Escudo!','¡Protege!',
  '¡Rebota!','¡Desvía!','¡Frena!','¡Cúbrete!',
  '¡Resiste!','¡Aguanta!','¡Rechaza!','¡Deflecta!',
];

// Also send keywords so client can match voice loosely
const COUNTER_KEYWORDS = {
  '¡Esquiva!':  ['esquiva','esquivar','esquivo'],
  '¡Refleja!':  ['refleja','reflejar','reflejo'],
  '¡Barrera!':  ['barrera','barre','barreras'],
  '¡Detente!':  ['detente','detener','detén','deten'],
  '¡Bloquea!':  ['bloquea','bloquear','bloqueo','bloqué'],
  '¡Para!':     ['para','parar','párate','parate'],
  '¡Escudo!':   ['escudo','escudos','escudar'],
  '¡Protege!':  ['protege','proteger','protejo'],
  '¡Rebota!':   ['rebota','rebotar','rebote'],
  '¡Desvía!':   ['desvía','desvia','desviar','desvío'],
  '¡Frena!':    ['frena','frenar','freno'],
  '¡Cúbrete!':  ['cúbrete','cubrete','cubrirse','cubre'],
  '¡Resiste!':  ['resiste','resistir','resisto'],
  '¡Aguanta!':  ['aguanta','aguantar','aguanto'],
  '¡Rechaza!':  ['rechaza','rechazar','rechazo'],
  '¡Deflecta!': ['deflecta','deflectar','deflecto','defleja'],
};

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
      { hp:100, energy:MAX_ENERGY, shield:false, stun:false, path:null, username:null,
        countersOk:0, countersFail:0, combos:0, reactionTimes:[], choice:null, choiceTime:0 },
      { hp:100, energy:MAX_ENERGY, shield:false, stun:false, path:null, username:null,
        countersOk:0, countersFail:0, combos:0, reactionTimes:[], choice:null, choiceTime:0 },
    ],
    phase: 'simultaneous', // simultaneous | resolving | gameover
    roundDeadline: 0,
    roundTimeout: null,
    energyInterval: null,
  };
}

const ROUND_SECS = 4;

function startRound(code, room, io) {
  if (!rooms[code] || room.state.phase === 'gameover') return;

  // clear previous choices
  room.state.players[0].choice = null;
  room.state.players[1].choice = null;
  room.state.phase = 'simultaneous';

  // shuffle spell orders per player
  const PATH_SPELLS = {
    destructor: ['aturdir','destruir','expulsar','quemar'],
    guardian:   ['escudo','sanar','expulsar','restaurar'],
    trickster:  ['confundir','expulsar','aturdir','desgarrar'],
  };
  const order0 = shuffle(PATH_SPELLS[room.state.players[0].path] || PATH_SPELLS.destructor);
  const order1 = shuffle(PATH_SPELLS[room.state.players[1].path] || PATH_SPELLS.destructor);

  const deadline = Date.now() + ROUND_SECS * 1000;
  room.state.roundDeadline = deadline;

  // send round_start to each player with their own spell order
  if (room.sockets[0]) room.sockets[0].emit('round_start', {
    spellOrder: order0, secs: ROUND_SECS, deadline,
    myEnergy: room.state.players[0].energy,
    oppEnergy: room.state.players[1].energy,
  });
  if (room.sockets[1]) room.sockets[1].emit('round_start', {
    spellOrder: order1, secs: ROUND_SECS, deadline,
    myEnergy: room.state.players[1].energy,
    oppEnergy: room.state.players[0].energy,
  });

  // auto-resolve when time runs out
  clearTimeout(room.state.roundTimeout);
  room.state.roundTimeout = setTimeout(() => {
    if (rooms[code] && room.state.phase === 'simultaneous') {
      resolveRound(code, room, io);
    }
  }, (ROUND_SECS + 0.5) * 1000);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connected:', socket.id);

  socket.on('register', async ({ username, password, avatar }) => {
    if (!db) { socket.emit('auth_error', { msg: 'Servidor iniciando, intenta en unos segundos' }); return; }
    const u = username.trim().toLowerCase();
    if (!u || u.length < 2 || u.length > 20) {
      socket.emit('auth_error', { msg: 'Nombre: 2–20 caracteres' }); return;
    }
    if (!password || password.length < 3) {
      socket.emit('auth_error', { msg: 'Contraseña: mínimo 3 caracteres' }); return;
    }
    if (stmts.findUser(u)) {
      socket.emit('auth_error', { msg: 'Ese nombre ya existe — inicia sesión' }); return;
    }
    const hash = await bcrypt.hash(password, 8);
    const av = avatar && avatar.length <= 8 ? avatar : '🧙';
    stmts.insertUser({ username: u, password_hash: hash, avatar: av });
    const profile = rowToProfile(stmts.findUser(u));
    socket.username = u;
    socket.emit('auth_ok', publicProfile(profile));
    console.log('registered:', u);
  });

  socket.on('login', async ({ username, password }) => {
    if (!db) { socket.emit('auth_error', { msg: 'Servidor iniciando, intenta en unos segundos' }); return; }
    const u = username.trim().toLowerCase();
    console.log(`[${INSTANCE_ID}] login attempt for: ${u}`);
    const row = stmts.findUser(u);
    console.log(`[${INSTANCE_ID}] user found:`, !!row);
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
    const row = stmts.findUser(u);
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
        // send queued duel_start if player missed it
        if (pi === 0 && room._pendingDuelStart0) {
          socket.emit('duel_start', { ...room._pendingDuelStart0, state: room.state });
          room._pendingDuelStart0 = null;
        }
        // notify opponent that player is back
        const oppIdx = pi === 0 ? 1 : 0;
        if (room.sockets[oppIdx]) {
          room.sockets[oppIdx].emit('opponent_reconnected');
        }
        // if duel was in progress, send state to reconnected player
        if (room.sockets[0] && room.sockets[1]) {
          const p0row = stmts.findUser(room.state.players[0].username);
          const p1row = stmts.findUser(room.state.players[1].username);
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
    stmts.updateAvatar(socket.username, av);
    const row = stmts.findUser(socket.username);
    socket.emit('avatar_updated', publicProfile(rowToProfile(row)));
  });

  // ─── LOBBY ────────────────────────────────────────────────────────────────
  socket.on('create_room', ({ path }) => {
    if (!socket.username) { socket.emit('error', { msg: 'Inicia sesión primero' }); return; }
    const row = stmts.findUser(socket.username);
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

    const r1 = stmts.findUser(socket.username);
    const r0 = stmts.findUser(room.state.players[0].username);
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

    // Kick off first simultaneous round
    setTimeout(() => startRound(code, room, io), 500);

    // Send each player their own index + opponent info
    // Guard against null sockets (player may have briefly disconnected while waiting)
    const p0Avatar = p0 ? (p0.avatar||'🧙')   : '🧙';
    const p1Avatar = p1 ? (p1.avatar||'🧙‍♀️') : '🧙‍♀️';

    if (room.sockets[0]) {
      room.sockets[0].emit('duel_start', {
        yourIndex: 0,
        yourLevel: calcLevel(p0.xp).n,
        oppLevel:  calcLevel(p1.xp).n,
        oppName:   socket.username,
        oppAvatar: p1Avatar,
        state: room.state,
      });
    } else {
      // store for reconnect
      room._pendingDuelStart0 = {
        yourIndex:0, yourLevel:calcLevel(p0.xp).n,
        oppLevel:calcLevel(p1.xp).n, oppName:socket.username,
        oppAvatar:p1Avatar
      };
      console.log(`[${INSTANCE_ID}] Player 0 offline — duel_start queued`);
    }
    if (room.sockets[1]) {
      room.sockets[1].emit('duel_start', {
        yourIndex: 1,
        yourLevel: calcLevel(p1.xp).n,
        oppLevel:  calcLevel(p0.xp).n,
        oppName:   room.state.players[0].username,
        oppAvatar: p0Avatar,
        state: room.state,
      });
    }
  });

  // ─── SIMULTANEOUS COMBAT ─────────────────────────────────────────────────
  socket.on('choose_spell', ({ spell }) => {
    const code = socket.roomCode;
    const room = rooms[code];
    if (!room || room.state.phase !== 'simultaneous') return;
    const pi = socket.playerIndex;
    const s = SPELLS[spell];
    if (!s) return;
    if (room.state.players[pi].energy < s.cost) {
      socket.emit('no_energy', { needed: s.cost, have: room.state.players[pi].energy });
      return;
    }
    room.state.players[pi].choice = spell;
    room.state.players[pi].choiceTime = Date.now();
    socket.emit('choice_confirmed', { spell });
    // if both chose resolve immediately
    if (room.state.players[0].choice && room.state.players[1].choice) {
      clearTimeout(room.state.roundTimeout);
      setTimeout(() => resolveRound(code, room, io), 300);
    }
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
    startRound(code, room, io);
  }
}

// ─── WIN / XP RESOLUTION ──────────────────────────────────────────────────────
function resolveRound(code, room, io) {
  if (!rooms[code] || room.state.phase === 'gameover') return;
  room.state.phase = 'resolving';

  const p0 = room.state.players[0], p1 = room.state.players[1];
  const c0 = p0.choice, c1 = p1.choice;
  const s0 = c0 ? SPELLS[c0] : null;
  const s1 = c1 ? SPELLS[c1] : null;
  const m0 = PATH_MULTS[p0.path] || { dmg:1, heal:1 };
  const m1 = PATH_MULTS[p1.path] || { dmg:1, heal:1 };

  // deduct energy
  if (s0) p0.energy = Math.max(0, p0.energy - s0.cost);
  if (s1) p1.energy = Math.max(0, p1.energy - s1.cost);

  let result = { type:'none', p0dmg:0, p1dmg:0, p0heal:0, p1heal:0, clash:false };

  if (!s0 && !s1) {
    result.type = 'both_idle';
  } else if (s0?.shield && s1?.shield) {
    result.type = 'both_shield';
  } else if (s0?.shield && s1?.dmg > 0) {
    result.type = 'p0_blocked';
  } else if (s1?.shield && s0?.dmg > 0) {
    result.type = 'p1_blocked';
  } else if (s0?.dmg > 0 && s1?.dmg > 0) {
    // CLASH
    result.clash = true;
    const pow0 = s0.power || 1, pow1 = s1.power || 1;
    const d0 = Math.round(s0.dmg * m0.dmg), d1 = Math.round(s1.dmg * m1.dmg);
    if (pow0 > pow1) {
      result.type = 'p0_wins_clash';
      result.p1dmg = d0 - Math.floor(d1 * 0.5);
    } else if (pow1 > pow0) {
      result.type = 'p1_wins_clash';
      result.p0dmg = d1 - Math.floor(d0 * 0.5);
    } else {
      result.type = 'equal_clash';
      result.p0dmg = Math.floor(d1 * 0.4);
      result.p1dmg = Math.floor(d0 * 0.4);
    }
  } else if (s0?.dmg > 0 && !s1) {
    result.type = 'p0_hits';
    result.p1dmg = Math.round(s0.dmg * m0.dmg);
    if (s0.stun) p1.stun = true;
  } else if (s1?.dmg > 0 && !s0) {
    result.type = 'p1_hits';
    result.p0dmg = Math.round(s1.dmg * m1.dmg);
    if (s1.stun) p0.stun = true;
  } else if (s0?.heal > 0) {
    result.type = 'p0_heals';
    result.p0heal = Math.round(s0.heal * m0.heal);
  } else if (s1?.heal > 0) {
    result.type = 'p1_heals';
    result.p1heal = Math.round(s1.heal * m1.heal);
  }

  // apply damage and healing
  p0.hp = Math.max(0, Math.min(100, p0.hp - result.p0dmg + result.p0heal));
  p1.hp = Math.max(0, Math.min(100, p1.hp - result.p1dmg + result.p1heal));

  // start energy regen
  let regenTicks = 0;
  const regenInterval = setInterval(() => {
    if (!rooms[code]) { clearInterval(regenInterval); return; }
    regenTicks++;
    p0.energy = Math.min(MAX_ENERGY, p0.energy + ENERGY_REGEN * 0.1);
    p1.energy = Math.min(MAX_ENERGY, p1.energy + ENERGY_REGEN * 0.1);
    io.to(code).emit('energy_update', {
      p0: Math.round(p0.energy), p1: Math.round(p1.energy)
    });
    if (regenTicks >= 20) clearInterval(regenInterval); // 2 seconds of regen
  }, 100);

  // emit result to both players
  io.to(code).emit('round_result', {
    result,
    spell0: c0, spell1: c1,
    p0hp: p0.hp, p1hp: p1.hp,
    p0energy: Math.round(p0.energy), p1energy: Math.round(p1.energy),
  });

  checkWin(code, room);
  if (room.state.phase !== 'gameover') {
    setTimeout(() => {
      if (rooms[code]) startRound(code, room, io);
    }, 2200);
  }
}

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
  const wRow = stmts.findUser(winnerUsername);
  const lRow = stmts.findUser(loserUsername);
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

initDb().then(() => {
  console.log('DB ready — starting server');
  server.listen(PORT, () => {
    console.log(`Wizard Duel v2 running on port ${PORT} — instance ${INSTANCE_ID}`);
  });
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});

// Log active rooms every 30s so we can debug missing rooms
setInterval(() => {
  const codes = Object.keys(rooms);
  if(codes.length > 0) console.log(`[${INSTANCE_ID}] Active rooms:`, codes);
}, 30000);
