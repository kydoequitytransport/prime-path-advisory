export type PieceKind = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export const PIECE_KINDS: readonly PieceKind[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

export type Rotation = 0 | 1 | 2 | 3;

export interface Point {
  x: number;
  y: number;
}

export interface ActivePiece {
  kind: PieceKind;
  x: number;
  y: number;
  rotation: Rotation;
}

// Each shape in each rotation state (0 = spawn, 1 = 90° CW, 2 = 180°, 3 = 270° CW)
// Coordinates are relative to the piece's (x, y) origin.
export const PIECE_SHAPES: Record<PieceKind, readonly [readonly Point[], readonly Point[], readonly Point[], readonly Point[]]> = {
  I: [
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
    [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }],
    [{ x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }]
  ],
  O: [
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }]
  ],
  T: [
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }]
  ],
  S: [
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }]
  ],
  Z: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }]
  ],
  J: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }]
  ],
  L: [
    [{ x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 2 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }]
  ]
};

export function createSpawnPiece(kind: PieceKind): ActivePiece {
  return {
    kind,
    x: 3,
    y: 0,
    rotation: 0
  };
}

export function getPieceCells(piece: ActivePiece): Point[] {
  const offsets = PIECE_SHAPES[piece.kind][piece.rotation];
  return offsets.map((offset) => ({
    x: piece.x + offset.x,
    y: piece.y + offset.y
  }));
}

export function nextRotationCW(rotation: Rotation): Rotation {
  return ((rotation + 1) % 4) as Rotation;
}

/**
 * Deterministic PRNG (Mulberry32) used so both players pull from the exact
 * same sequence of 7-bag pieces and deterministic garbage holes.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a shared sequence of pieces using the standard 7-bag randomizer.
 * Every chunk of 7 pieces contains one of each shape (I, O, T, S, Z, J, L).
 */
export class SharedPieceStream {
  private readonly rng: () => number;
  private readonly sequence: PieceKind[] = [];

  constructor(seed: number) {
    this.rng = createSeededRng(seed);
  }

  public at(index: number): PieceKind {
    while (this.sequence.length <= index) {
      this.appendBag();
    }
    return this.sequence[index]!;
  }

  private appendBag(): void {
    const bag: PieceKind[] = [...PIECE_KINDS];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const tmp = bag[i]!;
      bag[i] = bag[j]!;
      bag[j] = tmp;
    }
    this.sequence.push(...bag);
  }
}
