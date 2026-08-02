import type {
  BulkInvalidEntry,
  BulkParseResult,
  BulkTestCandidate,
} from "./bulk-tester.models";

const URL_PATTERN = /https?:\/\/[^\s,;]+/i;
const TOKEN_SEPARATOR = /[\s,;|]+/;

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function trimToken(value: string): string {
  return value.trim().replace(/^["'<>]+|["'<>]+$/g, "");
}

function tokenize(value: string): string[] {
  return value.split(TOKEN_SEPARATOR).map(trimToken).filter(Boolean);
}

function serverRoot(url: URL): string {
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
}

function normalizeServerUrl(raw: string): string | null {
  const trimmed = trimToken(raw);
  const value = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return serverRoot(parsed);
  } catch {
    return null;
  }
}

function makeXtream(
  originalText: string,
  serverUrl: string,
  username: string,
  password: string,
): BulkTestCandidate | null {
  const normalizedServer = normalizeServerUrl(serverUrl);
  const normalizedUsername = trimToken(username);
  const normalizedPassword = trimToken(password);
  if (!normalizedServer || !normalizedUsername || !normalizedPassword) {
    return null;
  }
  return {
    id: randomId(),
    type: "xtream",
    originalText,
    serverUrl: normalizedServer,
    playlistUrl: "",
    username: normalizedUsername,
    password: normalizedPassword,
    normalizedKey: `xtream|${normalizedServer.toLowerCase()}|${normalizedUsername}|${normalizedPassword}`,
  };
}

function makeM3u(
  originalText: string,
  playlistUrl: string,
): BulkTestCandidate | null {
  const normalized = trimToken(playlistUrl);
  let url: URL;
  try {
    url = new URL(normalized);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
  } catch {
    return null;
  }

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  const normalizedUrl = url.toString();

  return {
    id: randomId(),
    type: "m3u",
    originalText,
    serverUrl: "",
    playlistUrl: normalizedUrl,
    username: "",
    password: "",
    // URL normalizes scheme, hostname, and default ports while preserving the
    // case-sensitive path and query portions used by some IPTV providers.
    normalizedKey: `m3u|${normalizedUrl}`,
  };
}

function looksLikeM3u(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes(".m3u") ||
    lower.includes("type=m3u") ||
    lower.includes("m3u_plus") ||
    lower.includes("output=m3u") ||
    lower.includes("/get.php") ||
    lower.includes("/playlist")
  );
}

function parseUrlCandidate(line: string): BulkTestCandidate | null {
  const match = line.match(URL_PATTERN);
  if (!match) {
    return null;
  }

  const urlText = trimToken(match[0]);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }

  const username = url.username || url.searchParams.get("username") || "";
  const password = url.password || url.searchParams.get("password") || "";
  if (username && password) {
    return makeXtream(line, serverRoot(url), username, password);
  }

  const trailingTokens = tokenize(line.replace(match[0], " "));
  if (trailingTokens.length >= 2) {
    return makeXtream(
      line,
      serverRoot(url),
      trailingTokens[0],
      trailingTokens[1],
    );
  }

  if (looksLikeM3u(urlText)) {
    return makeM3u(line, urlText);
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts.length >= 2) {
    return makeXtream(line, serverRoot(url), pathParts[0], pathParts[1]);
  }

  return makeM3u(line, urlText);
}

function parseSpacedCredentials(line: string): BulkTestCandidate | null {
  const tokens = tokenize(line);
  if (
    tokens.length < 3 ||
    (!tokens[0].includes(".") && !tokens[0].includes(":")) ||
    tokens[0].includes("@")
  ) {
    return null;
  }
  return makeXtream(line, tokens[0], tokens[1], tokens[2]);
}

function parseSlashCredentials(line: string): BulkTestCandidate | null {
  const value = /^https?:\/\//i.test(line) ? line : `http://${line}`;
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length >= 2
      ? makeXtream(line, serverRoot(url), parts[0], parts[1])
      : null;
  } catch {
    return null;
  }
}

function parseLine(line: string): BulkTestCandidate | null {
  return (
    parseUrlCandidate(line) ??
    parseSpacedCredentials(line) ??
    parseSlashCredentials(line)
  );
}

function splitInput(rawInput: string): string[] {
  return rawInput
    .replace(/\r/g, "\n")
    .split("\n")
    .reduce<string[]>((entries, line) => {
      const trimmed = line.trim();
      if (/https?:\/\//i.test(trimmed)) {
        entries.push(trimmed);
      } else {
        entries.push(...trimmed.split(/[;,]/).map((part) => part.trim()));
      }
      return entries;
    }, [])
    .filter(Boolean);
}

export function parseIptvCredentials(
  rawInput: string,
  limit = 100,
): BulkParseResult {
  const candidates: BulkTestCandidate[] = [];
  const duplicates: BulkTestCandidate[] = [];
  const invalidEntries: BulkInvalidEntry[] = [];
  const seen = new Set<string>();

  for (const line of splitInput(rawInput)) {
    if (candidates.length >= limit) {
      invalidEntries.push({
        id: randomId(),
        text: line,
        reason: `Only the first ${limit} unique entries are accepted.`,
      });
      continue;
    }

    const candidate = parseLine(line);
    if (!candidate) {
      invalidEntries.push({
        id: randomId(),
        text: line,
        reason: "Could not detect M3U or Xtream credentials.",
      });
      continue;
    }

    if (seen.has(candidate.normalizedKey)) {
      duplicates.push(candidate);
      continue;
    }
    seen.add(candidate.normalizedKey);
    candidates.push(candidate);
  }

  return { candidates, duplicates, invalidEntries };
}
