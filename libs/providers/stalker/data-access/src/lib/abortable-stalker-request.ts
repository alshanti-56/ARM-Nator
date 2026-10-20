import {
  STALKER_CANCEL_REQUEST,
  STALKER_REQUEST,
  STALKER_SEARCH_PAGE,
} from "@arm-nator/shared/interfaces";
import type {
  StalkerSearchContext,
  StalkerRequestPayload,
} from "@arm-nator/shared/interfaces";
import type { DataService } from "@arm-nator/services";
export function throwIfStalkerRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Portal request cancelled");
    error.name = "AbortError";
    throw error;
  }
}
export async function abortableStalkerRequest<T>(
  data: DataService,
  payload: StalkerRequestPayload,
  signal?: AbortSignal,
  discovery?: StalkerSearchContext,
): Promise<T> {
  throwIfStalkerRequestAborted(signal);
  const command = discovery ? STALKER_SEARCH_PAGE : STALKER_REQUEST;
  const requestPayload = discovery ? { ...payload, discovery } : payload;
  if (!signal) return data.sendIpcEvent<T>(command, requestPayload);
  const requestId = crypto.randomUUID();
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => {
      void Promise.resolve(
        data.sendIpcEvent(STALKER_CANCEL_REQUEST, requestId),
      ).catch((error) =>
        console.warn("Unable to cancel portal request", error),
      );
      const error = new Error("Portal request cancelled");
      error.name = "AbortError";
      reject(error);
    };
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve(
        data.sendIpcEvent<T>(command, { ...requestPayload, requestId }),
      ),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", rejectAbort);
  }
}
