import crypto from 'node:crypto';
import {
  ActivePiece,
  BOARD_WIDTH,
  BoardGrid,
  PieceKind,
  PlayerBoardState,
  PlayerIntent,
  SharedPieceStream,
  applyIntent,
  createInitialPlayerState,
  createSeededRng,
  receiveGarbageOnState,
  stepGravity
} from '../../../packages/rules/src/index.js';

export type SeatIndex = 0 | 1;
export type RoomStatus = 'waiting' | 'playing' | 'finished';

const VALID_INTENTS = new Set<string>(['left', 'right', 'rotate', 'soft', 'hard']);

export function isValidIntent(value: unknown): value is PlayerIntent {
  return typeof value === 'string' && VALID_INTENTS.has(value);
}

export interface PublicPlayerSnapshot {
  seat: SeatIndex;
  name: string;
  connected: boolean;
  disconnectDeadlineMs: number | null;
  board: BoardGrid;
  active: ActivePiece;
  nextPiece: PieceKind;
  pieceIndex: number;
  linesCleared: number;
  score: number;
  alive: boolean;
}

export interface RoomSnapshot {
  code: string;
  status: RoomStatus;
  seed: number;
  winnerSeat: SeatIndex | null;
  finishReason: string | null;
  players: [PublicPlayerSnapshot | null, PublicPlayerSnapshot | null];
}

export interface PlayerSlot {
  seat: SeatIndex;
  token: string;
  name: string;
  connected: boolean;
  disconnectDeadlineMs: number | null;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  state: PlayerBoardState;
  lastIntentTimestamps: number[];
}

export interface RoomOptions {
  code: string;
  seed?: number;
  gravityIntervalMs?: number;
  disconnectGraceMs?: number;
  maxIntentsPerSecond?: number;
  onBroadcast?: (room: MatchRoom) => void;
}

export class MatchRoom {
  public readonly code: string;
  public readonly seed: number;
  public status: RoomStatus = 'waiting';
  public winnerSeat: SeatIndex | null = null;
  public finishReason: string | null = null;

