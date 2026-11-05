import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { MatchRoom, SeatIndex } from './room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode(existing: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      const idx = Math.floor(Math.random() * ROOM_ALPHABET.length);
      code += ROOM_ALPHABET[idx];
    }
    if (!existing.has(code)) return code;
  }
  return `RM${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

interface ClientBinding {
  ws: WebSocket;
  roomCode: string;
  token: string;
  seat: SeatIndex;
}

const rooms = new Map<string, MatchRoom>();
const roomSockets = new Map<string, Set<ClientBinding>>();

function broadcastRoom(room: MatchRoom): void {
  const bindings = roomSockets.get(room.code);
  if (!bindings || bindings.size === 0) return;

  const snapshot = room.getSnapshot();
  for (const binding of bindings) {
    if (binding.ws.readyState === WebSocket.OPEN) {
      binding.ws.send(
        JSON.stringify({
          type: 'snapshot',
          yourSeat: binding.seat,
          room: snapshot
        })
      );
    }
  }
}

function attachSocketToRoom(
  ws: WebSocket,
  room: MatchRoom,
  token: string,
  seat: SeatIndex
): void {
  let set = roomSockets.get(room.code);
  if (!set) {
    set = new Set();
    roomSockets.set(room.code, set);
  }
  // Remove any stale binding for the same token
  for (const existing of set) {
    if (existing.token === token && existing.ws !== ws) {
      set.delete(existing);
    }
  }
  set.add({ ws, roomCode: room.code, token, seat });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const webDistDir = path.resolve(__dirname, '../../web/dist');

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, activeRooms: rooms.size }));
    return;
  }

  // Serve built Vite SPA if available
  if (fs.existsSync(webDistDir)) {
    const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const safeCandidate = path.normalize(path.join(webDistDir, requestedPath));
    if (safeCandidate.startsWith(webDistDir) && fs.existsSync(safeCandidate) && fs.statSync(safeCandidate).isFile()) {
      const ext = path.extname(safeCandidate);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
      fs.createReadStream(safeCandidate).pipe(res);
      return;
    }

    const indexHtml = path.join(webDistDir, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexHtml).pipe(res);
      return;
    }
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Splitwell server is running. Build apps/web or run Vite dev server.');
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let activeBinding: ClientBinding | null = null;

  ws.on('message', (rawData) => {
    // Reject oversized payloads so a malicious client cannot stall the event loop
    if (rawData instanceof Buffer && rawData.byteLength > 2048) {
      ws.send(JSON.stringify({ type: 'error', message: 'Payload too large.' }));
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(rawData)) as Record<string, unknown>;
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message.' }));
      return;
    }

    const type = msg.type;

    if (type === 'create_room') {
      const name = typeof msg.name === 'string' ? msg.name : undefined;
      const code = generateRoomCode(new Set(rooms.keys()));
      const room = new MatchRoom({
        code,
        onBroadcast: broadcastRoom
      });
      rooms.set(code, room);

      const joined = room.addOrReconnectPlayer({ name });
      if ('error' in joined) {
        ws.send(JSON.stringify({ type: 'error', message: joined.error }));
        return;
      }

      activeBinding = { ws, roomCode: code, token: joined.token, seat: joined.seat };
      attachSocketToRoom(ws, room, joined.token, joined.seat);

      ws.send(
        JSON.stringify({
          type: 'joined',
          code: room.code,
          seat: joined.seat,
          token: joined.token,
          room: room.getSnapshot()
        })
      );
      broadcastRoom(room);
      return;
    }

    if (type === 'join_room') {
      const rawCode = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const name = typeof msg.name === 'string' ? msg.name : undefined;
      const token = typeof msg.token === 'string' ? msg.token : undefined;

      const room = rooms.get(rawCode);
      if (!room) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: `Room "${rawCode || '?'}" was not found.`
          })
        );
        return;
      }

      const joined = room.addOrReconnectPlayer({ token, name });
      if ('error' in joined) {
        ws.send(JSON.stringify({ type: 'error', message: joined.error }));
        return;
      }

      activeBinding = { ws, roomCode: room.code, token: joined.token, seat: joined.seat };
      attachSocketToRoom(ws, room, joined.token, joined.seat);

      ws.send(
        JSON.stringify({
          type: 'joined',
          code: room.code,
          seat: joined.seat,
          token: joined.token,
          room: room.getSnapshot()
        })
      );
      broadcastRoom(room);
      return;
    }

    if (type === 'intent') {
      if (!activeBinding) {
        ws.send(JSON.stringify({ type: 'error', message: 'Not in a room.' }));
        return;
      }
      const room = rooms.get(activeBinding.roomCode);
      if (!room) return;
      room.handleIntent(activeBinding.token, msg.intent);
      return;
    }

    if (type === 'leave_room') {
      if (!activeBinding) return;
      const room = rooms.get(activeBinding.roomCode);
      if (room) {
        room.handleExplicitLeave(activeBinding.token);
      }
      const set = roomSockets.get(activeBinding.roomCode);
      if (set) {
        set.delete(activeBinding);
      }
      activeBinding = null;
      return;
    }
  });

  ws.on('close', () => {
    if (!activeBinding) return;
    const room = rooms.get(activeBinding.roomCode);
    if (room) {
      room.handleSocketDisconnect(activeBinding.token);
    }
    const set = roomSockets.get(activeBinding.roomCode);
    if (set) {
      set.delete(activeBinding);
    }
    activeBinding = null;
  });
});

server.listen(PORT, () => {
  console.log(`Splitwell server listening on http://localhost:${PORT}`);
});
