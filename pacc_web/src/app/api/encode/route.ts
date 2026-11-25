import { NextRequest, NextResponse } from "next/server";
import { callBridge } from "@/lib/server/pythonBridge";

/** Accept 0–3 / -1 numerically, or QR-style L/M/Q/H letters mapped to 0–3. */
function parseEccLevel(value: unknown): number {
  if (typeof value === "number" && !isNaN(value)) return value;
  if (typeof value !== "string") return -1;
  const letter = { L: 0, M: 1, Q: 2, H: 3 }[value.trim().toUpperCase()];
  if (letter !== undefined) return letter;
  const n = parseInt(value, 10);
  return isNaN(n) ? -1 : n;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { text, text_l2, multilayer, password, cell_size, ecc_level, min_copies, kdf_profile, encryption_target } = body;

    if (!text && text !== "") {
      return NextResponse.json({ success: false, error: "Text payload is required" }, { status: 400 });
    }

    const result = await callBridge(
      "encode",
      {
        text,
        text_l2: text_l2 || "",
        multilayer: !!multilayer,
        encryption_target: encryption_target || "both",
        password: password || null,
        kdf_profile: kdf_profile || "standard",
        cell_size: cell_size && !isNaN(Number(cell_size)) ? Number(cell_size) : 10,
        ecc_level: parseEccLevel(ecc_level),
        min_copies: min_copies && !isNaN(Number(min_copies)) ? Number(min_copies) : 2,
      },
      30_000
    );

    if (result.success === false) {
      // Encoder errors (e.g. capacity exceeded) are user-input problems.
      return NextResponse.json(result, { status: 400 });
    }
    // Clients read either spelling.
    if (result.dataUrl && !result.data_url) result.data_url = result.dataUrl;
    else if (result.data_url && !result.dataUrl) result.dataUrl = result.data_url;
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
