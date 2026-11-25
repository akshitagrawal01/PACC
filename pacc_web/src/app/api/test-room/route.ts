import { NextRequest, NextResponse } from "next/server";
import { callOnce } from "@/lib/server/pythonBridge";
import path from "path";
import fs from "fs";
import { parseAndroidModelCode } from "@/lib/deviceFingerprint";
import { errorMessage } from "@/lib/errors";

export interface TestSuiteItem {
  id: string;
  codeType: "PACC" | "PACC_DUAL" | "PACC_QC" | "QR" | "JAB";
  badge: string;
  label: string;
  sublabel: string;
  gridSide: number | null;
  cellSize: number;
  eccLevel: string;
  bitsPerCell: string;
  payload: string;
  payloadBytes: number;
  dataUrl: string;
  serverDecodeLatencyMs?: number;
  serverDecodeSuccess?: boolean;
  encodeDurationMs?: number;
  password?: string;
  /** PACC suites (scripts/pacc_suites.py): tags for the paper report and how the phone grades the item. */
  group?: string;
  condition?: string;
  codec?: string;
  severity?: number | null;
  expect?: "text" | "signed" | "reject" | "coarse" | "fine" | "qc_hidden";
  secrets?: {
    trustedSigners?: { alg: number; publicKeyHex: string; fingerprint: string }[];
    recipientPrivateHex?: string[];
    pqRecipientSeedHex?: string[];
  };
  frames?: string[] | null;
  fps?: number;
  hint?: string;
}

export interface ConnectedDevice {
  deviceId: string;
  deviceName: string;
  deviceModel?: string;
  deviceBrand?: string;
  os?: string;
  browser?: string;
  userAgent: string;
  platform?: string;
  screenResolution?: string;
  viewportResolution?: string;
  devicePixelRatio?: number;
  colorDepth?: string;
  hardwareConcurrency?: number;
  deviceMemory?: string;
  maxTouchPoints?: number;
  networkConnection?: string;
  gpuRenderer?: string;
  gpuVendor?: string;
  webglVersion?: string;
  cameraResolution?: string;
  cameraFps?: number;
  cameraFacingMode?: string;
  hasTorch?: boolean;
  lastSeen: number;
  scansCompleted: number;
  isOnline?: boolean;
}

export interface ScanLogEvent {
  scanId: string;
  roomId: string;
  round: number;
  timestamp: string;
  testIndex: number;
  testId: string;
  codeType: string;
  label: string;
  gridSide: number | null;
  // Copied from TestSuiteItem at log-write time so downstream queries need no join
  eccLevel: string;
  bitsPerCell?: string;
  expectedPayload: string;
  decodedPayload: string;
  match: boolean;
  /** PASS   – payload matched exactly
   *  MISMATCH – decoded something that didn't match
   *  SKIPPED  – user manually skipped
   *  TIMEOUT  – per-item scan budget (10 s) expired without a decode
   *  FAIL     – decode threw an unrecoverable error
   */
  status: "PASS" | "FAIL" | "SKIPPED" | "MISMATCH" | "TIMEOUT";
  decodeLatencyMs: number;
  clientTimeToScanMs: number;
  attempts: number;
  /** Which decode path produced the result (tier1_tracking | tier2_roi | tier3_cold |
   *  ZXing | native_cold | snap | server | timeout | unknown) */
  decoderUsed?: string;
  deviceId: string;
  deviceName: string;
  deviceModel?: string;
  deviceBrand?: string;
  os?: string;
  browser?: string;
  gpuRenderer?: string;
  gpuVendor?: string;
  screenResolution?: string;
  viewportResolution?: string;
  devicePixelRatio?: number;
  hardwareConcurrency?: number;
  deviceMemory?: string;
  cameraResolution?: string;
  cameraFps?: number;
  networkConnection?: string;
}

export interface RoomData {
  roomId: string;
  createdAt: string;
  completedAt?: string | null;
  isCompleted?: boolean;
  suiteType: string;
  currentIndex: number;
  round: number;
  items: TestSuiteItem[];
  devices: Record<string, ConnectedDevice>;
  scanLogs: ScanLogEvent[];
  roundHistory?: Array<{ round: number; logs: ScanLogEvent[] }>;
  /** scanId of the most recent terminal event (PASS/MISMATCH/SKIPPED/TIMEOUT/FAIL).
   *  Derive the full object via scanLogs.find(l => l.scanId === lastScanResultId).
   *  Nulled on every step/new_round to avoid stale-result confusion. */
  lastScanResultId: string | null;
  /** Flat summary counts computed at save time — no full log scan needed at read time. */
  completionSummary: {
    total: number;
    pass: number;
    skipped: number;
    timeout: number;
    fail: number;
    mismatch: number;
  };
  /** Epoch ms of the host theater's last heartbeat; drives the host-online indicator. */
  hostLastSeen?: number;
}

const memoryRooms = new Map<string, RoomData>();

