import { MinSubset } from "./minsubset";

type Vec2d = {
  x: number;
  y: number;
};

function vectorAdd(a: Vec2d, b: Vec2d): Vec2d {
  return { x: a.x + b.x, y: a.y + b.y };
}

// these are the moves a piece can make, represented as offsets from the piece's
// current position
type MoveSet = Vec2d[];

type Player = {
  name: string;
  color: string;
  moveSet: MoveSet;
  // players whose pieces must be avoided
  avoidPlayers: string[];
};

type Simulation = {
  spiralSize: number;
  players: Player[];

  _currentPieces: { playerId: number; position: number }[];
  _currentPlayer: number;
  // maps player index to the indices of players that are avoiding it
  _avoidedMap: Record<number, number[]>;

  // maps player index to the set of available indices on the square spiral
  _availableSpace: Record<number, MinSubset>;
};

// initializes a simulation with the given size of square spiral and players
function createSimulation(N: number, players: Player[]): Simulation {
  const nameToIndex: Record<string, number> = Object.fromEntries(
    players.map((p, i) => [p.name, i]),
  );

  const avoidedMap: Record<number, number[]> = {};
  for (let i = 0; i < players.length; i++) {
    avoidedMap[i] = [];
  }
  for (let i = 0; i < players.length; i++) {
    for (const avoided of players[i].avoidPlayers) {
      const j = nameToIndex[avoided];
      if (j === undefined) {
        throw new Error(
          `Player "${players[i].name}" cannot avoid unknown player "${avoided}".`,
        );
      }
      avoidedMap[j].push(i);
    }
  }

  const availableSpace: Record<number, MinSubset> = {};
  for (let i = 0; i < players.length; i++) {
    availableSpace[i] = new MinSubset();
    availableSpace[i].build(N);
  }

  return {
    spiralSize: N,
    players,
    _currentPieces: [],
    _currentPlayer: 0,
    _avoidedMap: avoidedMap,
    _availableSpace: availableSpace,
  };
}

// stepSimulation advances the simulation by one step, returning true if the game is over
function stepSimulation(simulation: Simulation): boolean {
  const playerIdx = simulation._currentPlayer;
  const player = simulation.players[playerIdx];

  // compute where the current player can place their piece
  const available = simulation._availableSpace[playerIdx];
  const placement = available.min();
  if (placement === null) return true;
  simulation._currentPieces.push({ playerId: playerIdx, position: placement });

  // remove the just occupied position from all player's available space sets
  for (let i = 0; i < simulation.players.length; i++) {
    simulation._availableSpace[i].remove([placement]);
  }

  // any players that must avoid the current player, remove all visible positions
  // from the just placed spot
  const placementGrid = spiralToGrid(placement);
  for (const otherPlayerIdx of simulation._avoidedMap[playerIdx]) {
    const toRemove = player.moveSet.map((offset) =>
      gridToSpiral(vectorAdd(placementGrid, offset)),
    );
    simulation._availableSpace[otherPlayerIdx].remove(toRemove);
  }

  // advance to the next player
  simulation._currentPlayer = (playerIdx + 1) % simulation.players.length;
  return false;
}

function getPixels(
  simulation: Simulation,
): { color: string; position: Vec2d; spiralIndex: number }[] {
  // simulate until the end, then return the current pieces
  while (!stepSimulation(simulation));
  return simulation._currentPieces.map((piece) => ({
    color: simulation.players[piece.playerId].color,
    position: spiralToGrid(piece.position),
    spiralIndex: piece.position,
  }));
}

// transforms an index on the square spiral to a grid position
// represented as an offset from the origin (which is where 0 is placed)
function spiralToGrid(n: number): Vec2d {
  if (n === 0) {
    return { x: 0, y: 0 };
  }
  const k = Math.floor((Math.floor(Math.sqrt(n)) + 1) / 2);
  const s = (2 * k - 1) ** 2;
  const d = n - s;
  if (d < 2 * k) return { x: k, y: -k + 1 + d };
  if (d < 4 * k) return { x: k - 1 - (d - 2 * k), y: k };
  if (d < 6 * k) return { x: -k, y: k - 1 - (d - 4 * k) };
  return { x: -k + 1 + (d - 6 * k), y: -k };
}

// transforms a grid position to an index on the square spiral
// where the grid position is represented as an offset from the origin
function gridToSpiral(gridPos: Vec2d): number {
  const { x, y } = gridPos;
  if (x === 0 && y === 0) {
    return 0;
  }

  const k = Math.max(Math.abs(x), Math.abs(y));
  const s = (2 * k - 1) ** 2;

  if (x === k && y > -k) {
    return s + (y + k - 1);
  }
  if (y === k && x < k) {
    return s + 2 * k + (k - 1 - x);
  }
  if (x === -k && y < k) {
    return s + 4 * k + (k - 1 - y);
  }
  return s + 6 * k + (x + k - 1);
}

export type { MoveSet, Player, Simulation, Vec2d };
export { createSimulation, getPixels, spiralToGrid, stepSimulation };
