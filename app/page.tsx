"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSimulation,
  getPixels,
  type Player,
  type Vec2d,
} from "@/lib/simulation";

import _PLAYER_PRESETS from "@/public/player-presets.json";

type PlayerPreset = {
  name: string;
  moveSet: [number, number][];
};
const PLAYER_PRESETS: PlayerPreset[] = _PLAYER_PRESETS as PlayerPreset[];

type EditablePlayer = {
  id: string;
  name: string;
  color: string;
  moveSet: { xInput: string; yInput: string }[];
  avoidPlayerIds: string[];
};

type MoveCoordinates = {
  x: number;
  y: number;
};

const DEFAULT_COLORS = [
  "#000000",
  "#a51d2d",
  "#99c1f1",
  "#10b981",
  "#f59e0b",
  "#a855f7",
  "#06b6d4",
];
const DEFAULT_LAYERS = 200;
const DEFAULT_CANVAS_SIZE = 1000;

let playerIdCounter = 1;

function getNextPlayerNumber(players: EditablePlayer[]): number {
  const used = new Set<number>();
  for (const player of players) {
    const match = /^Player #(\d+)$/.exec(player.name.trim());
    if (!match) continue;
    used.add(Number.parseInt(match[1], 10));
  }
  let next = 1;
  while (used.has(next)) {
    next += 1;
  }
  return next;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getNextPresetPlayerNumber(
  players: EditablePlayer[],
  presetName: string,
): number {
  const used = new Set<number>();
  const pattern = new RegExp(`^${escapeRegex(presetName)} #(\\d+)$`);
  for (const player of players) {
    const match = pattern.exec(player.name.trim());
    if (!match) continue;
    used.add(Number.parseInt(match[1], 10));
  }
  let next = 1;
  while (used.has(next)) {
    next += 1;
  }
  return next;
}

function hueToHex(hue: number): string {
  const s = 0.7;
  const l = 0.55;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const color = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function getDefaultColor(players: EditablePlayer[]): string {
  const used = new Set(players.map((player) => player.color.toLowerCase()));
  for (const color of DEFAULT_COLORS) {
    if (!used.has(color)) return color;
  }
  for (let i = 0; i < 360; i += 17) {
    const candidate = hueToHex((players.length * 59 + i) % 360).toLowerCase();
    if (!used.has(candidate)) return candidate;
  }
  return "#000000";
}

function createPlayerDraft(players: EditablePlayer[]): EditablePlayer {
  return {
    id: `player-${playerIdCounter++}`,
    name: `Player #${getNextPlayerNumber(players)}`,
    color: getDefaultColor(players),
    moveSet: [],
    avoidPlayerIds: [],
  };
}

function createPresetPlayerDraft(
  players: EditablePlayer[],
  preset: PlayerPreset,
): EditablePlayer {
  const trimmedName = preset.name.trim();
  return {
    id: `player-${playerIdCounter++}`,
    name: `${trimmedName} #${getNextPresetPlayerNumber(players, trimmedName)}`,
    color: getDefaultColor(players),
    moveSet: preset.moveSet.map(([x, y]) => ({
      xInput: String(x),
      yInput: String(y),
    })),
    avoidPlayerIds: [],
  };
}

function parseIntegerInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function isPartialIntegerInput(value: string): boolean {
  return /^-?\d*$/.test(value);
}

function parseRequiredInteger(value: string, label: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  return Number.parseInt(value, 10);
}

function parseOptionalInteger(value: string): number | null {
  if (!/^-?\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

function moveKey(move: MoveCoordinates): string {
  return `${move.x},${move.y}`;
}

function dedupeMoves(moves: MoveCoordinates[]): MoveCoordinates[] {
  const seen = new Set<string>();
  const result: MoveCoordinates[] = [];
  for (const move of moves) {
    const key = moveKey(move);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(move);
  }
  return result;
}

function getSymmetricMoves(move: MoveCoordinates): MoveCoordinates[] {
  const { x, y } = move;
  return dedupeMoves([
    { x, y },
    { x, y: -y },
    { x: -x, y },
    { x: -x, y: -y },
    { x: y, y: x },
    { x: -y, y: x },
    { x: y, y: -x },
    { x: -y, y: -x },
  ]);
}

function parseLooseMoveLine(line: string): MoveCoordinates | null {
  const ints = line.match(/[+-]?\d+/g);
  if (!ints || ints.length !== 2) {
    return null;
  }
  return {
    x: Number.parseInt(ints[0], 10),
    y: Number.parseInt(ints[1], 10),
  };
}

function parseBulkMoveInput(input: string): {
  moves: MoveCoordinates[];
  invalidLines: { lineNumber: number; content: string }[];
} {
  const moves: MoveCoordinates[] = [];
  const invalidLines: { lineNumber: number; content: string }[] = [];

  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const withSymmetry = trimmed.startsWith("@");
    const moveText = withSymmetry ? trimmed.slice(1).trim() : trimmed;
    const parsed = parseLooseMoveLine(moveText);
    if (!parsed) {
      invalidLines.push({ lineNumber: i + 1, content: rawLine });
      continue;
    }

    if (withSymmetry) {
      moves.push(...getSymmetricMoves(parsed));
    } else {
      moves.push(parsed);
    }
  }

  return {
    moves: dedupeMoves(moves),
    invalidLines,
  };
}

type Pixel = { color: string; position: Vec2d };

function computeCellSize(canvasSize: number, layers: number): number {
  return Math.max(1, Math.floor(canvasSize / (2 * layers + 1)));
}

function createInitialPlayers(): EditablePlayer[] {
  const first = createPresetPlayerDraft([], PLAYER_PRESETS[0]);
  const second = createPresetPlayerDraft([first], PLAYER_PRESETS[0]);
  first.avoidPlayerIds = [second.id];
  second.avoidPlayerIds = [first.id];
  return [first, second];
}

function getConfigurationSignature(config: {
  layers: number;
  canvasSize: number;
  players: EditablePlayer[];
}): string {
  return JSON.stringify({
    layers: config.layers,
    canvasSize: config.canvasSize,
    players: config.players.map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      moveSet: player.moveSet,
      avoidPlayerIds: player.avoidPlayerIds,
    })),
  });
}

