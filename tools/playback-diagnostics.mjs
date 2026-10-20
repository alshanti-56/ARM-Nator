import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
let directory = join(
  process.env.ARM_NATOR_E2E_DATA_DIR?.trim() || join(homedir(), ".arm-nator"),
  "logs",
);
let last = 40;
let sessionId;
let json = false;
let redact = false;

function usage() {
  console.log(
    "Usage: pnpm diagnostics:playback [--last N] [--session ID] [--json] [--redact] [--directory DIR]",
  );
}

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === "--") continue;
  if (argument === "--help") {
    usage();
    process.exit(0);
  }
  if (argument === "--json") {
    json = true;
    continue;
  }
  if (argument === "--redact") {
    redact = true;
    continue;
  }
  if (
    argument === "--directory" ||
    argument === "--session" ||
    argument === "--last"
  ) {
    const value = args[++index];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${argument}`);
    if (argument === "--directory") directory = value;
    if (argument === "--session") sessionId = value;
    if (argument === "--last") {
      last = Number(value);
      if (!Number.isSafeInteger(last) || last < 1 || last > 10000)
        throw new Error("--last must be between 1 and 10000");
    }
    continue;
  }
  throw new Error(`Unknown option: ${argument}`);
}

function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "[Unavailable]";
  }
}

function sharingCopy(record) {
  // Sharing is explicitly requested. Keep replayable originals untouched;
  // remove full paths, query strings, headers and free-form error text.
  const output = {};
  for (const field of [
    "timestamp",
    "event",
    "requestId",
    "sessionId",
    "resourceId",
    "transport",
    "resourceKind",
    "phase",
    "operation",
    "state",
    "status",
    "durationMs",
    "activeSessions",
    "providerAuth",
    "providerActiveConnections",
    "providerMaxConnections",
  ]) {
    if (record[field] !== undefined) output[field] = record[field];
  }
  for (const field of ["sourceUrl", "requestUrl", "responseUrl"]) {
    if (record[field])
      output[field] = safeOrigin(record[field]) + "/[Path and query removed]";
  }
  if (record.error)
    output.error = { name: record.error.name, code: record.error.code };
  return output;
}

const records = [];
for (const name of [
  "playback-diagnostics.2.jsonl",
  "playback-diagnostics.1.jsonl",
  "playback-diagnostics.jsonl",
]) {
  let content;
  try {
    content = await readFile(join(directory, name), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (
        record &&
        typeof record === "object" &&
        !Array.isArray(record) &&
        (!sessionId || record.sessionId === sessionId)
      )
        records.push(record);
    } catch {
      /* A live writer may not have finished the last line yet. */
    }
  }
}
const selected = records
  .slice(-last)
  .map((record) => (redact ? sharingCopy(record) : record));
if (json) {
  console.log(JSON.stringify(selected, null, 2));
} else if (!selected.length) {
  console.log(`No playback diagnostics recorded yet in ${directory}.`);
} else {
  console.table(
    selected.map((record) => ({
      time: record.timestamp,
      event: record.event,
      status: record.status ?? record.state ?? "",
      transport: record.transport ?? "",
      phase: record.phase ?? record.operation ?? "",
      server: safeOrigin(
        record.responseUrl ?? record.requestUrl ?? record.sourceUrl,
      ),
    })),
  );
  console.log(
    "Use --json to inspect the complete local replay data; --redact removes private details from a sharing copy.",
  );
}
