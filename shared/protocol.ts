export const FIVE_ELEMENTS = ["wood", "fire", "earth", "metal", "water"] as const;
export type FiveElement = (typeof FIVE_ELEMENTS)[number];
export type GamePhase = "title" | "attribute_selection" | "attribute_reveal" | "battle";
export type CardPlayTarget = "cpu_player" | "cpu_unit" | "cpu_any" | "cpu_field" | "player" | "player_field";
export type CardTarget = "cpu_player" | "cpu_field" | "player" | "player_field" | `cpu_unit:${string}`;

export interface CardView {
  instanceId: string;
  cardId: string;
  name: string;
  category: string;
  system: string;
  attribute: string;
  cost: number;
  mpCost: number;
  target: string;
  timing: string;
  effectText: string;
  description: string;
  flavorText: string;
  playable: boolean;
  unusableReason?: string;
  playTarget?: CardPlayTarget;
  ignoreTaunt?: boolean;
}

export interface CurseState {
  id: string;
  name: string;
  stacks: number;
  remainingTriggers?: number;
}

export interface ShikigamiState {
  instanceId: string;
  shikigamiId: string;
  name: string;
  attribute: string;
  hp: number;
  maxHp: number;
  attack: number;
  aiProfile: string;
  keywords: string[];
  ability: string;
  curses: CurseState[];
  nextDamageReduction: number;
}

export interface BattlePlayerState {
  hp: number;
  mp: number;
  cost: number;
  curses: CurseState[];
  nextDamageReduction: number;
  shikigami: ShikigamiState[];
}

export interface BattleState {
  turnNumber: number;
  activePlayer: "player" | "cpu";
  phase: "card_use" | "resolving" | "finished";
  winner?: "player" | "cpu";
  player: BattlePlayerState & { hand: CardView[]; discard: CardView[] };
  cpu: BattlePlayerState & { handCount: number };
  log: string[];
}

export interface SessionState {
  phase: GamePhase;
  reconnectToken?: string;
  playerName?: string;
  playerAttribute?: FiveElement;
  cpuAttribute?: FiveElement;
  battle?: BattleState;
}

export interface ActionResult {
  ok: boolean;
  message?: string;
  state?: SessionState;
}

export interface ClientToServerEvents {
  "session:resume": (token: string, callback: (result: ActionResult) => void) => void;
  "cpu:start": (payload: { playerName: string }, callback: (result: ActionResult) => void) => void;
  "attribute:select": (payload: { attribute: FiveElement }, callback: (result: ActionResult) => void) => void;
  "match:enter": (callback: (result: ActionResult) => void) => void;
  "card:use": (payload: { instanceId: string; target: CardTarget }, callback: (result: ActionResult) => void) => void;
  "turn:end": (callback: (result: ActionResult) => void) => void;
  "session:reset": (callback: (result: ActionResult) => void) => void;
}

export interface ServerToClientEvents {
  "session:state": (state: SessionState) => void;
}