import {
  BoardGrid,
  canPlacePiece,
  clearCompletedRows,
  cloneBoard,
  createEmptyBoard,
  lockPieceOnBoard
} from './board.js';
import { addGarbageRows, garbageCountForClearedRows } from './garbage.js';
import {
  ActivePiece,
  PieceKind,
  createSpawnPiece,
  nextRotationCW
} from './pieces.js';

export type PlayerIntent = 'left' | 'right' | 'rotate' | 'soft' | 'hard';

export interface PlayerBoardState {
  board: BoardGrid;
  active: ActivePiece;
  pieceIndex: number;
  linesCleared: number;
  score: number;
  alive: boolean;
}

export interface StepResult {
  state: PlayerBoardState;
  locked: boolean;
  clearedRows: number;
  garbageToSend: number;
}

export function createInitialPlayerState(pieceAt: (index: number) => PieceKind): PlayerBoardState {
  const board = createEmptyBoard();
  const firstKind = pieceAt(0);
  const active = createSpawnPiece(firstKind);
  const alive = canPlacePiece(board, active);
  return {
    board,
    active,
    pieceIndex: 0,
    linesCleared: 0,
    score: 0,
    alive
  };
}

export function tryMoveHorizontal(state: PlayerBoardState, dx: -1 | 1): PlayerBoardState {
  if (!state.alive) return state;
  const candidate: ActivePiece = {
    ...state.active,
    x: state.active.x + dx
  };
  if (!canPlacePiece(state.board, candidate)) {
    return state;
  }
  return {
    ...state,
    active: candidate
  };
}

/**
 * Clockwise rotation with a simple wall-kick table (0, -1, +1, -2 horizontal offsets)
 * so pieces right against the wall can still turn when there is space adjacent.
 */
export function tryRotateCW(state: PlayerBoardState): PlayerBoardState {
  if (!state.alive) return state;
  const rotated: ActivePiece = {
    ...state.active,
    rotation: nextRotationCW(state.active.rotation)
  };
  const kicks = [0, -1, 1, -2, 2];
  for (const dx of kicks) {
    const candidate: ActivePiece = {
      ...rotated,
      x: rotated.x + dx
    };
    if (canPlacePiece(state.board, candidate)) {
      return {
        ...state,
        active: candidate
      };
    }
  }
  return state;
}

export function computeGhostY(board: BoardGrid, active: ActivePiece): number {
  let y = active.y;
  while (canPlacePiece(board, { ...active, y: y + 1 })) {
    y += 1;
  }
  return y;
}

function lockAndAdvance(
  state: PlayerBoardState,
  pieceToLock: ActivePiece,
  pieceAt: (index: number) => PieceKind
): StepResult {
  const withLocked = lockPieceOnBoard(state.board, pieceToLock);
  const { board: afterClear, clearedCount } = clearCompletedRows(withLocked);
  const garbageToSend = garbageCountForClearedRows(clearedCount);

  const nextIndex = state.pieceIndex + 1;
  const nextPiece = createSpawnPiece(pieceAt(nextIndex));
  const canSpawn = canPlacePiece(afterClear, nextPiece);

  const lineScoreTable = [0, 100, 300, 500, 800];
  const scoreGain = lineScoreTable[Math.min(clearedCount, 4)] ?? clearedCount * 200;

  return {
    state: {
      board: afterClear,
      active: nextPiece,
      pieceIndex: nextIndex,
      linesCleared: state.linesCleared + clearedCount,
      score: state.score + scoreGain,
      alive: canSpawn
    },
    locked: true,
    clearedRows: clearedCount,
    garbageToSend
  };
}

/**
 * Steps the active piece down by 1 cell (used for both server gravity ticks and soft drop).
 * If the piece cannot move down, it locks in place, clears any completed rows,
 * and spawns the next piece from the shared stream.
 */
export function stepGravity(
  state: PlayerBoardState,
  pieceAt: (index: number) => PieceKind
): StepResult {
  if (!state.alive) {
    return { state, locked: false, clearedRows: 0, garbageToSend: 0 };
  }
  const downward: ActivePiece = {
    ...state.active,
    y: state.active.y + 1
  };
  if (canPlacePiece(state.board, downward)) {
    return {
      state: {
        ...state,
        active: downward
      },
      locked: false,
      clearedRows: 0,
      garbageToSend: 0
    };
  }
  return lockAndAdvance(state, state.active, pieceAt);
}

/**
 * Drops the active piece instantly to the lowest valid row and locks it immediately.
 */
export function hardDrop(
  state: PlayerBoardState,
  pieceAt: (index: number) => PieceKind
): StepResult {
  if (!state.alive) {
    return { state, locked: false, clearedRows: 0, garbageToSend: 0 };
  }
  const landingY = computeGhostY(state.board, state.active);
  const landedPiece: ActivePiece = {
    ...state.active,
    y: landingY
  };
  return lockAndAdvance(state, landedPiece, pieceAt);
}

export function applyIntent(
  state: PlayerBoardState,
  intent: PlayerIntent,
  pieceAt: (index: number) => PieceKind
): StepResult {
  if (!state.alive) {
    return { state, locked: false, clearedRows: 0, garbageToSend: 0 };
  }
  switch (intent) {
    case 'left':
      return {
        state: tryMoveHorizontal(state, -1),
        locked: false,
        clearedRows: 0,
        garbageToSend: 0
      };
    case 'right':
      return {
        state: tryMoveHorizontal(state, 1),
        locked: false,
        clearedRows: 0,
        garbageToSend: 0
      };
    case 'rotate':
      return {
        state: tryRotateCW(state),
        locked: false,
        clearedRows: 0,
        garbageToSend: 0
      };
    case 'soft':
      return stepGravity(state, pieceAt);
    case 'hard':
      return hardDrop(state, pieceAt);
  }
}

/**
 * Injects incoming garbage rows into the bottom of a player's board.
 * If the currently falling piece now overlaps the shifted stack, it is nudged up;
 * if it still cannot fit on the board, the player loses on the next spawn/lock check.
 */
export function receiveGarbageOnState(
  state: PlayerBoardState,
  holeColumns: readonly number[]
): PlayerBoardState {
  if (!state.alive || holeColumns.length === 0) {
    return state;
  }
  const nextBoard = addGarbageRows(cloneBoard(state.board), holeColumns);
  let adjustedActive = { ...state.active };
  while (!canPlacePiece(nextBoard, adjustedActive) && adjustedActive.y > 0) {
    adjustedActive = { ...adjustedActive, y: adjustedActive.y - 1 };
  }
  return {
    ...state,
    board: nextBoard,
    active: adjustedActive
  };
}
