import { BOARD_WIDTH, BoardGrid, CellValue } from './board.js';

/**
 * Spec rule 4:
 * Clearing 2 or more rows at once sends "garbage" rows to the bottom of the
 * opponent's board: 2 rows cleared sends 1 garbage row, 3 sends 2 and 4 sends 4.
 * Each garbage row has one empty square, so it can still be cleared.
 */
export function garbageCountForClearedRows(clearedRows: number): number {
  if (clearedRows === 2) return 1;
  if (clearedRows === 3) return 2;
  if (clearedRows >= 4) return 4;
  return 0;
}

export function createGarbageRow(holeColumn: number, width: number = BOARD_WIDTH): CellValue[] {
  const safeHole = ((holeColumn % width) + width) % width;
  return Array.from({ length: width }, (_, col) => (col === safeHole ? 0 : 'G'));
}

/**
 * Pushes garbage rows onto the bottom of the board, shifting existing rows up.
 * Each garbage row has exactly one empty square (`0`) at the provided hole column.
 */
export function addGarbageRows(board: BoardGrid, holeColumns: readonly number[]): BoardGrid {
  if (holeColumns.length === 0) {
    return board.map((row) => [...row]);
  }
  const height = board.length;
  const width = board[0]?.length ?? BOARD_WIDTH;
  const garbageRows = holeColumns.map((col) => createGarbageRow(col, width));
  const combined = [...board.map((row) => [...row]), ...garbageRows];
  return combined.slice(combined.length - height);
}
