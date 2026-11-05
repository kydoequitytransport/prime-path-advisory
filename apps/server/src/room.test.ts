import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatchRoom } from './room.js';

describe('MatchRoom server authority', () => {
  const createdRooms: MatchRoom[] = [];

  afterEach(() => {
    for (const room of createdRooms) {
      room.stopTimers();
    }
    createdRooms.length = 0;
    vi.useRealTimers();
  });

  it('starts in waiting state, transitions to playing when second player joins, and gives both players the exact same piece sequence', () => {
    const room = new MatchRoom({ code: 'ABCD12', seed: 42, gravityIntervalMs: 60_000 });
    createdRooms.push(room);

    const p1 = room.addOrReconnectPlayer({ name: 'Alice' });
    expect('seat' in p1 && p1.seat).toBe(0);
    expect(room.status).toBe('waiting');

    const p2 = room.addOrReconnectPlayer({ name: 'Bob' });
    expect('seat' in p2 && p2.seat).toBe(1);
    expect(room.status).toBe('playing');

    const snap = room.getSnapshot();
    expect(snap.players[0]?.active.kind).toBe(snap.players[1]?.active.kind);
    expect(snap.players[0]?.nextPiece).toBe(snap.players[1]?.nextPiece);
  });

  it('rejects fabricated boards, unknown tokens, invalid intents, and floods exceeding the rate limit', () => {
    const room = new MatchRoom({
      code: 'SAFE99',
      seed: 99,
      gravityIntervalMs: 60_000,
      maxIntentsPerSecond: 5
    });
    createdRooms.push(room);

    const p1 = room.addOrReconnectPlayer({ name: 'Alice' });
    const p2 = room.addOrReconnectPlayer({ name: 'Bob' });
    if ('error' in p1 || 'error' in p2) throw new Error('Expected join success');

    // Unknown token rejected
    expect(room.handleIntent('forged-token', 'left').accepted).toBe(false);

    // Arbitrary payload / fake intent rejected
    expect(room.handleIntent(p1.token, { board: [] }).accepted).toBe(false);
    expect(room.handleIntent(p1.token, 'clear_all_rows').accepted).toBe(false);

    // Rate limit enforcement within a 1s window
    const now = 10_000;
    for (let i = 0; i < 5; i++) {
      expect(room.handleIntent(p1.token, 'left', now + i * 10).accepted).toBe(true);
    }
    const flooded = room.handleIntent(p1.token, 'left', now + 100);
    expect(flooded.accepted).toBe(false);
    expect(flooded.reason).toContain('Rate limit');
  });

  it('handles connection drops with a grace period and awards the win if the player does not return', () => {
    vi.useFakeTimers();
    const room = new MatchRoom({
      code: 'DROP01',
      seed: 7,
      gravityIntervalMs: 60_000,
      disconnectGraceMs: 5000
    });
    createdRooms.push(room);

    const p1 = room.addOrReconnectPlayer({ name: 'Alice' });
    const p2 = room.addOrReconnectPlayer({ name: 'Bob' });
    if ('error' in p1 || 'error' in p2) throw new Error('Expected join success');

    // Bob's connection drops briefly and reconnects within the grace window
    room.handleSocketDisconnect(p2.token);
    expect(room.getSnapshot().players[1]?.connected).toBe(false);

    vi.advanceTimersByTime(2000);
    const rejoined = room.addOrReconnectPlayer({ token: p2.token });
    expect('reconnected' in rejoined && rejoined.reconnected).toBe(true);
    expect(room.status).toBe('playing');

    // Now Bob disconnects and does not return before the 5000ms grace timer expires
    room.handleSocketDisconnect(p2.token);
    vi.advanceTimersByTime(5100);
    expect(room.status).toBe('finished');
    expect(room.winnerSeat).toBe(0);
  });
});
