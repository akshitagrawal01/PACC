/**
 * Test Lab Helper Utilities
 * Parses and extracts room identifiers and modes from decoded barcodes,
 * URLs, deep links, and structured payloads.
 */

export interface TestLabTarget {
  roomId: string;
  mode: "host" | "scanner";
  originalPayload: string;
}

/**
 * Extracts a valid Test Lab room ID and target mode from an arbitrary decoded payload.
 * Supports:
 * - Full absolute URLs: https://.../?tab=test-lab&room=1454&mode=scanner
 * - Tunnel / IP URLs: http://192.168.1.5:3000/?room=1454
 * - Path-based URLs: /test-lab?room=1454
 * - Relative query strings: ?tab=test-lab&room=1454
 * - Structured prefixes: PACC-ROOM:1454, TESTLAB:1454, ROOM:1454
 * - JSON payloads: {"room": "1454", "mode": "scanner"}
 * - Exact 4-to-6 alphanumeric room code
 */
export function extractTestLabRoom(payload: string | null | undefined): TestLabTarget | null {
  if (!payload || typeof payload !== "string") return null;
  const trimmed = payload.trim();
  if (!trimmed) return null;

  // 1. Try parsing as a standard URL
  try {
    const url = new URL(trimmed);
    const roomParam = url.searchParams.get("room") || url.searchParams.get("join");
    if (roomParam) {
      const modeParam = url.searchParams.get("mode")?.toLowerCase();
      return {
        roomId: roomParam.trim().toUpperCase(),
        mode: modeParam === "host" ? "host" : "scanner",
        originalPayload: trimmed,
      };
    }
  } catch {
    // Not a full URL, continue to string patterns
  }

  // 2. Relative URL, path, or query string (e.g., /?tab=test-lab&room=1454 or ?room=1454)
  if (trimmed.includes("room=") || trimmed.includes("join=")) {
    const match = trimmed.match(/[?&](?:room|join)=([A-Za-z0-9]{3,8})/i);
    if (match) {
      const modeMatch = trimmed.match(/[?&]mode=(host|scanner)/i);
      return {
        roomId: match[1].trim().toUpperCase(),
        mode: modeMatch && modeMatch[1].toLowerCase() === "host" ? "host" : "scanner",
        originalPayload: trimmed,
      };
    }
  }

  // 3. Structured prefix: PACC-ROOM:1454, TESTLAB:1454, ROOM:1454
  const prefixMatch = trimmed.match(/^(?:PACC-)?(?:ROOM|TESTLAB)[:=]\s*([A-Za-z0-9]{3,8})/i);
  if (prefixMatch) {
    const modeMatch = trimmed.match(/(?:[:=]|&|\s)(?:mode[:=])?(host|scanner)/i);
    return {
      roomId: prefixMatch[1].trim().toUpperCase(),
      mode: modeMatch && modeMatch[1].toLowerCase() === "host" ? "host" : "scanner",
      originalPayload: trimmed,
    };
  }

  // 4. JSON payload: {"room":"1454"} or {"type":"testlab","room":"1454"}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      const room = parsed.room || parsed.roomId || parsed.join;
      if (room && typeof room === "string") {
        return {
          roomId: room.trim().toUpperCase(),
          mode: parsed.mode?.toLowerCase() === "host" ? "host" : "scanner",
          originalPayload: trimmed,
        };
      }
    } catch {
      // Not valid JSON
    }
  }

  // 5. Bare 4-digit numeric or 4-to-6 alphanumeric room code (e.g., "1454", "3930")
  if (/^[A-Za-z0-9]{4,6}$/.test(trimmed)) {
    return {
      roomId: trimmed.toUpperCase(),
      mode: "scanner",
      originalPayload: trimmed,
    };
  }

  return null;
}
