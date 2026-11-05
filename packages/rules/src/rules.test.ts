import { describe, expect, it } from 'vitest';
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  PIECE_KINDS,
  PieceKind,
  SharedPieceStream,
  addGarbageRows,
  applyIntent,
  canPlacePiece,
  clearCompletedRows,
  createEmptyBoard,
  createGarbageRow,
  createInitialPlayerState,
  createSpawnPiece,
  garbageCountForClearedRows,
  getPieceCells,
  hardDrop,
  lockPieceOnBoard,
  receiveGarbageOnState,
  stepGravity,
  tryMoveHorizontal,
  tryRotateCW
} from './index.js';

describe('@splitwell/rules', () => {
  it('defines a 10x20 empty board and all 7 standard 4-square shapes', () => {
    const board = createEmptyBoard();
    expect(board.length).toBe(20);
    expect(board[0]?.length).toBe(10);

    expect(PIECE_KINDS).toEqual(['I', 'O', 'T', 'S', 'Z', 'J', 'L']);
    for (const kind of PIECE_KINDS) {
      for (const rotation of [0, 1, 2, 3] as const) {
        const cells = getPieceCells({ kind, x: 3, y: 0, rotation });
        expect(cells.length).toBe(4);
      }
    }
  });

  it('produces identical piece sequences from the same seed in 7-bag chunks', () => {
    const streamA = new SharedPieceStream(123456);
    const streamB = new SharedPieceStream(123456);

    for (let i = 0; i < 28; i++) {
      expect(streamA.at(i)).toBe(streamB.at(i));
    }

    // Each bag of 7 must contain all 7 standard shapes exactly once
    for (let bagStart = 0; bagStart < 28; bagStart += 7) {
      const slice = Array.from({ length: 7 }, (_, idx) => streamA.at(bagStart + idx));
      expect(new Set(slice).size).toBe(7);
    }
  });

  it('stops pieces from moving past left and right walls or into settled blocks', () => {
    const pieceAt = (): PieceKind => 'O';
    let state = createInitialPlayerState(pieceAt);

    // Move left repeatedly — should clamp at the left wall (O piece cells start at x+1)
    for (let i = 0; i < 15; i++) {
      state = tryMoveHorizontal(state, -1);
    }
    const leftCells = getPieceCells(state.active);
    expect(Math.min(...leftCells.map((c) => c.x))).toBe(0);

    // Move right repeatedly — should clamp at the right wall (x = 9)
    for (let i = 0; i < 15; i++) {
      state = tryMoveHorizontal(state, 1);
    }
    const rightCells = getPieceCells(state.active);
    expect(Math.max(...rightCells.map((c) => c.x))).toBe(BOARD_WIDTH - 1);

    // Place a settled block directly to the left of the piece and confirm horizontal collision
    const blockedState = createInitialPlayerState(() => 'O');
    // O spawns at x=3, y=0 occupying x=4,5 and y=0,1. Block x=3, y=0:
    blockedState.board[0]![3] = 'T';
    const afterBlockedLeft = tryMoveHorizontal(blockedState, -1);
    expect(afterBlockedLeft.active.x).toBe(blockedState.active.x);
  });

  it('rotates pieces clockwise, wall-kicks against the wall, and rejects blocked rotations', () => {
    const state = createInitialPlayerState(() => 'T');
    const rotated = tryRotateCW(state);
    expect(rotated.active.rotation).toBe(1);

    // Put a vertical I piece (rotation 1) against the left wall and rotate CW:
    // Without wall kick x=-1 would put cells out of bounds; wall kick nudges it in bounds.
    let iState = createInitialPlayerState(() => 'I');
    iState = tryRotateCW(iState); // rotation 1 (vertical at x + 2)
    for (let i = 0; i < 10; i++) {
      iState = tryMoveHorizontal(iState, -1);
    }
    const kicked = tryRotateCW(iState);
    expect(kicked.active.rotation).toBe(2);
    expect(canPlacePiece(kicked.board, kicked.active)).toBe(true);

    // Surround the T piece with settled blocks so no rotation or kick can fit
    const boxed = createInitialPlayerState(() => 'I');
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < BOARD_WIDTH; x++) {
        boxed.board[y]![x] = 'J';
      }
    }
    // Carve only the horizontal spawn cells for 'I'
    for (const cell of getPieceCells(boxed.active)) {
      boxed.board[cell.y]![cell.x] = 0;
    }
    const rejected = tryRotateCW(boxed);
    expect(rejected.active.rotation).toBe(0);
  });

  it('clears completed rows and shifts rows above down', () => {
    const board = createEmptyBoard();
    // Fill bottom two rows completely
    for (let x = 0; x < BOARD_WIDTH; x++) {
      board[BOARD_HEIGHT - 1]![x] = 'I';
      board[BOARD_HEIGHT - 2]![x] = 'L';
    }
    // Put a marker block on row BOARD_HEIGHT - 3 at column 4
    board[BOARD_HEIGHT - 3]![4] = 'T';

    const { board: clearedBoard, clearedCount } = clearCompletedRows(board);
    expect(clearedCount).toBe(2);
    // The marker block should have dropped 2 rows to the bottom row
    expect(clearedBoard[BOARD_HEIGHT - 1]![4]).toBe('T');
    // Top rows are now empty
    expect(clearedBoard[0]!.every((c) => c === 0)).toBe(true);
    expect(clearedBoard[1]!.every((c) => c === 0)).toBe(true);
  });

  it('maps cleared lines to garbage count (2->1, 3->2, 4->4) and leaves one hole per garbage row', () => {
    expect(garbageCountForClearedRows(0)).toBe(0);
    expect(garbageCountForClearedRows(1)).toBe(0);
    expect(garbageCountForClearedRows(2)).toBe(1);
    expect(garbageCountForClearedRows(3)).toBe(2);
    expect(garbageCountForClearedRows(4)).toBe(4);

    const row = createGarbageRow(6);
    expect(row.length).toBe(BOARD_WIDTH);
    expect(row[6]).toBe(0);
    expect(row.filter((c) => c === 0).length).toBe(1);
    expect(row.filter((c) => c === 'G').length).toBe(BOARD_WIDTH - 1);

    const board = createEmptyBoard();
    board[BOARD_HEIGHT - 1]![2] = 'S';
    const withGarbage = addGarbageRows(board, [3, 7]);
    // Previous bottom row shifted up by 2
    expect(withGarbage[BOARD_HEIGHT - 3]![2]).toBe('S');
    expect(withGarbage[BOARD_HEIGHT - 2]![3]).toBe(0);
    expect(withGarbage[BOARD_HEIGHT - 1]![7]).toBe(0);

    // Completing the single empty hole in a garbage row clears that row
    withGarbage[BOARD_HEIGHT - 1]![7] = 'I';
    const afterClear = clearCompletedRows(withGarbage);
    expect(afterClear.clearedCount).toBe(1);
  });

  it('hard drops instantly to the bottom, clears rows, and computes garbage to send', () => {
    const seq: PieceKind[] = ['O', 'I', 'T'];
    const pieceAt = (i: number): PieceKind => seq[i % seq.length]!;
    const state = createInitialPlayerState(pieceAt);

    // Pre-fill the bottom two rows except columns 4 and 5 (where O piece lands at spawn x=3)
    for (let y = BOARD_HEIGHT - 2; y < BOARD_HEIGHT; y++) {
      for (let x = 0; x < BOARD_WIDTH; x++) {
        if (x !== 4 && x !== 5) {
          state.board[y]![x] = 'J';
        }
      }
    }

    const result = hardDrop(state, pieceAt);
    expect(result.locked).toBe(true);
    expect(result.clearedRows).toBe(2);
    expect(result.garbageToSend).toBe(1);
    expect(result.state.pieceIndex).toBe(1);
    expect(result.state.active.kind).toBe('I');
    expect(result.state.linesCleared).toBe(2);
  });

  it('marks player as lost when a newly spawned piece cannot enter the board', () => {
    const pieceAt = (): PieceKind => 'O';
    const state = createInitialPlayerState(pieceAt);

    // Fill rows 1..19 at columns 4 and 5 so as soon as the current piece locks at the top,
    // the next spawn position at y=0,1 is occupied.
    for (let y = 2; y < BOARD_HEIGHT; y++) {
      state.board[y]![4] = 'Z';
      state.board[y]![5] = 'Z';
    }

    const step = stepGravity(state, pieceAt);
    expect(step.locked).toBe(true);
    expect(step.state.alive).toBe(false);

    // Further intents on a dead board are ignored
    const afterDeadMove = applyIntent(step.state, 'left', pieceAt);
    expect(afterDeadMove.state).toEqual(step.state);
  });

  it('nudges the active piece upward if incoming garbage rows overlap its current cells', () => {
    const state = createInitialPlayerState(() => 'O');
    // Put the active piece near the bottom of the board
    state.active = { ...state.active, y: BOARD_HEIGHT - 2 };
    // Fill settled block just above so when shifted up by 2 rows it would overlap
    state.board[BOARD_HEIGHT - 1]![4] = 'L';
    const updated = receiveGarbageOnState(state, [0, 1]);
    expect(canPlacePiece(updated.board, updated.active)).toBe(true);
  });
});
