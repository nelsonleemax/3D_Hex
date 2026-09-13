// server.js  —  3D Hex multiplayer server
// Run with:  node server.js
// Requires:  npm install express socket.io
//
// Two players connect; the server holds the authoritative shared game state
// and broadcasts every change to both clients.  Each client keeps its own
// display/camera settings independently.

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

// Serve game files from the same directory as server.js
app.use(express.static(__dirname));

// Serve the game when the browser requests just '/'
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '3D_Hex_multiplayer.html'));
});

// ── Shared game state ────────────────────────────────────────────────────────
// This mirrors the variables in the client that both players must agree on.
// It is reset whenever a new game begins (either player presses Enter after a win
// or Tab-Enter to restart).

const DEFAULT_LEVELS   = 9;
const MAX_SITES        = 19 * 20;   // nlevels = 20 max
const MAX_CYLINDERS    = 7 * 19 * 20;

function makeDefaultState() {
  return {
    // game setup (may be changed before first move)
    actual_levels      : DEFAULT_LEVELS,
    redturns           : 2,
    saved_first_player : 1,

    // in-progress state
    player             : 1,
    red_moves          : 2,        // starts equal to redturns
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
    red_bidder         : null,   // seat of player who bid for red, null if not yet bid
    pending_random     : null,   // { seat, level, k } when one player pressed space awaiting confirmation
  };
}

let state = makeDefaultState();

// ── Player tracking ──────────────────────────────────────────────────────────
// We allow exactly two seats: seat 1 (red, 2D player) and seat 2 (green, 1D player).
// A third browser can connect as a spectator (read-only).

const players = {};   // socket.id -> { seat: 1|2|null }

