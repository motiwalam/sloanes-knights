"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  createSimulation,
  getPixels,
  stepSimulation,
  spiralToGrid,
  type Player,
  type Simulation,
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
  const [animationMode, setAnimationMode] = useState(false);
  const [isAnimationStarted, setIsAnimationStarted] = useState(false);
  const [isAnimationComplete, setIsAnimationComplete] = useState(false);
  const [animationConfigSignature, setAnimationConfigSignature] = useState<
    string | null
  >(null);
  const [animationStepCount, setAnimationStepCount] = useState("10");
  const [bulkMoveModalPlayerId, setBulkMoveModalPlayerId] = useState<
    string | null
  >(null);
  const [bulkMoveInput, setBulkMoveInput] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationSimulationRef = useRef<Simulation | null>(null);
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
  const hasAnimationConfigChanges =
    hasUnrenderedConfigChanges ||
    (animationConfigSignature !== null &&
      animationConfigSignature !== currentSimulationConfigSignature);
  const shouldShowAnimationControls =
    animationMode &&
    isAnimationStarted &&
    !isAnimationComplete &&
    !hasAnimationConfigChanges;
  const pixelsToRender = useMemo(
    () => (hasUnrenderedConfigChanges ? [] : renderedPixels),
    [hasUnrenderedConfigChanges, renderedPixels],
  );
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

  function runSimulation() {
    try {
      validateSimulationInputs();
      const simulationPlayers = buildSimulationPlayers();
      const simulation = createSimulation(spiralSize, simulationPlayers);
      animationSimulationRef.current = null;
      setIsAnimationStarted(false);
      setIsAnimationComplete(false);
      setAnimationConfigSignature(null);
      setRenderedPixels(getPixels(simulation));
      syncRenderedConfig();
      setError(null);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unknown error.";
      setError(message);
    }
  }

  function startAnimationSimulation() {
    try {
      validateSimulationInputs();
      const simulationPlayers = buildSimulationPlayers();
      animationSimulationRef.current = createSimulation(
        spiralSize,
        simulationPlayers,
      );
      setIsAnimationStarted(true);
      setIsAnimationComplete(false);
      setAnimationConfigSignature(currentSimulationConfigSignature);
      setRenderedPixels([]);
      syncRenderedConfig();
      setError(null);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Unknown error.";
      setError(message);
    }
  }

  function stepAnimationSimulation(stepCount: number) {
    const simulation = animationSimulationRef.current;
    if (!simulation || isAnimationComplete || hasUnrenderedConfigChanges) {
      return;
    }

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

    if (newPixels.length > 0) {
      setRenderedPixels((prev) => [...prev, ...newPixels]);
    }

    if (completed) {
      setIsAnimationComplete(true);
    }
  }

  function runAnimationUntilCompletion() {
    const simulation = animationSimulationRef.current;
    if (!simulation || isAnimationComplete || hasUnrenderedConfigChanges) {
      return;
    }

    const newPixels: Pixel[] = [];
    while (true) {
      const completed = stepSimulation(simulation);
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

    if (newPixels.length > 0) {
      setRenderedPixels((prev) => [...prev, ...newPixels]);
    }
    setIsAnimationComplete(true);
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
            <h2 className="font-bold">Spiral settings</h2>
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
                      isSpiralNumberRenderUnsafeForConfig(nextLayers, canvasSize)
                    ) {
                      setRenderSpiralOptions(false, false);
                      setShowSpiralNumberRenderWarning(true);
                    }
                  }}
                  className="w-24 rounded border border-zinc-300 px-2 py-1"
                />
              </label>
              <p className="text-sm text-zinc-600">
                Spiral size: <span className="font-mono">{spiralSize}</span> = (2k
                + 1)^2 - 1
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
            <h2 className="font-bold">Canvas settings</h2>
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
            <h2 className="font-bold">Player settings</h2>
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
            <div className="space-y-3">
              {players.map((player, index) => {
                const enemyOptions = players;
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

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={animationMode ? startAnimationSimulation : runSimulation}
              className="rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
            >
              {animationMode ? "Start simulation" : "Run simulation"}
            </button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={animationMode}
                onChange={(event) => {
                  const nextAnimationMode = event.target.checked;
                  setAnimationMode(nextAnimationMode);
                  if (!nextAnimationMode) {
                    animationSimulationRef.current = null;
                    setIsAnimationStarted(false);
                    setIsAnimationComplete(false);
                    setAnimationConfigSignature(null);
                  }
                }}
              />
              Animation mode
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
          {shouldShowAnimationControls ? (
            <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:items-end">
                <div className="sm:justify-self-start">
                  <button
                    type="button"
                    onClick={() => stepAnimationSimulation(1)}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
                  >
                    Step +1
                  </button>
                </div>
                <div className="flex items-end justify-center gap-2">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={animationStepCount}
                    onChange={(event) =>
                      setAnimationStepCount(event.target.value)
                    }
                    className="w-24 rounded border border-zinc-300 px-2 py-1"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const parsedStepCount = Math.max(
                        1,
                        parseIntegerInput(animationStepCount, 10),
                      );
                      setAnimationStepCount(String(parsedStepCount));
                      stepAnimationSimulation(parsedStepCount);
                    }}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
                  >
                    Step +N
                  </button>
                </div>
                <div className="sm:justify-self-end">
                  <button
                    type="button"
                    onClick={runAnimationUntilCompletion}
                    className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100"
                  >
                    Run until completion
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          {animationMode && isAnimationStarted && isAnimationComplete ? (
            <p className="mt-4 text-sm text-amber-700">
              Simulation complete. Click Start simulation to initialize a new
              run.
            </p>
          ) : null}
          {animationMode &&
          isAnimationStarted &&
          !isAnimationComplete &&
          hasAnimationConfigChanges ? (
            <p className="mt-4 text-sm text-amber-700">
              Animation controls are hidden because configuration changed. Click
              Start simulation to reinitialize.
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
