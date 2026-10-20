import assert from "node:assert/strict";
import { abortableStalkerRequest } from "./abortable-stalker-request";
import type { DataService } from "@arm-nator/services";
const payload = {
  url: "http://fixture.invalid",
  macAddress: "fixture",
  params: { action: "get_ordered_list" },
};
test("aborting a portal request cancels its exact IPC lease and rejects stale output", async () => {
  const calls: { type: string; payload: unknown }[] = [];
  let resolve!: (value: unknown) => void;
  const pending = new Promise((r) => (resolve = r));
  const data = {
    sendIpcEvent: (type: string, payload: unknown) => {
      calls.push({ type, payload });
      return type === "STALKER_REQUEST"
        ? pending
        : Promise.resolve({ cancelled: true });
    },
  } as unknown as DataService;
  const controller = new AbortController();
  const run = abortableStalkerRequest(data, payload, controller.signal);
  controller.abort();
  await assert.rejects(run, { name: "AbortError" });
  const request = calls[0].payload as { requestId: string };
  assert.equal(calls[1].type, "STALKER_CANCEL_REQUEST");
  assert.equal(calls[1].payload, request.requestId);
  resolve({ js: { data: ["stale"] } });
});
test("already cancelled work sends no request", async () => {
  let calls = 0;
  const data = {
    sendIpcEvent: () => {
      calls++;
    },
  } as unknown as DataService;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    abortableStalkerRequest(data, payload, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
});