  private readonly pieceStream: SharedPieceStream;
  private readonly garbageRng: () => number;
  private readonly slots: [PlayerSlot | null, PlayerSlot | null] = [null, null];
  private readonly gravityIntervalMs: number;
  private readonly disconnectGraceMs: number;
  private readonly maxIntentsPerSecond: number;
  private readonly onBroadcast?: (room: MatchRoom) => void;
  private gravityTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoomOptions) {
    this.code = options.code.toUpperCase();
    this.seed = options.seed ?? crypto.randomInt(1, 0x7fffffff);
    this.pieceStream = new SharedPieceStream(this.seed);
    this.garbageRng = createSeededRng(this.seed ^ 0x9e3779b9);
    this.gravityIntervalMs = options.gravityIntervalMs ?? 550;
    this.disconnectGraceMs = options.disconnectGraceMs ?? 10_000;
    this.maxIntentsPerSecond = options.maxIntentsPerSecond ?? 35;
    this.onBroadcast = options.onBroadcast;
  }

  public addOrReconnectPlayer(params: {
    token?: string;
    name?: string;
  }): { seat: SeatIndex; token: string; reconnected: boolean } | { error: string } {
    // 1. Check if token matches an existing seat (reconnect)
    if (params.token) {
      for (const slot of this.slots) {
        if (slot && slot.token === params.token) {
          if (slot.disconnectTimer) {
            clearTimeout(slot.disconnectTimer);
            slot.disconnectTimer = null;
          }
          slot.connected = true;
          slot.disconnectDeadlineMs = null;
          this.notify();
          return { seat: slot.seat, token: slot.token, reconnected: true };
        }
      }
    }

    if (this.status !== 'waiting') {
      return { error: 'Match has already started or ended.' };
    }

    const seat: SeatIndex | null = this.slots[0] === null ? 0 : this.slots[1] === null ? 1 : null;
    if (seat === null) {
      return { error: 'Room is already full.' };
    }

    const token = crypto.randomBytes(16).toString('hex');
    const cleanName =
      (params.name ?? '').trim().slice(0, 20) || `Player ${seat + 1}`;

    this.slots[seat] = {
      seat,
      token,
      name: cleanName,
      connected: true,
      disconnectDeadlineMs: null,
      disconnectTimer: null,
      state: createInitialPlayerState((index) => this.pieceStream.at(index)),
      lastIntentTimestamps: []
    };

    if (this.slots[0] !== null && this.slots[1] !== null) {
      this.startMatch();
    } else {
      this.notify();
    }

    return { seat, token, reconnected: false };
  }

  private startMatch(): void {
    this.status = 'playing';
    this.winnerSeat = null;
    this.finishReason = null;
    for (const slot of this.slots) {
      if (slot) {
        slot.state = createInitialPlayerState((index) => this.pieceStream.at(index));
      }
    }
    if (this.gravityTimer) {
      clearInterval(this.gravityTimer);
    }
    this.gravityTimer = setInterval(() => {
      this.tickGravity();
    }, this.gravityIntervalMs);
    this.notify();
  }

  /**
   * Advances server-authoritative gravity by one tick for all players in the match.
   */
  public tickGravity(): void {
    if (this.status !== 'playing') return;

    for (const seat of [0, 1] as const) {
      const slot = this.slots[seat];
      if (!slot || !slot.state.alive) continue;

      const step = stepGravity(slot.state, (index) => this.pieceStream.at(index));
      slot.state = step.state;
      if (step.garbageToSend > 0) {
        this.deliverGarbage(seat, step.garbageToSend);
      }
    }

    this.checkOutcome();
    this.notify();
  }

  /**
   * Processes a single validated player intent from the player's authenticated token.
   * Rejects unknown tokens, invalid intents, rate-limit floods, or moves when not playing.
   */
  public handleIntent(
    token: string,
    rawIntent: unknown,
    nowMs: number = Date.now()
  ): { accepted: boolean; reason?: string } {
    if (this.status !== 'playing') {
      return { accepted: false, reason: 'Match is not active.' };
    }
    const slot = this.findSlotByToken(token);
    if (!slot) {
      return { accepted: false, reason: 'Invalid player token.' };
    }
    if (!slot.connected) {
      return { accepted: false, reason: 'Player is marked disconnected.' };
    }
    if (!isValidIntent(rawIntent)) {
      return { accepted: false, reason: 'Unsupported intent.' };
    }

    // Anti-cheat rate limiting: drop floods beyond maxIntentsPerSecond in a 1000ms sliding window
    const windowStart = nowMs - 1000;
    slot.lastIntentTimestamps = slot.lastIntentTimestamps.filter((t) => t > windowStart);
    if (slot.lastIntentTimestamps.length >= this.maxIntentsPerSecond) {
      return { accepted: false, reason: 'Rate limit exceeded.' };
    }
    slot.lastIntentTimestamps.push(nowMs);

    const step = applyIntent(slot.state, rawIntent, (index) => this.pieceStream.at(index));
    slot.state = step.state;

    if (step.garbageToSend > 0) {
      this.deliverGarbage(slot.seat, step.garbageToSend);
    }

    this.checkOutcome();
    this.notify();
    return { accepted: true };
  }

  private deliverGarbage(fromSeat: SeatIndex, count: number): void {
    const targetSeat: SeatIndex = fromSeat === 0 ? 1 : 0;
    const target = this.slots[targetSeat];
    if (!target || !target.state.alive) return;

    // Each garbage burst chooses one random hole column (standard competitive rule)
    // and each row has one empty square so it can still be cleared.
    const holes = Array.from({ length: count }, () =>
      Math.floor(this.garbageRng() * BOARD_WIDTH)
    );
    target.state = receiveGarbageOnState(target.state, holes);
  }

  /**
   * Called when a player's WebSocket closes unexpectedly.
   * Starts a grace timer so brief network blips can reconnect with the same token.
   */
  public handleSocketDisconnect(token: string): void {
    const slot = this.findSlotByToken(token);
    if (!slot) return;

    slot.connected = false;

    if (this.status === 'waiting') {
      // If the host leaves before anyone joins, keep the seat reservable for the grace period
      slot.disconnectDeadlineMs = Date.now() + this.disconnectGraceMs;
      this.notify();
      return;
    }

    if (this.status === 'playing') {
      slot.disconnectDeadlineMs = Date.now() + this.disconnectGraceMs;
      if (slot.disconnectTimer) {
        clearTimeout(slot.disconnectTimer);
      }
      slot.disconnectTimer = setTimeout(() => {
        if (!slot.connected && this.status === 'playing') {
          const otherSeat: SeatIndex = slot.seat === 0 ? 1 : 0;
          this.finishMatch(
            otherSeat,
            `${slot.name} lost connection and did not return in time.`
          );
        }
      }, this.disconnectGraceMs);
      this.notify();
    }
  }

  /**
   * Called when a player explicitly clicks Leave / Forfeit.
   */
  public handleExplicitLeave(token: string): void {
    const slot = this.findSlotByToken(token);
    if (!slot) return;
    slot.connected = false;
    if (slot.disconnectTimer) {
      clearTimeout(slot.disconnectTimer);
      slot.disconnectTimer = null;
    }

    if (this.status === 'playing') {
      const otherSeat: SeatIndex = slot.seat === 0 ? 1 : 0;
      this.finishMatch(otherSeat, `${slot.name} left the match.`);
    } else {
      this.notify();
    }
  }

  private checkOutcome(): void {
    if (this.status !== 'playing') return;
    const p0 = this.slots[0];
    const p1 = this.slots[1];
    if (!p0 || !p1) return;

    const p0Alive = p0.state.alive;
    const p1Alive = p1.state.alive;

    if (!p0Alive && p1Alive) {
      this.finishMatch(1, `${p0.name} topped out.`);
    } else if (!p1Alive && p0Alive) {
      this.finishMatch(0, `${p1.name} topped out.`);
    } else if (!p0Alive && !p1Alive) {
      const winner: SeatIndex = p0.state.score >= p1.state.score ? 0 : 1;
      this.finishMatch(winner, 'Both boards topped out on the same tick.');
    }
  }

  private finishMatch(winnerSeat: SeatIndex, reason: string): void {
    this.status = 'finished';
    this.winnerSeat = winnerSeat;
    this.finishReason = reason;
    this.stopTimers();
    this.notify();
  }

  public stopTimers(): void {
    if (this.gravityTimer) {
      clearInterval(this.gravityTimer);
      this.gravityTimer = null;
    }
    for (const slot of this.slots) {
      if (slot?.disconnectTimer) {
        clearTimeout(slot.disconnectTimer);
        slot.disconnectTimer = null;
      }
    }
  }

  public findSlotByToken(token: string): PlayerSlot | null {
    for (const slot of this.slots) {
      if (slot && slot.token === token) {
        return slot;
      }
    }
    return null;
  }

  public getSnapshot(): RoomSnapshot {
    return {
      code: this.code,
      status: this.status,
      seed: this.seed,
      winnerSeat: this.winnerSeat,
      finishReason: this.finishReason,
      players: [this.toPublicPlayer(this.slots[0]), this.toPublicPlayer(this.slots[1])]
    };
  }

  private toPublicPlayer(slot: PlayerSlot | null): PublicPlayerSnapshot | null {
    if (!slot) return null;
    return {
      seat: slot.seat,
      name: slot.name,
      connected: slot.connected,
      disconnectDeadlineMs: slot.disconnectDeadlineMs,
      board: slot.state.board,
      active: slot.state.active,
      nextPiece: this.pieceStream.at(slot.state.pieceIndex + 1),
      pieceIndex: slot.state.pieceIndex,
      linesCleared: slot.state.linesCleared,
      score: slot.state.score,
      alive: slot.state.alive
    };
  }

  private notify(): void {
    this.onBroadcast?.(this);
  }

  public static fromSnapshot(
    snapshot: RoomSnapshot,
    callerSeat: SeatIndex,
    callerToken: string
  ): MatchRoom {
    const room = new MatchRoom({
      code: snapshot.code,
      seed: snapshot.seed,
      gravityIntervalMs: 600_000
    });
    room.stopTimers();
    room.status = snapshot.status;
    room.winnerSeat = snapshot.winnerSeat;
    room.finishReason = snapshot.finishReason;

    for (const seat of [0, 1] as const) {
      const p = snapshot.players[seat];
      if (!p) continue;
      room.slots[seat] = {
        seat,
        token: seat === callerSeat ? callerToken : `peer-${seat}`,
        name: p.name,
        connected: p.connected,
        disconnectDeadlineMs: p.disconnectDeadlineMs,
        disconnectTimer: null,
        state: {
          board: p.board.map((row) => [...row]),
          active: { ...p.active },
          pieceIndex: p.pieceIndex,
          linesCleared: p.linesCleared,
          score: p.score,
          alive: p.alive
        },
        lastIntentTimestamps: []
      };
    }
    return room;
  }

  public syncSlotToken(seat: SeatIndex, token: string): void {
    const slot = this.slots[seat];
    if (slot && token) {
      slot.token = token;
    }
  }

  public mergeFromSnapshot(
    snapshot: RoomSnapshot,
    callerSeat: SeatIndex,
    callerToken: string
  ): void {
    if (this.status === 'waiting' && snapshot.status !== 'waiting') {
      this.status = snapshot.status;
    }
    if (snapshot.status === 'finished' && this.status !== 'finished') {
      this.status = 'finished';
      this.winnerSeat = snapshot.winnerSeat;
      this.finishReason = snapshot.finishReason;
    }

    for (const seat of [0, 1] as const) {
      const incoming = snapshot.players[seat];
      if (!incoming) continue;
      const current = this.slots[seat];
      if (!current) {
        this.slots[seat] = {
          seat,
          token: seat === callerSeat && callerToken ? callerToken : `peer-${seat}`,
          name: incoming.name,
          connected: incoming.connected,
          disconnectDeadlineMs: incoming.disconnectDeadlineMs,
          disconnectTimer: null,
          state: {
            board: incoming.board.map((row) => [...row]),
            active: { ...incoming.active },
            pieceIndex: incoming.pieceIndex,
            linesCleared: incoming.linesCleared,
            score: incoming.score,
            alive: incoming.alive
          },
          lastIntentTimestamps: []
        };
        continue;
      }

      if (seat === callerSeat && callerToken) {
        current.token = callerToken;
      }

      // Adopt incoming seat state if it is further ahead or belongs to the caller
      const incomingAhead =
        incoming.pieceIndex > current.state.pieceIndex ||
        (incoming.pieceIndex === current.state.pieceIndex &&
          incoming.active.y > current.state.active.y) ||
        !incoming.alive;

      if (seat === callerSeat || incomingAhead) {
        current.state = {
          board: incoming.board.map((row) => [...row]),
          active: { ...incoming.active },
          pieceIndex: incoming.pieceIndex,
          linesCleared: Math.max(current.state.linesCleared, incoming.linesCleared),
          score: Math.max(current.state.score, incoming.score),
          alive: incoming.alive && current.state.alive
        };
      }
    }
    this.checkOutcome();
  }
}
