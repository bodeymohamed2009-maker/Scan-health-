import type {
  CaptureMode,
  RoiBox,
  RoiExtractionResult,
  RoiRgbTriplet,
} from "../types/rppg";

/**
 * Extracts dynamic centroid-locked facial skin ROIs (Forehead, Left Cheek, Right Cheek)
 * with specular glare trimming, plus dual non-skin background ambient reference zones
 * so the downstream NLMS adaptive filter can cancel room/screen flicker.
 */
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

export class RoiFrameExtractor {
  private prevLuma: Float32Array | null = null;
  private smoothCx = 0.5;
  private smoothCy = 0.44;
  private awbGainR = 1;
  private awbGainG = 1;
  private awbGainB = 1;
  private smoothColorTempK = 5500;

  public reset(): void {
    this.prevLuma = null;
    this.smoothCx = 0.5;
    this.smoothCy = 0.44;
    this.awbGainR = 1;
    this.awbGainG = 1;
    this.awbGainB = 1;
    this.smoothColorTempK = 5500;
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
    // Background ambient illumination reference zones (top-left & top-right corners)
    const bgZones = [
      { x0: 0.04, y0: 0.06, x1: 0.16, y1: 0.24, label: "Ambient Ref L" },
      { x0: 0.84, y0: 0.06, x1: 0.96, y1: 0.24, label: "Ambient Ref R" },
    ];

    let bgSumR = 0;
    let bgSumG = 0;
    let bgSumB = 0;
    let bgCount = 0;

    for (const bz of bgZones) {
      const px0 = Math.floor(bz.x0 * width);
      const py0 = Math.floor(bz.y0 * height);
      const px1 = Math.floor(bz.x1 * width);
      const py1 = Math.floor(bz.y1 * height);
      for (let y = py0; y <= py1; y++) {
        for (let x = px0; x <= px1; x++) {
          const idx = (y * width + x) * 4;
          bgSumR += data[idx];
          bgSumG += data[idx + 1];
          bgSumB += data[idx + 2];
          bgCount++;
        }
      }
    }

    const rawBgR = bgCount > 0 ? bgSumR / bgCount : 128;
    const rawBgG = bgCount > 0 ? bgSumG / bgCount : 128;
    const rawBgB = bgCount > 0 ? bgSumB / bgCount : 128;

    // Pass 0: Gray-World non-saturated illuminant estimate blended with ambient corners
    let gwR = 0;
    let gwG = 0;
    let gwB = 0;
    let gwCount = 0;
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luma >= 20 && luma <= 238) {
          gwR += r;
          gwG += g;
          gwB += b;
          gwCount++;
        }
      }
    }

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

    // Smooth EMA adaptation suppresses slow room-light shifts without touching >0.7Hz pulse
    this.awbGainR = this.awbGainR * 0.84 + targetGainR * 0.16;
    this.awbGainG = this.awbGainG * 0.84 + targetGainG * 0.16;
    this.awbGainB = this.awbGainB * 0.84 + targetGainB * 0.16;

    const frameCct = estimateCorrelatedColorTempK(illumR, illumG, illumB);
    this.smoothColorTempK = Math.round(
      this.smoothColorTempK * 0.82 + frameCct * 0.18
    );

    const gR = enableAwb ? this.awbGainR : 1;
    const gG = enableAwb ? this.awbGainG : 1;
    const gB = enableAwb ? this.awbGainB : 1;

    const bgR = Math.min(255, rawBgR * gR);
    const bgG = Math.min(255, rawBgG * gG);
    const bgB = Math.min(255, rawBgB * gB);

    // Pass 1: Locate dynamic skin centroid inside central search region
    const sx0 = Math.floor(width * 0.24);
    const sy0 = Math.floor(height * 0.14);
    const sx1 = Math.floor(width * 0.76);
    const sy1 = Math.floor(height * 0.72);

    let sumX = 0;
    let sumY = 0;
    let massCount = 0;

    for (let y = sy0; y <= sy1; y += 2) {
      for (let x = sx0; x <= sx1; x += 2) {
        const idx = (y * width + x) * 4;
        const r = Math.min(255, data[idx] * gR);
        const g = Math.min(255, data[idx + 1] * gG);
        const b = Math.min(255, data[idx + 2] * gB);
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;
        const Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

        if (Y > 45 && Y < 235 && Cb >= 76 && Cb <= 129 && Cr >= 132 && Cr <= 175) {
          sumX += x / width;
          sumY += y / height;
          massCount++;
        }
      }
    }

    if (massCount > 35) {
      const targetCx = Math.max(0.36, Math.min(0.64, sumX / massCount));
      const targetCy = Math.max(0.32, Math.min(0.56, sumY / massCount));
      // Smooth EMA centroid damping avoids bounding-box quantization jitter
      this.smoothCx = this.smoothCx * 0.74 + targetCx * 0.26;
      this.smoothCy = this.smoothCy * 0.74 + targetCy * 0.26;
    }

    const dx = this.smoothCx - 0.5;
    const dy = this.smoothCy - 0.44;
    const clamp01 = (v: number) => Math.max(0.02, Math.min(0.98, v));

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
        x0: clamp01(0.37 + dx),
        y0: clamp01(0.20 + dy),
        x1: clamp01(0.63 + dx),
        y1: clamp01(0.32 + dy),
        label: "Forehead ROI",
      },
      {
        key: "leftCheek",
        x0: clamp01(0.32 + dx),
        y0: clamp01(0.44 + dy),
        x1: clamp01(0.44 + dx),
        y1: clamp01(0.58 + dy),
        label: "Cheek L",
      },
      {
        key: "rightCheek",
        x0: clamp01(0.56 + dx),
        y0: clamp01(0.44 + dy),
        x1: clamp01(0.68 + dx),
        y1: clamp01(0.58 + dy),
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
          const Cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
          const Cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

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

          const isSkin =
            Y > 42 && Cb >= 75 && Cb <= 130 && Cr >= 131 && Cr <= 176;

          if (isSkin) {
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

      if (regCount >= 12) {
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
    const motionIndex =
      motionSamples > 0 ? motionDeltaSum / motionSamples : 0;

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

    if (totalSkinCount < 25) {
      return {
        r: 0,
        g: 0,
        b: 0,
        bgR,
        bgG,
        bgB,
        skinCoveragePct,
        brightness: 0,
        motionIndex,
        specularRejectedPct,
        faceCenter: { x: this.smoothCx, y: this.smoothCy },
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
      brightness: totalSumLuma / totalSkinCount,
      motionIndex,
      specularRejectedPct,
      faceCenter: { x: this.smoothCx, y: this.smoothCy },
      roiBoxes,
      hasValidTarget: skinCoveragePct >= 15,
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
