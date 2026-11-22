import type {
  CaptureMode,
  FaceBox,
  RoiBox,
  RoiExtractionResult,
  RoiRgbTriplet,
  ZoneGuidance,
} from "../types/rppg";

interface NativeDetectedFace {
  boundingBox: DOMRectReadOnly;
}

interface NativeFaceDetectorInstance {
  detect(source: HTMLVideoElement): Promise<NativeDetectedFace[]>;
}

function estimateCorrelatedColorTempK(r: number, g: number, b: number): number {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const sum = X + Y + Z;
  if (sum <= 1e-6) return 5500;
  const x = X / sum;
  const y = Y / sum;
  const denom = 0.1858 - y;
  if (Math.abs(denom) < 1e-4) return 5500;
  const n = (x - 0.332) / denom;
  const cct = 449 * n * n * n + 3525 * n * n + 6823.3 * n + 5520.33;
  return Math.round(Math.max(2200, Math.min(9500, cct)));
}

/**
 * Dual-mode skin tone classifier (YCbCr + Kovac RGB ratio) covering Fitzpatrick I-VI
 * under warm and cool lighting once Von Kries AWB gains are applied.
 */
function isFacialSkinPixel(r: number, g: number, b: number): boolean {
  const Y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (Y <= 38 || Y >= 242) return false;

  const Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const ycbcrSkin = Cb >= 72 && Cb <= 132 && Cr >= 130 && Cr <= 178;

  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const rgbSkin =
    r > 55 &&
    g > 30 &&
    b > 18 &&
    maxC - minC > 12 &&
    Math.abs(r - g) > 10 &&
    r > g &&
    r > b;

  return ycbcrSkin && (rgbSkin || (Cr >= 134 && Cr <= 174 && Cb >= 77 && Cb <= 127));
}

export class RoiFrameExtractor {
  private prevLuma: Float32Array | null = null;
  private smoothCx = 0.5;
  private smoothCy = 0.46;
  private smoothRx = 0.2;
  private smoothRy = 0.32;
  private awbGainR = 1;
  private awbGainG = 1;
  private awbGainB = 1;
  private smoothColorTempK = 5500;

  private nativeDetector: NativeFaceDetectorInstance | null = null;
  private nativeHint: { box: FaceBox; ts: number } | null = null;
  private lastNativeDetectAttempt = 0;
  private nativeDetectInFlight = false;

  constructor() {
    if (typeof window !== "undefined") {
      const Ctor = (
        window as unknown as {
          FaceDetector?: new (opts: {
            fastMode?: boolean;
            maxDetectedFaces?: number;
          }) => NativeFaceDetectorInstance;
        }
      ).FaceDetector;
      if (typeof Ctor === "function") {
        try {
          this.nativeDetector = new Ctor({ fastMode: true, maxDetectedFaces: 1 });
        } catch {
          this.nativeDetector = null;
        }
      }
    }
  }

  public reset(): void {
    this.prevLuma = null;
    this.smoothCx = 0.5;
    this.smoothCy = 0.46;
    this.smoothRx = 0.2;
    this.smoothRy = 0.32;
    this.awbGainR = 1;
    this.awbGainG = 1;
    this.awbGainB = 1;
    this.smoothColorTempK = 5500;
    this.nativeHint = null;
    this.lastNativeDetectAttempt = 0;
    this.nativeDetectInFlight = false;
  }

  /**
   * Optional non-blocking native FaceDetector hint (Chromium) to reinforce
   * cluster-based facial geometry at ~7 Hz without blocking the 30 FPS DSP loop.
   */
  public pollNativeFaceDetector(video: HTMLVideoElement, nowMs: number): void {
    if (
      !this.nativeDetector ||
      this.nativeDetectInFlight ||
      nowMs - this.lastNativeDetectAttempt < 140 ||
      video.readyState < 2 ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      return;
    }

    this.lastNativeDetectAttempt = nowMs;
    this.nativeDetectInFlight = true;
    this.nativeDetector
      .detect(video)
      .then((faces) => {
        if (faces && faces.length > 0) {
          const bb = faces[0].boundingBox;
          const vw = video.videoWidth || 640;
          const vh = video.videoHeight || 480;
          const cx = Math.max(0.15, Math.min(0.85, (bb.x + bb.width * 0.5) / vw));
          const cy = Math.max(0.15, Math.min(0.85, (bb.y + bb.height * 0.48) / vh));
          const rx = Math.max(0.11, Math.min(0.32, (bb.width * 0.5) / vw));
          const ry = Math.max(0.16, Math.min(0.42, (bb.height * 0.52) / vh));
          this.nativeHint = {
            box: { cx, cy, rx, ry },
            ts: performance.now(),
          };
        }
      })
      .catch(() => {
        // Fallback cluster detector remains active on any browser restriction
      })
      .finally(() => {
        this.nativeDetectInFlight = false;
      });
  }

