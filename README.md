# Splitwell

**Splitwell** is a server-authoritative, head-to-head online falling-block game built in TypeScript for the Prime Path Advisory engineering exercise.

Two players join a shared room via a 6-character code or invite link, receive the exact same 7-bag sequence of pieces, see both 10×20 boards live, and send garbage rows to their opponent when clearing 2 or more lines at once.

---

## How to Run Locally

Prerequisites: Node.js 20+ and npm.

```bash
# 1. Install dependencies across workspaces
npm install

# 2. Run the automated test suite (rules + server room authority)
npm test

# 3. Build the React client and Node server, then start the single-port server
npm run build
npm start
```

Open `http://localhost:3001` in two browser windows:
1. In Window 1, click **Create New Game** and copy the 6-character room code or invite link.
2. In Window 2, paste the invite link or enter the code and click **Join Game**.

### Controls
- **Left / Right (`←` / `→` or `A` / `D`)**: Move piece horizontally
- **Rotate (`↑` / `W` / `X`)**: Rotate clockwise (with wall-kick support)
- **Soft Drop (`↓` / `S`)**: Step piece downward faster
- **Hard Drop (`Space`)**: Drop piece instantly to the bottom

---

## Deploying to Render (Single Free Web Service)

Because the Node server in `apps/server` serves both the built static frontend (`apps/web/dist`) and the `/ws` WebSocket endpoint on the same `PORT`, the entire application deploys as a single service URL:

- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm start`
- **Environment:** Node 20+

An optional `render.yaml` blueprint is included in the repository root.

---

## Design Decisions & Loom Walkthrough Notes

### 1. Where the "Truth" of the Game Lives
The server (`apps/server/src/room.ts`) is the single source of truth for every match.
- Clients never send board states, piece coordinates, or line-clear claims.
- Clients only send discrete player intents (`left`, `right`, `rotate`, `soft`, `hard`).
- A server-side tick loop advances gravity and lock checks, runs the pure game rules from `@splitwell/rules`, and broadcasts snapshots to both players.

### 2. How Both Players Get the Same Pieces
When a `MatchRoom` is created, the server generates a 32-bit seed and initializes a `SharedPieceStream` (`packages/rules/src/pieces.ts`) backed by a deterministic Mulberry32 PRNG and the standard **7-bag randomizer** (each batch of 7 pieces contains one of `I, O, T, S, Z, J, L`).
- Each player's board tracks its own `pieceIndex` (`0, 1, 2, ...`).
- Whenever either player spawns piece `k`, the server looks up `pieceStream.at(k)`, guaranteeing both players pull from the exact same sequence regardless of who plays faster.

### 3. How Someone Could Cheat, and What Stops Them
- **Fabricating board state / fake line clears:** Stopped because the server only accepts `intent` messages (`left`, `right`, `rotate`, `soft`, `hard`) and computes all board mutations and garbage calculations itself.
- **Gravity stalling (ignoring downward ticks in the browser):** Stopped because gravity runs on an authoritative server interval (`tickGravity`), not in the client's browser timer.
- **Piece peeking:** The server snapshot only exposes `nextPiece` (`pieceIndex + 1`), never the full future stream.
- **Input flooding / packet spam:** Each player seat enforces a sliding-window rate limit (`maxIntentsPerSecond`) and payload size cap (`2 KB`), and each player is authenticated to their seat via an unguessable 128-bit session token.

### 4. What Happens When a Connection Drops or Slows Down
- When a player joins or creates a room, their browser stores their seat token in `sessionStorage`.
- If a WebSocket closes unexpectedly mid-game, the server marks the player as `connected: false` and starts a **10-second reconnect grace timer** (`disconnectGraceMs`).
- If the player's browser reconnects within the grace window, it automatically presents the saved token, reclaims the seat, and continues the live match.
- If the player does not return before the grace period expires (or clicks **Leave Match** explicitly), the server ends the match and awards the win to the remaining player.

### 5. What Was Finished vs. Left Out
- **Finished (all must-haves):**
  - 10×20 board, all 7 standard tetromino shapes (`I, O, T, S, Z, J, L`), move/rotate/soft-drop/hard-drop, row clearing, top-out loss detection.
  - Room creation with 6-character shareable code & URL query link (`?room=CODE`).
  - Live dual-board rendering for both players.
  - Shared seeded 7-bag piece sequence.
  - Garbage row rules: `2 → 1`, `3 → 2`, `4 → 4` with one empty hole column per garbage row.
  - Disconnect grace window with automatic token-based reconnection and forfeit handling.
  - Automated Vitest suites covering both pure game rules (`packages/rules/src/rules.test.ts`) and server room authority (`apps/server/src/room.test.ts`).
  - **Bonus nice-to-haves included:** Ghost piece landing outline and next-piece indicator.
- **Left out (and why):**
  - **Spectator mode & rematch button:** Kept out to keep the room state machine small, auditable, and well within the 4–6 hour budget.
  - **Client-side input prediction / rollback:** Since the server processes intents immediately and broadcasts snapshots, local/low-latency play feels responsive without the complexity of client state reconciliation.

### 6. What I Would Do Next With More Time
- Add **client-side prediction with server reconciliation** (attaching monotonic input sequence numbers to each intent so high-latency players see zero input lag on horizontal moves while the server remains authoritative).
- Add a one-click **Rematch** flow that reuses the connected room sockets with a fresh seed.

### 7. How AI Tools Were Used
- Used AI coding assistance in Cursor to scaffold the monorepo workspace structure, React board UI, and initial test cases.
- Manually reviewed and verified the boundary conditions that matter for fairness and correctness:
  - Ensuring garbage rows shift existing blocks upward and nudge the active falling piece if needed so incoming garbage doesn't silently overwrite an active piece.
  - Ensuring both players pull by `pieceIndex` from a single seeded `SharedPieceStream` rather than calling a shared `next()` queue (which would interleave pieces between fast and slow players).
  - Verifying server rate-limiting and token checks so a second tab or tampered client cannot move the opponent's piece.
