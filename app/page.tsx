"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSimulation,
  stepSimulation,
  spiralToGrid,
  type Player,
  type Simulation,
  type Vec2d,
} from "@/lib/simulation";
import { useLocalStorage } from "@/lib/storage";

import _PLAYER_PRESETS from "@/public/player-presets.json";
import _SIMULATION_PRESETS from "@/public/simulation-presets.json";

type PlayerPreset = {
  name: string;
  moveSet: [number, number][];
};
const PLAYER_PRESETS: PlayerPreset[] = _PLAYER_PRESETS as PlayerPreset[];
type SerializedMove = [number, number];
type SerializedSimulationPlayer = {
  name: string;
  color: string;
  moveSet: SerializedMove[];
  avoidPlayers: string[];
};
type SimulationSerialization = {
  layers: number;
  canvasSize: number;
  players: SerializedSimulationPlayer[];
};
type SimulationPresetOption = {
  id: string;
  name: string;
  source: "builtin" | "custom";
  layers: number;
  canvasSize: number;
  serialization: SimulationSerialization;
};
const BUILTIN_SIMULATION_PRESETS = _SIMULATION_PRESETS as unknown as Record<
  string,
  SimulationSerialization
>;

type EditablePlayer = {
  id: string;
  name: string;
  color: string;
  isFolded: boolean;
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
const DEFAULT_SPIRAL_SIZE = (2 * DEFAULT_LAYERS + 1) ** 2 - 1;
const MAX_SPIRAL_SIZE = 2_000_000;
const MIN_LEGIBLE_SPIRAL_NUMBER_FONT_SIZE = 8;
const MAX_SPIRAL_NUMBER_TEXT_RENDER_SIZE = 100_000;
const MIN_MOVE_GRID_DIMENSION = 3;
const MAX_MOVE_GRID_DIMENSION = 15;
const DEFAULT_MOVE_EDITOR_GRID_DIMENSION = 5;
const DEFAULT_SIMULATION_STEP_COUNT = "10";
const DEFAULT_SIMULATION_SPEED = 10;
const MIN_SIMULATION_SPEED = 1;
const MAX_SIMULATION_SPEED = 100;
const SIMULATION_STEPS_PER_SPEED_UNIT = 1_000;

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
    isFolded: true,
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
    isFolded: true,
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

function parseSimulationSerialization(value: unknown): SimulationSerialization {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Configuration must be a JSON object.");
  }
  const record = value as Record<string, unknown>;

  const layers = record.layers;
  if (!Number.isInteger(layers) || (layers as number) < 0) {
    throw new Error("Configuration layers must be a non-negative integer.");
  }

  const canvasSize = record.canvasSize;
  if (!Number.isInteger(canvasSize) || (canvasSize as number) <= 0) {
    throw new Error("Configuration canvasSize must be a positive integer.");
  }

  const players = record.players;
  if (!Array.isArray(players)) {
    throw new Error("Configuration players must be an array.");
  }

  const parsedPlayers: SerializedSimulationPlayer[] = players.map(
    (player, index) => {
      if (!player || typeof player !== "object" || Array.isArray(player)) {
        throw new Error(`Configuration player ${index + 1} must be an object.`);
      }
      const playerRecord = player as Record<string, unknown>;
      const name = playerRecord.name;
      const color = playerRecord.color;
      const moveSet = playerRecord.moveSet;
      const avoidPlayers = playerRecord.avoidPlayers;

      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error(
          `Configuration player ${index + 1} name must be a non-empty string.`,
        );
      }
      if (typeof color !== "string" || color.trim().length === 0) {
        throw new Error(
          `Configuration player ${index + 1} color must be a non-empty string.`,
        );
      }
      if (!Array.isArray(moveSet)) {
        throw new Error(
          `Configuration player ${index + 1} moveSet must be an array.`,
        );
      }
      if (!Array.isArray(avoidPlayers)) {
        throw new Error(
          `Configuration player ${index + 1} avoidPlayers must be an array.`,
        );
      }

      const parsedMoveSet = moveSet.map((move, moveIndex) => {
        if (
          !Array.isArray(move) ||
          move.length !== 2 ||
          !Number.isInteger(move[0]) ||
          !Number.isInteger(move[1])
        ) {
          throw new Error(
            `Configuration player ${index + 1} move ${moveIndex + 1} must be [x, y] integers.`,
          );
        }
        return [move[0] as number, move[1] as number] as SerializedMove;
      });

      const parsedAvoidPlayers = avoidPlayers.map((enemy, enemyIndex) => {
        if (typeof enemy !== "string") {
          throw new Error(
            `Configuration player ${index + 1} avoidPlayers[${enemyIndex}] must be a string.`,
          );
        }
        return enemy.trim();
      });

      return {
        name: name.trim(),
        color: color.trim(),
        moveSet: parsedMoveSet,
        avoidPlayers: parsedAvoidPlayers,
      };
    },
  );

  return {
    layers: layers as number,
    canvasSize: canvasSize as number,
    players: parsedPlayers,
  };
}

function buildSimulationPresetOptions(
  presets: Record<string, unknown>,
  source: "builtin" | "custom",
): SimulationPresetOption[] {
  const options: SimulationPresetOption[] = [];
  for (const [name, rawSerialization] of Object.entries(presets)) {
    if (name.trim().length === 0) {
      continue;
    }
    try {
      const serialization = parseSimulationSerialization(rawSerialization);
      options.push({
        id: `${source}:${name}`,
        name,
        source,
        layers: serialization.layers,
        canvasSize: serialization.canvasSize,
        serialization,
      });
    } catch {
      continue;
    }
  }
  return options;
}

function createEditablePlayersFromSerialization(
  serializedPlayers: SerializedSimulationPlayer[],
): EditablePlayer[] {
  const nameToId = new Map<string, string>();
  const players = serializedPlayers.map((player) => {
    const id = `player-${playerIdCounter++}`;
    const trimmedName = player.name.trim();
    if (nameToId.has(trimmedName)) {
      throw new Error(
        `Player names must be unique; duplicate "${trimmedName}".`,
      );
    }
    nameToId.set(trimmedName, id);
    return {
      id,
      name: trimmedName,
      color: player.color.trim(),
      isFolded: true,
      moveSet: player.moveSet.map(([x, y]) => ({
        xInput: String(x),
        yInput: String(y),
      })),
      avoidPlayerIds: [] as string[],
    };
  });

  return players.map((player, index) => ({
    ...player,
    avoidPlayerIds: serializedPlayers[index].avoidPlayers.map((enemyName) => {
      const enemyId = nameToId.get(enemyName.trim());
      if (!enemyId) {
        throw new Error(
          `Player "${player.name}" avoids unknown player "${enemyName}".`,
        );
      }
      return enemyId;
    }),
  }));
}

