import { spawn, ChildProcess } from "child_process";
import path from "path";
import readline from "readline";

/**
 * Shared access to scripts/api_bridge.py for every API route.
 *
 * - callDaemon(): a persistent worker process (avoids ~1 s Python start-up per
 *   call). Requests carry an `_id` that the worker echoes back, and replies are
 *   matched by id, never by arrival order: a timed-out request is still
 *   answered later, and an order-based queue would hand that late reply to the
 *   next caller. The worker is single-threaded, so only short, latency-sensitive
 *   actions (decode, decrypt, encode) belong here.
 * - callOnce(): a fresh process per call, for long jobs (version matrix, test
 *   suite generation) that must not block live decoding behind them.
 */

export type BridgeResult = { success?: boolean; error?: string; [key: string]: unknown };

const SCRIPT_PATH = path.resolve(process.cwd(), "scripts", "api_bridge.py");
const PYTHON_EXE = process.env.PYTHON_PATH || "python";

interface Pending {
  resolve: (value: BridgeResult) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

let worker: ChildProcess | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

function failAll(err: Error) {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(err);
  }
  pending.clear();
}

function getWorker(): ChildProcess {
  if (worker && !worker.killed && worker.exitCode === null && worker.stdin?.writable) {
    return worker;
  }
  if (worker) {
    try {
      worker.kill();
    } catch {}
  }

  const proc = spawn(/*turbopackIgnore: true*/ PYTHON_EXE, [SCRIPT_PATH, "daemon"], { stdio: ["pipe", "pipe", "pipe"] });
  if (!proc.stdout || !proc.stdin) {
    throw new Error("Unable to establish stdio with Python bridge worker");
  }

  readline.createInterface({ input: proc.stdout, terminal: false }).on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.includes('"READY"')) return;
    let parsed: BridgeResult & { _id?: unknown };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.warn("[python bridge] unparseable line dropped:", trimmed.slice(0, 200));
      return;
    }
    const id = parsed._id;
    const item = typeof id === "number" ? pending.get(id) : undefined;
    if (!item) return; // reply to a request that already timed out
    pending.delete(id as number);
    clearTimeout(item.timer);
    delete parsed._id;
    item.resolve(parsed);
  });

  proc.stderr?.on("data", (data) => {
    const text = data.toString().trim();
    if (text) console.warn("[python bridge stderr]:", text);
  });
  proc.on("error", (err) => {
    console.error("[python bridge] worker error:", err);
    failAll(err);
    worker = null;
  });
  proc.on("exit", (code) => {
    failAll(new Error(`Python bridge worker exited with code ${code}`));
    worker = null;
  });

  worker = proc;
  return proc;
}

/** Send one request to the persistent worker. `data.action` selects the handler. */
export function callDaemon(data: Record<string, unknown>, timeoutMs = 10_000): Promise<BridgeResult> {
  const proc = getWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Python bridge request timed out (${timeoutMs} ms)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin!.write(JSON.stringify({ ...data, _id: id }) + "\n");
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Extract the useful line from a Python traceback (prefers a ValueError message). */
function cleanStderr(stderr: string): string {
  const text = stderr.trim();
  const valueError = text.match(/ValueError:\s*([\s\S]+)/);
  if (valueError) return valueError[1].trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** Run `action` in a fresh Python process. Errors are returned, not thrown. */
export function callOnce(action: string, data: Record<string, unknown>, timeoutMs = 120_000): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const proc = spawn(/*turbopackIgnore: true*/ PYTHON_EXE, [SCRIPT_PATH, action]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ success: false, error: `Python bridge '${action}' timed out (${timeoutMs} ms)` });
    }, timeoutMs);

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ success: false, error: `Failed to start Python bridge: ${err.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({
          success: false,
          error: cleanStderr(stderr) || `Python bridge '${action}' exited with code ${code} and no JSON output`,
        });
      }
    });

    proc.stdin.write(JSON.stringify(data));
    proc.stdin.end();
  });
}

/** Daemon first; if the worker is unavailable or times out, fall back to a one-shot process. */
export async function callBridge(
  action: string,
  data: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<BridgeResult> {
  try {
    return await callDaemon({ ...data, action }, timeoutMs);
  } catch (err) {
    console.warn(`[python bridge] daemon '${action}' failed, falling back to one-shot:`, err);
    return callOnce(action, data, Math.max(timeoutMs * 3, 30_000));
  }
}
