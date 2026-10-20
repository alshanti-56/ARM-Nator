import {
  canRevealNativeFrame,
  nativeSceneClip,
} from "./native-presentation-state";
import type { EmbeddedMpvSession } from "@arm-nator/shared/interfaces";
const snapshot = (extra: Partial<EmbeddedMpvSession> = {}) =>
  ({
    id: "current",
    status: "playing",
    positionSeconds: 0,
    ...extra,
  }) as EmbeddedMpvSession;
it("requires an actual current-session presented frame, not time/status", () => {
  const input = {
    enabled: true,
    activeSessionId: "current",
    snapshot: snapshot(),
    closing: false,
  };
  expect(canRevealNativeFrame(input)).toBe(false);
  expect(
    canRevealNativeFrame({
      ...input,
      snapshot: snapshot({ frameReady: true, status: "paused" }),
    }),
  ).toBe(true);
  expect(
    canRevealNativeFrame({
      ...input,
      snapshot: snapshot({ id: "old", frameReady: true }),
    }),
  ).toBe(false);
  expect(
    canRevealNativeFrame({
      ...input,
      closing: true,
      snapshot: snapshot({ frameReady: true }),
    }),
  ).toBe(false);
  expect(
    canRevealNativeFrame({
      ...input,
      snapshot: snapshot({ status: "loading", frameReady: true }),
    }),
  ).toBe(true);
  for (const status of ["idle", "error", "closed"] as const)
    expect(
      canRevealNativeFrame({
        ...input,
        snapshot: snapshot({ status, frameReady: true }),
      }),
    ).toBe(false);
});
it("cuts out only a finite aperture and rejects invalid geometry", () => {
  expect(
    nativeSceneClip({ x: 20, y: 30, width: 100, height: 80 }, 800, 600),
  ).toContain("evenodd");
  expect(
    nativeSceneClip({ x: 20, y: 30, width: 100, height: 80 }, 800, 600),
  ).toContain("120");
  expect(nativeSceneClip({ x: NaN, y: 0, width: 2, height: 2 }, 800, 600)).toBe(
    "none",
  );
  expect(nativeSceneClip({ x: 0, y: 0, width: 0, height: 0 }, 800, 600)).toBe(
    "none",
  );
});

it("rounds the bottom of an aperture without rounding its join to the header", () => {
  const clip = nativeSceneClip(
    { x: 20, y: 30, width: 100, height: 80 },
    800,
    600,
    { top: 0, bottom: 13 },
  );
  expect(clip).toContain('M20 30 H120 Q120 30 120 30');
  expect(clip).toContain('V97 Q120 110 107 110 H33 Q20 110 20 97');
  expect(nativeSceneClip(
    { x: 20, y: 30, width: 100, height: 80 }, 800, 600,
    { top: 0, bottom: Number.NaN },
  )).toBe('none');
});