function getRoomsStorageDir(): string {
  const dir = path.join(process.cwd(), "data", "test_rooms");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function purgeHostFromDevices(devices?: Record<string, ConnectedDevice>): void {
  if (!devices) return;
  for (const [id, dev] of Object.entries(devices)) {
    if (
      (dev as ConnectedDevice & { mode?: string }).mode === "host" ||
      dev.os === "Windows 10/11" ||
      dev.platform === "Win32" ||
      dev.deviceName?.includes("PC Workstation")
    ) {
      delete devices[id];
    }
  }
}

function loadRoom(roomId: string): RoomData | null {
  const normId = roomId.trim().toUpperCase();
  if (memoryRooms.has(normId)) {
    const r = memoryRooms.get(normId)!;
    purgeHostFromDevices(r.devices);
    return r;
  }

  // Fallback: try loading from disk
  const dir = getRoomsStorageDir();
  const fp = path.join(dir, `${normId}.json`);
  if (fs.existsSync(fp)) {
    try {
      const data = fs.readFileSync(fp, "utf8");
      const r = JSON.parse(data) as RoomData;
      memoryRooms.set(normId, r);
      purgeHostFromDevices(r.devices);
      return r;
    } catch (err) {
      console.error(`[TestRoom] Failed to load room ${normId} from disk:`, err);
    }
  }

  return null;
}

const persistTimers = new Map<string, NodeJS.Timeout>();

function computeCompletionSummary(room: RoomData): RoomData["completionSummary"] {
  const logs = room.scanLogs || [];
  return {
    total: room.items.length,
    pass:     logs.filter((l) => l.status === "PASS").length,
    skipped:  logs.filter((l) => l.status === "SKIPPED").length,
    timeout:  logs.filter((l) => l.status === "TIMEOUT").length,
    fail:     logs.filter((l) => l.status === "FAIL").length,
    mismatch: logs.filter((l) => l.status === "MISMATCH").length,
  };
}

function saveRoom(room: RoomData, immediate = false): void {
  room.completionSummary = computeCompletionSummary(room);
  const normId = room.roomId.trim().toUpperCase();
  memoryRooms.set(normId, room);

  const saveToDisk = () => {
    try {
      const dir = getRoomsStorageDir();
      const fp = path.join(dir, `${normId}.json`);
      fs.writeFileSync(fp, JSON.stringify(room, null, 2), "utf8");
    } catch (err) {
      console.error(`[TestRoom] Failed to persist room ${normId}:`, err);
    }
  };

  if (immediate) {
    saveToDisk();
  } else {
    // Debounce disk writes to avoid blocking on every single scan
    if (persistTimers.has(normId)) {
      clearTimeout(persistTimers.get(normId)!);
    }
    persistTimers.set(
      normId,
      setTimeout(() => {
        saveToDisk();
        persistTimers.delete(normId);
      }, 2000)
    );
  }
}

function computeRoomStats(room: RoomData) {
  const logs = room.scanLogs || [];
  const totalScans = logs.length;
  const passedLogs = logs.filter((l) => l.status === "PASS");
  const passedCount = passedLogs.length;
  const passRate = totalScans > 0 ? Math.round((passedCount / totalScans) * 1000) / 10 : 0;

  const totalDecodeLatency = passedLogs.reduce((acc, l) => acc + (l.decodeLatencyMs || 0), 0);
  const avgDecodeLatencyMs = passedLogs.length > 0 ? Math.round((totalDecodeLatency / passedLogs.length) * 10) / 10 : 0;

  const totalTimeToScan = passedLogs.reduce((acc, l) => acc + (l.clientTimeToScanMs || 0), 0);
  const avgTimeToScanMs = passedLogs.length > 0 ? Math.round(totalTimeToScan / passedLogs.length) : 0;

  const typeMap: Record<string, { total: number; pass: number; totalLatency: number; totalTimeToScan: number }> = {
    PACC: { total: 0, pass: 0, totalLatency: 0, totalTimeToScan: 0 },
    PACC_DUAL: { total: 0, pass: 0, totalLatency: 0, totalTimeToScan: 0 },
    QR: { total: 0, pass: 0, totalLatency: 0, totalTimeToScan: 0 },
  };

  logs.forEach((l) => {
    const t = l.codeType || "PACC";
    if (!typeMap[t]) {
      typeMap[t] = { total: 0, pass: 0, totalLatency: 0, totalTimeToScan: 0 };
    }
    typeMap[t].total += 1;
    if (l.status === "PASS") {
      typeMap[t].pass += 1;
      typeMap[t].totalLatency += l.decodeLatencyMs || 0;
      typeMap[t].totalTimeToScan += l.clientTimeToScanMs || 0;
    }
  });

  const byType: Record<string, { total: number; pass: number; passRate: number; avgLatency: number; avgTimeToScan: number }> = {};
  for (const [k, v] of Object.entries(typeMap)) {
    byType[k] = {
      total: v.total,
      pass: v.pass,
      passRate: v.total > 0 ? Math.round((v.pass / v.total) * 100) : 0,
      avgLatency: v.pass > 0 ? Math.round((v.totalLatency / v.pass) * 10) / 10 : 0,
      avgTimeToScan: v.pass > 0 ? Math.round(v.totalTimeToScan / v.pass) : 0,
    };
  }

  const byDevice: Record<
    string,
    { name: string; model?: string; os?: string; browser?: string; total: number; pass: number; avgLatency: number }
  > = {};
  for (const l of logs) {
    const dId = l.deviceId || "unknown";
    if (!byDevice[dId]) {
      byDevice[dId] = {
        name: l.deviceName || "Unknown Device",
        model: l.deviceModel,
        os: l.os,
        browser: l.browser,
        total: 0,
        pass: 0,
        avgLatency: 0,
      };
    }
    byDevice[dId].total += 1;
    if (l.status === "PASS") {
      byDevice[dId].pass += 1;
    }
  }

  return {
    totalScans,
    passedCount,
    passRate,
    avgDecodeLatencyMs,
    avgTimeToScanMs,
    byType,
    byDevice,
  };
}

function getSuiteTitle(suiteType: string): string {
  switch (suiteType) {
    case "paper_set": return "Paper set (N1, N2, N5, N6, N7, stream)";
    case "n1_capacity": return "N1 · Capacity";
    case "n2_robustness": return "N2 · Everyday conditions";
    case "n5_security": return "N5 · Signatures and encryption";
    case "n6_multiframe": return "N6 · Multi-frame combining";
    case "n7_layers_qc": return "N7 · Layered and QR-compatible";
    case "stream": return "Animated stream";
    default: return "Optical Benchmark Suite";
  }
}

function buildStandardRoomResponse(room: RoomData, targetMode?: string) {
  const currentItem = room.items[room.currentIndex] || null;
  const stats = computeRoomStats(room);
  const now = Date.now();
  const hostLastSeen = room.hostLastSeen || 0;
  const hostOnline = Boolean(hostLastSeen && (now - hostLastSeen < 20000));

  // Purge any host device that may have leaked into room.devices
  const activeDevices = Object.values(room.devices || {})
    .filter((d: ConnectedDevice & { mode?: string }) => d.mode !== "host" && d.os !== "Windows 10/11" && !d.deviceName?.includes("PC Workstation"))
    .map((d) => ({
      ...d,
      isOnline: now - d.lastSeen < 30000,
    }));

  // Derive the full last-scan object from the ID reference (no stale duplication).
  const lastScanResult = room.lastScanResultId
    ? (room.scanLogs || []).find((l) => l.scanId === room.lastScanResultId) ?? null
    : null;

  // Scanner only needs metadata & payload for matching; omit 30KB base64 dataUrl
  let activeTest = currentItem;
  if (targetMode === "scanner" && currentItem) {
    activeTest = {
      ...currentItem,
      dataUrl: "", // live camera uses live video, never renders PNG
      frames: undefined,
    };
  }

  // Build lookup of latest status per testId across all logs in this round
  const itemStatuses: Record<string, "PASS" | "FAIL" | "SKIPPED" | "MISMATCH" | "TIMEOUT"> = {};
  for (const l of room.scanLogs || []) {
    if (l.testId) {
      itemStatuses[l.testId] = l.status;
    }
    if (typeof l.testIndex === "number" && room.items[l.testIndex]?.id) {
      itemStatuses[room.items[l.testIndex].id] = l.status;
    }
  }

  // Lightweight suite items metadata without 30KB base64 dataUrls
  const suiteItems = room.items.map((it) => ({
    id: it.id,
    codeType: it.codeType,
    badge: it.badge,
    label: it.label,
    sublabel: it.sublabel,
    gridSide: it.gridSide,
    cellSize: it.cellSize,
    eccLevel: it.eccLevel,
    bitsPerCell: it.bitsPerCell,
    payload: it.payload,
    payloadBytes: it.payloadBytes,
    serverDecodeLatencyMs: it.serverDecodeLatencyMs,
    serverDecodeSuccess: it.serverDecodeSuccess,
    group: it.group,
    condition: it.condition,
    codec: it.codec,
    severity: it.severity,
    expect: it.expect,
    hint: it.hint,
  }));

  return {
    success: true,
    roomId: room.roomId,
    createdAt: room.createdAt,
    completedAt: room.completedAt || null,
    isCompleted: Boolean(room.isCompleted),
    suiteType: room.suiteType,
    suiteTitle: getSuiteTitle(room.suiteType),
    currentIndex: room.currentIndex,
    totalTests: room.items.length,
    round: room.round,
    currentTest: activeTest,
    suiteItems,
    itemStatuses,
    hostOnline,
    devices: activeDevices,
    connectedDevices: activeDevices,
    lastScanResult,
    completionSummary: room.completionSummary,
    stats,
    // Last 25 scan events for live feed (most recent first)
    recentScanLogs: (room.scanLogs || []).slice(-25).reverse().map((l) => ({
      scanId: l.scanId,
      testId: l.testId,
      testIndex: l.testIndex,
      codeType: l.codeType,
      label: l.label,
      status: l.status,
      decodeLatencyMs: l.decodeLatencyMs,
      clientTimeToScanMs: l.clientTimeToScanMs,
      attempts: l.attempts,
      decoderUsed: l.decoderUsed,
      deviceName: l.deviceName,
      gridSide: l.gridSide,
      eccLevel: l.eccLevel,
      bitsPerCell: l.bitsPerCell,
      round: l.round,
      timestamp: l.timestamp,
    })),
    // Omit heavy allItems array on regular scanner poll (keeps response ~1.2 KB)
    ...(targetMode !== "scanner"
      ? {
          allItems: room.items.map((it) => ({
            id: it.id,
            codeType: it.codeType,
            badge: it.badge,
            label: it.label,
            gridSide: it.gridSide,
            eccLevel: it.eccLevel,
            payloadBytes: it.payloadBytes,
            serverDecodeLatencyMs: it.serverDecodeLatencyMs,
            serverDecodeSuccess: it.serverDecodeSuccess,
          })),
        }
      : {}),
    serverTimestamp: now,
  };
}

function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ── Real-Time Server-Sent Events (SSE) Hub for Sub-10ms Push Sync ─────────────
type SseSubscriber = {
  id: string;
  mode: string;
  send: (data: unknown) => void;
};

const roomSubscribers = new Map<string, Set<SseSubscriber>>();

function addRoomSubscriber(roomId: string, mode: string, send: (data: unknown) => void): () => void {
  const normId = roomId.trim().toUpperCase();
  if (!roomSubscribers.has(normId)) {
    roomSubscribers.set(normId, new Set());
  }
  const sub: SseSubscriber = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    mode,
    send,
  };
  roomSubscribers.get(normId)!.add(sub);

  return () => {
    const set = roomSubscribers.get(normId);
    if (set) {
      set.delete(sub);
      if (set.size === 0) roomSubscribers.delete(normId);
    }
  };
}