export default function Home() {
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [players, setPlayers] =
    useState<EditablePlayer[]>(createInitialPlayers);
  const [canvasSize, setCanvasSize] = useState(DEFAULT_CANVAS_SIZE);
  const [renderedPixels, setRenderedPixels] = useState<Pixel[]>([]);
  const [renderedCanvasSize, setRenderedCanvasSize] =
    useState(DEFAULT_CANVAS_SIZE);
  const [renderedCellSize, setRenderedCellSize] = useState(
    computeCellSize(DEFAULT_CANVAS_SIZE, DEFAULT_LAYERS),
  );
  const [renderedConfigSignature, setRenderedConfigSignature] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [bulkMoveModalPlayerId, setBulkMoveModalPlayerId] = useState<
    string | null
  >(null);
  const [bulkMoveInput, setBulkMoveInput] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const spiralSize = (2 * layers + 1) ** 2 - 1;
  const cellSize = useMemo(
    () => computeCellSize(canvasSize, layers),
    [canvasSize, layers],
  );
  const currentConfigSignature = useMemo(
    () => getConfigurationSignature({ layers, canvasSize, players }),
    [layers, canvasSize, players],
  );
  const hasUnrenderedConfigChanges =
    renderedConfigSignature !== null &&
    renderedConfigSignature !== currentConfigSignature;
  const isCanvasTooSmall = cellSize * (2 * layers + 1) > canvasSize;
  const bulkMoveTargetPlayer =
    players.find((player) => player.id === bulkMoveModalPlayerId) ?? null;
  const bulkMoveParse = useMemo(
    () => parseBulkMoveInput(bulkMoveInput),
    [bulkMoveInput],
  );
  const bulkPreviewMoves = useMemo(() => {
    if (!bulkMoveTargetPlayer) {
      return [];
    }

    const existingMoveKeys = new Set<string>();
    for (const move of bulkMoveTargetPlayer.moveSet) {
      const x = parseOptionalInteger(move.xInput);
      const y = parseOptionalInteger(move.yInput);
      if (x === null || y === null) {
        continue;
      }
      existingMoveKeys.add(moveKey({ x, y }));
    }

    return bulkMoveParse.moves.filter(
      (move) => !existingMoveKeys.has(moveKey(move)),
    );
  }, [bulkMoveParse.moves, bulkMoveTargetPlayer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    context.clearRect(0, 0, renderedCanvasSize, renderedCanvasSize);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, renderedCanvasSize, renderedCanvasSize);

    const originX = renderedCanvasSize / 2;
    const originY = renderedCanvasSize / 2;

    for (const pixel of renderedPixels) {
      const drawX = Math.round(
        originX + pixel.position.x * renderedCellSize - renderedCellSize / 2,
      );
      const drawY = Math.round(
        originY - pixel.position.y * renderedCellSize - renderedCellSize / 2,
      );
      context.fillStyle = pixel.color;
      context.fillRect(drawX, drawY, renderedCellSize, renderedCellSize);
    }
  }, [renderedPixels, renderedCanvasSize, renderedCellSize]);

  function updatePlayer(
    playerId: string,
    updater: (player: EditablePlayer) => EditablePlayer,
  ) {
    setPlayers((prev) =>
      prev.map((player) => (player.id === playerId ? updater(player) : player)),
    );
  }

  function buildSimulationPlayers(): Player[] {
    const names = players.map((player) => player.name.trim());
    if (names.some((name) => name.length === 0)) {
      throw new Error("Player names cannot be empty.");
    }
    if (new Set(names).size !== names.length) {
      throw new Error("Player names must be unique.");
    }

    return players.map((player, index) => {
      const avoidPlayers = player.avoidPlayerIds.map((enemyId) => {
        const enemy = players.find((candidate) => candidate.id === enemyId);
        if (!enemy) {
          throw new Error(`Player ${index + 1} references an unknown enemy.`);
        }
        return enemy.name.trim();
      });

      return {
        name: names[index],
        color: player.color,
        moveSet: player.moveSet.map((move, moveIndex) => ({
          x: parseRequiredInteger(
            move.xInput,
            `Player ${index + 1} move ${moveIndex + 1} x`,
          ),
          y: parseRequiredInteger(
            move.yInput,
            `Player ${index + 1} move ${moveIndex + 1} y`,
          ),
        })),
        avoidPlayers,
      };
    });
  }

  function runSimulation() {
    try {
      if (players.length === 0) {
        throw new Error("Add at least one player.");
      }
      if (!Number.isInteger(layers) || layers < 0) {
        throw new Error("Layers must be a non-negative integer.");
      }
      if (!Number.isInteger(canvasSize) || canvasSize <= 0) {
        throw new Error("Canvas size must be a positive integer.");
      }
      const simulationPlayers = buildSimulationPlayers();
      console.log("running simulation with", spiralSize, simulationPlayers);
      const simulation = createSimulation(spiralSize, simulationPlayers);
      setRenderedPixels(getPixels(simulation));
      setRenderedCanvasSize(canvasSize);
      setRenderedCellSize(cellSize);
      setRenderedConfigSignature(currentConfigSignature);
      setError(null);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unknown error.";
      setError(message);
    }
  }

  function closeBulkMoveModal() {
    setBulkMoveModalPlayerId(null);
    setBulkMoveInput("");
  }

  function applyBulkMoves() {
    if (!bulkMoveTargetPlayer || bulkPreviewMoves.length === 0) {
      return;
    }

    updatePlayer(bulkMoveTargetPlayer.id, (draft) => ({
      ...draft,
      moveSet: [
        ...draft.moveSet,
        ...bulkPreviewMoves.map((move) => ({
          xInput: String(move.x),
          yInput: String(move.y),
        })),
      ],
    }));

    closeBulkMoveModal();
  }

  return (
    <div className="flex flex-1 bg-zinc-100 p-4 text-zinc-900">
      <main className="mx-auto grid w-full max-w-7xl gap-4 lg:grid-cols-[420px_1fr]">
        <section className="lg:col-span-2">
          <div className="flex items-center justify-center gap-2">
            <h1 className="text-center text-2xl font-semibold">
              Sloane&apos;s Knights
            </h1>
            <a
              href="#what-is-this"
              className="rounded text-sm font-medium leading-none underline decoration-dotted underline-offset-2 hover:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-zinc-400"
              aria-label="Jump to What is this section"
            >
              ?
            </a>
          </div>
        </section>

        <section className="space-y-4 rounded-lg border border-zinc-300 bg-white p-4">
          <h2 className="text-xl font-semibold">Simulation Controls</h2>

          <div className="space-y-2 rounded border border-zinc-200 p-3">
            <h2 className="font-medium">Spiral</h2>
            <label className="flex flex-col gap-1 text-sm">
              Layers (k)
              <input
                type="number"
                min={0}
                step={1}
                value={layers}
                onChange={(event) =>
                  setLayers(
                    Math.max(0, parseIntegerInput(event.target.value, 0)),
                  )
                }
                className="rounded border border-zinc-300 px-2 py-1"
              />
            </label>
            <p className="text-sm text-zinc-600">
              Spiral size: <span className="font-mono">{spiralSize}</span> = (2k
              + 1)^2 - 1
            </p>
          </div>

          <div className="space-y-2 rounded border border-zinc-200 p-3">
            <h2 className="font-medium">Canvas</h2>
            <div className="grid grid-cols-1 gap-2">
              <label className="flex flex-col gap-1 text-sm">
                Canvas size
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={canvasSize}
                  onChange={(event) =>
                    setCanvasSize(
                      Math.max(1, parseIntegerInput(event.target.value, 1)),
                    )
                  }
                  className="rounded border border-zinc-300 px-2 py-1"
                />
              </label>
            </div>
            <p className="text-sm text-zinc-600">
              Computed cell size:{" "}
              <span className="font-mono">{cellSize}px</span>
            </p>
            {isCanvasTooSmall ? (
              <p className="text-sm text-amber-700">
                The canvas size may be too small to render the entire spiral.
              </p>
            ) : null}
          </div>

          <div className="space-y-2 rounded border border-zinc-200 p-3">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Players</h2>
              <div className="flex items-center gap-1">
                <select
                  value=""
                  onChange={(event) => {
                    const preset = PLAYER_PRESETS.find(
                      (entry) => entry.name === event.target.value,
                    );
                    if (!preset) {
                      return;
                    }
                    setPlayers((prev) => [
                      ...prev,
                      createPresetPlayerDraft(prev, preset),
                    ]);
                  }}
                  disabled={PLAYER_PRESETS.length === 0}
                  className="max-w-32 rounded border border-zinc-300 px-2 py-1 text-sm disabled:bg-zinc-100"
                >
                  <option value="" disabled>
                    Add preset
                  </option>
                  {PLAYER_PRESETS.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setPlayers((prev) => [...prev, createPlayerDraft(prev)])
                  }
                  className="rounded border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100"
                >
                  Add blank player
                </button>
              </div>
            </div>
            <div className="space-y-3">
              {players.map((player, index) => {
                const enemyOptions = players.filter(
                  (candidate) => candidate.id !== player.id,
                );

                return (
                  <article
                    key={player.id}
                    className="space-y-2 rounded border p-2"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium">
                        Player {index + 1} ({player.name})
                      </h3>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            setPlayers((prev) => {
                              if (index === 0) return prev;
                              const next = [...prev];
                              [next[index - 1], next[index]] = [
                                next[index],
                                next[index - 1],
                              ];
                              return next;
                            })
                          }
                          className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPlayers((prev) => {
                              if (index === prev.length - 1) return prev;
                              const next = [...prev];
                              [next[index], next[index + 1]] = [
                                next[index + 1],
                                next[index],
                              ];
                              return next;
                            })
                          }
                          className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setPlayers((prev) =>
                              prev
                                .filter(
                                  (candidate) => candidate.id !== player.id,
                                )
                                .map((candidate) => ({
                                  ...candidate,
                                  avoidPlayerIds:
                                    candidate.avoidPlayerIds.filter(
                                      (enemyId) => enemyId !== player.id,
                                    ),
                                })),
                            )
                          }
                          className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <label className="flex flex-col gap-1 text-sm">
                        Name
                        <input
                          type="text"
                          value={player.name}
                          onChange={(event) =>
                            updatePlayer(player.id, (draft) => ({
                              ...draft,
                              name: event.target.value,
                            }))
                          }
                          className="rounded border border-zinc-300 px-2 py-1"
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm">
                        Color
                        <input
                          type="color"
                          value={player.color}
                          onChange={(event) =>
                            updatePlayer(player.id, (draft) => ({
                              ...draft,
                              color: event.target.value,
                            }))
                          }
                          className="h-9 w-14 rounded border border-zinc-300"
                        />
                      </label>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <h4 className="flex items-center gap-1 text-sm font-medium">
                          Move set (dx, dy)
                          <span
                            className="cursor-help text-xs leading-none underline decoration-dotted underline-offset-2"
                            title="A piece placed at (x, y) sees (x + dx, y + dy) for all (dx, dy) in the move set."
                            aria-label="Move set help"
                          >
                            ?
                          </span>
                        </h4>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              updatePlayer(player.id, (draft) => ({
                                ...draft,
                                moveSet: [
                                  ...draft.moveSet,
                                  { xInput: "1", yInput: "2" },
                                ],
                              }))
                            }
                            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100"
                          >
                            Add move
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setBulkMoveModalPlayerId(player.id);
                              setBulkMoveInput("");
                            }}
                            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100"
                          >
                            Bulk add
                          </button>
                        </div>
                      </div>
                      {player.moveSet.map((move, moveIndex) => (
                        <div
                          key={`${player.id}-move-${moveIndex}`}
                          className="grid w-fit grid-cols-[auto_minmax(0,72px)_minmax(0,72px)] items-center justify-start gap-1"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              updatePlayer(player.id, (draft) => ({
                                ...draft,
                                moveSet: draft.moveSet.filter(
                                  (_, index2) => index2 !== moveIndex,
                                ),
                              }))
                            }
                            className="grid h-6 w-6 place-items-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                            aria-label={`Delete player ${index + 1} move ${moveIndex + 1}`}
                            title="Delete move"
                          >
                            <svg
                              viewBox="0 0 16 16"
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            >
                              <path
                                d="M3.5 3.5l9 9m0-9l-9 9"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                              />
                            </svg>
                          </button>
                          <input
                            type="text"
                            inputMode="numeric"
                            value={move.xInput}
                            onChange={(event) =>
                              updatePlayer(player.id, (draft) => {
                                if (
                                  !isPartialIntegerInput(event.target.value)
                                ) {
                                  return draft;
                                }
                                return {
                                  ...draft,
                                  moveSet: draft.moveSet.map(
                                    (candidate, index2) =>
                                      index2 === moveIndex
                                        ? {
                                            ...candidate,
                                            xInput: event.target.value,
                                          }
                                        : candidate,
                                  ),
                                };
                              })
                            }
                            className="min-w-0 rounded border border-zinc-300 px-1.5 py-1 text-sm"
                            aria-label={`Player ${index + 1} move ${moveIndex + 1} x`}
                          />
                          <input
                            type="text"
                            inputMode="numeric"
                            value={move.yInput}
                            onChange={(event) =>
                              updatePlayer(player.id, (draft) => {
                                if (
                                  !isPartialIntegerInput(event.target.value)
                                ) {
                                  return draft;
                                }
                                return {
                                  ...draft,
                                  moveSet: draft.moveSet.map(
                                    (candidate, index2) =>
                                      index2 === moveIndex
                                        ? {
                                            ...candidate,
                                            yInput: event.target.value,
                                          }
                                        : candidate,
                                  ),
                                };
                              })
                            }
                            className="min-w-0 rounded border border-zinc-300 px-1.5 py-1 text-sm"
                            aria-label={`Player ${index + 1} move ${moveIndex + 1} y`}
                          />
                        </div>
                      ))}
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <h4 className="flex items-center gap-1 text-sm font-medium">
                          Enemies to avoid
                          <span
                            className="cursor-help text-xs leading-none underline decoration-dotted underline-offset-2"
                            title="This player cannot place a piece on a cell that is seen by any of its enemies pieces."
                            aria-label="Enemies to avoid help"
                          >
                            ?
                          </span>
                        </h4>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              updatePlayer(player.id, (draft) => {
                                const availableEnemy = enemyOptions.find(
                                  (candidate) =>
                                    !draft.avoidPlayerIds.includes(
                                      candidate.id,
                                    ),
                                );
                                if (!availableEnemy) return draft;
                                return {
                                  ...draft,
                                  avoidPlayerIds: [
                                    ...draft.avoidPlayerIds,
                                    availableEnemy.id,
                                  ],
                                };
                              })
                            }
                            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100"
                          >
                            Add enemy
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updatePlayer(player.id, (draft) => {
                                const availableEnemies = enemyOptions.filter(
                                  (candidate) =>
                                    !draft.avoidPlayerIds.includes(
                                      candidate.id,
                                    ),
                                );
                                return {
                                  ...draft,
                                  avoidPlayerIds: [
                                    ...draft.avoidPlayerIds,
                                    ...availableEnemies.map(
                                      (enemy) => enemy.id,
                                    ),
                                  ],
                                };
                              })
                            }
                            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100"
                          >
                            Add all
                          </button>
                        </div>
                      </div>
                      {player.avoidPlayerIds.map((enemyId, enemyIndex) => {
                        const optionsForRow = enemyOptions.filter(
                          (candidate) =>
                            candidate.id === enemyId ||
                            !player.avoidPlayerIds.includes(candidate.id),
                        );

                        return (
                          <div
                            key={`${player.id}-enemy-${enemyIndex}`}
                            className="grid grid-cols-[1fr_auto] gap-2"
                          >
                            <select
                              value={enemyId}
                              onChange={(event) =>
                                updatePlayer(player.id, (draft) => {
                                  const nextEnemyId = event.target.value;
                                  if (
                                    nextEnemyId !== enemyId &&
                                    draft.avoidPlayerIds.includes(nextEnemyId)
                                  ) {
                                    return draft;
                                  }
                                  return {
                                    ...draft,
                                    avoidPlayerIds: draft.avoidPlayerIds.map(
                                      (candidate, index2) =>
                                        index2 === enemyIndex
                                          ? nextEnemyId
                                          : candidate,
                                    ),
                                  };
                                })
                              }
                              className="rounded border border-zinc-300 px-2 py-1 text-sm"
                            >
                              {optionsForRow.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.name.trim() || "(unnamed player)"}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() =>
                                updatePlayer(player.id, (draft) => ({
                                  ...draft,
                                  avoidPlayerIds: draft.avoidPlayerIds.filter(
                                    (_, index2) => index2 !== enemyIndex,
                                  ),
                                }))
                              }
                              className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100"
                            >
                              Delete
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <button
            type="button"
            onClick={runSimulation}
            className="rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
          >
            Run simulation
          </button>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </section>

        <section className="rounded-lg border border-zinc-300 bg-white p-4">
          <h2 className="mb-3 text-lg font-semibold">Canvas Output</h2>
          <canvas
            ref={canvasRef}
            width={renderedCanvasSize}
            height={renderedCanvasSize}
            className={`max-w-full border bg-white ${
              hasUnrenderedConfigChanges
                ? "border-red-500 border-4"
                : "border-zinc-300"
            }`}
          />
        </section>

        <section
          id="what-is-this"
          className="space-y-2 rounded-lg border border-zinc-300 bg-white p-4 lg:col-span-2"
        >
          <h2 className="text-lg font-semibold">What is this?</h2>
          <p className="text-sm text-zinc-700">
            This is a simulator for (a generalized version of) Sloane&apos;s
            Knights game as described in{" "}
            <a
              href="https://www.youtube.com/watch?v=UiX4CFIiegM"
              target="_blank"
              className="text-blue-600 underline decoration-dotted underline-offset-2"
            >
              this Numberphile video
            </a>{" "}
            and{" "}
            <a
              href="https://oeis.org/A392177"
              target="_blank"
              className="text-blue-600 underline decoration-dotted underline-offset-2"
            >
              this OEIS article
            </a>
            .
          </p>

          <p className="text-sm text-zinc-700">
            Consider a square spiral with its cells numbered starting at 0. The
            spiral is centered at the origin, with the center cell being 0 and
            the spiral expanding outward in a counter-clockwise direction.
          </p>

          <p className="text-sm text-zinc-700">
            Each player takes turns placing their pieces on the spiral
            (represented by their color). Each player places their piece on the
            lowest available cell in the spiral, where &ldquo;available&rdquo;
            means the cell is both not already occupied by another player&apos;s
            piece and is not within a move&apos;s reach of any of the
            player&apos;s enemies&apos; pieces.
          </p>

          <p className="text-sm text-zinc-700">
            The default configuration describes Sloane&apos;s original game: two
            players, each with a knight piece trying to avoid the other player.
          </p>

          <p className="text-sm text-zinc-700">
            In this simulator, you can customize the number of players, their
            move sets (which cells their pieces threaten), and which players
            they must avoid.
          </p>

          <p className="text-sm text-zinc-700">
            The simulator contains a number of preset player types, that are
            taken from Jonas Karlsson&apos;s discussion on it{" "}
            <a
              href="https://jonka364.github.io/stendhal/stendhal.html"
              target="_blank"
              className="text-blue-600 underline decoration-dotted underline-offset-2"
            >
              here
            </a>
            .
          </p>

          <p className="text-sm text-zinc-700">
            Find source code for this website{" "}
            <a
              href="https://github.com/motiwalam/sloanes-knights"
              target="_blank"
              className="text-blue-600 underline decoration-dotted underline-offset-2"
            >
              here
            </a>
            .
          </p>
        </section>
      </main>

      {bulkMoveTargetPlayer ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-add-moves-title"
            className="w-full max-w-2xl rounded-lg border border-zinc-300 bg-white p-4 shadow-lg"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 id="bulk-add-moves-title" className="text-lg font-semibold">
                  Bulk add moves
                </h2>
                <p className="text-sm text-zinc-600">
                  Target: {bulkMoveTargetPlayer.name.trim() || "Unnamed player"}
                </p>
              </div>
              <button
                type="button"
                onClick={closeBulkMoveModal}
                className="rounded border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100"
              >
                Close
              </button>
            </div>

            <p className="mb-2 text-sm text-zinc-700">
              Enter one move per line. Supported formats include{" "}
              <span className="font-mono">(x, y)</span>,{" "}
              <span className="font-mono">x y</span>,{" "}
              <span className="font-mono">x, y</span>,{" "}
              <span className="font-mono">[x, y]</span>. Prefix with{" "}
              <span className="font-mono">@</span> to add all symmetries.
            </p>

            <textarea
              value={bulkMoveInput}
              onChange={(event) => setBulkMoveInput(event.target.value)}
              className="mb-3 h-44 w-full rounded border border-zinc-300 px-2 py-1 font-mono text-sm"
              placeholder={"(1, 2)\n@ (2, 1)\n-3 4"}
            />

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <h3 className="mb-1 text-sm font-medium">
                  Preview ({bulkPreviewMoves.length} moves to add)
                </h3>
                <div className="max-h-44 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
                  {bulkPreviewMoves.length === 0 ? (
                    <p className="text-zinc-500">No new moves detected.</p>
                  ) : (
                    <div className="font-mono">
                      {bulkPreviewMoves.map((move) => (
                        <div key={moveKey(move)}>
                          ({move.x}, {move.y})
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div>
                <h3 className="mb-1 text-sm font-medium">
                  Parse issues ({bulkMoveParse.invalidLines.length})
                </h3>
                <div className="max-h-44 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-2 text-sm">
                  {bulkMoveParse.invalidLines.length === 0 ? (
                    <p className="text-zinc-500">No parse issues.</p>
                  ) : (
                    <div className="space-y-1 text-red-700">
                      {bulkMoveParse.invalidLines.map((invalid) => (
                        <div key={`${invalid.lineNumber}-${invalid.content}`}>
                          Line {invalid.lineNumber}:{" "}
                          <span className="font-mono">
                            {invalid.content || "(empty)"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeBulkMoveModal}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyBulkMoves}
                disabled={bulkPreviewMoves.length === 0}
                className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
              >
                Add {bulkPreviewMoves.length} move
                {bulkPreviewMoves.length === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