function connectedSeats() {
  return Object.values(players).map(p => p.seat).filter(s => s !== null);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function broadcastState(eventName, data) {
  io.emit(eventName, data);
}

function seatOf(socketId) {
  return players[socketId] ? players[socketId].seat : null;
}

// ── Connection handling ──────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('connect', socket.id);

  // Assign a seat if one is free, otherwise spectator
  const taken = connectedSeats();
  let seat = null;
  if (!taken.includes(1))      seat = 1;
  else if (!taken.includes(2)) seat = 2;
  players[socket.id] = { seat };

  // Send the full current state immediately so the new client can sync
  socket.emit('welcome', { seat, state });
  console.log(`  assigned seat ${seat ?? 'spectator'}`);

  // ── Move ────────────────────────────────────────────────────────────────
  // Payload: { level, k }
  socket.on('move', ({ level, k }) => {
    const seat = seatOf(socket.id);
    if (seat === null) return;                         // spectator
    if (state.winning_player > 0) return;             // game over
    if (state.moves === 0 && state.actual_levels < 2) return;

    const i = 19 * level + k;
    if (state.sphere_colors[i] !== 0) return;         // already occupied

    // Record for undo
    state.move_active_level = level;
    state.move_active_k     = k;
    state.undo_calls        = 0;

    // Place the piece — bond colours are computed client-side from sphere_colors,
    // so we only need to keep sphere_colors and cylinder_colors in sync here.
    // The client sends the resulting cylinder_colors delta along with the move.
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
    broadcastState('state_update', state);
  });

  // ── Cylinder colours delta ───────────────────────────────────────────────
  // After a move the client that made it sends back the updated cylinder_colors
  // (it already ran set_bond_colors locally).  We store it and relay to the other.
  socket.on('cylinder_delta', (cylinder_colors) => {
    state.cylinder_colors = cylinder_colors;
    socket.broadcast.emit('cylinder_delta', cylinder_colors);
  });

  // ── Win report ───────────────────────────────────────────────────────────
  socket.on('win', ({ winning_player }) => {
    if (state.winning_player > 0) return;  // already declared
    state.winning_player = winning_player;
    // Broadcast so the OTHER client also sees winning_player, shows the alert,
    // and can press Enter to reset.  We use a dedicated 'win_declared' event
    // so applyServerState doesn't re-run the win test and double-alert.
    io.emit('win_declared', { winning_player });
  });

  // ── Undo ────────────────────────────────────────────────────────────────
  // Payload: { expected_moves } — the move count the client thinks is current.
  // If it doesn't match state.moves, the other player has moved in the meantime
  // (race condition) and the undo is rejected with a 'undo_rejected' event.
  socket.on('undo', ({ expected_moves }) => {
    const seat = seatOf(socket.id);
    if (seat === null || state.undo_calls !== 0) return;

    // Race condition: another move arrived before the undo — reject it.
    if (expected_moves !== undefined && expected_moves !== state.moves) {
      socket.emit('undo_rejected', {
        message: 'Too late to undo — the other player has already moved.'
      });
      return;
    }

    const i = 19 * state.move_active_level + state.move_active_k;
    state.sphere_colors[i] = 0;

    // The player who made the last move was (3 - state.player), since state.player
    // already advanced after the move.  Restore it to that player so they can
    // make a replacement move.
    const mover = 3 - state.player;   // who made the move being undone
    if (mover === 1) {
      // Undoing a red move: restore red's remaining turns
      if (state.red_moves_incremented) state.red_moves -= state.redturns;
      state.red_moves += 1;
      state.player = 1;
    } else {
      // Undoing a green move: give the turn back to green
      state.player = 2;
    }
    state.undo_calls            = 1;
    state.red_moves_incremented = false;
    state.moves                 = Math.max(0, state.moves - 1);
    broadcastState('state_update', state);
    // cylinder_colors reset is handled client-side via restore_bond_colors;
    // client will send a cylinder_delta after undo
  });

  // ── Reset (new game) ─────────────────────────────────────────────────────
  socket.on('reset', ({ saved_first_player }) => {
    // makeDefaultState() clears everything including pending_random, red_bidder,
    // random_sites, moves, sphere_colors — a fully clean slate.
    state                    = makeDefaultState();
    state.player             = saved_first_player;
    state.saved_first_player = saved_first_player;
    state.red_moves          = state.redturns;
    // random_sites is 0 in default state — client uses this to detect a true reset
    broadcastState('state_update', state);
  });

  // ── Setup changes (before first move) ───────────────────────────────────
  // Payload: { actual_levels } or { redturns } or { add_random: { level, k } }
  socket.on('setup', (changes) => {
    if (state.moves > 0) return;   // ignore if game started
    if (changes.actual_levels !== undefined) {
      state.actual_levels = changes.actual_levels;
    }
    if (changes.redturns !== undefined) {
      state.redturns  = changes.redturns;
      state.red_moves = state.redturns;  // reset remaining moves to new rate
    }
    if (changes.add_random !== undefined) {
      const { level, k } = changes.add_random;
      const i = 19 * level + k;
      state.sphere_colors[i] = 1;   // always red, regardless of whose turn it is
      state.random_sites += 1;
      // Store level/k so the receiving client can call set_bond_colors directly
      state.move_active_level = level;
      state.move_active_k     = k;
    }
    if (changes.first_player !== undefined) {
      state.player             = changes.first_player;
      state.saved_first_player = changes.first_player;
    }
    // bid_red: first player to press 'm' becomes red (player 1 / seat 1).
    // Only accepted before any moves or random sites have been placed.
    if (changes.bid_red !== undefined && state.moves === 0) {  // allowed even after random sites
      if (!state.red_bidder) {
        state.red_bidder = changes.bid_red; // seat of the winning bidder
        // Swap seats so the bidder becomes seat 1 (red) and the other becomes seat 2 (green).
        // We tell each client their new seat via a 'seat_change' event.
        const biddingSeat = changes.bid_red;
        io.emit('seat_change', { red_seat: biddingSeat });
        // Also update first player to match
        state.saved_first_player = 1;
        state.player = 1;
        broadcastState('state_update', state);
      } else {
        // Someone already bid — inform this client
        socket.emit('bid_rejected', { message: 'Red has already been claimed.' });
      }
      return;
    }
    broadcastState('state_update', state);
  });

  // ── Chat ──────────────────────────────────────────────────────────────────
  socket.on('chat', ({ msg }) => {
    const seat = seatOf(socket.id);
    const who = seat === 1 ? 'Red' : seat === 2 ? 'Green' : 'Spectator';
    // Relay to all clients (including sender so they see their own message)
    io.emit('chat', { who, msg: String(msg).slice(0, 300) });
  });

  // ── Space pressed (two-player random site confirmation) ─────────────────────
  socket.on('space_pressed', ({ seat }) => {
    if (state.moves > 0) return;

    if (!state.pending_random) {
      // First press: pick a random unoccupied site now so both clients use the same one
      let level, k, attempts = 0;
      do {
        level = Math.floor(state.actual_levels * Math.random());
        k     = Math.floor(19 * Math.random());
        attempts++;
      } while (state.sphere_colors[19 * level + k] !== 0 && attempts < 10000);

      state.pending_random = { seat, level, k };
      // Notify both clients — the requesting player gets the wait message (client-side),
      // the other player gets the popup via 'pending_random' event
      io.emit('pending_random', { requesting_seat: seat });

    } else if (state.pending_random.seat !== seat) {
      // Confirmation from the other player
      const { level, k } = state.pending_random;
      state.pending_random = null;
      const i = 19 * level + k;
      state.sphere_colors[i]  = 1;
      state.random_sites      += 1;
      state.move_active_level  = level;
      state.move_active_k      = k;
      broadcastState('state_update', state);

    } else {
      // Same player presses again — cancel
      state.pending_random = null;
      io.emit('random_cancelled');
    }
  });

  // ── Disconnect ───────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('disconnect', socket.id, 'seat', players[socket.id]?.seat);
    delete players[socket.id];
    io.emit('player_list', connectedSeats());
  });

  io.emit('player_list', connectedSeats());
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`3D Hex server listening on http://localhost:${PORT}`);
  console.log('Open that URL in two browser windows to play.');
});
