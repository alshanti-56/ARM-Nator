import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";

/** Normalized once before creating the window or loading a native adapter. */
export function nativePlayerCompositionEnabled(
  env: NodeJS.ProcessEnv,
  defaultEnabled = true,
): boolean {
  const value = env.ARM_NATOR_NATIVE_COMPOSITION;
  return value === undefined ? defaultEnabled : value === "1";
}

export function compositionWindowOptions(
  enabled: boolean,
  preferences: WebPreferences,
): BrowserWindowConstructorOptions {
  return {
    ...(enabled ? { transparent: true, backgroundColor: "#00000000" } : {}),
    webPreferences: {
      ...preferences,
      webviewTag: enabled,
      additionalArguments: [
        ...(preferences.additionalArguments ?? []),
        `--arm-nator-native-composition=${enabled ? "1" : "0"}`,
      ],
    },
  };
}

/** Hide the window before cleanup: a failed native disposal must never stay visible. */
export async function recoverNativeRenderer(actions: {
  hide: () => void;
  dispose: Array<() => unknown | Promise<unknown>>;
  recover: () => unknown | Promise<unknown>;
  fail: (errors: unknown[]) => void;
}): Promise<void> {
  actions.hide();
  const results = await Promise.allSettled(
    actions.dispose.map((dispose) => Promise.resolve().then(dispose)),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length) {
    actions.fail(errors);
    return;
  }
  try {
    await actions.recover();
  } catch (error) {
    actions.fail([error]);
  }
}