  public extract(
    imageData: ImageData,
    mode: CaptureMode,
    enableAwb = true
  ): RoiExtractionResult {
    const { width, height, data } = imageData;

    if (mode === "finger") {
      return this.extractFingerRoi(width, height, data);
    }

    return this.extractFaceRoi(width, height, data, enableAwb);
  }

  private extractFaceRoi(
    width: number,
    height: number,
    data: Uint8ClampedArray,
    enableAwb: boolean
  ): RoiExtractionResult {
    // Background ambient illumination reference zones (corners), excluding facial skin pixels
    const bgZones = [
      { x0: 0.03, y0: 0.05, x1: 0.15, y1: 0.23, label: "Ambient Ref L" },
      { x0: 0.85, y0: 0.05, x1: 0.97, y1: 0.23, label: "Ambient Ref R" },
    ];

    let bgSumR = 0;
    let bgSumG = 0;
    let bgSumB = 0;
    let bgCount = 0;
    let fallbackBgR = 0;
    let fallbackBgG = 0;
    let fallbackBgB = 0;
    let fallbackBgCount = 0;

    for (const bz of bgZones) {
      const px0 = Math.floor(bz.x0 * width);
      const py0 = Math.floor(bz.y0 * height);
      const px1 = Math.floor(bz.x1 * width);
      const py1 = Math.floor(bz.y1 * height);
      for (let y = py0; y <= py1; y++) {
        for (let x = px0; x <= px1; x++) {
          const idx = (y * width + x) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          fallbackBgR += r;
          fallbackBgG += g;
          fallbackBgB += b;
          fallbackBgCount++;
          if (!isFacialSkinPixel(r * this.awbGainR, g * this.awbGainG, b * this.awbGainB)) {
            bgSumR += r;
            bgSumG += g;
            bgSumB += b;
            bgCount++;
          }
        }
      }
    }

    const rawBgR =
      bgCount >= 16
        ? bgSumR / bgCount
        : fallbackBgCount > 0
        ? fallbackBgR / fallbackBgCount
        : 128;
    const rawBgG =
      bgCount >= 16
        ? bgSumG / bgCount
        : fallbackBgCount > 0
        ? fallbackBgG / fallbackBgCount
        : 128;
    const rawBgB =
      bgCount >= 16
        ? bgSumB / bgCount
        : fallbackBgCount > 0
        ? fallbackBgB / fallbackBgCount
        : 128;

    // Pass 0: Gray-World non-saturated illuminant estimate + frame luma
    let gwR = 0;
    let gwG = 0;
    let gwB = 0;
    let gwCount = 0;
    let frameLumaSum = 0;
    let frameLumaCount = 0;

    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;

        if (x > width * 0.1 && x < width * 0.9 && y > height * 0.1 && y < height * 0.9) {
          frameLumaSum += luma;
          frameLumaCount++;
        }

        if (luma >= 20 && luma <= 238) {
          gwR += r;
          gwG += g;
          gwB += b;
          gwCount++;
        }
      }
    }

    const centerRawLuma = frameLumaCount > 0 ? frameLumaSum / frameLumaCount : 0;
    const frameR = gwCount > 0 ? gwR / gwCount : rawBgR;
    const frameG = gwCount > 0 ? gwG / gwCount : rawBgG;
    const frameB = gwCount > 0 ? gwB / gwCount : rawBgB;

    const illumR = 0.65 * rawBgR + 0.35 * frameR;
    const illumG = 0.65 * rawBgG + 0.35 * frameG;
    const illumB = 0.65 * rawBgB + 0.35 * frameB;
    const grayTarget = (illumR + illumG + illumB) / 3 || 128;

    const clampGain = (g: number) => Math.max(0.55, Math.min(1.85, g));
    const targetGainR = clampGain(grayTarget / Math.max(12, illumR));
    const targetGainG = clampGain(grayTarget / Math.max(12, illumG));
    const targetGainB = clampGain(grayTarget / Math.max(12, illumB));

    this.awbGainR = this.awbGainR * 0.84 + targetGainR * 0.16;
    this.awbGainG = this.awbGainG * 0.84 + targetGainG * 0.16;
    this.awbGainB = this.awbGainB * 0.84 + targetGainB * 0.16;

    const frameCct = estimateCorrelatedColorTempK(illumR, illumG, illumB);
    this.smoothColorTempK = Math.round(this.smoothColorTempK * 0.82 + frameCct * 0.18);

    const gR = enableAwb ? this.awbGainR : 1;
    const gG = enableAwb ? this.awbGainG : 1;
    const gB = enableAwb ? this.awbGainB : 1;

    const bgR = Math.min(255, rawBgR * gR);
    const bgG = Math.min(255, rawBgG * gG);
    const bgB = Math.min(255, rawBgB * gB);

    // Pass 1A: Full-frame 8x6 spatial skin-density grid so tracker chases face anywhere in view
    const sx0 = Math.floor(width * 0.04);
    const sy0 = Math.floor(height * 0.04);
    const sx1 = Math.floor(width * 0.96);
    const sy1 = Math.floor(height * 0.94);

    const hasFreshNativeHint =
      this.nativeHint !== null && performance.now() - this.nativeHint.ts < 450;

    let roughCx = hasFreshNativeHint ? this.nativeHint!.box.cx : this.smoothCx;
    let roughCy = hasFreshNativeHint ? this.nativeHint!.box.cy : this.smoothCy;

    const GRID_COLS = 8;
    const GRID_ROWS = 6;
    const gridCounts = new Int32Array(GRID_COLS * GRID_ROWS);
    const gridSumX = new Float64Array(GRID_COLS * GRID_ROWS);
    const gridSumY = new Float64Array(GRID_COLS * GRID_ROWS);
    let totalSkin1A = 0;

    for (let y = sy0; y <= sy1; y += 2) {
      for (let x = sx0; x <= sx1; x += 2) {
        const idx = (y * width + x) * 4;
        const r = Math.min(255, data[idx] * gR);
        const g = Math.min(255, data[idx + 1] * gG);
        const b = Math.min(255, data[idx + 2] * gB);
        if (isFacialSkinPixel(r, g, b)) {
          const nx = x / width;
          const ny = y / height;
          const gc = Math.min(GRID_COLS - 1, Math.floor(nx * GRID_COLS));
          const gr = Math.min(GRID_ROWS - 1, Math.floor(ny * GRID_ROWS));
          const gi = gr * GRID_COLS + gc;
          gridCounts[gi]++;
          gridSumX[gi] += nx;
          gridSumY[gi] += ny;
          totalSkin1A++;
        }
      }
    }

    if (totalSkin1A >= 30 && !hasFreshNativeHint) {
      // Find peak 2x2 neighborhood in the 8x6 grid to lock onto primary facial cluster
      let bestScore = -1;
      let bestX = this.smoothCx;
      let bestY = this.smoothCy;

      for (let gr = 0; gr < GRID_ROWS - 1; gr++) {
        for (let gc = 0; gc < GRID_COLS - 1; gc++) {
          let cnt = 0;
          let sx = 0;
          let sy = 0;
          for (let dr = 0; dr <= 1; dr++) {
            for (let dc = 0; dc <= 1; dc++) {
              const gi = (gr + dr) * GRID_COLS + (gc + dc);
              cnt += gridCounts[gi];
              sx += gridSumX[gi];
              sy += gridSumY[gi];
            }
          }
          if (cnt > bestScore) {
            bestScore = cnt;
            if (cnt > 0) {
              bestX = sx / cnt;
              bestY = sy / cnt;
            }
          }
        }
      }

      if (bestScore >= 18) {
        roughCx = bestX;
        roughCy = bestY;
      }
    }

    // Pass 1B: Tight cluster variance & centroid refinement around candidate face
    const tx0 = Math.max(0, Math.floor((roughCx - 0.3) * width));
    const ty0 = Math.max(0, Math.floor((roughCy - 0.38) * height));
    const tx1 = Math.min(width - 1, Math.floor((roughCx + 0.3) * width));
    const ty1 = Math.min(height - 1, Math.floor((roughCy + 0.38) * height));

    let sumX2 = 0;
    let sumY2 = 0;
    let sumXX = 0;
    let sumYY = 0;
    let count2 = 0;

    for (let y = ty0; y <= ty1; y += 2) {
      for (let x = tx0; x <= tx1; x += 2) {
        const idx = (y * width + x) * 4;
        const r = Math.min(255, data[idx] * gR);
        const g = Math.min(255, data[idx + 1] * gG);
        const b = Math.min(255, data[idx + 2] * gB);
        if (isFacialSkinPixel(r, g, b)) {
          const nx = x / width;
          const ny = y / height;
          sumX2 += nx;
          sumY2 += ny;
          sumXX += nx * nx;
          sumYY += ny * ny;
          count2++;
        }
      }
    }

    const faceDetected = count2 >= 36 || hasFreshNativeHint;

    if (count2 >= 36) {
      const meanX = sumX2 / count2;
      const meanY = sumY2 / count2;
      const varX = Math.max(0.002, sumXX / count2 - meanX * meanX);
      const varY = Math.max(0.004, sumYY / count2 - meanY * meanY);
      const stdX = Math.sqrt(varX);
      const stdY = Math.sqrt(varY);

      let targetCx = meanX;
      let targetCy = meanY;
      let targetRx = Math.max(0.10, Math.min(0.34, stdX * 2.05));
      let targetRy = Math.max(0.16, Math.min(0.44, stdY * 2.15));

      if (hasFreshNativeHint) {
        const nb = this.nativeHint!.box;
        targetCx = nb.cx * 0.7 + meanX * 0.3;
        targetCy = nb.cy * 0.7 + meanY * 0.3;
        targetRx = nb.rx * 0.72 + targetRx * 0.28;
        targetRy = nb.ry * 0.72 + targetRy * 0.28;
      }

      const shift = Math.hypot(targetCx - this.smoothCx, targetCy - this.smoothCy);
      const alpha = shift > 0.08 ? 0.58 : shift > 0.03 ? 0.38 : 0.24;
      this.smoothCx = this.smoothCx * (1 - alpha) + targetCx * alpha;
      this.smoothCy = this.smoothCy * (1 - alpha) + targetCy * alpha;
      this.smoothRx = this.smoothRx * 0.76 + targetRx * 0.24;
      this.smoothRy = this.smoothRy * 0.76 + targetRy * 0.24;
    } else if (hasFreshNativeHint) {
      const nb = this.nativeHint!.box;
      this.smoothCx = this.smoothCx * 0.55 + nb.cx * 0.45;
      this.smoothCy = this.smoothCy * 0.55 + nb.cy * 0.45;
      this.smoothRx = this.smoothRx * 0.72 + nb.rx * 0.28;
      this.smoothRy = this.smoothRy * 0.72 + nb.ry * 0.28;
    }

    const cx = this.smoothCx;
    const cy = this.smoothCy;
    const rx = this.smoothRx;
    const ry = this.smoothRy;
    const clamp01 = (v: number) => Math.max(0.01, Math.min(0.99, v));

    const zones: Array<{
      key: "forehead" | "leftCheek" | "rightCheek";
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      label: string;
    }> = [
      {
        key: "forehead",
        x0: clamp01(cx - 0.58 * rx),
        y0: clamp01(cy - 0.74 * ry),
        x1: clamp01(cx + 0.58 * rx),
        y1: clamp01(cy - 0.36 * ry),
        label: "Forehead ROI",
      },
      {
        key: "leftCheek",
        x0: clamp01(cx - 0.80 * rx),
        y0: clamp01(cy - 0.02 * ry),
        x1: clamp01(cx - 0.24 * rx),
        y1: clamp01(cy + 0.42 * ry),
        label: "Cheek L",
      },
      {
        key: "rightCheek",
        x0: clamp01(cx + 0.24 * rx),
        y0: clamp01(cy - 0.02 * ry),
        x1: clamp01(cx + 0.80 * rx),
        y1: clamp01(cy + 0.42 * ry),
        label: "Cheek R",
      },
    ];

    let totalSumR = 0;
    let totalSumG = 0;
    let totalSumB = 0;
    let totalSumLuma = 0;
    let totalSkinCount = 0;
    let totalZonePixels = 0;
    let specularCount = 0;
    let motionDeltaSum = 0;
    let motionSamples = 0;

    const regionResults: Record<
      "forehead" | "leftCheek" | "rightCheek",
      RoiRgbTriplet
    > = {
      forehead: { r: 0, g: 0, b: 0, valid: false },
      leftCheek: { r: 0, g: 0, b: 0, valid: false },
      rightCheek: { r: 0, g: 0, b: 0, valid: false },
    };

    const currentLuma = new Float32Array(width * height);

    for (const z of zones) {
      const px0 = Math.max(0, Math.floor(z.x0 * width));
      const py0 = Math.max(0, Math.floor(z.y0 * height));
      const px1 = Math.min(width - 1, Math.floor(z.x1 * width));
      const py1 = Math.min(height - 1, Math.floor(z.y1 * height));

      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let regCount = 0;

      for (let y = py0; y <= py1; y++) {
        for (let x = px0; x <= px1; x++) {
          const pixIdx = y * width + x;
          const idx = pixIdx * 4;
          const rawR = data[idx];
          const rawG = data[idx + 1];
          const rawB = data[idx + 2];
          const rawY = 0.299 * rawR + 0.587 * rawG + 0.114 * rawB;

          const r = Math.min(255, rawR * gR);
          const g = Math.min(255, rawG * gG);
          const b = Math.min(255, rawB * gB);
          const Y = 0.299 * r + 0.587 * g + 0.114 * b;

          currentLuma[pixIdx] = rawY;
          totalZonePixels++;

          if (this.prevLuma) {
            motionDeltaSum += Math.abs(rawY - this.prevLuma[pixIdx]);
            motionSamples++;
          }

          const isSpecular = rawY >= 232 || (rawR > 235 && rawG > 230 && rawB > 225);
          if (isSpecular) {
            specularCount++;
            continue;
          }

          if (isFacialSkinPixel(r, g, b)) {
            rSum += r;
            gSum += g;
            bSum += b;
            regCount++;

            totalSumR += r;
            totalSumG += g;
            totalSumB += b;
            totalSumLuma += Y;
            totalSkinCount++;
          }
        }
      }

      if (regCount >= 10) {
        regionResults[z.key] = {
          r: rSum / regCount,
          g: gSum / regCount,
          b: bSum / regCount,
          valid: true,
        };
      }
    }

    this.prevLuma = currentLuma;

    const skinCoveragePct =
      totalZonePixels > 0 ? (totalSkinCount / totalZonePixels) * 100 : 0;
    const specularRejectedPct =
      totalZonePixels > 0 ? (specularCount / totalZonePixels) * 100 : 0;
    const motionIndex = motionSamples > 0 ? motionDeltaSum / motionSamples : 0;
    const brightness =
      totalSkinCount > 0 ? totalSumLuma / totalSkinCount : centerRawLuma;

    // Free-roaming face zone: pauses only if face vanishes, clips outside sensor edge, too dark, or too small
    let zoneGuidance: ZoneGuidance = "ok";
    if (centerRawLuma < 36 || (totalSkinCount > 0 && brightness < 38)) {
      zoneGuidance = "low_light";
    } else if (!faceDetected || totalSkinCount < 25 || skinCoveragePct < 15) {
      zoneGuidance = "no_face";
    } else if (cx < 0.09 || cx > 0.91 || cy < 0.09 || cy > 0.91) {
      zoneGuidance = "off_center";
    } else if (rx < 0.105 && !hasFreshNativeHint) {
      zoneGuidance = "too_far";
    } else if (rx > 0.355 && ry > 0.435) {
      zoneGuidance = "too_close";
    }

    const inZone = zoneGuidance === "ok";

    const roiBoxes: RoiBox[] = [
      ...zones.map((z) => ({
        x: z.x0,
        y: z.y0,
        w: z.x1 - z.x0,
        h: z.y1 - z.y0,
        label: z.label,
        kind: "skin" as const,
      })),
      ...bgZones.map((bz) => ({
        x: bz.x0,
        y: bz.y0,
        w: bz.x1 - bz.x0,
        h: bz.y1 - bz.y0,
        label: bz.label,
        kind: "background" as const,
      })),
    ];

    const awbState = {
      gainR: Number(gR.toFixed(2)),
      gainG: Number(gG.toFixed(2)),
      gainB: Number(gB.toFixed(2)),
      colorTempK: this.smoothColorTempK,
      applied: enableAwb,
    };

    const faceBox: FaceBox = { cx, cy, rx, ry };

    if (totalSkinCount < 25) {
      return {
        r: 0,
        g: 0,
        b: 0,
        bgR,
        bgG,
        bgB,
        skinCoveragePct,
        brightness,
        motionIndex,
        specularRejectedPct,
        faceCenter: { x: cx, y: cy },
        faceBox,
        inZone: false,
        zoneGuidance,
        roiBoxes,
        hasValidTarget: false,
        awb: awbState,
        regions: regionResults,
      };
    }

    return {
      r: totalSumR / totalSkinCount,
      g: totalSumG / totalSkinCount,
      b: totalSumB / totalSkinCount,
      bgR,
      bgG,
      bgB,
      skinCoveragePct,
      brightness,
      motionIndex,
      specularRejectedPct,
      faceCenter: { x: cx, y: cy },
      faceBox,
      inZone,
      zoneGuidance,
      roiBoxes,
      hasValidTarget: inZone && skinCoveragePct >= 15,
      awb: awbState,
      regions: regionResults,
    };
  }

  private extractFingerRoi(
    width: number,
    height: number,
    data: Uint8ClampedArray
  ): RoiExtractionResult {
    const px0 = Math.floor(width * 0.3);
    const py0 = Math.floor(height * 0.3);
    const px1 = Math.floor(width * 0.7);
    const py1 = Math.floor(height * 0.7);

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumLuma = 0;
    let count = 0;
    let motionDeltaSum = 0;

    const currentLuma = new Float32Array(width * height);

    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) {
        const pixIdx = y * width + x;
        const idx = pixIdx * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;

        currentLuma[pixIdx] = Y;
        if (this.prevLuma) {
          motionDeltaSum += Math.abs(Y - this.prevLuma[pixIdx]);
        }

        sumR += r;
        sumG += g;
        sumB += b;
        sumLuma += Y;
        count++;
      }
    }

    this.prevLuma = currentLuma;

    const meanR = count > 0 ? sumR / count : 0;
    const meanG = count > 0 ? sumG / count : 0;
    const meanB = count > 0 ? sumB / count : 0;
    const brightness = count > 0 ? sumLuma / count : 0;
    const motionIndex = count > 0 ? motionDeltaSum / count : 0;

    const isFingerCovered = meanR > 105 && meanR > meanG * 1.3;

    return {
      r: meanR,
      g: meanG,
      b: meanB,
      bgR: meanR,
      bgG: meanG,
      bgB: meanB,
      skinCoveragePct: isFingerCovered ? 100 : 5,
      brightness,
      motionIndex,
      specularRejectedPct: 0,
      faceCenter: { x: 0.5, y: 0.5 },
      faceBox: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2 },
      inZone: isFingerCovered,
      zoneGuidance: isFingerCovered ? "ok" : "no_face",
      roiBoxes: [
        {
          x: 0.3,
          y: 0.3,
          w: 0.4,
          h: 0.4,
          label: "Contact PPG Zone",
          kind: "skin",
        },
      ],
      hasValidTarget: isFingerCovered,
    };
  }
}