function toSimulationSerialization(
  layers: number,
  canvasSize: number,
  players: Player[],
): SimulationSerialization {
  return {
    layers,
    canvasSize,
    players: players.map((player) => ({
      name: player.name,
      color: player.color,
      moveSet: player.moveSet.map(
        (move) => [move.x, move.y] as [number, number],
      ),
      avoidPlayers: player.avoidPlayers,
    })),
  };
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

function parseDraftMoveSet(
  draftMoves: EditablePlayer["moveSet"],
): MoveCoordinates[] {
  const moves: MoveCoordinates[] = [];
  for (const move of draftMoves) {
    const x = parseOptionalInteger(move.xInput);
    const y = parseOptionalInteger(move.yInput);
    if (x === null || y === null) {
      continue;
    }
    moves.push({ x, y });
  }
  return dedupeMoves(moves);
}

function toDraftMoveSet(moves: MoveCoordinates[]): EditablePlayer["moveSet"] {
  return dedupeMoves(moves).map((move) => ({
    xInput: String(move.x),
    yInput: String(move.y),
  }));
}

function splitMovesByGridBounds(
  moves: MoveCoordinates[],
  gridDimension: number,
): {
  inBounds: MoveCoordinates[];
  outOfBounds: MoveCoordinates[];
} {
  const radius = (gridDimension - 1) / 2;
  const inBounds: MoveCoordinates[] = [];
  const outOfBounds: MoveCoordinates[] = [];
  for (const move of dedupeMoves(moves)) {
    if (Math.abs(move.x) <= radius && Math.abs(move.y) <= radius) {
      inBounds.push(move);
    } else {
      outOfBounds.push(move);
    }
  }
  return { inBounds, outOfBounds };
}

function getSmallestGridDimensionForMoves(moves: MoveCoordinates[]): number {
  let maxAbsCoordinate = 1;
  for (const move of dedupeMoves(moves)) {
    maxAbsCoordinate = Math.max(
      maxAbsCoordinate,
      Math.abs(move.x),
      Math.abs(move.y),
    );
  }
  return Math.min(
    MAX_MOVE_GRID_DIMENSION,
    Math.max(MIN_MOVE_GRID_DIMENSION, 2 * maxAbsCoordinate + 1),
  );
}

function getGridCoordinates(gridDimension: number): MoveCoordinates[] {
  const radius = (gridDimension - 1) / 2;
  const coordinates: MoveCoordinates[] = [];
  for (let y = radius; y >= -radius; y -= 1) {
    for (let x = -radius; x <= radius; x += 1) {
      coordinates.push({ x, y });
    }
  }
  return coordinates;
}

type Pixel = { color: string; position: Vec2d; spiralIndex: number };

function computeCellSize(canvasSize: number, layers: number): number {
  return Math.max(1, Math.floor(canvasSize / (2 * layers + 1)));
}

function countDigits(value: number): number {
  return Math.abs(value).toString().length;
}

function computeSpiralNumberFontSize(
  cellSize: number,
  spiralSize: number,
): number {
  return Math.max(1, Math.floor(cellSize / countDigits(spiralSize)));
}

function isSpiralNumberRenderUnsafeForConfig(
  layers: number,
  canvasSize: number,
): boolean {
  const spiralSize = (2 * layers + 1) ** 2 - 1;
  const cellSize = computeCellSize(canvasSize, layers);
  const spiralNumberFontSize = computeSpiralNumberFontSize(
    cellSize,
    spiralSize,
  );
  return (
    spiralNumberFontSize < MIN_LEGIBLE_SPIRAL_NUMBER_FONT_SIZE ||
    spiralSize > MAX_SPIRAL_NUMBER_TEXT_RENDER_SIZE
  );
}

function expandShortHex(hex: string): string {
  return hex
    .split("")
    .map((char) => `${char}${char}`)
    .join("");
}

function parseHexColor(
  color: string,
): { r: number; g: number; b: number } | null {
  const normalized = color.trim();
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(normalized);
  const longMatch = /^#([0-9a-fA-F]{6})$/.exec(normalized);

  const hex = shortMatch
    ? expandShortHex(shortMatch[1])
    : longMatch
      ? longMatch[1]
      : null;
  if (!hex) {
    return null;
  }

  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function getContrastTextColor(backgroundColor: string): string {
  const parsed = parseHexColor(backgroundColor);
  if (!parsed) {
    return "#111111";
  }

  const luminance =
    (0.299 * parsed.r + 0.587 * parsed.g + 0.114 * parsed.b) / 255;
  return luminance > 0.5 ? "#111111" : "#ffffff";
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
  renderSpiralNumbers: boolean;
  forceSpiralNumberRenderAnyway: boolean;
}): string {
  return JSON.stringify({
    layers: config.layers,
    canvasSize: config.canvasSize,
    renderSpiralNumbers: config.renderSpiralNumbers,
    forceSpiralNumberRenderAnyway: config.forceSpiralNumberRenderAnyway,
    players: config.players.map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      moveSet: player.moveSet,
      avoidPlayerIds: player.avoidPlayerIds,
    })),
  });
}

