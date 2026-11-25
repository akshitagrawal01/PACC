/**
 * Device Fingerprinting & Hardware Telemetry Engine
 * --------------------------------------------------
 * High-accuracy device identification combining:
 * 1. Chromium User-Agent Client Hints (model, platformVersion) with Accept-CH headers
 * 2. Exhaustive Android model & brand dictionary (Samsung, Pixel, OnePlus, OPPO, Realme, Xiaomi, POCO, Vivo, iQOO, Motorola, Nothing)
 * 3. iOS hardware screen dimension & DPR lookup table
 * 4. WebGL GPU renderer normalization & mobile SoC chipset inference (Snapdragon, Dimensity, Tensor, Exynos, Apple A-series)
 * 5. Dynamic camera resolution tracking
 * 6. User-customizable persistent device name
 */

import { navigatorExtras, type NavigatorExtras } from "./browserApis";

export interface HardwareFingerprint {
  deviceId: string;
  deviceName: string;
  deviceBrand: string;
  deviceModel: string;
  os: string;
  browser: string;
  userAgent: string;
  platform: string;
  screenResolution: string;
  viewportResolution: string;
  devicePixelRatio: number;
  colorDepth: string;
  hardwareConcurrency: number;
  deviceMemory: string;
  maxTouchPoints: number;
  networkConnection: string;
  gpuRenderer: string;
  gpuVendor: string;
  webglVersion: string;
  chipsetInferred?: string;
  cameraResolution?: string;
  cameraFps?: number;
}

export function getDeviceId(): string {
  if (typeof window === "undefined") return "server-client";
  let dId = localStorage.getItem("pacc_device_id");
  if (!dId) {
    dId = "dev-" + Math.random().toString(36).substring(2, 10);
    localStorage.setItem("pacc_device_id", dId);
  }
  return dId;
}

export function getCustomDeviceName(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("pacc_device_name");
}

export function setCustomDeviceName(name: string): void {
  if (typeof window === "undefined") return;
  if (name && name.trim()) {
    localStorage.setItem("pacc_device_name", name.trim());
  } else {
    localStorage.removeItem("pacc_device_name");
  }
}

// ─── GPU Normalization & Mobile SoC Inference ────────────────────────────────

export interface GpuHardwareInfo {
  gpuRenderer: string;
  gpuVendor: string;
  webglVersion: string;
  chipsetInferred?: string;
}

let _gpuInfoCache: GpuHardwareInfo | null = null;

