// server.js  —  3D Hex multiplayer server with lobby
// Run with:  node server.js
// Requires:  npm install express socket.io
//
// Many games can run at once.  Each game lives in its own "room" with its own
// shared state and exactly two seats.  Players get into a room in one of three ways:
//   * "Play with a stranger"  — the server pairs two waiting players.
//   * "Create private game"   — the server makes a room and a code like HEX-4827;
//                               the creator gives the code (or a link) to a friend.
//   * "Join private game"     — the friend enters the code (or opens the link).
// Each client keeps its own display/camera settings; only game state is shared.

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

// ── CSV statistics ────────────────────────────────────────────────────────────
// Written to disk (persists within a Render session; lost on redeploy unless
// a persistent disk is mounted at /data). Also served at GET /statistics.csv.
// Fields: first_player, red_turns_per_move, random_sites, actual_levels, winner
// One file for all rooms: every completed game from every room is one row.
const CSV_PATH = process.env.CSV_PATH || path.join(__dirname, 'statistics.csv');
const CSV_HEADER = 'first_player,red_turns_per_move,random_sites,actual_levels,winner\n';

let csvData = '';
try {
  csvData = fs.readFileSync(CSV_PATH, 'utf8');
  if (!csvData.startsWith('first_player')) csvData = CSV_HEADER + csvData;
} catch (e) {
  csvData = CSV_HEADER;
  try { fs.writeFileSync(CSV_PATH, csvData); } catch (e2) {}
}

// ── Who won: two numbering systems ───────────────────────────────────────────
// INSIDE the game (state.winning_player, the 'win' and 'win_declared' messages, and
// the client's own win test) the numbering is:  1 = GREEN won,  2 = RED won.
// The STATISTICS FILE uses the numbering you specified:  1 = red won,  2 = green won.
// Convert only here, when writing the file.
const GREEN_WON = 1, RED_WON = 2;
function csvWinnerCode(winningPlayer) { return winningPlayer === RED_WON ? 1 : 2; }

function appendGameResult(state, winningPlayer) {
  const row = [
    state.saved_first_player,          // 1 = red moved first, 2 = green moved first
    state.redturns.toFixed(4),
    state.random_sites,
    state.actual_levels,
    csvWinnerCode(winningPlayer)       // 1 = red won, 2 = green won
  ].join(',') + '\n';
  csvData += row;
  try { fs.writeFileSync(CSV_PATH, csvData); } catch (e) {}
  console.log('Game result recorded:', row.trim());
}

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

// Serve game files from the same directory as server.js
app.use(express.static(__dirname));

// Serve the game when the browser requests just '/'  (also with ?room=HEX-1234)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '3D_Hex_multiplayer.html'));
});

// Download statistics
app.get('/statistics.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="statistics.csv"');
  res.send(csvData);
});

// ── Game state (one per room) ────────────────────────────────────────────────
// This mirrors the variables in the client that both players must agree on.

const DEFAULT_LEVELS   = 9;
const MAX_LEVELS       = 20;
const MAX_SITES        = 19 * MAX_LEVELS;
const MAX_CYLINDERS    = 7 * 19 * MAX_LEVELS;

function makeDefaultState() {
  return {
    // game setup (may be changed before first move)
    actual_levels      : DEFAULT_LEVELS,
    redturns           : 2,
    saved_first_player : 1,

    // in-progress state
    player             : 1,
    red_moves          : 2,        // starts at floor(redturns)
    red_moves_incremented : false,
    moves              : 0,
    random_sites       : 0,
    winning_player     : 0,

    // board arrays — sent as plain arrays (JSON-serialisable)
    sphere_colors      : new Array(MAX_SITES).fill(0),
    cylinder_colors    : new Array(MAX_CYLINDERS).fill(0),

    // last move info (needed so either player can undo)
    move_active_level  : 0,
    move_active_k      : 0,
    undo_calls         : 0,
    undo_seat          : 0,      // 1=red 2=green 0=nobody
    red_bidder         : null,   // seat of player who bid for red, null if not yet bid
    pending_random     : null,   // { seat, level, k } when one player pressed space awaiting confirmation
    require_space      : 0,      // when 1, both players must press space to add a random site
  };
}

