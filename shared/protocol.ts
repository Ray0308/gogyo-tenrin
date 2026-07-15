export const FIVE_ELEMENTS = ["wood", "fire", "earth", "metal", "water"] as const;
export type FiveElement = (typeof FIVE_ELEMENTS)[number];
export type GamePhase = "title" | "attribute_selection" | "attribute_reveal" | "battle";

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
}

export interface BattlePlayerState {
  hp: number;
  mp: number;
  cost: number;
}

export interface BattleState {
  turnNumber: number;
  activePlayer: "player" | "cpu";
  phase: "card_use";
  player: BattlePlayerState & { hand: CardView[] };
  cpu: BattlePlayerState & { handCount: number };
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
  "session:reset": (callback: (result: ActionResult) => void) => void;
}

export interface ServerToClientEvents {
  "session:state": (state: SessionState) => void;
}