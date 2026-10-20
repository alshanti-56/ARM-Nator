export interface DirectPlayEngineSnapshot {
  readonly engine?: string;
  readonly available?: boolean;
  readonly sessionId?: string;
  readonly sessionStatus?: string;
}

export function hasStartedEmbeddedMpvSession(
  engine: DirectPlayEngineSnapshot | undefined,
): boolean {
  return (
    engine?.engine === "embedded-mpv" &&
    (Boolean(engine.sessionId) || engine.sessionStatus !== undefined)
  );
}

/** A workspace engine change is explicit user intent, not a KS fallback. */
export function isUnexpectedEmbeddedMpvSession(
  requestedEngine: string,
  activeEngine: string,
  snapshot: DirectPlayEngineSnapshot | undefined,
): boolean {
  return (
    requestedEngine === "ksplayer" &&
    activeEngine === "ksplayer" &&
    hasStartedEmbeddedMpvSession(snapshot)
  );
}