// ── Rooms ────────────────────────────────────────────────────────────────────
// room = { code, isPrivate, state, seats: {1: socketId|null, 2: socketId|null},
//          entered: { socketId: true } }   // entered = has been sent 'welcome'

const rooms      = new Map();   // code -> room
const socketRoom = new Map();   // socket.id -> room code
let   waitingStranger = null;   // socket.id of the one player waiting for a stranger

function makeRoom(isPrivate) {
  let code;
  do {
    code = 'HEX-' + (1000 + Math.floor(Math.random() * 9000));
  } while (rooms.has(code));
  const room = {
    code, isPrivate,
    state: makeDefaultState(),
    seats: { 1: null, 2: null },
    entered: {}
  };
  rooms.set(code, room);
  console.log(`room ${code} created (${isPrivate ? 'private' : 'stranger'}); rooms now ${rooms.size}`);
  return room;
}

function roomOf(socket) {
  const code = socketRoom.get(socket.id);
  return code ? rooms.get(code) : null;
}

function seatOf(room, socketId) {
  if (room.seats[1] === socketId) return 1;
  if (room.seats[2] === socketId) return 2;
  return null;
}

function joinRoom(socket, room, seat) {
  room.seats[seat] = socket.id;
  socketRoom.set(socket.id, room.code);
  socket.join(room.code);
}

function broadcastState(room) {
  io.to(room.code).emit('state_update', room.state);
}

function emitPlayerList(room) {
  io.to(room.code).emit('player_list', [1, 2].filter(s => room.seats[s]));
}

// Send 'welcome' to every seated player who has not yet entered the game.
// Players who were already in the game are told that an opponent has (re)joined.
function enterGame(room) {
  for (const seat of [1, 2]) {
    const id = room.seats[seat];
    if (!id) continue;
    if (!room.entered[id]) {
      io.to(id).emit('welcome', {
        seat,
        state: room.state,
        code: room.isPrivate ? room.code : null
      });
      room.entered[id] = true;
    } else {
      io.to(id).emit('opponent_joined');
    }
  }
  emitPlayerList(room);
}

// Remove a socket from its room (disconnect, or cancelling a private game).
function leaveRoom(socket) {
  const room = roomOf(socket);
  socketRoom.delete(socket.id);
  if (waitingStranger === socket.id) waitingStranger = null;
  if (!room) return;
  const seat = seatOf(room, socket.id);
  if (seat) room.seats[seat] = null;
  delete room.entered[socket.id];
  socket.leave(room.code);
  if (!room.seats[1] && !room.seats[2]) {
    rooms.delete(room.code);
    console.log(`room ${room.code} closed; rooms now ${rooms.size}`);
  } else {
    io.to(room.code).emit('opponent_left', { seat });
    emitPlayerList(room);
  }
}

// "HEX-4827", "hex 4827", "4827" -> "HEX-4827";  anything else -> null
function normalizeCode(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length === 4 ? 'HEX-' + digits : null;
}

function isInt(x, lo, hi) {
  return Number.isInteger(x) && x >= lo && x <= hi;
}