function broadcastRoomUpdate(room: RoomData): void {
  const normId = room.roomId.trim().toUpperCase();
  const set = roomSubscribers.get(normId);
  if (!set || set.size === 0) return;

  const hostResponse = buildStandardRoomResponse(room, "host");
  const scannerResponse = buildStandardRoomResponse(room, "scanner");

  for (const sub of Array.from(set)) {
    try {
      sub.send(sub.mode === "scanner" ? scannerResponse : hostResponse);
    } catch {
      // disconnected
    }
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action");
    const roomId = searchParams.get("roomId");

    if (!roomId) {
      return NextResponse.json({ success: false, error: "Missing roomId parameter" }, { status: 400 });
    }

    const room = loadRoom(roomId);
    if (!room) {
      return NextResponse.json({ success: false, error: `Room ${roomId} not found` }, { status: 404 });
    }

    // Real-Time Server-Sent Events (SSE) Stream for sub-10ms instant synchronization
    if (action === "stream" || action === "events") {
      const mode = searchParams.get("mode") || "host";
      let cleanup: (() => void) | null = null;
      let heartbeatTimer: NodeJS.Timeout | null = null;

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();

          // Push current state immediately upon connection
          const initialData = buildStandardRoomResponse(room, mode);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(initialData)}\n\n`));

          const send = (data: unknown) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            } catch {
              // controller closed
            }
          };

          cleanup = addRoomSubscriber(room.roomId, mode, send);

          // Keepalive ping every 15s to keep proxies alive
          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: keepalive\n\n`));
            } catch {
              if (heartbeatTimer) clearInterval(heartbeatTimer);
            }
          }, 15000);
        },
        cancel() {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          cleanup?.();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // On-demand full items fetch (e.g. for client benchmark when joining room or after page refresh)
    if (action === "items" || action === "all_items") {
      return NextResponse.json({
        success: true,
        roomId: room.roomId,
        totalTests: room.items.length,
        items: room.items,
      });
    }

    // CSV or JSON export (Full Scientific Telemetry Export)
    if (action === "export") {
      const format = searchParams.get("format") || "csv";
      if (format === "json") {
        return new NextResponse(JSON.stringify(room, null, 2), {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="${room.roomId}_benchmark_export.json"`,
          },
        });
      }

      // Comprehensive RFC-4180 CSV with all device hardware and scan telemetry
      const headers = [
        "Scan ID",
        "Room ID",
        "Round",
        "Timestamp",
        "Test Index",
        "Test ID",
        "Code Type",
        "Label",
        "Grid Side",
        "ECC Level",
        "Bits Per Cell",
        "Expected Payload",
        "Decoded Payload",
        "Payload Match",
        "Status",
        "Decode Latency (ms)",
        "Time to Scan (ms)",
        "Attempts",
        "Decoder Used",
        "Device ID",
        "Device Name",
        "Device Brand",
        "Device Model",
        "OS",
        "Browser",
        "GPU Renderer",
        "GPU Vendor",
        "Screen Resolution",
        "Viewport Resolution",
        "Device Pixel Ratio",
        "CPU Cores",
        "Device Memory",
        "Camera Resolution",
        "Camera FPS",
        "Network Connection",
      ];

      const rows = room.scanLogs.map((l) => [
        escapeCsvField(l.scanId),
        escapeCsvField(l.roomId),
        escapeCsvField(l.round),
        escapeCsvField(l.timestamp),
        escapeCsvField(l.testIndex + 1),
        escapeCsvField(l.testId),
        escapeCsvField(l.codeType),
        escapeCsvField(l.label),
        escapeCsvField(l.gridSide || ""),
        escapeCsvField(l.eccLevel),
        escapeCsvField(l.bitsPerCell || ""),
        escapeCsvField(l.expectedPayload),
        escapeCsvField(l.decodedPayload),
        escapeCsvField(l.match ? "TRUE" : "FALSE"),
        escapeCsvField(l.status),
        escapeCsvField(l.decodeLatencyMs),
        escapeCsvField(l.clientTimeToScanMs),
        escapeCsvField(l.attempts),
        escapeCsvField(l.decoderUsed || ""),
        escapeCsvField(l.deviceId),
        escapeCsvField(l.deviceName),
        escapeCsvField(l.deviceBrand || ""),
        escapeCsvField(l.deviceModel || ""),
        escapeCsvField(l.os || ""),
        escapeCsvField(l.browser || ""),
        escapeCsvField(l.gpuRenderer || ""),
        escapeCsvField(l.gpuVendor || ""),
        escapeCsvField(l.screenResolution || ""),
        escapeCsvField(l.viewportResolution || ""),
        escapeCsvField(l.devicePixelRatio || ""),
        escapeCsvField(l.hardwareConcurrency || ""),
        escapeCsvField(l.deviceMemory || ""),
        escapeCsvField(l.cameraResolution || ""),
        escapeCsvField(l.cameraFps || ""),
        escapeCsvField(l.networkConnection || ""),
      ]);

      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\r\n");

      return new NextResponse(csvContent, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${room.roomId}_benchmark_export.csv"`,
        },
      });
    }

    // Standard Room State Poll
    // Refresh device heartbeat and host status (In-memory heartbeat, NO disk write!)
    const pollDeviceId = searchParams.get("deviceId");
    const pollMode = searchParams.get("mode");
    const nowTs = Date.now();

    if (pollMode === "host") {
      room.hostLastSeen = nowTs;
      // Guarantee host is never in devices
      if (pollDeviceId && room.devices && room.devices[pollDeviceId]) {
        delete room.devices[pollDeviceId];
      }
    } else if (pollDeviceId) {
      if (!room.devices) room.devices = {};
      if (room.devices[pollDeviceId]) {
        room.devices[pollDeviceId].lastSeen = nowTs;
      } else {
        room.devices[pollDeviceId] = {
          deviceId: pollDeviceId,
          deviceName: "Mobile Scanner",
          userAgent: req.headers.get("user-agent") || "Mobile Scanner",
          lastSeen: nowTs,
          scansCompleted: 0,
          isOnline: true,
        };
      }
    }

    return NextResponse.json(buildStandardRoomResponse(room, pollMode || undefined));
  } catch (error: unknown) {
    return NextResponse.json({ success: false, error: errorMessage(error, "Internal server error") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") || "create";
    const body = await req.json().catch(() => ({}));

    // 1. Create Room
    if (action === "create") {
      const suiteType = body.suiteType || searchParams.get("suite") || searchParams.get("suiteType") || "paper_set";
      // R5 fix: loop until a unique room code is found (birthday-paradox collision guard)
      let roomId: string;
      if (body.customRoomId) {
        roomId = body.customRoomId;
      } else {
        let attempts = 0;
        do {
          const randomCode = Math.floor(1000 + Math.random() * 9000);
          roomId = `${randomCode}`;
          attempts++;
        } while (loadRoom(roomId) !== null && attempts < 50);
      }

      // Suite generation renders and server-verifies every barcode, so it runs in
      // its own process instead of blocking live decodes on the shared worker.
      const suiteRes = await callOnce(
        "generate_test_suite",
        { suite_type: suiteType, cell_size: 9 },
        300_000
      );

      if (!suiteRes.success || !Array.isArray(suiteRes.items)) {
        return NextResponse.json(
          { success: false, error: suiteRes.error || "Failed to generate test suite barcodes" },
          { status: 500 }
        );
      }
      const suiteItems = suiteRes.items as TestSuiteItem[];

      const newRoom: RoomData = {
        roomId,
        createdAt: new Date().toISOString(),
        completedAt: null,
        isCompleted: false,
        suiteType,
        currentIndex: 0,
        round: 1,
        items: suiteItems,
        devices: {},
        scanLogs: [],
        lastScanResultId: null,
        completionSummary: { total: suiteItems.length, pass: 0, skipped: 0, timeout: 0, fail: 0, mismatch: 0 },
      };

      newRoom.hostLastSeen = Date.now();
      saveRoom(newRoom);

      return NextResponse.json({
        ...buildStandardRoomResponse(newRoom),
        items: newRoom.items,
      });
    }

    const roomId = body.roomId || searchParams.get("roomId");
    if (!roomId) {
      return NextResponse.json({ success: false, error: "Missing roomId in request" }, { status: 400 });
    }

    const room = loadRoom(roomId);
    if (!room) {
      return NextResponse.json({ success: false, error: `Room ${roomId} not found` }, { status: 404 });
    }

    // 2. Device Join (Stores Complete Hardware & Environment Metadata)
    if (action === "join") {
      const {
        deviceId,
        mode,
        deviceName,
        deviceModel,
        deviceBrand,
        os,
        browser,
        userAgent,
        platform,
        screenResolution,
        viewportResolution,
        devicePixelRatio,
        colorDepth,
        hardwareConcurrency,
        deviceMemory,
        maxTouchPoints,
        networkConnection,
        gpuRenderer,
        gpuVendor,
        webglVersion,
        cameraResolution,
        cameraFps,
        cameraFacingMode,
        hasTorch,
      } = body;

      if (!deviceId) {
        return NextResponse.json({ success: false, error: "Missing deviceId" }, { status: 400 });
      }

      // Host registration check: host should NEVER be in room.devices
      if (mode === "host" || os === "Windows 10/11" || platform === "Win32" || deviceName?.includes("PC Workstation")) {
        room.hostLastSeen = Date.now();
        if (room.devices && room.devices[deviceId]) {
          delete room.devices[deviceId];
        }
        return NextResponse.json({
          ...buildStandardRoomResponse(room, "host"),
          registered: true,
          isHost: true,
        });
      }

      const headerModel = req.headers.get("sec-ch-ua-model")?.replace(/^"|"$/g, "");
      const headerPlatVer = req.headers.get("sec-ch-ua-platform-version")?.replace(/^"|"$/g, "");

      let finalBrand = deviceBrand;
      let finalModel = deviceModel;
      let finalOs = os;

      if ((!finalModel || finalModel === "Smartphone" || finalModel === "Device") && headerModel) {
        const parsed = parseAndroidModelCode(headerModel);
        finalBrand = parsed.brand;
        finalModel = parsed.model;
      }
      if (headerPlatVer && (!finalOs || finalOs.includes("Android 10") || finalOs === "Android (Modern)")) {
        const maj = parseInt(headerPlatVer.split(".")[0], 10);
        if (!isNaN(maj) && maj >= 10) finalOs = `Android ${maj}`;
      }

      const existing = room.devices[deviceId] || { scansCompleted: 0 };
      room.devices[deviceId] = {
        deviceId,
        deviceName: deviceName || existing.deviceName || (finalBrand && finalModel ? `${finalBrand} ${finalModel}` : "Mobile Device"),
        deviceModel: finalModel || existing.deviceModel,
        deviceBrand: finalBrand || existing.deviceBrand,
        os: finalOs || existing.os,
        browser: browser || existing.browser,
        userAgent: userAgent || existing.userAgent || "",
        platform: platform || existing.platform,
        screenResolution: screenResolution || existing.screenResolution,
        viewportResolution: viewportResolution || existing.viewportResolution,
        devicePixelRatio: devicePixelRatio || existing.devicePixelRatio,
        colorDepth: colorDepth || existing.colorDepth,
        hardwareConcurrency: hardwareConcurrency || existing.hardwareConcurrency,
        deviceMemory: deviceMemory || existing.deviceMemory,
        maxTouchPoints: maxTouchPoints !== undefined ? maxTouchPoints : existing.maxTouchPoints,
        networkConnection: networkConnection || existing.networkConnection,
        gpuRenderer: gpuRenderer || existing.gpuRenderer,
        gpuVendor: gpuVendor || existing.gpuVendor,
        webglVersion: webglVersion || existing.webglVersion,
        cameraResolution: cameraResolution || existing.cameraResolution,
        cameraFps: cameraFps || existing.cameraFps,
        cameraFacingMode: cameraFacingMode || existing.cameraFacingMode,
        hasTorch: hasTorch !== undefined ? hasTorch : existing.hasTorch,
        lastSeen: Date.now(),
        scansCompleted: existing.scansCompleted || 0,
      };

      saveRoom(room);
      broadcastRoomUpdate(room);
      return NextResponse.json({
        ...buildStandardRoomResponse(room),
        registered: true,
      });
    }

    // 3. Heartbeat Ping
    if (action === "ping") {
      const { deviceId, cameraResolution, cameraFps, deviceName, userAgent } = body;
      if (deviceId) {
        if (!room.devices) room.devices = {};
        const headerModel = req.headers.get("sec-ch-ua-model")?.replace(/^"|"$/g, "");
        const headerPlatVer = req.headers.get("sec-ch-ua-platform-version")?.replace(/^"|"$/g, "");

        let pBrand = body.deviceBrand;
        let pModel = body.deviceModel;
        let pOs = body.os;

        if ((!pModel || pModel === "Smartphone" || pModel === "Device") && headerModel) {
          const parsed = parseAndroidModelCode(headerModel);
          pBrand = parsed.brand;
          pModel = parsed.model;
        }
        if (headerPlatVer && (!pOs || pOs.includes("Android 10") || pOs === "Android (Modern)")) {
          const maj = parseInt(headerPlatVer.split(".")[0], 10);
          if (!isNaN(maj) && maj >= 10) pOs = `Android ${maj}`;
        }

        if (room.devices[deviceId]) {
          room.devices[deviceId].lastSeen = Date.now();
          if (cameraResolution) room.devices[deviceId].cameraResolution = cameraResolution;
          if (cameraFps) room.devices[deviceId].cameraFps = cameraFps;
          const dev = room.devices[deviceId];
          if (body.deviceName) dev.deviceName = body.deviceName;
          if (body.gpuRenderer) dev.gpuRenderer = body.gpuRenderer;
          if (body.gpuVendor) dev.gpuVendor = body.gpuVendor;
          if (pOs) dev.os = pOs;
          if (body.browser) dev.browser = body.browser;
          if (pModel) dev.deviceModel = pModel;
          if (pBrand) dev.deviceBrand = pBrand;
          if (body.screenResolution) dev.screenResolution = body.screenResolution;
          if (body.hardwareConcurrency) dev.hardwareConcurrency = body.hardwareConcurrency;
          if (body.deviceMemory) dev.deviceMemory = body.deviceMemory;
          if (body.networkConnection) dev.networkConnection = body.networkConnection;
        } else {
          // Auto-register device if missing from memory
          room.devices[deviceId] = {
            deviceId,
            deviceName: deviceName || body.deviceName || (pBrand && pModel ? `${pBrand} ${pModel}` : "Mobile Scanner"),
            userAgent: userAgent || req.headers.get("user-agent") || "Mobile Scanner",
            os:           pOs || body.os,
            browser:      body.browser,
            deviceModel:  pModel || body.deviceModel,
            deviceBrand:  pBrand || body.deviceBrand,
            gpuRenderer:  body.gpuRenderer,
            gpuVendor:    body.gpuVendor,
            screenResolution: body.screenResolution,
            hardwareConcurrency: body.hardwareConcurrency,
            deviceMemory: body.deviceMemory,
            networkConnection: body.networkConnection,
            lastSeen: Date.now(),
            scansCompleted: 0,
            isOnline: true,
            cameraResolution,
            cameraFps,
          };
        }
      }
      saveRoom(room);
      return NextResponse.json(buildStandardRoomResponse(room));
    }

    // 4. Optical Scan Evaluation & Logging
    if (action === "scan") {
      const {
        decodedPayload,
        text,
        decodeLatencyMs,
        engine,
        deviceId,
        clientTimeToScanMs,
        attempts,
        testId,
        deviceDetails,
        roundId,      // R2 fix: client attaches the round it was scanning for
        decoderUsed,  // which decode path produced the result
      } = body;

      // R2 fix: reject results tagged with a stale round number
      if (typeof roundId === "number" && roundId !== room.round) {
        return NextResponse.json({
          success: false,
          error: "stale_round",
          staleRound: roundId,
          currentRound: room.round,
        }, { status: 409 });
      }

      let activeTest = room.items[room.currentIndex];
      if (testId) {
        const found = room.items.find((it) => it.id === testId);
        if (found) activeTest = found;
      }

      if (!activeTest) {
        return NextResponse.json({ success: false, error: "No active test found in room" }, { status: 400 });
      }

      // R4 fix: resolve correct testIndex from the item's actual position, not the current pointer
      const activeTestIndex = room.items.indexOf(activeTest);

      if (deviceId && room.devices[deviceId]) {
        room.devices[deviceId].lastSeen = Date.now();
      }

      const clientDecodedText = (decodedPayload || text || "").trim();
      const dev = (deviceId && room.devices[deviceId]) || deviceDetails || {};

      // Case A: Web-Integrated Client-Side Decode Result (Instant Sync, 0 Server Delay)
      if (clientDecodedText) {
        // Dedup guard: if this testId + round already has ANY terminal status log from this
        // device, reject immediately. Covers PASS (racing frames) and the race between a skip
        // or timeout arriving simultaneously with an in-flight decode POST.
        const alreadyTerminal = room.scanLogs.some(
          (l) =>
            l.testId === activeTest.id &&
            l.round === room.round &&
            (l.status === "PASS" || l.status === "SKIPPED" || l.status === "TIMEOUT" || l.status === "FAIL") &&
            (l.deviceId === (deviceId || "unknown") || !deviceId)
        );
        if (alreadyTerminal) {
          return NextResponse.json({
            ...buildStandardRoomResponse(room, "scanner"),
            success: true,
            match: true,
            text: clientDecodedText,
            latencyMs: 0,
            engine: "dedup_guard",
            duplicate: true,
          });
        }

        const match = clientDecodedText === activeTest.payload.trim();

        const scanEvent: ScanLogEvent = {
          scanId: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          roomId: room.roomId,
          round: room.round,
          timestamp: new Date().toISOString(),
          testIndex: activeTestIndex,
          testId: activeTest.id,
          codeType: activeTest.codeType,
          label: activeTest.label,
          gridSide: activeTest.gridSide,
          eccLevel: activeTest.eccLevel,
          bitsPerCell: activeTest.bitsPerCell,
          expectedPayload: activeTest.payload,
          decodedPayload: clientDecodedText,
          match,
          status: match ? "PASS" : "MISMATCH",
          decodeLatencyMs: Number(decodeLatencyMs) || 0,
          clientTimeToScanMs: Number(clientTimeToScanMs) || 0,
          attempts: Number(attempts) || 1,
          decoderUsed: decoderUsed || engine || "unknown",
          deviceId: deviceId || "unknown",
          deviceName: body.deviceName || dev.deviceName || "Mobile Scanner",
          deviceBrand: body.deviceBrand || dev.deviceBrand,
          deviceModel: body.deviceModel || dev.deviceModel,
          os: body.os || dev.os,
          browser: body.browser || dev.browser,
          gpuRenderer: body.gpuRenderer || dev.gpuRenderer,
          gpuVendor: body.gpuVendor || dev.gpuVendor,
          screenResolution: body.screenResolution || dev.screenResolution,
          viewportResolution: body.viewportResolution || dev.viewportResolution,
          devicePixelRatio: body.devicePixelRatio || dev.devicePixelRatio,
          hardwareConcurrency: body.hardwareConcurrency || dev.hardwareConcurrency,
          deviceMemory: body.deviceMemory || dev.deviceMemory,
          cameraResolution: body.cameraResolution || dev.cameraResolution,
          cameraFps: body.cameraFps || dev.cameraFps,
          networkConnection: body.networkConnection || dev.networkConnection,
        };

        room.scanLogs.push(scanEvent);
        room.lastScanResultId = scanEvent.scanId;

        if (deviceId && room.devices[deviceId]) {
          const d = room.devices[deviceId];
          d.scansCompleted = (d.scansCompleted || 0) + 1;
          if (body.deviceName) d.deviceName = body.deviceName;
          if (body.deviceModel) d.deviceModel = body.deviceModel;
          if (body.deviceBrand) d.deviceBrand = body.deviceBrand;
          if (body.os) d.os = body.os;
          if (body.browser) d.browser = body.browser;
          if (body.gpuRenderer) d.gpuRenderer = body.gpuRenderer;
          if (body.cameraResolution) d.cameraResolution = body.cameraResolution;
          if (body.cameraFps) d.cameraFps = body.cameraFps;
        }

        // Auto-advance on match: advance to next item only if this was current test or ahead
        if (match) {
          if (activeTestIndex >= room.currentIndex) {
            if (activeTestIndex >= room.items.length - 1) {
              room.isCompleted = true;
              room.completedAt = new Date().toISOString();
            } else {
              room.currentIndex = activeTestIndex + 1;
            }
          }
        }

        saveRoom(room, true);
        broadcastRoomUpdate(room);

        return NextResponse.json({
          ...buildStandardRoomResponse(room, "scanner"),
          match,
          text: clientDecodedText,
          latencyMs: Number(decodeLatencyMs) || 0,
          engine: engine || "web_native",
          scanEvent,
        });
      }

      return NextResponse.json({ success: false, error: "Missing decodedPayload" }, { status: 400 });
    }

    // 4b. Timeout — client's per-item 10 s budget expired without a successful decode
    if (action === "timeout") {
      const { deviceId, testId: timeoutTestId, clientTimeToScanMs, attempts } = body;

      let activeTest = room.items[room.currentIndex];
      if (timeoutTestId) {
        const found = room.items.find((it) => it.id === timeoutTestId);
        if (found) activeTest = found;
      }

      if (!activeTest) {
        return NextResponse.json({ success: false, error: "No active test found in room" }, { status: 400 });
      }

      const activeTestIndex = room.items.indexOf(activeTest);
      const dev = (deviceId && room.devices[deviceId]) || {};

      // Dedup guard: don't record a TIMEOUT if a prior terminal event already exists.
      const alreadyTerminal = room.scanLogs.some(
        (l) =>
          l.testId === activeTest.id &&
          l.round === room.round &&
          (l.status === "PASS" || l.status === "SKIPPED" || l.status === "TIMEOUT" || l.status === "FAIL") &&
          (l.deviceId === (deviceId || "unknown") || !deviceId)
      );
      if (alreadyTerminal) {
        return NextResponse.json({
          ...buildStandardRoomResponse(room, "scanner"),
          success: true,
          duplicate: true,
          timedOut: true,
        });
      }

      const timeoutEvent: ScanLogEvent = {
        scanId: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        roomId: room.roomId,
        round: room.round,
        timestamp: new Date().toISOString(),
        testIndex: activeTestIndex,
        testId: activeTest.id,
        codeType: activeTest.codeType,
        label: activeTest.label,
        gridSide: activeTest.gridSide,
        eccLevel: activeTest.eccLevel,
        bitsPerCell: activeTest.bitsPerCell,
        expectedPayload: activeTest.payload,
        decodedPayload: "TIMEOUT",
        match: false,
        status: "TIMEOUT",
        decodeLatencyMs: 0,
        clientTimeToScanMs: Number(clientTimeToScanMs) || 10000,
        attempts: Number(attempts) || 0,
        decoderUsed: "timeout",
        deviceId: deviceId || "unknown",
        deviceName: dev.deviceName || "Mobile Scanner",
        deviceModel: dev.deviceModel,
        os: dev.os,
        browser: dev.browser,
      };

      room.scanLogs.push(timeoutEvent);
      room.lastScanResultId = timeoutEvent.scanId;

      // Auto-advance past the timed-out item only if this was current test or ahead
      if (activeTestIndex >= room.currentIndex) {
        if (activeTestIndex >= room.items.length - 1) {
          room.isCompleted = true;
          room.completedAt = new Date().toISOString();
        } else {
          room.currentIndex = activeTestIndex + 1;
        }
      }

      saveRoom(room, true);
      broadcastRoomUpdate(room);
      return NextResponse.json({
        ...buildStandardRoomResponse(room, "scanner"),
        timedOut: true,
        testId: activeTest.id,
      });
    }

    // 5. Navigation Step
    if (action === "step") {
      const direction = body.direction || searchParams.get("dir") || searchParams.get("direction");
      const index = typeof body.index === "number" ? body.index : searchParams.get("index") ? parseInt(searchParams.get("index")!, 10) : undefined;
      room.lastScanResultId = null;
      if (typeof index === "number") {
        room.currentIndex = Math.max(0, Math.min(room.items.length - 1, index));
        room.isCompleted = false;
      } else if (direction === "prev") {
        room.currentIndex = Math.max(0, room.currentIndex - 1);
        room.isCompleted = false;
      } else {
        if (room.currentIndex >= room.items.length - 1) {
          room.isCompleted = true;
          room.completedAt = new Date().toISOString();
        } else {
          room.currentIndex += 1;
        }
      }

      saveRoom(room);
      broadcastRoomUpdate(room);
      return NextResponse.json(buildStandardRoomResponse(room));
    }

    // 6. Skip Test
    if (action === "skip") {
      const { deviceId, reason } = body;
      const activeTest = room.items[room.currentIndex];
      const dev = (deviceId && room.devices[deviceId]) || {};

      if (activeTest) {
        const skipEvent: ScanLogEvent = {
          scanId: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          roomId: room.roomId,
          round: room.round,
          timestamp: new Date().toISOString(),
          testIndex: room.currentIndex,
          testId: activeTest.id,
          codeType: activeTest.codeType,
          label: activeTest.label,
          gridSide: activeTest.gridSide,
          eccLevel: activeTest.eccLevel,
          bitsPerCell: activeTest.bitsPerCell,
          expectedPayload: activeTest.payload,
          decodedPayload: reason || "SKIPPED_BY_USER",
          match: false,
          status: "SKIPPED",
          decodeLatencyMs: 0,
          clientTimeToScanMs: 0,
          attempts: 0,
          decoderUsed: "skip",
          deviceId: deviceId || "unknown",
          deviceName: dev.deviceName || "Mobile Scanner",
          deviceModel: dev.deviceModel,
          os: dev.os,
          browser: dev.browser,
        };
        room.scanLogs.push(skipEvent);
        room.lastScanResultId = skipEvent.scanId;
      }

      if (room.currentIndex >= room.items.length - 1) {
        room.isCompleted = true;
        room.completedAt = new Date().toISOString();
      } else {
        room.currentIndex += 1;
      }

      saveRoom(room);
      broadcastRoomUpdate(room);
      return NextResponse.json(buildStandardRoomResponse(room));
    }

    // 7. Start New Round
    if (action === "new_round" || action === "new-round") {
      // R2 fix: snapshot current round's logs into roundHistory before clearing,
      // so per-round stats remain available for export without cross-round bleed.
      if (!room.roundHistory) room.roundHistory = [];
      if (room.scanLogs.length > 0) {
        room.roundHistory.push({ round: room.round, logs: [...room.scanLogs] });
      }
      room.scanLogs = [];  // clear for fresh round — export joins roundHistory + scanLogs
      room.round = (room.round || 1) + 1;
      room.currentIndex = 0;
      room.isCompleted = false;
      room.completedAt = null;
      room.lastScanResultId = null;
      saveRoom(room);
      broadcastRoomUpdate(room);
      return NextResponse.json(buildStandardRoomResponse(room));
    }

    return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error: unknown) {
    return NextResponse.json({ success: false, error: errorMessage(error, "Internal server error") }, { status: 500 });
  }
}
