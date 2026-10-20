import type { ResolvedPortalPlayback } from "@arm-nator/shared/interfaces";
import type { PlayerOpenContext } from "./player-facade";
/** Renderer-only ownership. Functions never travel through source metadata or IPC. */
const contexts = new WeakMap<ResolvedPortalPlayback, PlayerOpenContext>();
export function registerPlaybackContext(
  playback: ResolvedPortalPlayback,
  context: PlayerOpenContext,
): PlayerOpenContext {
  contexts.set(playback, context);
  return context;
}
export function getPlaybackContext(
  playback: ResolvedPortalPlayback,
): PlayerOpenContext | undefined {
  return contexts.get(playback);
}