function cleanGpuString(raw: string): { vendor: string; renderer: string } {
  let r = (raw || "").trim();
  let v = "Unknown Vendor";

  // Check ANGLE wrapper: ANGLE (Vendor, Device, ...)
  const angleMatch = r.match(/^ANGLE\s*\(\s*([^,]+?)\s*,\s*(.+)\s*\)$/i);
  if (angleMatch) {
    v = angleMatch[1].trim();
    r = angleMatch[2].trim();
  }

  // Strip backend trailer after comma e.g. ', OpenGL ES 3.2' or ', Direct3D11'
  r = r.replace(/,\s*(?:OpenGL|Direct3D|Vulkan|Metal|SwiftShader).*$/i, "");

  // Strip driver boilerplate
  r = r
    .replace(/\(TM\)|\(R\)/gi, "")
    .replace(/Direct3D\d+.*$/i, "")
    .replace(/OpenGL\s*ES.*$/i, "")
    .replace(/vs_\d+_\d+\s+ps_\d+_\d+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // Deduce vendor if generic
  if (/Mali|Immortalis/i.test(r)) v = "ARM";
  else if (/Adreno/i.test(r)) v = "Qualcomm";
  else if (/Apple/i.test(r)) v = "Apple";
  else if (/NVIDIA|GeForce/i.test(r)) v = "NVIDIA";
  else if (/Intel/i.test(r)) v = "Intel";
  else if (/AMD|Radeon|Xclipse/i.test(r)) v = "AMD";
  else if (/PowerVR/i.test(r)) v = "Imagination Technologies";

  return { vendor: v, renderer: r };
}

/**
 * Infers the phone's hardware processor / SoC tier from WebGL unmasked renderer.
 * On modern Android, the GPU renderer is NOT frozen by User-Agent reduction and
 * directly exposes the exact chipset class.
 */
export function inferSoCFromGpu(renderer: string): string | null {
  const r = renderer.toLowerCase();

  // Qualcomm Adreno Series
  if (r.includes("adreno 750")) return "Qualcomm Snapdragon 8 Gen 3 (Adreno 750)";
  if (r.includes("adreno 740")) return "Qualcomm Snapdragon 8 Gen 2 (Adreno 740)";
  if (r.includes("adreno 730")) return "Qualcomm Snapdragon 8 Gen 1 (Adreno 730)";
  if (r.includes("adreno 725")) return "Qualcomm Snapdragon 7+ Gen 2 (Adreno 725)";
  if (r.includes("adreno 720")) return "Qualcomm Snapdragon 7 Gen 3 (Adreno 720)";
  if (r.includes("adreno 710")) return "Qualcomm Snapdragon 7s Gen 2 / 6 Gen 1 (Adreno 710)";
  if (r.includes("adreno 660")) return "Qualcomm Snapdragon 888 (Adreno 660)";
  if (r.includes("adreno 650")) return "Qualcomm Snapdragon 865/870 (Adreno 650)";
  if (r.includes("adreno 644")) return "Qualcomm Snapdragon 7 Gen 1 (Adreno 644)";
  if (r.includes("adreno 642l")) return "Qualcomm Snapdragon 778G (Adreno 642L)";
  if (r.includes("adreno 619")) return "Qualcomm Snapdragon 695 5G (Adreno 619)";
  if (r.includes("adreno 618")) return "Qualcomm Snapdragon 720G/730G (Adreno 618)";
  if (r.includes("adreno 616")) return "Qualcomm Snapdragon 710/712 (Adreno 616)";
  if (r.includes("adreno 610")) return "Qualcomm Snapdragon 662/665 (Adreno 610)";

  // ARM Immortalis / Mali Series
  if (r.includes("immortalis-g720")) return "MediaTek Dimensity 9300 (ARM Immortalis-G720)";
  if (r.includes("immortalis-g715")) return "MediaTek Dimensity 9200 (ARM Immortalis-G715)";
  if (r.includes("mali-g715")) return "MediaTek Dimensity 8300 / Tensor G3 (ARM Mali-G715)";
  if (r.includes("mali-g710")) return "MediaTek Dimensity 9000 / Tensor G2 (ARM Mali-G710)";
  if (r.includes("mali-g78")) return "Google Tensor / Exynos 2100 (ARM Mali-G78)";
  if (r.includes("mali-g77")) return "MediaTek Dimensity 1000 / Exynos 990 (ARM Mali-G77)";
  if (r.includes("mali-g615")) return "MediaTek Dimensity 8200 (ARM Mali-G615)";
  if (r.includes("mali-g610")) return "MediaTek Dimensity 8100 (ARM Mali-G610)";
  if (r.includes("mali-g68")) return "Samsung Exynos 1380 / Dimensity 920 (ARM Mali-G68)";
  if (r.includes("mali-g57")) return "MediaTek Dimensity 700/810 / Helio G99 (ARM Mali-G57)";
  if (r.includes("mali-g52")) return "MediaTek Helio G85/G88 / Exynos 850 (ARM Mali-G52)";

  // Samsung Xclipse (AMD RDNA on Exynos)
  if (r.includes("xclipse 940")) return "Samsung Exynos 2400 (AMD RDNA3 Xclipse 940)";
  if (r.includes("xclipse 920")) return "Samsung Exynos 2200 (AMD RDNA2 Xclipse 920)";
  if (r.includes("xclipse 530")) return "Samsung Exynos 1480 (AMD RDNA Xclipse 530)";

  // Apple GPUs
  if (r.includes("apple a18 pro")) return "Apple A18 Pro (iPhone 16 Pro Series)";
  if (r.includes("apple a18")) return "Apple A18 (iPhone 16 Series)";
  if (r.includes("apple a17 pro")) return "Apple A17 Pro (iPhone 15 Pro Series)";
  if (r.includes("apple a16")) return "Apple A16 Bionic (iPhone 14 Pro / 15)";
  if (r.includes("apple a15")) return "Apple A15 Bionic (iPhone 13 / 14)";
  if (r.includes("apple a14")) return "Apple A14 Bionic (iPhone 12)";

  return null;
}

export function getGpuHardware(): GpuHardwareInfo {
  if (_gpuInfoCache) return _gpuInfoCache;
  if (typeof window === "undefined") {
    return (_gpuInfoCache = { gpuRenderer: "SSR", gpuVendor: "SSR", webglVersion: "None" });
  }
  try {
    const canvas = document.createElement("canvas");
    const gl =
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl") ||
      canvas.getContext("experimental-webgl");
    if (!gl) {
      return (_gpuInfoCache = { gpuRenderer: "No WebGL", gpuVendor: "Software", webglVersion: "None" });
    }
    const glCtx = gl as WebGLRenderingContext;
    const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const dbg = glCtx.getExtension("WEBGL_debug_renderer_info");
    const rawRenderer = dbg ? (glCtx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : "";
    const rawVendor = dbg ? (glCtx.getParameter(dbg.UNMASKED_VENDOR_WEBGL) as string) : "";

    const cleaned = cleanGpuString(rawRenderer || (glCtx.getParameter(glCtx.RENDERER) as string) || "GPU");
    const inferred = inferSoCFromGpu(cleaned.renderer);

    return (_gpuInfoCache = {
      gpuRenderer: cleaned.renderer,
      gpuVendor: cleaned.vendor || rawVendor || "Hardware",
      webglVersion: isWebGL2 ? "WebGL 2.0" : "WebGL 1.0",
      chipsetInferred: inferred || undefined,
    });
  } catch {
    return (_gpuInfoCache = { gpuRenderer: "Unknown GPU", gpuVendor: "Unknown Vendor", webglVersion: "None" });
  }
}

// ─── Model Dictionaries ──────────────────────────────────────────────────────

function detectIPhoneModel(w: number, h: number, dpr: number): string | null {
  const min = Math.min(w, h);
  const max = Math.max(w, h);

  if (dpr >= 2.8) {
    if (min === 440 && max === 956) return "iPhone 16 Pro Max";
    if (min === 402 && max === 874) return "iPhone 16 Pro";
    if (min === 430 && max === 932) return "iPhone 15/16 Plus or 14/15 Pro Max";
    if (min === 393 && max === 852) return "iPhone 16/15/14 Pro";
    if (min === 428 && max === 926) return "iPhone 14 Plus / 13 Pro Max / 12 Pro Max";
    if (min === 390 && max === 844) return "iPhone 14 / 13 / 12";
    if (min === 375 && max === 812) return "iPhone 13 mini / 12 mini / 11 Pro / XS";
    if (min === 414 && max === 896) return "iPhone 11 Pro Max / XS Max";
  } else if (dpr >= 1.8) {
    if (min === 414 && max === 896) return "iPhone 11 / XR";
    if (min === 375 && max === 667) return "iPhone SE / 8 / 7";
    if (min >= 768) return "iPad";
  }
  return null;
}

/**
 * Comprehensive parser for Android model codes reported by Client Hints,
 * User-Agent strings, or HTTP headers.
 */
export function parseAndroidModelCode(code: string): { brand: string; model: string } {
  const c = (code || "").trim();
  if (!c || c === "K" || c === "U" || c.toLowerCase() === "generic") {
    return { brand: "Android", model: "Smartphone" };
  }

  // 1. Google Pixel
  if (/^Pixel/i.test(c)) {
    return { brand: "Google", model: c };
  }

  // 2. Samsung Galaxy Models
  const smMatch = c.match(/^SM-([A-Z0-9]+)/i);
  if (smMatch) {
    const sm = smMatch[1].toUpperCase();
    let friendly = `Galaxy (${c})`;

    // S-series Ultra / Plus / Base
    if (sm.startsWith("S928")) friendly = "Galaxy S24 Ultra";
    else if (sm.startsWith("S926")) friendly = "Galaxy S24+";
    else if (sm.startsWith("S921")) friendly = "Galaxy S24";
    else if (sm.startsWith("S918")) friendly = "Galaxy S23 Ultra";
    else if (sm.startsWith("S916")) friendly = "Galaxy S23+";
    else if (sm.startsWith("S911")) friendly = "Galaxy S23";
    else if (sm.startsWith("S908")) friendly = "Galaxy S22 Ultra";
    else if (sm.startsWith("S906")) friendly = "Galaxy S22+";
    else if (sm.startsWith("S901")) friendly = "Galaxy S22";
    else if (sm.startsWith("G998")) friendly = "Galaxy S21 Ultra";
    else if (sm.startsWith("G996")) friendly = "Galaxy S21+";
    else if (sm.startsWith("G991")) friendly = "Galaxy S21";
    else if (sm.startsWith("G990")) friendly = "Galaxy S21 FE";
    else if (sm.startsWith("G780") || sm.startsWith("G781")) friendly = "Galaxy S20 FE";
    // Note series
    else if (sm.startsWith("N986") || sm.startsWith("N985")) friendly = "Galaxy Note 20 Ultra";
    else if (sm.startsWith("N981") || sm.startsWith("N980")) friendly = "Galaxy Note 20";
    // Z Fold / Flip
    else if (sm.startsWith("F956")) friendly = "Galaxy Z Fold 6";
    else if (sm.startsWith("F946")) friendly = "Galaxy Z Fold 5";
    else if (sm.startsWith("F936")) friendly = "Galaxy Z Fold 4";
    else if (sm.startsWith("F926")) friendly = "Galaxy Z Fold 3";
    else if (sm.startsWith("F741")) friendly = "Galaxy Z Flip 6";
    else if (sm.startsWith("F731")) friendly = "Galaxy Z Flip 5";
    else if (sm.startsWith("F721")) friendly = "Galaxy Z Flip 4";
    else if (sm.startsWith("F711")) friendly = "Galaxy Z Flip 3";
    // A-series
    else if (sm.startsWith("A556") || sm.startsWith("A55")) friendly = "Galaxy A55 5G";
    else if (sm.startsWith("A546") || sm.startsWith("A54")) friendly = "Galaxy A54 5G";
    else if (sm.startsWith("A536") || sm.startsWith("A53")) friendly = "Galaxy A53 5G";
    else if (sm.startsWith("A528") || sm.startsWith("A526") || sm.startsWith("A525")) friendly = "Galaxy A52s / A52";
    else if (sm.startsWith("A356") || sm.startsWith("A35")) friendly = "Galaxy A35 5G";
    else if (sm.startsWith("A346") || sm.startsWith("A34")) friendly = "Galaxy A34 5G";
    else if (sm.startsWith("A336") || sm.startsWith("A33")) friendly = "Galaxy A33 5G";
    else if (sm.startsWith("A256") || sm.startsWith("A25")) friendly = "Galaxy A25 5G";
    else if (sm.startsWith("A156") || sm.startsWith("A155") || sm.startsWith("A15")) friendly = "Galaxy A15";
    else if (sm.startsWith("A146") || sm.startsWith("A145") || sm.startsWith("A14")) friendly = "Galaxy A14";
    // M & F series
    else if (sm.startsWith("M54") || sm.startsWith("M34") || sm.startsWith("M14")) friendly = `Galaxy M${sm.substring(1, 3)}`;
    else if (sm.startsWith("E54") || sm.startsWith("E34") || sm.startsWith("E14")) friendly = `Galaxy F${sm.substring(1, 3)}`;

    return { brand: "Samsung", model: friendly };
  }

  // 3. Realme Models (RMX...)
  if (/^RMX([0-9]+)/i.test(c)) {
    const rmx = c.toUpperCase();
    let friendly = `Realme (${rmx})`;
    if (rmx.startsWith("RMX3851") || rmx.startsWith("RMX3850")) friendly = "Realme GT 6";
    else if (rmx.startsWith("RMX3820") || rmx.startsWith("RMX3823")) friendly = "Realme GT5";
    else if (rmx.startsWith("RMX3706") || rmx.startsWith("RMX3708")) friendly = "Realme GT Neo 5";
    else if (rmx.startsWith("RMX3840") || rmx.startsWith("RMX3842")) friendly = "Realme 12 Pro+";
    else if (rmx.startsWith("RMX3867")) friendly = "Realme 12+ 5G";
    else if (rmx.startsWith("RMX3771") || rmx.startsWith("RMX3770")) friendly = "Realme 11 Pro+";
    else if (rmx.startsWith("RMX3740") || rmx.startsWith("RMX3741")) friendly = "Realme 11 5G";
    else if (rmx.startsWith("RMX3686")) friendly = "Realme 10 Pro+";
    else if (rmx.startsWith("RMX3360") || rmx.startsWith("RMX3363")) friendly = "Realme GT Master";
    else if (rmx.startsWith("RMX3561")) friendly = "Realme GT Neo 3";
    return { brand: "Realme", model: friendly };
  }

  // 4. OnePlus Models (Clean model naming, avoid "OnePlus OnePlus" duplication)
  if (/^CPH(2581|2583|2609|2611|2449|2451|2413|2415|2613|2493|2491|2469|2569)/i.test(c) || /OnePlus/i.test(c)) {
    const clean = c.replace(/^OnePlus\s+/i, "");
    let friendly = clean;
    if (/CPH2581|CPH2583/i.test(c)) friendly = "OnePlus 12";
    else if (/CPH2609|CPH2611/i.test(c)) friendly = "OnePlus 12R";
    else if (/CPH2449|CPH2451/i.test(c)) friendly = "OnePlus 11";
    else if (/CPH2413|CPH2415/i.test(c)) friendly = "OnePlus 10T";
    else if (/NE2215|NE2213|NE2211/i.test(c)) friendly = "OnePlus 10 Pro";
    else if (/LE2121|LE2123|LE2125/i.test(c)) friendly = "OnePlus 9 Pro";
    else if (/LE2111|LE2113/i.test(c)) friendly = "OnePlus 9";
    else if (/IN2023|IN2025/i.test(c)) friendly = "OnePlus 8 Pro";
    else if (/KB2003|KB2005/i.test(c)) friendly = "OnePlus 8T";
    else if (/CPH2613/i.test(c)) friendly = "OnePlus Nord 4";
    else if (/CPH2493|CPH2491/i.test(c)) friendly = "OnePlus Nord 3";
    else if (/DN2103|DN2101/i.test(c)) friendly = "OnePlus Nord 2";
    else if (/CPH2469/i.test(c)) friendly = "OnePlus Nord CE 3 Lite";
    else if (/CPH2569/i.test(c)) friendly = "OnePlus Nord CE 4";
    return { brand: "OnePlus", model: friendly.startsWith("OnePlus") ? friendly : `OnePlus ${friendly}` };
  }

  // 5. OPPO Models
  if (/^CPH(2551|2437|2305|2529|2531|2607|2619|2579|2387|2483)/i.test(c) || /OPPO/i.test(c)) {
    let friendly = c.replace(/^OPPO\s+/i, "");
    if (/CPH2551/i.test(c)) friendly = "Find N3";
    else if (/CPH2437/i.test(c)) friendly = "Find N2 Flip";
    else if (/CPH2305/i.test(c)) friendly = "Find X5 Pro";
    else if (/CPH2529|CPH2531/i.test(c)) friendly = "Reno 10 Pro";
    else if (/CPH2607/i.test(c)) friendly = "Reno 11 Pro";
    else if (/CPH2619/i.test(c)) friendly = "Reno 12 Pro";
    else if (/CPH2579/i.test(c)) friendly = "A79 5G";
    return { brand: "OPPO", model: friendly };
  }

  // 6. Xiaomi / Redmi / POCO
  if (/^(2[1-4][0-9]{2}[A-Z0-9]+)/i.test(c) || /Redmi|POCO|Xiaomi/i.test(c)) {
    let friendly = c;
    if (/24030PN60/i.test(c)) friendly = "Xiaomi 14 Ultra";
    else if (/23127PN0C/i.test(c)) friendly = "Xiaomi 14";
    else if (/2210132G/i.test(c)) friendly = "Xiaomi 13 Pro";
    else if (/23078PND5G/i.test(c)) friendly = "Xiaomi 13T Pro";
    else if (/24069PC21/i.test(c)) friendly = "POCO F6";
    else if (/24053PY09/i.test(c)) friendly = "POCO F6 Pro";
    else if (/23049PCD8/i.test(c)) friendly = "POCO F5";
    else if (/23013PC75/i.test(c)) friendly = "POCO F5 Pro";
    else if (/2311DRK48/i.test(c)) friendly = "POCO X6 Pro";
    else if (/23122PCD1/i.test(c)) friendly = "POCO X6 5G";
    else if (/2312DRA50/i.test(c)) friendly = "Redmi Note 13 Pro+";
    else if (/23117RA68/i.test(c)) friendly = "Redmi Note 13 Pro";
    else if (/22101316/i.test(c)) friendly = "Redmi Note 12 Pro";
    const brand = /POCO/i.test(friendly) ? "POCO" : /Redmi/i.test(friendly) ? "Redmi" : "Xiaomi";
    return { brand, model: friendly };
  }

  // 7. Vivo / iQOO
  if (/^V(2[1-4][0-9]{2})/i.test(c) || /vivo/i.test(c)) {
    let friendly = c;
    if (/V2309/i.test(c)) friendly = "Vivo X100 Pro";
    else if (/V2324/i.test(c)) friendly = "Vivo X100";
    else if (/V2303/i.test(c)) friendly = "Vivo V30 Pro";
    else if (/V2318/i.test(c)) friendly = "Vivo V30";
    else if (/V2250/i.test(c)) friendly = "Vivo V27";
    else if (/V2241/i.test(c)) friendly = "Vivo X90";
    return { brand: "Vivo", model: friendly };
  }
  if (/^I(2[0-3][0-9]{2})/i.test(c) || /iQOO/i.test(c)) {
    let friendly = c;
    if (/I2217/i.test(c)) friendly = "iQOO 12";
    else if (/I2220/i.test(c)) friendly = "iQOO Neo 9 Pro";
    else if (/I2202/i.test(c)) friendly = "iQOO 11";
    else if (/I2207/i.test(c)) friendly = "iQOO Neo 7";
    return { brand: "iQOO", model: friendly };
  }

  // 8. Nothing Phone
  if (/A063|A065|A142|Nothing/i.test(c)) {
    let friendly = "Nothing Phone";
    if (c.includes("A142P")) friendly = "Phone (2a) Plus";
    else if (c.includes("A142")) friendly = "Phone (2a)";
    else if (c.includes("A065")) friendly = "Phone (2)";
    else if (c.includes("A063")) friendly = "Phone (1)";
    return { brand: "Nothing", model: friendly };
  }

  // 9. Motorola
  if (/^XT(2[0-4][0-9]{2})/i.test(c) || /moto/i.test(c) || /motorola/i.test(c)) {
    let friendly = c;
    if (/XT2401/i.test(c)) friendly = "Motorola Edge 50 Pro";
    else if (/XT2403/i.test(c)) friendly = "Motorola Edge 50 Ultra";
    else if (/XT2301|XT2307/i.test(c)) friendly = "Motorola Edge 40 Pro";
    else if (/XT2303/i.test(c)) friendly = "Motorola Edge 40";
    else if (/XT2341|XT2343/i.test(c)) friendly = "Moto G84 5G";
    else if (/XT2345/i.test(c)) friendly = "Moto G54 5G";
    else if (/XT2321/i.test(c)) friendly = "Motorola Razr 40 Ultra";
    else if (/XT2453/i.test(c)) friendly = "Motorola Razr 50 Ultra";
    return { brand: "Motorola", model: friendly };
  }

  // 10. Sony Xperia
  if (/^XQ-/i.test(c) || /Xperia/i.test(c)) {
    return { brand: "Sony", model: "Xperia " + c.replace(/^Xperia\s+/i, "") };
  }

  // 11. ASUS ROG
  if (/^ASUS_AI/i.test(c) || /ROG/i.test(c)) {
    return { brand: "ASUS", model: "ROG Phone (" + c + ")" };
  }

  // Default fallback
  return { brand: "Android", model: c };
}

// ─── Display Categorization ──────────────────────────────────────────────────

function formatScreenResolution(scr: Screen, dpr: number): string {
  const minSide = Math.min(scr.width, scr.height);
  const maxSide = Math.max(scr.width, scr.height);
  const physW = Math.round(minSide * dpr);
  const physH = Math.round(maxSide * dpr);

  // Match common physical panel specs
  let category = "";
  if (physW >= 1400 && physH >= 3000) category = " (QHD+)";
  else if (physW >= 1200 && physH >= 2600) category = " (1.5K)";
  else if (physW >= 1000 && physH >= 2300) category = " (FHD+)";
  else if (physW >= 700 && physH >= 1500) category = " (HD+)";

  return `${physW}x${physH}${category} @ ${dpr.toFixed(2).replace(/\.00$/, "")}x`;
}

// ─── Main Synchronous Fingerprint ───────────────────────────────────────────

export function getHardwareFingerprint(cameraInfo?: { resolution?: string; fps?: number }): HardwareFingerprint {
  if (typeof window === "undefined") {
    return {
      deviceId: "server-node",
      deviceName: "Server Node",
      deviceBrand: "Server",
      deviceModel: "Headless",
      os: "Server",
      browser: "Server",
      userAgent: "Server",
      platform: "Server",
      screenResolution: "1920x1080",
      viewportResolution: "1920x1080",
      devicePixelRatio: 1,
      colorDepth: "24-bit",
      hardwareConcurrency: 4,
      deviceMemory: "unknown",
      maxTouchPoints: 0,
      networkConnection: "unknown",
      gpuRenderer: "SSR",
      gpuVendor: "SSR",
      webglVersion: "None",
    };
  }

  const nav = navigatorExtras();
  const ua = nav.userAgent || "";
  const dId = getDeviceId();
  const customName = getCustomDeviceName();
  const scr = window.screen;
  const dpr = window.devicePixelRatio || 1;

  // OS detection
  let os = "Unknown OS";
  let brand = "Generic";
  let model = "Device";

  const isIPad =
    (/iPad/i.test(ua) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1)) &&
    !/iPhone/i.test(ua);

  if (/Windows NT 10.0/i.test(ua)) os = "Windows 10/11";
  else if (/Windows NT 6.3/i.test(ua)) os = "Windows 8.1";
  else if (/Windows NT 6.1/i.test(ua)) os = "Windows 7";
  else if (/iPhone OS ([\d_]+)/i.test(ua)) {
    os = "iOS " + (ua.match(/iPhone OS ([\d_]+)/i)?.[1] || "").replace(/_/g, ".");
    brand = "Apple";
    const detected = detectIPhoneModel(scr.width, scr.height, dpr);
    model = detected || "iPhone";
  } else if (isIPad) {
    os = "iPadOS";
    brand = "Apple";
    model = "iPad";
  } else if (/Mac OS X 10[._](\d+)/i.test(ua) || /Macintosh/i.test(ua)) {
    os = "macOS";
    brand = "Apple";
    model = "Mac";
  } else if (/Android\s+([\d.]+)/i.test(ua)) {
    const rawVer = ua.match(/Android\s+([\d.]+)/i)?.[1] || "";
    // Notice: Android 10 is the frozen value in reduced UAs.
    // If modern features exist, mark as modern Android pending Client Hints enrichment.
    // Older browsers lack these despite lib.dom typing them as always present.
    const optionalNav = nav as Partial<Navigator> & NavigatorExtras;
    if (rawVer === "10" && (optionalNav.wakeLock || optionalNav.canShare || optionalNav.userAgentData)) {
      os = "Android (Modern)";
    } else {
      os = rawVer ? `Android ${rawVer}` : "Android";
    }
    brand = "Android";

    // Check if model was preserved in non-reduced UA (older browsers or custom roms)
    const androidMatch = ua.match(/;\s*([^;]+?)\s*Build\//i);
    if (androidMatch && androidMatch[1]) {
      const parsed = parseAndroidModelCode(androidMatch[1]);
      brand = parsed.brand;
      model = parsed.model;
    } else {
      model = "Smartphone";
    }
  } else if (/Linux/i.test(ua)) {
    os = "Linux";
  }

  // Windows model fallback
  if (os.startsWith("Windows")) {
    brand = "PC";
    model = "Workstation";
  }

  // Browser detection
  let browser = "Unknown Browser";
  if (/SamsungBrowser\/([\d.]+)/i.test(ua)) {
    browser = `Samsung Internet ${ua.match(/SamsungBrowser\/([\d.]+)/i)?.[1] || ""}`.trim();
  } else if (/Chrome\/([\d.]+)/i.test(ua) && !/Edg|OPR/i.test(ua)) {
    browser = `Chrome ${ua.match(/Chrome\/([\d.]+)/i)?.[1] || ""}`.trim();
  } else if (/Safari\/([\d.]+)/i.test(ua) && !/Chrome/i.test(ua)) {
    browser = `Safari ${ua.match(/Version\/([\d.]+)/i)?.[1] || ""}`.trim();
  } else if (/Firefox\/([\d.]+)/i.test(ua)) {
    browser = `Firefox ${ua.match(/Firefox\/([\d.]+)/i)?.[1] || ""}`.trim();
  } else if (/Edg\/([\d.]+)/i.test(ua)) {
    browser = `Edge ${ua.match(/Edg\/([\d.]+)/i)?.[1] || ""}`.trim();
  }

  const gpu = getGpuHardware();

  // If the model couldn't be parsed from the frozen User-Agent, infer from the GPU / SoC!
  if (brand === "Android" && model === "Smartphone" && gpu.chipsetInferred) {
    model = gpu.chipsetInferred;
    if (gpu.gpuVendor === "Qualcomm") brand = "Qualcomm";
    else if (gpu.gpuVendor === "ARM") brand = "MediaTek/Tensor";
    else if (gpu.gpuVendor === "AMD") brand = "Samsung";
  }

  const screenResStr = formatScreenResolution(scr, dpr);

  const defaultName =
    brand === "Generic" || model === "Device"
      ? `${os} Device`
      : `${brand} ${model} (${os})`;

  return {
    deviceId: dId,
    deviceName: customName || defaultName,
    deviceBrand: brand,
    deviceModel: model,
    os,
    browser,
    userAgent: ua,
    platform: nav.platform || "unknown",
    screenResolution: screenResStr,
    viewportResolution: `${window.innerWidth}x${window.innerHeight}`,
    devicePixelRatio: dpr,
    colorDepth: `${scr.colorDepth || 24}-bit`,
    hardwareConcurrency: nav.hardwareConcurrency || 4,
    deviceMemory: nav.deviceMemory ? `${nav.deviceMemory} GB` : "unknown",
    maxTouchPoints: nav.maxTouchPoints || 0,
    networkConnection: nav.connection?.effectiveType || "unknown",
    gpuRenderer: gpu.gpuRenderer,
    gpuVendor: gpu.gpuVendor,
    webglVersion: gpu.webglVersion,
    chipsetInferred: gpu.chipsetInferred,
    cameraResolution: cameraInfo?.resolution || "1280x720",
    cameraFps: cameraInfo?.fps || 30,
  };
}

// ─── Asynchronous Client Hints Enrichment ───────────────────────────────────

/**
 * Enriches the hardware fingerprint by querying Chromium User-Agent Client Hints.
 * This unlocks the true hardware model (e.g. "Pixel 8 Pro", "SM-S928B", "CPH2581")
 * and true Android version (e.g. "Android 14").
 */
export async function enrichHardwareFingerprint(
  base: HardwareFingerprint
): Promise<HardwareFingerprint> {
  if (typeof window === "undefined") return base;

  const nav = navigatorExtras();
  if (!nav.userAgentData?.getHighEntropyValues) {
    return base;
  }

  try {
    const hints = await nav.userAgentData.getHighEntropyValues([
      "model",
      "platform",
      "platformVersion",
      "architecture",
      "bitness",
    ]);

    let updatedBrand = base.deviceBrand;
    let updatedModel = base.deviceModel;
    let updatedOs = base.os;

    if (hints.model && hints.model.trim()) {
      const parsed = parseAndroidModelCode(hints.model);
      updatedBrand = parsed.brand;
      updatedModel = parsed.model;
    }

    if (hints.platformVersion && base.os.startsWith("Android")) {
      const major = parseInt(hints.platformVersion.split(".")[0], 10);
      if (!isNaN(major) && major > 0) {
        if (major >= 10) {
          updatedOs = `Android ${major}`;
        } else if (major === 3) {
          updatedOs = "Android 11";
        } else if (major === 2) {
          updatedOs = "Android 10";
        } else if (major === 1) {
          updatedOs = "Android 9";
        }
      }
    }

    const customName = getCustomDeviceName();
    const newDefaultName = `${updatedBrand} ${updatedModel} (${updatedOs})`;

    return {
      ...base,
      deviceName: customName || newDefaultName,
      deviceBrand: updatedBrand,
      deviceModel: updatedModel,
      os: updatedOs,
    };
  } catch {
    return base;
  }
}
