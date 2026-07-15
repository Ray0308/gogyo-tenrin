export const FIVE_ELEMENTS = ["wood", "fire", "earth", "metal", "water"] as const;
export type FiveElement = (typeof FIVE_ELEMENTS)[number];
export type GamePhase = "title" | "attribute_selection" | "attribute_reveal" | "battle";

export interface SessionState {
  phase: GamePhase;
  reconnectToken?: string;
  playerName?: string;
  playerAttribute?: FiveElement;
  cpuAttribute?: FiveElement;
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