function getSimulationConfigurationSignature(config: {
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
  const [customSimulationPresets, setCustomSimulationPresets] = useLocalStorage<
    Record<string, unknown>
  >("sloanes-knights:simulation-presets", {});
  const [layers, setLayers] = useState(DEFAULT_LAYERS);
  const [players, setPlayers] =
    useState<EditablePlayer[]>(createInitialPlayers);
  const [canvasSize, setCanvasSize] = useState(DEFAULT_CANVAS_SIZE);
  const [renderedPixels, setRenderedPixels] = useState<Pixel[]>([]);
  const [renderedCanvasSize, setRenderedCanvasSize] =
    useState(DEFAULT_CANVAS_SIZE);
  const [renderedSpiralSize, setRenderedSpiralSize] =
    useState(DEFAULT_SPIRAL_SIZE);
  const [renderedCellSize, setRenderedCellSize] = useState(
    computeCellSize(DEFAULT_CANVAS_SIZE, DEFAULT_LAYERS),
  );
  const [renderSpiralNumbers, setRenderSpiralNumbers] = useState(false);
  const [forceSpiralNumberRenderAnyway, setForceSpiralNumberRenderAnyway] =
    useState(false);
  const [showSpiralNumberRenderWarning, setShowSpiralNumberRenderWarning] =
    useState(false);
  const [renderedRenderSpiralNumbers, setRenderedRenderSpiralNumbers] =
    useState(false);
  const [
    renderedForceSpiralNumberRenderAnyway,
    setRenderedForceSpiralNumberRenderAnyway,
  ] = useState(false);
  const [renderedConfigSignature, setRenderedConfigSignature] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [isSimulationStarted, setIsSimulationStarted] = useState(false);
  const [isSimulationPaused, setIsSimulationPaused] = useState(false);
  const [isSimulationComplete, setIsSimulationComplete] = useState(false);
  const [simulationConfigSignature, setSimulationConfigSignature] = useState<
    string | null
  >(null);
  const [simulationStepCount, setSimulationStepCount] = useState(
    DEFAULT_SIMULATION_STEP_COUNT,
  );
  const [simulationSpeed, setSimulationSpeed] = useState(
    DEFAULT_SIMULATION_SPEED,
  );
  const [totalStepsTaken, setTotalStepsTaken] = useState(0);
  const [moveEditorModalPlayerId, setMoveEditorModalPlayerId] = useState<
    string | null
  >(null);
  const [moveEditorInput, setMoveEditorInput] = useState("");
  const [moveEditorGridDimension, setMoveEditorGridDimension] = useState(
    DEFAULT_MOVE_EDITOR_GRID_DIMENSION,
  );
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isSavePresetModalOpen, setIsSavePresetModalOpen] = useState(false);
  const [exportedConfigJson, setExportedConfigJson] = useState("");
  const [importConfigJson, setImportConfigJson] = useState("");
  const [savePresetName, setSavePresetName] = useState("");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simulationRunRef = useRef<{
    id: number;
    simulation: Simulation;
    spiralSize: number;
    players: Player[];
  } | null>(null);
  const simulationRunIdRef = useRef(0);
  const simulationLoopTimeoutRef = useRef<number | null>(null);
  const isSimulationPausedRef = useRef(false);
  const simulationStepsPerBatchRef = useRef(
    DEFAULT_SIMULATION_SPEED * SIMULATION_STEPS_PER_SPEED_UNIT,
  );
  const previousDrawStateRef = useRef<{
    canvasSize: number;
    cellSize: number;
    spiralSize: number;
    shouldRenderSpiralNumbers: boolean;
    pixelCount: number;
  } | null>(null);

  const spiralSize = (2 * layers + 1) ** 2 - 1;
  const isSimulationTooBig = spiralSize > MAX_SPIRAL_SIZE;
  const cellSize = useMemo(
    () => computeCellSize(canvasSize, layers),
    [canvasSize, layers],
  );
  const currentConfigSignature = useMemo(
    () =>
      getConfigurationSignature({
        layers,
        canvasSize,
        players,
        renderSpiralNumbers,
        forceSpiralNumberRenderAnyway,
      }),
    [
      layers,
      canvasSize,
      players,
      renderSpiralNumbers,
      forceSpiralNumberRenderAnyway,
    ],
  );
  const currentSimulationConfigSignature = useMemo(
    () =>
      getSimulationConfigurationSignature({
        layers,
        canvasSize,
        players,
      }),
    [layers, canvasSize, players],
  );
  const hasUnrenderedConfigChanges =
    renderedConfigSignature !== null &&
    renderedConfigSignature !== currentConfigSignature;
  const isCanvasTooSmall = cellSize * (2 * layers + 1) > canvasSize;
  const spiralNumberFontSize = useMemo(
    () => computeSpiralNumberFontSize(cellSize, spiralSize),
    [cellSize, spiralSize],
  );
  const isSpiralNumberFontTooSmall =
    spiralNumberFontSize < MIN_LEGIBLE_SPIRAL_NUMBER_FONT_SIZE;
  const isSpiralNumberTextTooLarge =
    spiralSize > MAX_SPIRAL_NUMBER_TEXT_RENDER_SIZE;
  const isSpiralNumberRenderUnsafe =
    isSpiralNumberFontTooSmall || isSpiralNumberTextTooLarge;
  const renderedSpiralNumberFontSize = useMemo(
    () => computeSpiralNumberFontSize(renderedCellSize, renderedSpiralSize),
    [renderedCellSize, renderedSpiralSize],
  );
  const isRenderedSpiralNumberFontTooSmall =
    renderedSpiralNumberFontSize < MIN_LEGIBLE_SPIRAL_NUMBER_FONT_SIZE;
  const isRenderedSpiralNumberTextTooLarge =
    renderedSpiralSize > MAX_SPIRAL_NUMBER_TEXT_RENDER_SIZE;
  const isRenderedSpiralNumberRenderUnsafe =
    isRenderedSpiralNumberFontTooSmall || isRenderedSpiralNumberTextTooLarge;
  const shouldRenderSpiralNumbers =
    renderedRenderSpiralNumbers &&
    (!isRenderedSpiralNumberRenderUnsafe ||
      renderedForceSpiralNumberRenderAnyway);
  const shouldShowSpiralNumberRenderWarning =
    showSpiralNumberRenderWarning &&
    isSpiralNumberRenderUnsafe &&
    !renderSpiralNumbers;
  const hasSimulationConfigChanges =
    hasUnrenderedConfigChanges ||
    (simulationConfigSignature !== null &&
      simulationConfigSignature !== currentSimulationConfigSignature);
  const isSimulationRunning =
    isSimulationStarted && !isSimulationPaused && !isSimulationComplete;
  const isStepControlsEnabled =
    isSimulationStarted && isSimulationPaused && !isSimulationComplete;
  const simulationStepsPerBatch =
    simulationSpeed * SIMULATION_STEPS_PER_SPEED_UNIT;
  const pixelsToRender = renderedPixels;
  const moveEditorTargetPlayer =
    players.find((player) => player.id === moveEditorModalPlayerId) ?? null;
  const moveEditorParse = useMemo(
    () => parseBulkMoveInput(moveEditorInput),
    [moveEditorInput],
  );
  const moveEditorMoves = useMemo(
    () =>
      moveEditorTargetPlayer
        ? parseDraftMoveSet(moveEditorTargetPlayer.moveSet)
        : [],
    [moveEditorTargetPlayer],
  );
  const moveEditorGridCoordinates = useMemo(
    () => getGridCoordinates(moveEditorGridDimension),
    [moveEditorGridDimension],
  );
  const moveEditorGridSplit = useMemo(
    () => splitMovesByGridBounds(moveEditorMoves, moveEditorGridDimension),
    [moveEditorGridDimension, moveEditorMoves],
  );
  const moveEditorInBoundsMoveKeys = useMemo(
    () => new Set(moveEditorGridSplit.inBounds.map(moveKey)),
    [moveEditorGridSplit.inBounds],
  );
  const moveEditorMovesToAdd = useMemo(() => {
    const existingMoveKeys = new Set(moveEditorMoves.map(moveKey));
    return moveEditorParse.moves.filter(
      (move) => !existingMoveKeys.has(moveKey(move)),
    );
  }, [moveEditorMoves, moveEditorParse.moves]);
  const builtinSimulationPresetOptions = useMemo(
    () => buildSimulationPresetOptions(BUILTIN_SIMULATION_PRESETS, "builtin"),
    [],
  );
  const customSimulationPresetOptions = useMemo(
    () => buildSimulationPresetOptions(customSimulationPresets, "custom"),
    [customSimulationPresets],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const originX = renderedCanvasSize / 2;
    const originY = renderedCanvasSize / 2;

    const drawPixel = (pixel: Pixel) => {
      const drawX = Math.round(
        originX + pixel.position.x * renderedCellSize - renderedCellSize / 2,
      );
      const drawY = Math.round(
        originY - pixel.position.y * renderedCellSize - renderedCellSize / 2,
      );
      context.fillStyle = pixel.color;
      context.fillRect(drawX, drawY, renderedCellSize, renderedCellSize);

      if (!shouldRenderSpiralNumbers) {
        return;
      }
      context.font = `${renderedSpiralNumberFontSize}px sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = getContrastTextColor(pixel.color);
      context.fillText(
        String(pixel.spiralIndex),
        drawX + renderedCellSize / 2,
        drawY + renderedCellSize / 2,
      );
    };

    const previousDrawState = previousDrawStateRef.current;
    const needsFullRerender =
      !previousDrawState ||
      previousDrawState.canvasSize !== renderedCanvasSize ||
      previousDrawState.cellSize !== renderedCellSize ||
      previousDrawState.spiralSize !== renderedSpiralSize ||
      previousDrawState.shouldRenderSpiralNumbers !==
        shouldRenderSpiralNumbers ||
      pixelsToRender.length < previousDrawState.pixelCount;

    if (needsFullRerender) {
      context.clearRect(0, 0, renderedCanvasSize, renderedCanvasSize);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, renderedCanvasSize, renderedCanvasSize);

      for (const pixel of pixelsToRender) {
        const drawX = Math.round(
          originX + pixel.position.x * renderedCellSize - renderedCellSize / 2,
        );
        const drawY = Math.round(
          originY - pixel.position.y * renderedCellSize - renderedCellSize / 2,
        );
        context.fillStyle = pixel.color;
        context.fillRect(drawX, drawY, renderedCellSize, renderedCellSize);
      }

      if (shouldRenderSpiralNumbers) {
        const pixelColorsByPosition = new Map<string, string>();
        for (const pixel of pixelsToRender) {
          pixelColorsByPosition.set(
            `${pixel.position.x},${pixel.position.y}`,
            pixel.color,
          );
        }

        context.font = `${renderedSpiralNumberFontSize}px sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";

        for (let n = 0; n <= renderedSpiralSize; n += 1) {
          const grid = spiralToGrid(n);
          const drawX = Math.round(
            originX + grid.x * renderedCellSize - renderedCellSize / 2,
          );
          const drawY = Math.round(
            originY - grid.y * renderedCellSize - renderedCellSize / 2,
          );
          const backgroundColor =
            pixelColorsByPosition.get(`${grid.x},${grid.y}`) ?? "#ffffff";
          context.fillStyle = getContrastTextColor(backgroundColor);
          context.fillText(
            String(n),
            drawX + renderedCellSize / 2,
            drawY + renderedCellSize / 2,
          );
        }
      }
    } else {
      const newPixels = pixelsToRender.slice(previousDrawState.pixelCount);
      for (const pixel of newPixels) {
        drawPixel(pixel);
      }
    }

    previousDrawStateRef.current = {
      canvasSize: renderedCanvasSize,
      cellSize: renderedCellSize,
      spiralSize: renderedSpiralSize,
      shouldRenderSpiralNumbers,
      pixelCount: pixelsToRender.length,
    };
  }, [
    hasUnrenderedConfigChanges,
    shouldRenderSpiralNumbers,
    pixelsToRender,
    renderedCanvasSize,
    renderedCellSize,
    renderedSpiralSize,
    renderedSpiralNumberFontSize,
  ]);

  useEffect(() => {
    isSimulationPausedRef.current = isSimulationPaused;
  }, [isSimulationPaused]);

  useEffect(() => {
    simulationStepsPerBatchRef.current = simulationStepsPerBatch;
  }, [simulationStepsPerBatch]);

  useEffect(
    () => () => {
      if (simulationLoopTimeoutRef.current !== null) {
        window.clearTimeout(simulationLoopTimeoutRef.current);
        simulationLoopTimeoutRef.current = null;
      }
    },
    [],
  );

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

  function validateSimulationInputs() {
    if (players.length === 0) {
      throw new Error("Add at least one player.");
    }
    if (!Number.isInteger(layers) || layers < 0) {
      throw new Error("Layers must be a non-negative integer.");
    }
    if (!Number.isInteger(canvasSize) || canvasSize <= 0) {
      throw new Error("Canvas size must be a positive integer.");
    }
  }

  function syncRenderedConfig() {
    setRenderedCanvasSize(canvasSize);
    setRenderedSpiralSize(spiralSize);
    setRenderedCellSize(cellSize);
    setRenderedRenderSpiralNumbers(renderSpiralNumbers);
    setRenderedForceSpiralNumberRenderAnyway(forceSpiralNumberRenderAnyway);
    setRenderedConfigSignature(currentConfigSignature);
  }

  function setRenderSpiralOptions(
    nextRenderSpiralNumbers: boolean,
    nextForceRenderAnyway: boolean,
  ) {
    setRenderSpiralNumbers(nextRenderSpiralNumbers);
    setForceSpiralNumberRenderAnyway(nextForceRenderAnyway);
  }

  function clearScheduledSimulationLoop() {
    if (simulationLoopTimeoutRef.current !== null) {
      window.clearTimeout(simulationLoopTimeoutRef.current);
      simulationLoopTimeoutRef.current = null;
    }
  }

  function runSimulationSteps(
    simulation: Simulation,
    stepCount: number,
  ): { newPixels: Pixel[]; completed: boolean } {
    const newPixels: Pixel[] = [];
    let completed = false;
    for (let i = 0; i < stepCount; i += 1) {
      completed = stepSimulation(simulation);
      if (completed) {
        break;
      }
      const latestPiece =
        simulation._currentPieces[simulation._currentPieces.length - 1];
      newPixels.push({
        color: simulation.players[latestPiece.playerId].color,
        position: spiralToGrid(latestPiece.position),
        spiralIndex: latestPiece.position,
      });
    }
    return { newPixels, completed };
  }

  function applySimulationProgress(progress: {
    newPixels: Pixel[];
    completed: boolean;
  }) {
    if (progress.newPixels.length > 0) {
      setRenderedPixels((prev) => [...prev, ...progress.newPixels]);
      setTotalStepsTaken((prev) => prev + progress.newPixels.length);
    }

    if (progress.completed) {
      clearScheduledSimulationLoop();
      setIsSimulationComplete(true);
      setIsSimulationPaused(true);
      isSimulationPausedRef.current = true;
    }
  }

  function scheduleSimulationLoop(runId: number) {
    clearScheduledSimulationLoop();
    simulationLoopTimeoutRef.current = window.setTimeout(() => {
      const activeRun = simulationRunRef.current;
      if (
        !activeRun ||
        activeRun.id !== runId ||
        isSimulationPausedRef.current
      ) {
        return;
      }

      const progress = runSimulationSteps(
        activeRun.simulation,
        simulationStepsPerBatchRef.current,
      );
      if (!simulationRunRef.current || simulationRunRef.current.id !== runId) {
        return;
      }

      applySimulationProgress(progress);
      if (!progress.completed) {
        scheduleSimulationLoop(runId);
      }
    }, 0);
  }

  function startSimulation() {
    try {
      validateSimulationInputs();
      const simulationPlayers = buildSimulationPlayers();
      const runId = simulationRunIdRef.current + 1;
      simulationRunIdRef.current = runId;
      simulationRunRef.current = {
        id: runId,
        simulation: createSimulation(spiralSize, simulationPlayers),
        spiralSize,
        players: simulationPlayers,
      };

      clearScheduledSimulationLoop();
      setIsSimulationStarted(true);
      setIsSimulationPaused(false);
      isSimulationPausedRef.current = false;
      setIsSimulationComplete(false);
      setSimulationConfigSignature(currentSimulationConfigSignature);
      setRenderedPixels([]);
      setTotalStepsTaken(0);
      syncRenderedConfig();
      setError(null);
      scheduleSimulationLoop(runId);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unknown error.";
      setError(message);
    }
  }

  function toggleSimulationPause() {
    const activeRun = simulationRunRef.current;
    if (!activeRun || !isSimulationStarted || isSimulationComplete) {
      return;
    }

    if (isSimulationPaused) {
      setIsSimulationPaused(false);
      isSimulationPausedRef.current = false;
      scheduleSimulationLoop(activeRun.id);
      return;
    }

    setIsSimulationPaused(true);
    isSimulationPausedRef.current = true;
    clearScheduledSimulationLoop();
  }

  function resetSimulation() {
    const activeRun = simulationRunRef.current;
    if (!activeRun) {
      return;
    }

    const runId = simulationRunIdRef.current + 1;
    simulationRunIdRef.current = runId;
    simulationRunRef.current = {
      id: runId,
      simulation: createSimulation(activeRun.spiralSize, activeRun.players),
      spiralSize: activeRun.spiralSize,
      players: activeRun.players,
    };

    clearScheduledSimulationLoop();
    setIsSimulationStarted(true);
    setIsSimulationPaused(true);
    isSimulationPausedRef.current = true;
    setIsSimulationComplete(false);
    setRenderedPixels([]);
    setTotalStepsTaken(0);
    setError(null);
  }

  function stepSimulationForward(stepCount: number) {
    const activeRun = simulationRunRef.current;
    if (!activeRun || !isStepControlsEnabled) {
      return;
    }

    const progress = runSimulationSteps(activeRun.simulation, stepCount);
    applySimulationProgress(progress);
  }

  function setPlayerMoveSet(playerId: string, moves: MoveCoordinates[]) {
    updatePlayer(playerId, (draft) => ({
      ...draft,
      moveSet: toDraftMoveSet(moves),
    }));
  }

  function removePlayerMove(playerId: string, moveToRemove: MoveCoordinates) {
    updatePlayer(playerId, (draft) => {
      const keyToRemove = moveKey(moveToRemove);
      const nextMoves = parseDraftMoveSet(draft.moveSet).filter(
        (move) => moveKey(move) !== keyToRemove,
      );
      return {
        ...draft,
        moveSet: toDraftMoveSet(nextMoves),
      };
    });
  }

  function clearPlayerMoves(playerId: string) {
    setPlayerMoveSet(playerId, []);
  }

  function openMoveEditorModal(player: EditablePlayer) {
    setMoveEditorModalPlayerId(player.id);
    setMoveEditorGridDimension(DEFAULT_MOVE_EDITOR_GRID_DIMENSION);
    setMoveEditorInput("");
  }

  function closeMoveEditorModal() {
    setMoveEditorModalPlayerId(null);
    setMoveEditorInput("");
    setMoveEditorGridDimension(DEFAULT_MOVE_EDITOR_GRID_DIMENSION);
  }

  function handleMoveEditorInputChange(nextInput: string) {
    setMoveEditorInput(nextInput);
  }

  function addMovesFromEditorInput() {
    if (!moveEditorTargetPlayer || moveEditorParse.moves.length === 0) {
      return;
    }
    setPlayerMoveSet(moveEditorTargetPlayer.id, [
      ...moveEditorMoves,
      ...moveEditorParse.moves,
    ]);
    setMoveEditorInput("");
  }

  function clearMoveEditorMoves() {
    if (!moveEditorTargetPlayer) {
      return;
    }
    clearPlayerMoves(moveEditorTargetPlayer.id);
  }

  function toggleMoveInEditorGrid(move: MoveCoordinates) {
    if (!moveEditorTargetPlayer) {
      return;
    }
    const keyToToggle = moveKey(move);
    const currentMoves = parseDraftMoveSet(moveEditorTargetPlayer.moveSet);
    const hasMove = currentMoves.some(
      (candidate) => moveKey(candidate) === keyToToggle,
    );
    const nextMoves = hasMove
      ? currentMoves.filter((candidate) => moveKey(candidate) !== keyToToggle)
      : [...currentMoves, move];

    setPlayerMoveSet(moveEditorTargetPlayer.id, nextMoves);
  }

  function applySimulationSerialization(
    serialization: SimulationSerialization,
  ) {
    const nextLayers = serialization.layers;
    const nextPlayers = createEditablePlayersFromSerialization(
      serialization.players,
    );
    setLayers(nextLayers);
    setCanvasSize(serialization.canvasSize);
    setPlayers(nextPlayers);
    if (
      renderSpiralNumbers &&
      isSpiralNumberRenderUnsafeForConfig(nextLayers, serialization.canvasSize)
    ) {
      setRenderSpiralOptions(false, false);
      setShowSpiralNumberRenderWarning(true);
    }
    setError(null);
  }

  function openExportModal() {
    try {
      validateSimulationInputs();
      const simulationPlayers = buildSimulationPlayers();
      const serialization = toSimulationSerialization(
        layers,
        canvasSize,
        simulationPlayers,
      );
      setExportedConfigJson(JSON.stringify(serialization, null, 2));
      setCopyStatus(null);
      setIsExportModalOpen(true);
      setError(null);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unknown error.";
      setError(message);
    }
  }

  async function copyExportJsonToClipboard() {
    try {
      await navigator.clipboard.writeText(exportedConfigJson);
      setCopyStatus("Copied to clipboard.");
    } catch {
      setCopyStatus("Clipboard copy failed.");
    }
  }

  function importSimulationConfiguration() {
    try {
      const parsed = parseSimulationSerialization(JSON.parse(importConfigJson));
      applySimulationSerialization(parsed);
      setIsImportModalOpen(false);
      setImportConfigJson("");
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unknown error.";
      setError(message);
    }
  }

  function saveSimulationConfiguration() {
    const trimmedName = savePresetName.trim();
    if (trimmedName.length === 0) {
      setError("Preset name cannot be empty.");
      return;
    }

    try {
      validateSimulationInputs();
      const simulationPlayers = buildSimulationPlayers();
      const serialization = toSimulationSerialization(
        layers,
        canvasSize,
        simulationPlayers,
      );
      setCustomSimulationPresets((previous) => ({
        ...previous,
        [trimmedName]: serialization,
      }));
      setIsSavePresetModalOpen(false);
      setSavePresetName("");
      setError(null);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unknown error.";
      setError(message);
    }
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
            <h2 className="mb-0 font-bold">Configuration</h2>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={openExportModal}
                className="rounded border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100"
              >
                Export
              </button>
              <button
                type="button"
                onClick={() => {
                  setImportConfigJson("");
                  setIsImportModalOpen(true);
                }}
                className="rounded border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100"
              >
                Import
              </button>
              <button
                type="button"
                onClick={() => {
                  setSavePresetName("");
                  setIsSavePresetModalOpen(true);
                }}
                className="rounded border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100"
              >
                Save
              </button>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Preset</span>
              <select
                value=""
                onChange={(event) => {
                  const selectedId = event.target.value;
                  if (!selectedId) {
                    return;
                  }
                  const preset = [
                    ...builtinSimulationPresetOptions,
                    ...customSimulationPresetOptions,
                  ].find((candidate) => candidate.id === selectedId);
                  if (!preset) {
                    setError("Unknown preset selected.");
                    return;
                  }
                  try {
                    applySimulationSerialization(preset.serialization);
                  } catch (caught) {
                    const message =
                      caught instanceof Error
                        ? caught.message
                        : "Unknown error.";
                    setError(message);
                  }
                }}
                disabled={
                  builtinSimulationPresetOptions.length === 0 &&
                  customSimulationPresetOptions.length === 0
                }
                className="w-64 rounded border border-zinc-300 px-2 py-1 text-sm disabled:bg-zinc-100"
              >
                <option value="" disabled>
                  Use preset
                </option>
                {builtinSimulationPresetOptions.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {`${preset.name} (k=${preset.layers}, ${preset.canvasSize}px)`}
                  </option>
                ))}
                {customSimulationPresetOptions.length > 0 ? (
                  <option value="" disabled>
                    CUSTOM
                  </option>
                ) : null}
                {customSimulationPresetOptions.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {`${preset.name} (k=${preset.layers}, ${preset.canvasSize}px)`}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-2 rounded border border-zinc-200 p-3">
            <h2 className="font-bold mb-0">Spiral settings</h2>
            <div className="space-y-1">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>Layers (k)</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={layers}
                  onChange={(event) => {
                    const nextLayers = Math.max(
                      0,
                      parseIntegerInput(event.target.value, 0),
                    );
                    setLayers(nextLayers);
                    if (
                      renderSpiralNumbers &&
                      isSpiralNumberRenderUnsafeForConfig(
                        nextLayers,
                        canvasSize,
                      )
                    ) {
                      setRenderSpiralOptions(false, false);
                      setShowSpiralNumberRenderWarning(true);
                    }
                  }}
                  className="w-24 rounded border border-zinc-300 px-2 py-1"
                />
              </label>
              <p className="text-sm text-zinc-600">
                Number of cells:{" "}
                <span className="font-mono">{spiralSize.toLocaleString()}</span>
              </p>
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Render spiral numbers</span>
              <input
                type="checkbox"
                checked={renderSpiralNumbers}
                onChange={(event) => {
                  if (!event.target.checked) {
                    setRenderSpiralOptions(false, false);
                    setShowSpiralNumberRenderWarning(false);
                    return;
                  }
                  if (
                    isSpiralNumberRenderUnsafe &&
                    !forceSpiralNumberRenderAnyway
                  ) {
                    setRenderSpiralOptions(false, false);
                    setShowSpiralNumberRenderWarning(true);
                    return;
                  }
                  setRenderSpiralOptions(true, forceSpiralNumberRenderAnyway);
                  setShowSpiralNumberRenderWarning(false);
                }}
              />
            </label>
            {shouldShowSpiralNumberRenderWarning ? (
              <p className="text-sm text-amber-700">
                Spiral number rendering is blocked: text may not be legible
                and/or rendering the text may freeze the browser. Consider
                decreasing the spiral size or{" "}
                <button
                  type="button"
                  className="underline decoration-dotted underline-offset-2 hover:text-amber-800"
                  onClick={() => {
                    setRenderSpiralOptions(true, true);
                    setShowSpiralNumberRenderWarning(false);
                  }}
                >
                  click here to render anyway.
                </button>
              </p>
            ) : null}
            {isSimulationTooBig ? (
              <p className="text-sm text-amber-700">
                The spiral size is quite big; this might take a while!
              </p>
            ) : null}
          </div>

          <div className="space-y-2 rounded border border-zinc-200 p-3">
            <h2 className="font-bold mb-0">Canvas settings</h2>
            <div className="grid grid-cols-1 gap-2">
              <div className="space-y-1">
                <label className="flex items-center justify-between gap-3 text-sm">
                  <span>Canvas size</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={canvasSize}
                    onChange={(event) => {
                      const nextCanvasSize = Math.max(
                        1,
                        parseIntegerInput(event.target.value, 1),
                      );
                      setCanvasSize(nextCanvasSize);
                      if (
                        renderSpiralNumbers &&
                        isSpiralNumberRenderUnsafeForConfig(
                          layers,
                          nextCanvasSize,
                        )
                      ) {
                        setRenderSpiralOptions(false, false);
                        setShowSpiralNumberRenderWarning(true);
                      }
                    }}
                    className="w-24 rounded border border-zinc-300 px-2 py-1"
                  />
                </label>
                <p className="text-sm text-zinc-600">
                  Computed cell size:{" "}
                  <span className="font-mono">{cellSize}px</span>
                </p>
              </div>
              {isCanvasTooSmall ? (
                <p className="text-sm text-amber-700">
                  The canvas size may be too small to render the entire spiral.
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2 rounded border border-zinc-200 p-3">
            <h2 className="font-bold mb-0">Player settings</h2>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm">Add players</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setPlayers((prev) => [...prev, createPlayerDraft(prev)])
                  }
                  className="rounded border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100"
                >
                  Blank
                </button>
                <span className="text-xs font-medium text-zinc-500">OR</span>
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
                    Choose preset
                  </option>
                  {PLAYER_PRESETS.map((preset) => (
                    <option key={preset.name} value={preset.name}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                setPlayers((prev) =>
                  prev.map((player) => ({
                    ...player,
                    avoidPlayerIds: prev
                      .filter((candidate) => candidate.id !== player.id)
                      .map((candidate) => candidate.id),
                  })),
                )
              }
              className="rounded border border-zinc-300 px-2 py-1 text-sm hover:bg-zinc-100"
            >
              Make everyone enemies of everyone else
            </button>
            <div className="space-y-3">
              {players.map((player, index) => {
                const enemyOptions = players;
                const hasAvailableNonSelfEnemy = enemyOptions.some(
                  (candidate) =>
                    candidate.id !== player.id &&
                    !player.avoidPlayerIds.includes(candidate.id),
                );
                const canAddSelfEnemy = !player.avoidPlayerIds.includes(player.id);
                const canAddAnyEnemy = hasAvailableNonSelfEnemy || canAddSelfEnemy;
                const isFolded = player.isFolded;
                const trimmedPlayerName = player.name.trim();
                const displayPlayerName =
                  trimmedPlayerName.length > 0
                    ? trimmedPlayerName
                    : "Unnamed player";
                const avoidedPlayerNames = player.avoidPlayerIds
                  .map(
                    (enemyId) =>
                      players
                        .find((candidate) => candidate.id === enemyId)
                        ?.name.trim() ?? "",
                  )
                  .map((name) => (name.length > 0 ? name : "Unnamed player"))
                  .join(", ");
                const playerMoves = parseDraftMoveSet(player.moveSet);
                const displayGridDimension =
                  getSmallestGridDimensionForMoves(playerMoves);
                const displayGridCoordinates =
                  getGridCoordinates(displayGridDimension);
                const displayGridMoveKeys = new Set(
                  splitMovesByGridBounds(
                    playerMoves,
                    displayGridDimension,
                  ).inBounds.map(moveKey),
                );
                const overflowMoves = splitMovesByGridBounds(
                  playerMoves,
                  MAX_MOVE_GRID_DIMENSION,
                ).outOfBounds;

                return (
                  <article
                    key={player.id}
                    className="group relative rounded border p-2"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        updatePlayer(player.id, (draft) => ({
                          ...draft,
                          isFolded: !draft.isFolded,
                        }))
                      }
                      className="absolute inset-x-0 top-0 z-10 h-6 cursor-pointer rounded-t"
                      aria-label={
                        isFolded
                          ? `Unfold player ${index + 1} card`
                          : `Fold player ${index + 1} card`
                      }
                      title={isFolded ? "Unfold card" : "Fold card"}
                    >
                      <span className="absolute left-1 top-0.5 text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <svg
                          viewBox="0 0 16 16"
                          className="h-3 w-3"
                          aria-hidden="true"
                        >
                          <path
                            d="M3.5 6.5l4.5 4.5 4.5-4.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            fill="none"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                    </button>
                    {isFolded ? (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">
                            <span className="text-xs text-zinc-600">
                              {index + 1}.
                            </span>
                            <span
                              className="h-3 w-3 shrink-0 rounded-sm border border-zinc-300"
                              style={{ backgroundColor: player.color }}
                              aria-hidden="true"
                            />
                            <span className="truncate text-sm font-medium">
                              {displayPlayerName}
                            </span>
                          </div>
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
                              className="rounded border border-zinc-300 z-11 px-2 py-1 text-xs hover:bg-zinc-100"
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
                              className="rounded border border-zinc-300 z-11 px-2 py-1 text-xs hover:bg-zinc-100"
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
                              className="rounded border border-red-300 z-11 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <p className="text-xs text-zinc-500">
                          # moves:{" "}
                          {player.moveSet.length > 0
                            ? player.moveSet.length
                            : "(none)"}
                        </p>
                        <p className="text-xs text-zinc-500">
                          Avoids:{" "}
                          {avoidedPlayerNames.length > 0
                            ? avoidedPlayerNames
                            : "(none)"}
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <h3 className="font-medium">
                            <span className="text-xs">{index + 1}.</span>{" "}
                            {player.name}
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
                              className="rounded border border-zinc-300 z-11 px-2 py-1 text-xs hover:bg-zinc-100"
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
                              className="rounded border border-zinc-300 z-11 px-2 py-1 text-xs hover:bg-zinc-100"
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
                              className="rounded border border-red-300 z-11 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
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

                        <div className="space-y-2">
                          <div className="flex items-center">
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
                          </div>
                          <div className="flex flex-wrap items-start gap-3">
                            <button
                              type="button"
                              onClick={() => openMoveEditorModal(player)}
                              className="h-44 w-44 shrink-0 cursor-pointer rounded border-2 border-zinc-300 bg-white p-1 text-left shadow-sm transition hover:border-zinc-500 hover:bg-zinc-50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
                              aria-label={`Edit moveset for ${displayPlayerName}`}
                              title="Edit moveset"
                            >
                              <div
                                className="grid h-full w-full"
                                style={{
                                  gridTemplateColumns: `repeat(${displayGridDimension}, minmax(0, 1fr))`,
                                  gridTemplateRows: `repeat(${displayGridDimension}, minmax(0, 1fr))`,
                                }}
                              >
                                {displayGridCoordinates.map((coordinate) => {
                                  const isCenter =
                                    coordinate.x === 0 && coordinate.y === 0;
                                  const isReachable = displayGridMoveKeys.has(
                                    moveKey(coordinate),
                                  );
                                  return (
                                    <div
                                      key={`${player.id}-${coordinate.x},${coordinate.y}`}
                                      className={`border border-zinc-300/70 ${
                                        isCenter ? "rounded-md" : ""
                                      }`}
                                      style={{
                                        backgroundColor: isCenter
                                          ? "#888888"
                                          : isReachable
                                            ? player.color
                                            : "#ffffff",
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            </button>
                            <div className="min-w-[11rem] space-y-1 text-xs text-zinc-600">
                              <p># moves: {playerMoves.length}</p>
                              {overflowMoves.length > 0 ? (
                                <p>
                                  There{" "}
                                  {overflowMoves.length === 1 ? "is" : "are"}{" "}
                                  {overflowMoves.length} move
                                  {overflowMoves.length === 1 ? "" : "s"} not
                                  visible on the current grid:{" "}
                                  <span className="font-mono">
                                    {overflowMoves
                                      .map((move) => `(${move.x}, ${move.y})`)
                                      .join(", ")}
                                  </span>
                                </p>
                              ) : null}
                            </div>
                          </div>
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
                                    const availableNonSelfEnemy =
                                      enemyOptions.find(
                                        (candidate) =>
                                          candidate.id !== player.id &&
                                          !draft.avoidPlayerIds.includes(
                                            candidate.id,
                                          ),
                                      );
                                    const availableSelfEnemy = enemyOptions.find(
                                      (candidate) =>
                                        candidate.id === player.id &&
                                        !draft.avoidPlayerIds.includes(
                                          candidate.id,
                                        ),
                                    );
                                    const availableEnemy =
                                      availableNonSelfEnemy ??
                                      availableSelfEnemy;
                                    if (!availableEnemy) {
                                      return draft;
                                    }
                                    return {
                                      ...draft,
                                      avoidPlayerIds: [
                                        ...draft.avoidPlayerIds,
                                        availableEnemy.id,
                                      ],
                                    };
                                  })
                                }
                                disabled={!canAddAnyEnemy}
                                className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
                              >
                                Add enemy
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  updatePlayer(player.id, (draft) => {
                                    const availableEnemies =
                                      enemyOptions.filter(
                                        (candidate) =>
                                          !draft.avoidPlayerIds.includes(
                                            candidate.id,
                                          ) && candidate.id !== player.id,
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
                                Add all others
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
                                        draft.avoidPlayerIds.includes(
                                          nextEnemyId,
                                        )
                                      ) {
                                        return draft;
                                      }
                                      return {
                                        ...draft,
                                        avoidPlayerIds:
                                          draft.avoidPlayerIds.map(
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
                                      {`${option.name.trim()}${option.id === player.id ? " (self)" : ""}` ||
                                        "(unnamed player)"}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  type="button"
                                  onClick={() =>
                                    updatePlayer(player.id, (draft) => ({
                                      ...draft,
                                      avoidPlayerIds:
                                        draft.avoidPlayerIds.filter(
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
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={startSimulation}
                className="rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Start simulation
              </button>
              <span className="text-sm text-zinc-600">
                Status:{" "}
                {isSimulationComplete
                  ? "Complete"
                  : isSimulationRunning
                    ? "Running"
                    : isSimulationPaused
                      ? "Paused"
                      : "Idle"}
              </span>
            </div>
            <label className="flex min-w-[20rem] flex-col gap-1 text-sm">
              <span className="flex items-center gap-1">
                Simulation Speed
                <span
                  className="cursor-help text-xs leading-none underline decoration-dotted underline-offset-2"
                  title="Higher speed values can result in faster simulations overall but make the rendering slower."
                  aria-label="Simulation speed help"
                >
                  ?
                </span>
              </span>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={MIN_SIMULATION_SPEED}
                  max={MAX_SIMULATION_SPEED}
                  step={1}
                  value={simulationSpeed}
                  onChange={(event) => {
                    const nextSpeed = Math.max(
                      MIN_SIMULATION_SPEED,
                      Math.min(
                        MAX_SIMULATION_SPEED,
                        parseIntegerInput(
                          event.target.value,
                          DEFAULT_SIMULATION_SPEED,
                        ),
                      ),
                    );
                    setSimulationSpeed(nextSpeed);
                  }}
                  className="w-56"
                />
                <span className="min-w-[11rem] text-right font-mono text-xs text-zinc-600">
                  {simulationStepsPerBatch.toLocaleString()} steps/batch
                </span>
              </div>
            </label>
          </div>
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
          {isSimulationStarted ? (
            <div className="mt-4 space-y-4 border-t border-zinc-200 pt-4">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={toggleSimulationPause}
                    disabled={isSimulationComplete}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
                  >
                    {isSimulationPaused ? "Play" : "Pause"}
                  </button>
                  <button
                    type="button"
                    onClick={resetSimulation}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
                  >
                    Reset
                  </button>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <button
                    type="button"
                    onClick={() => stepSimulationForward(1)}
                    disabled={!isStepControlsEnabled}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
                  >
                    Step +1
                  </button>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={simulationStepCount}
                    onChange={(event) =>
                      setSimulationStepCount(event.target.value)
                    }
                    disabled={!isStepControlsEnabled}
                    className="w-24 rounded border border-zinc-300 px-2 py-1 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const parsedStepCount = Math.max(
                        1,
                        parseIntegerInput(
                          simulationStepCount,
                          Number.parseInt(DEFAULT_SIMULATION_STEP_COUNT, 10),
                        ),
                      );
                      setSimulationStepCount(String(parsedStepCount));
                      stepSimulationForward(parsedStepCount);
                    }}
                    disabled={!isStepControlsEnabled}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-400"
                  >
                    Step +N
                  </button>
                </div>
              </div>
              <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2">
                <p className="text-xs uppercase tracking-wide text-zinc-500">
                  Total steps taken
                </p>
                <p className="font-mono text-lg">
                  {totalStepsTaken.toLocaleString()}
                </p>
              </div>
            </div>
          ) : null}
          {isSimulationStarted &&
          isSimulationComplete &&
          !hasSimulationConfigChanges ? (
            <p className="mt-4 text-sm text-amber-700">
              Simulation complete. Press Start simulation for a new run, or
              Reset to replay this run from the beginning.
            </p>
          ) : null}
          {isSimulationStarted && hasSimulationConfigChanges ? (
            <p className="mt-4 text-sm text-amber-700">
              Configuration changed while this simulation is active. The red
              canvas outline indicates the output reflects an earlier
              configuration.
            </p>
          ) : null}
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

      {moveEditorTargetPlayer ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={closeMoveEditorModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="move-editor-title"
            className="w-full max-w-5xl rounded-lg border border-zinc-300 bg-white p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h2 id="move-editor-title" className="text-lg font-semibold">
                  Create moveset
                </h2>
                <p className="text-sm text-zinc-500">
                  Target:{" "}
                  {moveEditorTargetPlayer.name.trim() || "Unnamed player"}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <section className="space-y-3 rounded border border-zinc-200 bg-zinc-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    Draw where the piece can move...
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setMoveEditorGridDimension((prev) =>
                          Math.max(MIN_MOVE_GRID_DIMENSION, prev - 2),
                        )
                      }
                      disabled={
                        moveEditorGridDimension <= MIN_MOVE_GRID_DIMENSION
                      }
                      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
                    >
                      -
                    </button>
                    <span className="font-mono text-xs">
                      {moveEditorGridDimension}x{moveEditorGridDimension}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setMoveEditorGridDimension((prev) =>
                          Math.min(MAX_MOVE_GRID_DIMENSION, prev + 2),
                        )
                      }
                      disabled={
                        moveEditorGridDimension >= MAX_MOVE_GRID_DIMENSION
                      }
                      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="mx-auto h-80 w-80 max-w-full rounded border border-zinc-300 bg-white p-1">
                  <div
                    className="grid h-full w-full"
                    style={{
                      gridTemplateColumns: `repeat(${moveEditorGridDimension}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${moveEditorGridDimension}, minmax(0, 1fr))`,
                    }}
                  >
                    {moveEditorGridCoordinates.map((coordinate) => {
                      const isCenter = coordinate.x === 0 && coordinate.y === 0;
                      const isReachable = moveEditorInBoundsMoveKeys.has(
                        moveKey(coordinate),
                      );
                      return (
                        <button
                          key={`move-editor-cell-${coordinate.x},${coordinate.y}`}
                          type="button"
                          disabled={isCenter}
                          onClick={() => toggleMoveInEditorGrid(coordinate)}
                          className={`border border-zinc-300/70 ${
                            isCenter
                              ? "cursor-default rounded-xl"
                              : "cursor-pointer hover:bg-zinc-100"
                          }`}
                          style={{
                            backgroundColor: isCenter
                              ? "#888888"
                              : isReachable
                                ? moveEditorTargetPlayer.color
                                : "#ffffff",
                          }}
                          aria-label={
                            isCenter
                              ? "Piece position"
                              : `Toggle move (${coordinate.x}, ${coordinate.y})`
                          }
                        />
                      );
                    })}
                  </div>
                </div>
                {moveEditorGridSplit.outOfBounds.length > 0 ? (
                  <div className="space-y-1 text-xs text-zinc-600">
                    <p>
                      There{" "}
                      {moveEditorGridSplit.outOfBounds.length === 1
                        ? "is"
                        : "are"}{" "}
                      {moveEditorGridSplit.outOfBounds.length} move
                      {moveEditorGridSplit.outOfBounds.length === 1
                        ? ""
                        : "s"}{" "}
                      not visible on the current grid
                    </p>
                    <div className="h-24 overflow-auto rounded border border-zinc-200 p-1.5">
                      <div className="space-y-1">
                        {moveEditorGridSplit.outOfBounds.map((move) => (
                          <div
                            key={`move-editor-overflow-${moveKey(move)}`}
                            className="flex items-center gap-1 font-mono"
                          >
                            <button
                              type="button"
                              onClick={() =>
                                moveEditorTargetPlayer &&
                                removePlayerMove(
                                  moveEditorTargetPlayer.id,
                                  move,
                                )
                              }
                              className="grid h-4 w-4 place-items-center rounded text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
                              aria-label={`Delete move (${move.x}, ${move.y})`}
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
                            <span>
                              ({move.x}, {move.y})
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div className="flex justify-start">
                  <button
                    type="button"
                    onClick={clearMoveEditorMoves}
                    disabled={moveEditorMoves.length === 0}
                    className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-zinc-300 disabled:text-zinc-400"
                  >
                    Clear all
                  </button>
                </div>
              </section>

              <section className="space-y-3 rounded border border-zinc-200 bg-zinc-50 p-3">
                <h3 className="text-sm font-medium">...or type it in</h3>
                <p className="text-sm text-zinc-700">
                  Enter one move per line. Supported formats include{" "}
                  <span className="font-mono">(x, y)</span>,{" "}
                  <span className="font-mono">x y</span>,{" "}
                  <span className="font-mono">x, y</span>,{" "}
                  <span className="font-mono">[x, y]</span>. Prefix with{" "}
                  <span className="font-mono">@</span> to add all symmetries.
                  Click Add to apply parsed moves to the moveset.
                </p>
                <div className="grid h-32 w-full">
                  <textarea
                    value={moveEditorInput}
                    onChange={(event) =>
                      handleMoveEditorInputChange(event.target.value)
                    }
                    className="col-start-1 row-start-1 h-full w-full resize-none rounded border border-zinc-300 px-2 py-1 pb-12 pr-16 font-mono text-sm"
                    placeholder={"(1, 2)\n@ (2, 1)\n-3 4"}
                  />
                  <button
                    type="button"
                    onClick={addMovesFromEditorInput}
                    disabled={moveEditorParse.moves.length === 0}
                    className="col-start-1 row-start-1 z-10 mr-2 mb-2 place-self-end rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-400"
                  >
                    Add
                  </button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <h4 className="mb-1 text-sm font-medium">
                      Parsed moves ({moveEditorParse.moves.length})
                    </h4>
                    <div className="max-h-44 overflow-auto rounded border border-zinc-200 bg-white p-2 text-sm">
                      {moveEditorParse.moves.length === 0 ? (
                        <p className="text-zinc-500">No parsed moves.</p>
                      ) : (
                        <div className="font-mono">
                          {moveEditorParse.moves.map((move) => (
                            <div key={`move-editor-list-${moveKey(move)}`}>
                              ({move.x}, {move.y})
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-zinc-600">
                      New moves to add: {moveEditorMovesToAdd.length}
                    </p>
                  </div>
                  <div>
                    <h4 className="mb-1 text-sm font-medium">
                      Parse issues ({moveEditorParse.invalidLines.length})
                    </h4>
                    <div className="max-h-44 overflow-auto rounded border border-zinc-200 bg-white p-2 text-sm">
                      {moveEditorParse.invalidLines.length === 0 ? (
                        <p className="text-zinc-500">No parse issues.</p>
                      ) : (
                        <div className="space-y-1 text-red-700">
                          {moveEditorParse.invalidLines.map((invalid) => (
                            <div
                              key={`${invalid.lineNumber}-${invalid.content}`}
                            >
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
              </section>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={closeMoveEditorModal}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isExportModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={() => setIsExportModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-config-title"
            className="w-full max-w-2xl rounded-lg border border-zinc-300 bg-white p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3">
              <h2 id="export-config-title" className="text-lg font-semibold">
                Export configuration
              </h2>
            </div>
            <textarea
              readOnly
              value={exportedConfigJson}
              className="h-80 w-full rounded border border-zinc-300 px-2 py-1 font-mono text-sm"
            />
            <div className="mt-4 flex items-center justify-between gap-2">
              <p className="text-sm text-zinc-600">{copyStatus ?? ""}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={copyExportJsonToClipboard}
                  className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
                >
                  Copy to clipboard
                </button>
                <button
                  type="button"
                  onClick={() => setIsExportModalOpen(false)}
                  className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {isImportModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={() => setIsImportModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="import-config-title"
            className="w-full max-w-2xl rounded-lg border border-zinc-300 bg-white p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3">
              <h2 id="import-config-title" className="text-lg font-semibold">
                Import configuration
              </h2>
            </div>
            <textarea
              value={importConfigJson}
              onChange={(event) => setImportConfigJson(event.target.value)}
              className="h-80 w-full rounded border border-zinc-300 px-2 py-1 font-mono text-sm"
              placeholder='{"layers": 100, "canvasSize": 1000, "players": []}'
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsImportModalOpen(false)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={importSimulationConfiguration}
                className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {isSavePresetModalOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
          onClick={() => setIsSavePresetModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="save-config-title"
            className="w-full max-w-lg rounded-lg border border-zinc-300 bg-white p-4 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3">
              <h2 id="save-config-title" className="text-lg font-semibold">
                Save configuration
              </h2>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              Preset name
              <input
                type="text"
                value={savePresetName}
                onChange={(event) => setSavePresetName(event.target.value)}
                className="rounded border border-zinc-300 px-2 py-1"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setIsSavePresetModalOpen(false)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveSimulationConfiguration}
                className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-700"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