// ── Connection handling ──────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // A malformed message from any client must never crash the server for everyone.
  function on(eventName, handler) {
    socket.on(eventName, (...args) => {
      try { handler(...args); }
      catch (err) { console.error('error in', eventName, err); }
    });
  }

  // ── Lobby ───────────────────────────────────────────────────────────────

  on('find_match', () => {
    if (roomOf(socket)) return;
    // Drop a stale waiter (disconnected, or already placed in a room).
    if (waitingStranger &&
        (!io.sockets.sockets.get(waitingStranger) || socketRoom.has(waitingStranger))) {
      waitingStranger = null;
    }
    if (waitingStranger && waitingStranger !== socket.id) {
      const waiter = io.sockets.sockets.get(waitingStranger);
      waitingStranger = null;
      const room = makeRoom(false);
      joinRoom(waiter, room, 1);
      joinRoom(socket, room, 2);
      enterGame(room);
    } else {
      waitingStranger = socket.id;
      socket.emit('lobby_waiting', { kind: 'stranger' });
    }
  });

  on('create_private', () => {
    const existing = roomOf(socket);
    if (existing) {
      // Already created one and still waiting: just show the code again.
      if (!existing.entered[socket.id])
        socket.emit('lobby_waiting', { kind: 'private', code: existing.code });
      return;
    }
    if (waitingStranger === socket.id) waitingStranger = null;
    const room = makeRoom(true);
    joinRoom(socket, room, 1);
    socket.emit('lobby_waiting', { kind: 'private', code: room.code });
  });

  on('join_private', ({ code } = {}) => {
    if (roomOf(socket)) return;
    const normalized = normalizeCode(code);
    const room = normalized ? rooms.get(normalized) : null;
    if (!room || !room.isPrivate) {
      socket.emit('join_failed', {
        message: 'No private game was found with that code. ' +
                 'Check the code, and ask your opponent to confirm that they are still waiting.'
      });
      return;
    }
    const seat = !room.seats[1] ? 1 : (!room.seats[2] ? 2 : null);
    if (seat === null) {
      socket.emit('join_failed', { message: 'That game already has two players.' });
      return;
    }
    if (waitingStranger === socket.id) waitingStranger = null;
    joinRoom(socket, room, seat);
    enterGame(room);
  });

  on('cancel_wait', () => {
    if (waitingStranger === socket.id) waitingStranger = null;
    const room = roomOf(socket);
    // Only a private-game creator who is still alone may cancel; players already
    // in a game cannot leave through this event.
    if (room && !room.entered[socket.id]) leaveRoom(socket);
    socket.emit('lobby_cancelled');
  });

  // ── Move ────────────────────────────────────────────────────────────────
  // Payload: { level, k }
  on('move', ({ level, k } = {}) => {
    const room = roomOf(socket); if (!room) return;
    const state = room.state;
    const seat = seatOf(room, socket.id);
    if (seat === null) return;
    if (state.winning_player > 0) return;             // game over
    if (!isInt(level, 0, state.actual_levels - 1) || !isInt(k, 0, 18)) return;

    const i = 19 * level + k;
    if (state.sphere_colors[i] !== 0) return;         // already occupied

    // Record for undo
    state.move_active_level = level;
    state.move_active_k     = k;
    state.undo_calls        = 0;

    // Place the piece — bond colours are computed client-side from sphere_colors,
    // so we only need to keep sphere_colors and cylinder_colors in sync here.
    state.sphere_colors[i] = state.player;

    if (state.player === 1) {
      state.red_moves -= 1;
      if (state.red_moves <= 0) {
        state.red_moves          += state.redturns;
        state.red_moves_incremented = true;
        state.player              = 2;
      } else {
        state.red_moves_incremented = false;
      }
    } else {
      state.player              = 1;
      state.red_moves_incremented = false;
    }

    state.moves += 1;
    state.undo_seat = seat;
    broadcastState(room);
  });

  // ── Cylinder colours delta ───────────────────────────────────────────────
  // After a move the client that made it sends back the updated cylinder_colors
  // (it already ran set_bond_colors locally).  We store it and relay to the other.
  on('cylinder_delta', (cylinder_colors) => {
    const room = roomOf(socket); if (!room) return;
    if (!Array.isArray(cylinder_colors) || cylinder_colors.length > MAX_CYLINDERS) return;
    room.state.cylinder_colors = cylinder_colors;
    socket.to(room.code).emit('cylinder_delta', cylinder_colors);
  });

  // ── Win report ───────────────────────────────────────────────────────────
  on('win', ({ winning_player } = {}) => {
    const room = roomOf(socket); if (!room) return;
    const state = room.state;
    if (seatOf(room, socket.id) === null) return;
    if (winning_player !== 1 && winning_player !== 2) return;
    if (state.winning_player > 0) return;  // already declared
    state.winning_player = winning_player;
    appendGameResult(state, winning_player);
    io.to(room.code).emit('win_declared', { winning_player });
  });

  // ── Concede ───────────────────────────────────────────────────────────────
  // A player presses Delete to concede; the other player wins.
  on('concede', () => {
    const room = roomOf(socket); if (!room) return;
    const state = room.state;
    const seat = seatOf(room, socket.id);
    if (seat === null || state.winning_player > 0 || state.moves === 0) return;
    // Seat 1 is red and seat 2 is green.  The player who concedes loses, so the
    // OTHER side wins.  (In the game's numbering: red conceding means GREEN_WON.)
    const winning = (seat === 1) ? GREEN_WON : RED_WON;
    state.winning_player = winning;
    appendGameResult(state, winning);
    io.to(room.code).emit('win_declared',
      { winning_player: winning, conceded: true, conceding_seat: seat });
  });

  // ── Undo ────────────────────────────────────────────────────────────────
  // Payload: { expected_moves, target_level, target_k, undoing_seat }
  // If expected_moves doesn't match state.moves, the other player has moved in the
  // meantime (race condition) and the undo is rejected with 'undo_rejected'.
  on('undo', ({ expected_moves, target_level, target_k, undoing_seat } = {}) => {
    const room = roomOf(socket); if (!room) return;
    const state = room.state;
    const seat = seatOf(room, socket.id);
    if (seat === null) return;

    // Allow undo if:
    //  - undo_calls is 0 (first undo in a sequence), OR
    //  - undo_seat matches this player (continuing a multi-step undo)
    if (state.undo_calls !== 0 && state.undo_seat !== seat) return;

    // Race condition check
    if (expected_moves !== undefined && expected_moves !== state.moves) {
      socket.emit('undo_rejected', {
        message: 'Too late to undo — the other player has already moved.'
      });
      return;
    }

    // Use the target from the client's move_history stack if provided,
    // otherwise fall back to move_active_level/k
    const ul = (target_level !== undefined) ? target_level : state.move_active_level;
    const uk = (target_k    !== undefined) ? target_k    : state.move_active_k;
    if (!isInt(ul, 0, state.actual_levels - 1) || !isInt(uk, 0, 18)) return;
    state.sphere_colors[19 * ul + uk] = 0;

    // Determine who made this move: use undoing_seat from client if provided.
    // This avoids the bug where (3 - state.player) gives the wrong mover
    // during red sub-moves when state.player hasn't switched yet.
    const mover = undoing_seat || seat;
    if (mover === 1) {
      // Undoing a red sub-move: restore one red placement
      if (state.red_moves_incremented) {
        state.red_moves -= state.redturns;
        state.red_moves_incremented = false;
        state.player = 1; // was green's turn, now back to red
      }
      state.red_moves += 1;
      state.player = 1;
    } else {
      // Undoing a green move
      state.player = 2;
    }
    state.undo_calls  = 1;
    state.undo_seat   = seat; // undo stays with undoing player
    state.moves       = Math.max(0, state.moves - 1);
    broadcastState(room);
  });

  // ── Reset (new game) ─────────────────────────────────────────────────────
  // A fresh game state, but the initial SETTINGS carry over: number of layers,
  // red placements per turn, and the two-player space-bar requirement.
  on('reset', ({ saved_first_player } = {}) => {
    const room = roomOf(socket); if (!room) return;
    if (seatOf(room, socket.id) === null) return;
    const prev = room.state;
    const next = makeDefaultState();
    next.actual_levels = prev.actual_levels;
    next.redturns      = prev.redturns;
    next.require_space = prev.require_space;
    const first = (saved_first_player === 1 || saved_first_player === 2)
                  ? saved_first_player : prev.saved_first_player;
    next.player             = first;
    next.saved_first_player = first;
    next.red_moves          = Math.floor(next.redturns);
    room.state = next;
    broadcastState(room);
  });

  // ── Setup changes (before first move) ───────────────────────────────────
  // Payload: { actual_levels } or { redturns } or { add_random: { level, k } } ...
  on('setup', (changes = {}) => {
    const room = roomOf(socket); if (!room) return;
    const state = room.state;
    const seat = seatOf(room, socket.id);
    if (seat === null) return;
    if (state.moves > 0) return;   // ignore if game started

    if (changes.actual_levels !== undefined) {
      if (isInt(changes.actual_levels, 2, MAX_LEVELS))
        state.actual_levels = changes.actual_levels;
    }
    if (changes.redturns !== undefined) {
      if (typeof changes.redturns === 'number' && isFinite(changes.redturns) &&
          changes.redturns >= 1 && changes.redturns <= 100) {
        state.redturns  = changes.redturns;
        // Start with floor(redturns) so the first red turn gives floor placements,
        // not ceil. The fractional part accumulates across turns as designed.
        state.red_moves = Math.floor(state.redturns);
      }
    }
    if (changes.add_random !== undefined) {
      const { level, k } = changes.add_random || {};
      if (isInt(level, 0, state.actual_levels - 1) && isInt(k, 0, 18) &&
          state.sphere_colors[19 * level + k] === 0) {
        state.sphere_colors[19 * level + k] = 1;   // always red, regardless of whose turn it is
        state.random_sites += 1;
        // Store level/k so the receiving client can call set_bond_colors directly
        state.move_active_level = level;
        state.move_active_k     = k;
      }
    }
    if (changes.first_player !== undefined) {
      if (changes.first_player === 1 || changes.first_player === 2) {
        state.player             = changes.first_player;
        state.saved_first_player = changes.first_player;
      }
    }
    if (changes.require_space !== undefined) {
      state.require_space = changes.require_space ? 1 : 0;
    }

    // bid_red: the first player to press 'm' becomes red (seat 1).
    // Allowed even after random sites have been added; closed by the first move.
    if (changes.bid_red !== undefined) {
      if (!state.red_bidder) {
        state.red_bidder = seat;
        // If the bidder holds seat 2, swap the two seats so the bidder becomes
        // seat 1 (red).  The clients make the same swap on 'seat_change'; the server
        // must do it too, so that it keeps agreeing with the clients about who is who.
        if (seat === 2) {
          const t = room.seats[1];
          room.seats[1] = room.seats[2];
          room.seats[2] = t;
        }
        io.to(room.code).emit('seat_change', { red_seat: seat });
        state.saved_first_player = 1;
        state.player = 1;
        broadcastState(room);
      } else {
        // Someone already bid — inform this client
        socket.emit('bid_rejected', { message: 'Red has already been claimed.' });
      }
      return;
    }
    broadcastState(room);
  });

  // ── Cursor position relay ────────────────────────────────────────────────
  // Relay the active player's cursor position to the other player in the room only.
  // No state stored — purely a display hint.
  on('cursor', (data) => {
    const room = roomOf(socket); if (!room) return;
    if (!data || !isInt(data.level, 0, MAX_LEVELS - 1) || !isInt(data.k, 0, 18)) return;
    socket.to(room.code).emit('cursor', { level: data.level, k: data.k });
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  on('chat', ({ msg } = {}) => {
    const room = roomOf(socket); if (!room) return;
    const seat = seatOf(room, socket.id);
    if (seat === null) return;
    const who = seat === 1 ? 'Red' : 'Green';
    // Relay to everyone in this room (including sender so they see their own message)
    io.to(room.code).emit('chat', { who, msg: String(msg).slice(0, 300) });
  });

  // ── Space pressed (two-player random site confirmation) ─────────────────────
  on('space_pressed', () => {
    const room = roomOf(socket); if (!room) return;
    const state = room.state;
    const seat = seatOf(room, socket.id);
    if (seat === null || state.moves > 0) return;

    if (!state.pending_random) {
      // First press: pick a random unoccupied site now so both clients use the same one
      let level, k, attempts = 0;
      do {
        level = Math.floor(state.actual_levels * Math.random());
        k     = Math.floor(19 * Math.random());
        attempts++;
      } while (state.sphere_colors[19 * level + k] !== 0 && attempts < 10000);

      state.pending_random = { seat, level, k };
      // Tell both clients — the requester shows a wait message, the other a confirm prompt
      io.to(room.code).emit('pending_random', { requesting_seat: seat });

    } else if (state.pending_random.seat !== seat) {
      // Confirmation from the other player
      const { level, k } = state.pending_random;
      state.pending_random = null;
      state.sphere_colors[19 * level + k] = 1;
      state.random_sites      += 1;
      state.move_active_level  = level;
      state.move_active_k      = k;
      broadcastState(room);

    } else {
      // Same player presses again — cancel
      state.pending_random = null;
      io.to(room.code).emit('random_cancelled');
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    leaveRoom(socket);
    if (waitingStranger === socket.id) waitingStranger = null;
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`3D Hex server listening on http://localhost:${PORT}`);
  console.log('Open that URL in two browser windows; use the lobby to start or join a game.');
});
