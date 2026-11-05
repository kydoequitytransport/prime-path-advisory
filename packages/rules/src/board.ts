import { ActivePiece, PieceKind, getPieceCells } from './pieces.js';

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;

export type CellValue = 0 | PieceKind | 'G';
export type BoardGrid = CellValue[][];

export function createEmptyBoard(
  width: number = BOARD_WIDTH,
  height: number = BOARD_HEIGHT
): BoardGrid {
  return Array.from({ length: height }, () => Array<CellValue>(width).fill(0));
}

export function cloneBoard(board: BoardGrid): BoardGrid {
  return board.map((row) => [...row]);
}

export function canPlacePiece(board: BoardGrid, piece: ActivePiece): boolean {
  const height = board.length;
  const width = board[0]?.length ?? BOARD_WIDTH;
  for (const cell of getPieceCells(piece)) {
    if (cell.x < 0 || cell.x >= width || cell.y < 0 || cell.y >= height) {
      return false;
    }
    if (board[cell.y]![cell.x] !== 0) {
      return false;
    }
  }
  return true;
}

export function lockPieceOnBoard(board: BoardGrid, piece: ActivePiece): BoardGrid {
  const next = cloneBoard(board);
  for (const cell of getPieceCells(piece)) {
    if (
      cell.y >= 0 &&
      cell.y < next.length &&
      cell.x >= 0 &&
      cell.x < (next[0]?.length ?? BOARD_WIDTH)
    ) {
      next[cell.y]![cell.x] = piece.kind;
    }
  }
  return next;
}

export interface ClearRowsResult {
  board: BoardGrid;
  clearedCount: number;
}

export function clearCompletedRows(board: BoardGrid): ClearRowsResult {
  const height = board.length;
  const width = board[0]?.length ?? BOARD_WIDTH;
  const remainingRows = board.filter((row) => row.some((cell) => cell === 0));
  const clearedCount = height - remainingRows.length;

  if (clearedCount === 0) {
    return { board: cloneBoard(board), clearedCount: 0 };
  }

  const emptyRows = Array.from({ length: clearedCount }, () =>
    Array<CellValue>(width).fill(0)
  );
  return {
    board: [...emptyRows, ...remainingRows.map((row) => [...row])],
    clearedCount
  };
}
