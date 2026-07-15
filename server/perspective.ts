export type CanonicalSide = "player" | "cpu";

/** Convert canonical server-side labels into labels relative to one client. */
export function perspectiveLog(text: string, viewerSide: CanonicalSide): string {
  const selfLabel = viewerSide === "player" ? "プレイヤー" : "CPU";
  const opponentLabel = viewerSide === "player" ? "CPU" : "プレイヤー";
  return text
    .replaceAll("両プレイヤー", "\u0000BOTH_PLAYERS\u0000")
    .replaceAll(selfLabel, "\u0000SELF\u0000")
    .replaceAll(opponentLabel, "相手")
    .replaceAll("\u0000SELF\u0000", "自分")
    .replaceAll("\u0000BOTH_PLAYERS\u0000", "両プレイヤー");
}
