import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivePiece,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  BoardGrid,
  CellValue,
  PieceKind,
  PlayerIntent,
  computeGhostY,
  createEmptyBoard,
  getPieceCells
} from '@splitwell/rules';

type SeatIndex = 0 | 1;
type RoomStatus = 'waiting' | 'playing' | 'finished';

interface PublicPlayerSnapshot {
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

interface RoomSnapshot {
  code: string;
  status: RoomStatus;
  seed: number;
  winnerSeat: SeatIndex | null;
  finishReason: string | null;
  players: [PublicPlayerSnapshot | null, PublicPlayerSnapshot | null];
}

const SESSION_STORAGE_KEY = 'splitwell_session_v1';

interface SavedSession {
  code: string;
  token: string;
  name: string;
  seat?: SeatIndex;
}

function getWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

function BoardView({
  player,
  showGhost
}: {
  player: PublicPlayerSnapshot | null;
  showGhost: boolean;
}) {
  const displayGrid = useMemo(() => {
    const base: (CellValue | 'ghost')[][] = player
      ? player.board.map((row) => [...row])
      : createEmptyBoard();

    if (player && player.alive) {
      if (showGhost) {
        const ghostY = computeGhostY(player.board, player.active);
        const ghostCells = getPieceCells({ ...player.active, y: ghostY });
        for (const c of ghostCells) {
          if (
            c.y >= 0 &&
            c.y < BOARD_HEIGHT &&
            c.x >= 0 &&
            c.x < BOARD_WIDTH &&
            base[c.y]![c.x] === 0
          ) {
            base[c.y]![c.x] = 'ghost';
          }
        }
      }
      for (const c of getPieceCells(player.active)) {
        if (c.y >= 0 && c.y < BOARD_HEIGHT && c.x >= 0 && c.x < BOARD_WIDTH) {
          base[c.y]![c.x] = player.active.kind;
        }
      }
    }
    return base;
  }, [player, showGhost]);

  return (
    <div className="board-grid" role="grid" aria-label={player ? `${player.name} board` : 'Empty board'}>
      {displayGrid.map((row, rIdx) =>
        row.map((cell, cIdx) => (
          <div
            key={`${rIdx}-${cIdx}`}
            className={cell === 0 ? 'cell' : `cell cell-${cell}`}
          />
        ))
      )}
    </div>
  );
}

export function App() {
  const initialJoinCode = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return (params.get('room') ?? '').toUpperCase();
  }, []);

  const [playerName, setPlayerName] = useState('Player');
  const [joinCodeInput, setJoinCodeInput] = useState(initialJoinCode);
  const [yourSeat, setYourSeat] = useState<SeatIndex | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [httpFallbackMode, setHttpFallbackMode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionRef = useRef<SavedSession | null>(null);
  const roomRef = useRef<RoomSnapshot | null>(null);
  const reqSeqRef = useRef(0);
  const latestAppliedSeqRef = useRef(0);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const applyServerMessage = (data: Record<string, any>, seq?: number) => {
    if (data.type === 'noop') return;
    if (seq !== undefined) {
      if (seq < latestAppliedSeqRef.current) {
        // Ignore stale out-of-order HTTP responses so pieces never jump backward
        return;
      }
      latestAppliedSeqRef.current = seq;
    }
    if (data.type === 'joined') {
      setError(null);
      setYourSeat(data.seat);
      setRoom(data.room);
      roomRef.current = data.room;
      const saved: SavedSession = {
        code: data.code,
        token: data.token,
        name: playerName,
        seat: data.seat
      };
      sessionRef.current = saved;
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(saved));
      const url = new URL(window.location.href);
      url.searchParams.set('room', data.code);
      window.history.replaceState({}, '', url.toString());
    } else if (data.type === 'snapshot') {
      setError(null);
      setYourSeat(data.yourSeat);
      setRoom(data.room);
      roomRef.current = data.room;
    } else if (data.type === 'error') {
      setError(data.message ?? 'Unexpected server error');
    }
  };

  const callHttpRoomApi = async (payload: Record<string, unknown>) => {
    const seq = ++reqSeqRef.current;
    try {
      const res = await fetch('/api/room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = (await res.json()) as Record<string, any>;
      applyServerMessage(data, seq);
    } catch {
      // ignore transient network blip
    }
  };

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (raw) {
        sessionRef.current = JSON.parse(raw) as SavedSession;
      }
    } catch {
      sessionRef.current = null;
    }
  }, []);

  useEffect(() => {
    let closedByUnmount = false;
    let openedOnce = false;

    const ws = new WebSocket(getWsUrl());
    wsRef.current = ws;

    const fallbackTimer = setTimeout(() => {
      if (!openedOnce && !closedByUnmount) {
        setHttpFallbackMode(true);
        setWsConnected(true);
      }
    }, 1200);

    ws.onopen = () => {
      openedOnce = true;
      clearTimeout(fallbackTimer);
      setHttpFallbackMode(false);
      setWsConnected(true);
      const saved = sessionRef.current;
      if (saved) {
        ws.send(
          JSON.stringify({
            type: 'join_room',
            code: saved.code,
            token: saved.token,
            name: saved.name
          })
        );
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data));
        applyServerMessage(data);
      } catch {
        // ignore malformed messages
      }
    };

    ws.onerror = () => {
      if (!openedOnce && !closedByUnmount) {
        clearTimeout(fallbackTimer);
        setHttpFallbackMode(true);
        setWsConnected(true);
      }
    };

    ws.onclose = () => {
      if (!openedOnce && !closedByUnmount) {
        clearTimeout(fallbackTimer);
        setHttpFallbackMode(true);
        setWsConnected(true);
        const saved = sessionRef.current;
        if (saved) {
          void callHttpRoomApi({
            type: 'join_room',
            code: saved.code,
            token: saved.token,
            name: saved.name
          });
        }
      } else if (!closedByUnmount) {
        setWsConnected(false);
      }
    };

    return () => {
      closedByUnmount = true;
      clearTimeout(fallbackTimer);
      ws.close();
    };
  }, []);

  // Poll room state automatically when running on serverless HTTP transport (e.g. Vercel)
  useEffect(() => {
    if (!httpFallbackMode || !room) return;
    let inFlight = false;
    const interval = setInterval(async () => {
      if (inFlight) return;
      const saved = sessionRef.current;
      if (!saved) return;
      inFlight = true;
      try {
        await callHttpRoomApi({
          type: 'poll',
          code: saved.code,
          token: saved.token,
          seat: saved.seat ?? yourSeat ?? 0,
          snapshot: roomRef.current
        });
      } finally {
        inFlight = false;
      }
    }, 320);
    return () => clearInterval(interval);
  }, [httpFallbackMode, room?.code, room?.status, yourSeat]);

  const sendIntent = (intent: PlayerIntent) => {
    if (!httpFallbackMode && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'intent', intent }));
      return;
    }
    const saved = sessionRef.current;
    if (saved) {
      void callHttpRoomApi({
        type: 'intent',
        code: saved.code,
        token: saved.token,
        seat: saved.seat ?? yourSeat ?? 0,
        snapshot: roomRef.current,
        intent
      });
    }
  };

  useEffect(() => {
    if (!room || room.status !== 'playing') return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      switch (e.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          e.preventDefault();
          sendIntent('left');
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          e.preventDefault();
          sendIntent('right');
          break;
        case 'ArrowUp':
        case 'w':
        case 'W':
        case 'x':
        case 'X':
          e.preventDefault();
          sendIntent('rotate');
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          e.preventDefault();
          sendIntent('soft');
          break;
        case ' ':
          e.preventDefault();
          sendIntent('hard');
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [room, httpFallbackMode]);

  const handleCreateRoom = () => {
    setError(null);
    sessionRef.current = null;
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    const name = playerName.trim() || 'Player 1';
    if (!httpFallbackMode && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'create_room', name }));
    } else {
      void callHttpRoomApi({ type: 'create_room', name });
    }
  };

  const handleJoinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const code = joinCodeInput.trim().toUpperCase();
    if (!code) {
      setError('Enter a room code to join.');
      return;
    }
    setError(null);
    const name = playerName.trim() || 'Player 2';
    if (!httpFallbackMode && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'join_room', code, name }));
    } else {
      void callHttpRoomApi({ type: 'join_room', code, name });
    }
  };

  const handleLeaveRoom = () => {
    const saved = sessionRef.current;
    if (!httpFallbackMode && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'leave_room' }));
    } else if (saved) {
      void callHttpRoomApi({
        type: 'leave_room',
        code: saved.code,
        token: saved.token
      });
    }
    sessionRef.current = null;
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    setRoom(null);
    setYourSeat(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
  };

  const handleCopyInvite = async () => {
    if (!room) return;
    const url = new URL(window.location.href);
    url.searchParams.set('room', room.code);
    await navigator.clipboard.writeText(url.toString());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const you = room && yourSeat !== null ? room.players[yourSeat] : null;
  const opponentSeat: SeatIndex = yourSeat === 0 ? 1 : 0;
  const opponent = room && yourSeat !== null ? room.players[opponentSeat] : null;

  return (
    <div className="app-shell">
      <header className="header-bar">
        <div className="brand-title">
          SPLITWELL
          <span className="brand-badge">Server-Authoritative 1v1</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            className={`status-dot ${wsConnected ? 'online' : 'offline'}`}
            title={wsConnected ? 'Connected to server' : 'Reconnecting...'}
          />
          <span style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
            {wsConnected ? 'Live Server' : 'Reconnecting...'}
          </span>
          {room && (
            <button className="btn btn-danger" onClick={handleLeaveRoom}>
              Leave Match
            </button>
          )}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {!room ? (
        <div className="lobby-card">
          <h2>Head-to-Head Falling Blocks</h2>
          <p>
            Create a room to get a shareable link or 6-letter code. Both players
            receive the exact same 7-bag piece sequence. Clearing 2, 3, or 4 rows
            sends 1, 2, or 4 garbage rows to your opponent.
          </p>

          <div className="field-group">
            <label htmlFor="player-name">Your Display Name</label>
            <input
              id="player-name"
              className="input"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              maxLength={20}
              placeholder="Enter your name"
            />
          </div>

          <button
            type="button"
            className="btn btn-primary"
            style={{ width: '100%' }}
            onClick={handleCreateRoom}
            disabled={!wsConnected}
          >
            Create New Game
          </button>

          <div className="divider">OR JOIN WITH CODE</div>

          <form onSubmit={handleJoinRoom} className="join-row">
            <input
              aria-label="Room Code"
              className="input"
              value={joinCodeInput}
              onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
              placeholder="6-CHAR CODE"
              maxLength={8}
            />
            <button
              type="submit"
              className="btn btn-secondary"
              disabled={!wsConnected}
            >
              Join Game
            </button>
          </form>
        </div>
      ) : (
        <>
          {room.status === 'waiting' && (
            <div className="share-box">
              <div>
                <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                  SHARE THIS ROOM CODE OR LINK WITH PLAYER 2
                </div>
                <div className="code-pill">{room.code}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleCopyInvite}
                >
                  {copiedLink ? 'Invite Link Copied!' : 'Copy Invite Link'}
                </button>
              </div>
            </div>
          )}

          {room.status === 'finished' && (
            <div
              className={`result-banner ${
                room.winnerSeat === yourSeat ? 'won' : 'lost'
              }`}
            >
              <div>
                <strong style={{ fontSize: '1.2rem', display: 'block' }}>
                  {room.winnerSeat === yourSeat ? 'You Win!' : 'You Lose'}
                </strong>
                <span style={{ color: 'var(--muted)', fontSize: '0.92rem' }}>
                  {room.finishReason ?? 'Match complete.'}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleLeaveRoom}
              >
                New Match
              </button>
            </div>
          )}

          <div className="arena-grid">
            <div className="player-card is-you">
              <div className="player-header">
                <div className="player-name">
                  <span
                    className={`status-dot ${
                      you?.connected ? 'online' : 'offline'
                    }`}
                  />
                  {you?.name ?? 'You'} (You)
                </div>
                <div className="stats-strip">
                  <span>
                    Lines: <strong>{you?.linesCleared ?? 0}</strong>
                  </span>
                  <span>
                    Next: <strong>{you?.nextPiece ?? '-'}</strong>
                  </span>
                  <span>
                    Score: <strong>{you?.score ?? 0}</strong>
                  </span>
                </div>
              </div>

              <BoardView player={you} showGhost={true} />

              <div className="controls-bar">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => sendIntent('left')}
                >
                  ← Left
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => sendIntent('rotate')}
                >
                  ⟳ Rotate
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => sendIntent('right')}
                >
                  Right →
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => sendIntent('soft')}
                >
                  ↓ Soft
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => sendIntent('hard')}
                >
                  ⤓ Drop
                </button>
              </div>
              <div className="kbd-hint">
                Keyboard: ←/→ Move • ↑/W Rotate • ↓/S Soft Drop • Space Hard Drop
              </div>
            </div>

            <div className="player-card">
              <div className="player-header">
                <div className="player-name">
                  <span
                    className={`status-dot ${
                      opponent?.connected ? 'online' : 'offline'
                    }`}
                  />
                  {opponent
                    ? `${opponent.name}${
                        !opponent.connected ? ' (Reconnecting...)' : ''
                      }`
                    : 'Waiting for opponent...'}
                </div>
                <div className="stats-strip">
                  <span>
                    Lines: <strong>{opponent?.linesCleared ?? 0}</strong>
                  </span>
                  <span>
                    Next: <strong>{opponent?.nextPiece ?? '-'}</strong>
                  </span>
                  <span>
                    Score: <strong>{opponent?.score ?? 0}</strong>
                  </span>
                </div>
              </div>

              <BoardView player={opponent} showGhost={false} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
