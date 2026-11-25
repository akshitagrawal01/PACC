import { NextRequest, NextResponse } from "next/server";
import { callBridge } from "@/lib/server/pythonBridge";

// Actions this public route may forward. Everything else the bridge supports
// (encode, test-suite generation, ...) has its own route with its own checks.
const ALLOWED_ACTIONS = new Set(["decode"]);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const image_base64 = body.image_base64 || body.image || body.imageData || null;
    const action: string = body.action || "decode";
    const password = body.password ? String(body.password).trim() : null;

    if (!ALLOWED_ACTIONS.has(action)) {
      return NextResponse.json({ success: false, error: `Unsupported action: ${action}` }, { status: 400 });
    }

    if (!image_base64) {
      return NextResponse.json({ success: false, error: "Image data (base64) is required" }, { status: 400 });
    }

    // Server-side file paths are deliberately not forwarded: this route is
    // reachable from any browser, so a path would let clients read server files.
    const result = await callBridge(action, { image_base64, password });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
