import type { IncomingMessage, ServerResponse } from 'node:http';
import { MatchRoom } from '../apps/server/src/room';

// Global in-memory room store across warm serverless invocations on the same instance
const globalStore = globalThis as unknown as {
  __splitwellRooms?: Map<string, { room: MatchRoom; lastTickMs: number }>;
};

if (!globalStore.__splitwellRooms) {
  globalStore.__splitwellRooms = new Map();
}
const rooms = globalStore.__splitwellRooms;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode(): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return `RM${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

function advanceTicksIfNeeded(entry: { room: MatchRoom; lastTickMs: number }, now: number) {
  const { room } = entry;
  if (room.status !== 'playing') {
    entry.lastTickMs = now;
    return;
  }
  const tickMs = 550;
  const elapsed = now - entry.lastTickMs;
  const ticks = Math.min(Math.floor(elapsed / tickMs), 8);
  if (ticks > 0) {
    for (let i = 0; i < ticks; i++) {
      room.tickGravity();
    }
    entry.lastTickMs += ticks * tickMs;
  }
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse
) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  let body: Record<string, unknown> = {};
  if (req.body && typeof req.body === 'object') {
    body = req.body as Record<string, unknown>;
  } else if (typeof req.body === 'string' && req.body.length > 0) {
    try {
      body = JSON.parse(req.body) as Record<string, unknown>;
    } catch {
      body = {};
    }
  } else if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
  }

  const now = Date.now();
  const action = body.type;

  if (action === 'create_room') {
    const name = typeof body.name === 'string' ? body.name : undefined;
    const code = generateRoomCode();
    // Use manual tick advancement in serverless mode (gravityIntervalMs very high so timer doesn't leak)
    const room = new MatchRoom({ code, gravityIntervalMs: 600_000 });
    room.stopTimers();
    const joined = room.addOrReconnectPlayer({ name });
    room.stopTimers();
    if ('error' in joined) {
      res.statusCode = 400;
      res.end(JSON.stringify({ type: 'error', message: joined.error }));
      return;
    }
    rooms.set(code, { room, lastTickMs: now });
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        type: 'joined',
        code: room.code,
        seat: joined.seat,
        token: joined.token,
        room: room.getSnapshot()
      })
    );
    return;
  }

  if (action === 'join_room') {
    const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const name = typeof body.name === 'string' ? body.name : undefined;
    const token = typeof body.token === 'string' ? body.token : undefined;

    const entry = rooms.get(rawCode);
    if (!entry) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          type: 'error',
          message: `Room "${rawCode || '?'}" was not found.`
        })
      );
      return;
    }

    const prevStatus = entry.room.status;
    const joined = entry.room.addOrReconnectPlayer({ token, name });
    entry.room.stopTimers();
    if ('error' in joined) {
      res.statusCode = 400;
      res.end(JSON.stringify({ type: 'error', message: joined.error }));
      return;
    }
    if (prevStatus !== 'playing' && entry.room.status === 'playing') {
      entry.lastTickMs = now;
    }
    advanceTicksIfNeeded(entry, now);

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        type: 'joined',
        code: entry.room.code,
        seat: joined.seat,
        token: joined.token,
        room: entry.room.getSnapshot()
      })
    );
    return;
  }

  if (action === 'intent') {
    const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const token = typeof body.token === 'string' ? body.token : '';
    const entry = rooms.get(rawCode);
    if (!entry) {
      res.statusCode = 404;
      res.end(JSON.stringify({ type: 'error', message: 'Room not found.' }));
      return;
    }
    advanceTicksIfNeeded(entry, now);
    entry.room.handleIntent(token, body.intent, now);
    const slot = entry.room.findSlotByToken(token);
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        type: 'snapshot',
        yourSeat: slot?.seat ?? 0,
        room: entry.room.getSnapshot()
      })
    );
    return;
  }

  if (action === 'poll') {
    const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const token = typeof body.token === 'string' ? body.token : '';
    const entry = rooms.get(rawCode);
    if (!entry) {
      res.statusCode = 404;
      res.end(JSON.stringify({ type: 'error', message: 'Room not found.' }));
      return;
    }
    advanceTicksIfNeeded(entry, now);
    const slot = entry.room.findSlotByToken(token);
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        type: 'snapshot',
        yourSeat: slot?.seat ?? 0,
        room: entry.room.getSnapshot()
      })
    );
    return;
  }

  if (action === 'leave_room') {
    const rawCode = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const token = typeof body.token === 'string' ? body.token : '';
    const entry = rooms.get(rawCode);
    if (entry) {
      entry.room.handleExplicitLeave(token);
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, activeRooms: rooms.size }));
}
