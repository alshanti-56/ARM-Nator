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
