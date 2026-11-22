import type {
  AwbTelemetry,
  CaptureMode,
  PoincarePoint,
  RgbSample,
  RppgAlgorithm,
  RppgMetrics,
  SignalQualityState,
  SpectrumBin,
} from "../types/rppg";

const TARGET_FS = 30;
const RESP_FS = 4;
const MIN_SECONDS_FOR_ESTIMATE = 5.0;
const MIN_SECONDS_FOR_RESPIRATION = 12.0;
const MAX_CARDIAC_WINDOW_SECONDS = 12.0;
const MAX_RESP_WINDOW_SECONDS = 30.0;

function mean(arr: Float64Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return arr.length > 0 ? sum / arr.length : 0;
}

function stdDev(arr: Float64Array | number[], mu?: number): number {
  if (arr.length < 2) return 0;
  const m = mu ?? mean(arr);
  let acc = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    acc += d * d;
  }
  return Math.sqrt(acc / arr.length);
}

/**
 * 2-State Velocity-Aware 1D Kalman Heart-Rate Tracker [bpm, velocity]
 * with SNR-adaptive measurement noise and motion-artifact freeze gating.
 */
export class KalmanBpmTracker {
  private x: number | null = null; // estimated BPM
  private v = 0; // BPM rate of change per update
  private p = 100; // error covariance

  public reset(): void {
    this.x = null;
    this.v = 0;
    this.p = 100;
  }

  public update(
    measuredBpm: number | null,
    snrDb: number,
    isMotionArtifact: boolean
  ): number | null {
    if (measuredBpm === null) {
      return this.x !== null ? Math.round(this.x) : null;
    }

    if (this.x === null) {
      this.x = measuredBpm;
      this.v = 0;
      this.p = 10;
      return Math.round(this.x);
    }

    // Freeze state update during sudden motion spikes if already locked
    if (isMotionArtifact) {
      return Math.round(this.x);
    }

    // Predict step with damped velocity prior
    const predicted = this.x + this.v * 0.45;
    const Q = 0.55;
    this.p += Q;

    // Measurement noise R scales inversely with SNR quality
    const clampedSnr = Math.max(0.5, Math.min(22, snrDb));
    const R = 22 / Math.pow(clampedSnr, 1.15);

    // Reject single-frame outlier jumps (>24 BPM) unless SNR is exceptionally strong
    if (Math.abs(measuredBpm - predicted) > 24 && snrDb < 8.5) {
      return Math.round(this.x);
    }

    const K = this.p / (this.p + R);
    const innovation = measuredBpm - predicted;
    this.x = predicted + K * innovation;
    this.v = Math.max(-2.5, Math.min(2.5, this.v * 0.6 + K * innovation * 0.35));
    this.p = (1 - K) * this.p;

    return Math.round(this.x);
  }
}

/**
 * Adaptive NLMS (Normalized Least-Mean-Squares) Ambient Flicker Canceller.
 * Subtracts correlated background illumination fluctuations (LED 50/60Hz aliasing,
 * screen brightness shifts) from facial skin channels while preserving capillary pulse.
 */
function applyNlmsAmbientCancel(
  skin: Float64Array,
  bgRef: Float64Array,
  taps = 5,
  mu = 0.08
): { cleaned: Float64Array; reductionDb: number } {
  const N = skin.length;
  if (N <= taps + 4 || bgRef.length !== N) {
    return { cleaned: skin, reductionDb: 0 };
  }

  const mSkin = mean(skin) || 1;
  const mBg = mean(bgRef) || 1;

  // Work on AC variations around temporal mean
  const d = new Float64Array(N);
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    d[i] = skin[i] - mSkin;
    x[i] = bgRef[i] - mBg;
  }

  const stdBg = stdDev(x);
  if (stdBg < 0.05) {
    // Background illumination is already rock-steady
    return { cleaned: skin, reductionDb: 0 };
  }

  const w = new Float64Array(taps);
  const cleaned = new Float64Array(N);
  let rawPower = 0;
  let cleanPower = 0;

  for (let n = 0; n < N; n++) {
    let yHat = 0;
    let normSq = 1e-4;
    for (let k = 0; k < taps; k++) {
      const xk = n - k >= 0 ? x[n - k] : 0;
      yHat += w[k] * xk;
      normSq += xk * xk;
    }

    const err = d[n] - yHat;
    // Clamp adaptive error to preserve genuine skin reflectance
    const step = (mu * err) / normSq;
    for (let k = 0; k < taps; k++) {
      const xk = n - k >= 0 ? x[n - k] : 0;
      w[k] += step * xk;
    }

    cleaned[n] = mSkin + err;
    rawPower += d[n] * d[n];
    cleanPower += err * err;
  }

  const ratio = rawPower > 1e-9 && cleanPower > 1e-9 ? rawPower / cleanPower : 1;
  const reductionDb = Math.max(
    0,
    Math.min(18, Number((10 * Math.log10(ratio)).toFixed(1)))
  );

  return { cleaned, reductionDb };
}

function hampelDespike(arr: Float64Array, halfWin = 3, nSigma = 3.5): Float64Array {
  const N = arr.length;
  if (N < halfWin * 2 + 1) return arr;
  const out = new Float64Array(arr);
  const windowVals = new Array<number>(halfWin * 2 + 1);

  for (let i = halfWin; i < N - halfWin; i++) {
    let idx = 0;
    for (let k = -halfWin; k <= halfWin; k++) {
      windowVals[idx++] = arr[i + k];
    }
    const sorted = [...windowVals].sort((a, b) => a - b);
    const med = sorted[halfWin];
    const devs = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
    const mad = devs[halfWin] * 1.4826;
    if (mad > 1e-6 && Math.abs(arr[i] - med) > nSigma * mad) {
      out[i] = med;
    }
  }
  return out;
}

function estimateCctFromRgb(r: number, g: number, b: number): number {
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

function zeroPhaseEma(arr: Float64Array, alpha = 0.09): Float64Array {
  const N = arr.length;
  if (N < 4) return new Float64Array(arr);
  const fwd = new Float64Array(N);
  fwd[0] = arr[0];
  for (let i = 1; i < N; i++) {
    fwd[i] = fwd[i - 1] * (1 - alpha) + arr[i] * alpha;
  }
  const bwd = new Float64Array(N);
  bwd[N - 1] = fwd[N - 1];
  for (let i = N - 2; i >= 0; i--) {
    bwd[i] = bwd[i + 1] * (1 - alpha) + fwd[i] * alpha;
  }
  return bwd;
}

function computeVonKriesGains(
  bgR: Float64Array,
  bgG: Float64Array,
  bgB: Float64Array
): {
  gainR: Float64Array;
  gainG: Float64Array;
  gainB: Float64Array;
  lastGainR: number;
  lastGainG: number;
  lastGainB: number;
  lastCctK: number;
} {
  const N = bgR.length;
  const sR = zeroPhaseEma(bgR, 0.12);
  const sG = zeroPhaseEma(bgG, 0.12);
  const sB = zeroPhaseEma(bgB, 0.12);

  const meanGray = (mean(sR) + mean(sG) + mean(sB)) / 3 || 128;

  const gainR = new Float64Array(N);
  const gainG = new Float64Array(N);
  const gainB = new Float64Array(N);
  const clampGain = (v: number) => Math.max(0.55, Math.min(1.85, v));

  for (let i = 0; i < N; i++) {
    gainR[i] = clampGain(meanGray / Math.max(12, sR[i]));
    gainG[i] = clampGain(meanGray / Math.max(12, sG[i]));
    gainB[i] = clampGain(meanGray / Math.max(12, sB[i]));
  }

  const last = Math.max(0, N - 1);
  return {
    gainR,
    gainG,
    gainB,
    lastGainR: Number((gainR[last] ?? 1).toFixed(2)),
    lastGainG: Number((gainG[last] ?? 1).toFixed(2)),
    lastGainB: Number((gainB[last] ?? 1).toFixed(2)),
    lastCctK: estimateCctFromRgb(sR[last] ?? 128, sG[last] ?? 128, sB[last] ?? 128),
  };
}

function computeChromaticityVariance(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array
): number {
  const N = r.length;
  if (N < 4) return 0;
  const rgRatio = new Float64Array(N);
  const bgRatio = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const sum = Math.max(1, r[i] + g[i] + b[i]);
    rgRatio[i] = r[i] / sum;
    bgRatio[i] = b[i] / sum;
  }
  const v1 = stdDev(rgRatio);
  const v2 = stdDev(bgRatio);
  return v1 * v1 + v2 * v2;
}

interface UniformChannels {
  r: Float64Array;
  g: Float64Array;
  b: Float64Array;
  bgR: Float64Array;
  bgG: Float64Array;
  bgB: Float64Array;
  forehead?: { r: Float64Array; g: Float64Array; b: Float64Array; validRatio: number };
  leftCheek?: { r: Float64Array; g: Float64Array; b: Float64Array; validRatio: number };
  rightCheek?: { r: Float64Array; g: Float64Array; b: Float64Array; validRatio: number };
  durationSec: number;
  ambientCanceledDb: number;
  awb: AwbTelemetry;
}

function resampleUniform(
  samples: RgbSample[],
  fs: number,
  maxSeconds: number,
  enableNlms: boolean,
  enableAwb: boolean,
  mode: CaptureMode
): UniformChannels {
  const defaultAwb: AwbTelemetry = {
    enabled: enableAwb && mode !== "finger",
    gainR: 1,
    gainG: 1,
    gainB: 1,
    colorTempK: 5500,
    driftReducedPct: 0,
  };

  const n = samples.length;
  if (n < 4) {
    return {
      r: new Float64Array(0),
      g: new Float64Array(0),
      b: new Float64Array(0),
      bgR: new Float64Array(0),
      bgG: new Float64Array(0),
      bgB: new Float64Array(0),
      durationSec: 0,
      ambientCanceledDb: 0,
      awb: defaultAwb,
    };
  }

  const tEnd = samples[n - 1].t;
  const totalSpanSec = (tEnd - samples[0].t) / 1000;
  const usedSec = Math.min(totalSpanSec, maxSeconds);
  const tStart = tEnd - usedSec * 1000;

  const outLen = Math.floor(usedSec * fs);
  if (outLen < 16) {
    return {
      r: new Float64Array(0),
      g: new Float64Array(0),
      b: new Float64Array(0),
      bgR: new Float64Array(0),
      bgG: new Float64Array(0),
      bgB: new Float64Array(0),
      durationSec: usedSec,
      ambientCanceledDb: 0,
      awb: defaultAwb,
    };
  }

  const rOut = new Float64Array(outLen);
  const gOut = new Float64Array(outLen);
  const bOut = new Float64Array(outLen);
  const bgROut = new Float64Array(outLen);
  const bgGOut = new Float64Array(outLen);
  const bgBOut = new Float64Array(outLen);

  const hasRegions = Boolean(samples[n - 1].regions);
  const fhR = hasRegions ? new Float64Array(outLen) : undefined;
  const fhG = hasRegions ? new Float64Array(outLen) : undefined;
  const fhB = hasRegions ? new Float64Array(outLen) : undefined;
  const lcR = hasRegions ? new Float64Array(outLen) : undefined;
  const lcG = hasRegions ? new Float64Array(outLen) : undefined;
  const lcB = hasRegions ? new Float64Array(outLen) : undefined;
  const rcR = hasRegions ? new Float64Array(outLen) : undefined;
  const rcG = hasRegions ? new Float64Array(outLen) : undefined;
  const rcB = hasRegions ? new Float64Array(outLen) : undefined;

  let fhValid = 0;
  let lcValid = 0;
  let rcValid = 0;

  let srcIdx = 0;
  const dtMs = 1000 / fs;

  for (let i = 0; i < outLen; i++) {
    const tTarget = tStart + i * dtMs;
    while (srcIdx < n - 2 && samples[srcIdx + 1].t < tTarget) {
      srcIdx++;
    }
    const s0 = samples[srcIdx];
    const s1 = samples[Math.min(srcIdx + 1, n - 1)];
    const span = s1.t - s0.t;
    const alpha =
      span > 0.001 ? Math.max(0, Math.min(1, (tTarget - s0.t) / span)) : 0;

    rOut[i] = s0.r + alpha * (s1.r - s0.r);
    gOut[i] = s0.g + alpha * (s1.g - s0.g);
    bOut[i] = s0.b + alpha * (s1.b - s0.b);

    const b0R = s0.bgR ?? 128;
    const b1R = s1.bgR ?? 128;
    const b0G = s0.bgG ?? 128;
    const b1G = s1.bgG ?? 128;
    const b0B = s0.bgB ?? 128;
    const b1B = s1.bgB ?? 128;

    bgROut[i] = b0R + alpha * (b1R - b0R);
    bgGOut[i] = b0G + alpha * (b1G - b0G);
    bgBOut[i] = b0B + alpha * (b1B - b0B);

    if (hasRegions && fhR && fhG && fhB && lcR && lcG && lcB && rcR && rcG && rcB) {
      const reg0 = s0.regions;
      const reg1 = s1.regions;

      const f0 = reg0?.forehead?.valid ? reg0.forehead : { r: s0.r, g: s0.g, b: s0.b, valid: false };
      const f1 = reg1?.forehead?.valid ? reg1.forehead : { r: s1.r, g: s1.g, b: s1.b, valid: false };
      if (f0.valid || f1.valid) fhValid++;
      fhR[i] = f0.r + alpha * (f1.r - f0.r);
      fhG[i] = f0.g + alpha * (f1.g - f0.g);
      fhB[i] = f0.b + alpha * (f1.b - f0.b);

      const l0 = reg0?.leftCheek?.valid ? reg0.leftCheek : { r: s0.r, g: s0.g, b: s0.b, valid: false };
      const l1 = reg1?.leftCheek?.valid ? reg1.leftCheek : { r: s1.r, g: s1.g, b: s1.b, valid: false };
      if (l0.valid || l1.valid) lcValid++;
      lcR[i] = l0.r + alpha * (l1.r - l0.r);
      lcG[i] = l0.g + alpha * (l1.g - l0.g);
      lcB[i] = l0.b + alpha * (l1.b - l0.b);

      const r0 = reg0?.rightCheek?.valid ? reg0.rightCheek : { r: s0.r, g: s0.g, b: s0.b, valid: false };
      const r1 = reg1?.rightCheek?.valid ? reg1.rightCheek : { r: s1.r, g: s1.g, b: s1.b, valid: false };
      if (r0.valid || r1.valid) rcValid++;
      rcR[i] = r0.r + alpha * (r1.r - r0.r);
      rcG[i] = r0.g + alpha * (r1.g - r0.g);
      rcB[i] = r0.b + alpha * (r1.b - r0.b);
    }
  }

  // Apply Temporal Von Kries AWB before Hampel & NLMS when not already applied at frame level
  const latestAwbSample = samples[n - 1].awb;
  const frameAlreadyAwbApplied = Boolean(latestAwbSample?.applied);

  let awbTelemetry: AwbTelemetry = {
    enabled: enableAwb && mode !== "finger",
    gainR: latestAwbSample?.gainR ?? 1,
    gainG: latestAwbSample?.gainG ?? 1,
    gainB: latestAwbSample?.gainB ?? 1,
    colorTempK:
      latestAwbSample?.colorTempK ??
      estimateCctFromRgb(
        mean(bgROut) || 128,
        mean(bgGOut) || 128,
        mean(bgBOut) || 128
      ),
    driftReducedPct: 0,
  };

  if (enableAwb && mode !== "finger" && !frameAlreadyAwbApplied) {
    const gains = computeVonKriesGains(bgROut, bgGOut, bgBOut);
    const varBefore = computeChromaticityVariance(rOut, gOut, bOut);

    const applyGains = (
      arrR: Float64Array,
      arrG: Float64Array,
      arrB: Float64Array
    ) => {
      for (let i = 0; i < outLen; i++) {
        arrR[i] = Math.min(255, arrR[i] * gains.gainR[i]);
        arrG[i] = Math.min(255, arrG[i] * gains.gainG[i]);
        arrB[i] = Math.min(255, arrB[i] * gains.gainB[i]);
      }
    };

    applyGains(rOut, gOut, bOut);
    applyGains(bgROut, bgGOut, bgBOut);
    if (fhR && fhG && fhB && lcR && lcG && lcB && rcR && rcG && rcB) {
      applyGains(fhR, fhG, fhB);
      applyGains(lcR, lcG, lcB);
      applyGains(rcR, rcG, rcB);
    }

    const varAfter = computeChromaticityVariance(rOut, gOut, bOut);
    const driftReducedPct =
      varBefore > 1e-9
        ? Math.max(0, Math.min(99, Math.round(((varBefore - varAfter) / varBefore) * 100)))
        : 0;

    awbTelemetry = {
      enabled: true,
      gainR: gains.lastGainR,
      gainG: gains.lastGainG,
      gainB: gains.lastGainB,
      colorTempK: gains.lastCctK,
      driftReducedPct,
    };
  } else if (enableAwb && mode !== "finger" && frameAlreadyAwbApplied && latestAwbSample) {
    const dev =
      (Math.abs(latestAwbSample.gainR - 1) +
        Math.abs(latestAwbSample.gainG - 1) +
        Math.abs(latestAwbSample.gainB - 1)) /
      3;
    awbTelemetry.driftReducedPct = Math.max(0, Math.min(95, Math.round(dev * 240)));
  }

  let rClean = hampelDespike(rOut);
  let gClean = hampelDespike(gOut);
  let bClean = hampelDespike(bOut);
  let ambientCanceledDb = 0;

  const cleanChannelPair = (
    cR: Float64Array,
    cG: Float64Array,
    cB: Float64Array
  ) => {
    const dR = hampelDespike(cR);
    const dG = hampelDespike(cG);
    const dB = hampelDespike(cB);
    if (!enableNlms || mode === "finger") {
      return { r: dR, g: dG, b: dB, redDb: 0 };
    }
    const nR = applyNlmsAmbientCancel(dR, bgROut);
    const nG = applyNlmsAmbientCancel(dG, bgGOut);
    const nB = applyNlmsAmbientCancel(dB, bgBOut);
    return { r: nR.cleaned, g: nG.cleaned, b: nB.cleaned, redDb: nG.reductionDb };
  };

  if (enableNlms && mode !== "finger") {
    const resMain = cleanChannelPair(rClean, gClean, bClean);
    rClean = resMain.r;
    gClean = resMain.g;
    bClean = resMain.b;
    ambientCanceledDb = resMain.redDb;
  }

  const fhCleaned =
    fhR && fhG && fhB ? cleanChannelPair(fhR, fhG, fhB) : undefined;
  const lcCleaned =
    lcR && lcG && lcB ? cleanChannelPair(lcR, lcG, lcB) : undefined;
  const rcCleaned =
    rcR && rcG && rcB ? cleanChannelPair(rcR, rcG, rcB) : undefined;

  return {
    r: rClean,
    g: gClean,
    b: bClean,
    bgR: bgROut,
    bgG: bgGOut,
    bgB: bgBOut,
    forehead: fhCleaned
      ? { r: fhCleaned.r, g: fhCleaned.g, b: fhCleaned.b, validRatio: fhValid / outLen }
      : undefined,
    leftCheek: lcCleaned
      ? { r: lcCleaned.r, g: lcCleaned.g, b: lcCleaned.b, validRatio: lcValid / outLen }
      : undefined,
    rightCheek: rcCleaned
      ? { r: rcCleaned.r, g: rcCleaned.g, b: rcCleaned.b, validRatio: rcValid / outLen }
      : undefined,
    durationSec: usedSec,
    ambientCanceledDb,
    awb: awbTelemetry,
  };
}

function extractPosSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  fs: number
): Float64Array {
  const N = r.length;
  const H = new Float64Array(N);
  const winLen = Math.max(24, Math.round(1.6 * fs));

  if (N <= winLen) {
    const mr = mean(r) || 1;
    const mg = mean(g) || 1;
    const mb = mean(b) || 1;
    const s1 = new Float64Array(N);
    const s2 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const rn = r[i] / mr - 1;
      const gn = g[i] / mg - 1;
      const bn = b[i] / mb - 1;
      s1[i] = gn - bn;
      s2[i] = gn + bn - 2 * rn;
    }
    const alpha = stdDev(s1) / (stdDev(s2) || 1e-6);
    for (let i = 0; i < N; i++) H[i] = s1[i] + alpha * s2[i];
    return H;
  }

  for (let start = 0; start <= N - winLen; start++) {
    let mr = 0,
      mg = 0,
      mb = 0;
    for (let j = 0; j < winLen; j++) {
      mr += r[start + j];
      mg += g[start + j];
      mb += b[start + j];
    }
    mr = mr / winLen || 1;
    mg = mg / winLen || 1;
    mb = mb / winLen || 1;

    const s1 = new Float64Array(winLen);
    const s2 = new Float64Array(winLen);
    for (let j = 0; j < winLen; j++) {
      const rn = r[start + j] / mr - 1;
      const gn = g[start + j] / mg - 1;
      const bn = b[start + j] / mb - 1;
      s1[j] = gn - bn;
      s2[j] = gn + bn - 2 * rn;
    }

    const alpha = stdDev(s1) / (stdDev(s2) || 1e-6);
    for (let j = 0; j < winLen; j++) {
      H[start + j] += s1[j] + alpha * s2[j];
    }
  }
  return H;
}

function extractChromSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  fs: number
): Float64Array {
  const N = r.length;
  const out = new Float64Array(N);
  const winLen = Math.max(24, Math.round(1.6 * fs));

  const processSegment = (start: number, len: number) => {
    let mr = 0,
      mg = 0,
      mb = 0;
    for (let j = 0; j < len; j++) {
      mr += r[start + j];
      mg += g[start + j];
      mb += b[start + j];
    }
    mr = mr / len || 1;
    mg = mg / len || 1;
    mb = mb / len || 1;

    const xs = new Float64Array(len);
    const ys = new Float64Array(len);
    for (let j = 0; j < len; j++) {
      const rn = r[start + j] / mr - 1;
      const gn = g[start + j] / mg - 1;
      const bn = b[start + j] / mb - 1;
      xs[j] = 3 * rn - 2 * gn;
      ys[j] = 1.5 * rn + gn - 1.5 * bn;
    }
    const alpha = stdDev(xs) / (stdDev(ys) || 1e-6);
    for (let j = 0; j < len; j++) {
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * j) / (len - 1)));
      out[start + j] += hann * (xs[j] - alpha * ys[j]);
    }
  };

  if (N <= winLen) {
    processSegment(0, N);
    return out;
  }

  const step = Math.max(1, Math.floor(winLen / 2));
  for (let start = 0; start <= N - winLen; start += step) {
    processSegment(start, winLen);
  }
  return out;
}

function extractGreenSignal(
  r: Float64Array,
  g: Float64Array,
  mode: CaptureMode
): Float64Array {
  const N = g.length;
  const out = new Float64Array(N);
  const mg = mean(g) || 1;
  const mr = mean(r) || 1;

  for (let i = 0; i < N; i++) {
    if (mode === "finger") {
      const gn = -(g[i] / mg - 1);
      const rn = -(r[i] / mr - 1);
      out[i] = 0.65 * rn + 0.35 * gn;
    } else {
      out[i] = -(g[i] / mg - 1);
    }
  }
  return out;
}

function selectBvpSignal(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  algorithm: RppgAlgorithm,
  mode: CaptureMode,
  fs: number
): Float64Array {
  if (mode === "finger") return extractGreenSignal(r, g, "finger");
  if (algorithm === "CHROM") return extractChromSignal(r, g, b, fs);
  if (algorithm === "GREEN") return extractGreenSignal(r, g, mode);
  return extractPosSignal(r, g, b, fs);
}

interface AlgoFusionResult {
  filtered: Float64Array;
  weights: { pos: number; chrom: number; green: number };
}

function normalizeUnitStd(arr: Float64Array): Float64Array {
  const m = mean(arr);
  const s = stdDev(arr, m) || 1;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    out[i] = (arr[i] - m) / s;
  }
  return out;
}

function alignPolarityToRef(sig: Float64Array, ref: Float64Array): Float64Array {
  let dot = 0;
  const len = Math.min(sig.length, ref.length);
  for (let i = 0; i < len; i++) {
    dot += sig[i] * ref[i];
  }
  if (dot >= 0) return sig;
  const flipped = new Float64Array(sig.length);
  for (let i = 0; i < sig.length; i++) flipped[i] = -sig[i];
  return flipped;
}

function detrendSlidingMean(signal: Float64Array, halfWin: number): Float64Array {
  const N = signal.length;
  if (N < 8) return new Float64Array(signal);
  const prefix = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) {
    prefix[i + 1] = prefix[i] + signal[i];
  }
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(N - 1, i + halfWin);
    const localMean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    out[i] = signal[i] - localMean;
  }
  return out;
}

/**
 * Tri-Algorithm Phase-Aligned Fusion (POS + CHROM + GREEN) with SNR SoftMax,
 * spectral concentration weighting, and fundamental frequency consensus boosting.
 */
function extractBandpassedByAlgorithm(
  r: Float64Array,
  g: Float64Array,
  b: Float64Array,
  algorithm: RppgAlgorithm,
  mode: CaptureMode,
  fs: number
): AlgoFusionResult {
  const halfDetrend = Math.max(8, Math.round(fs * 0.75));

  if (mode === "finger" || algorithm !== "FUSION") {
    const raw = detrendSlidingMean(
      selectBvpSignal(r, g, b, algorithm, mode, fs),
      halfDetrend
    );
    const filtered = zeroPhaseBandpass(raw, fs, 0.7, 3.5);
    const w =
      mode === "finger" || algorithm === "GREEN"
        ? { pos: 0, chrom: 0, green: 100 }
        : algorithm === "CHROM"
        ? { pos: 0, chrom: 100, green: 0 }
        : { pos: 100, chrom: 0, green: 0 };
    return { filtered, weights: w };
  }

  const fPos = normalizeUnitStd(
    zeroPhaseBandpass(
      detrendSlidingMean(extractPosSignal(r, g, b, fs), halfDetrend),
      fs,
      0.7,
      3.5
    )
  );
  const fChromRaw = normalizeUnitStd(
    zeroPhaseBandpass(
      detrendSlidingMean(extractChromSignal(r, g, b, fs), halfDetrend),
      fs,
      0.7,
      3.5
    )
  );
  const fGreenRaw = normalizeUnitStd(
    zeroPhaseBandpass(
      detrendSlidingMean(extractGreenSignal(r, g, mode), halfDetrend),
      fs,
      0.7,
      3.5
    )
  );

  const fChrom = alignPolarityToRef(fChromRaw, fPos);
  const fGreen = alignPolarityToRef(fGreenRaw, fPos);

  const sPos = evaluateCardiacSpectrum(fPos, fs);
  const sChrom = evaluateCardiacSpectrum(fChrom, fs);
  const sGreen = evaluateCardiacSpectrum(fGreen, fs);

  // Inter-algorithm frequency consensus boost (±0.06 Hz ≈ ±3.6 BPM)
  const near = (f1: number, f2: number) => Math.abs(f1 - f2) <= 0.06;
  const consensusPos =
    (near(sPos.dominantFreqHz, sChrom.dominantFreqHz) ? 1.3 : 1.0) *
    (near(sPos.dominantFreqHz, sGreen.dominantFreqHz) ? 1.18 : 1.0);
  const consensusChrom =
    (near(sChrom.dominantFreqHz, sPos.dominantFreqHz) ? 1.3 : 1.0) *
    (near(sChrom.dominantFreqHz, sGreen.dominantFreqHz) ? 1.18 : 1.0);
  const consensusGreen =
    (near(sGreen.dominantFreqHz, sPos.dominantFreqHz) ? 1.18 : 1.0) *
    (near(sGreen.dominantFreqHz, sChrom.dominantFreqHz) ? 1.18 : 1.0);

  const rawWPos = 1.25 * consensusPos * Math.exp(Math.max(-4, Math.min(18, sPos.snrDb)) / 3.0);
  const rawWChrom = 1.15 * consensusChrom * Math.exp(Math.max(-4, Math.min(18, sChrom.snrDb)) / 3.0);
  const rawWGreen = 0.78 * consensusGreen * Math.exp(Math.max(-4, Math.min(18, sGreen.snrDb)) / 3.0);

  const wSum = rawWPos + rawWChrom + rawWGreen || 1;
  const wp = rawWPos / wSum;
  const wc = rawWChrom / wSum;
  const wg = rawWGreen / wSum;

  const fused = new Float64Array(fPos.length);
  for (let i = 0; i < fPos.length; i++) {
    fused[i] = wp * fPos[i] + wc * fChrom[i] + wg * fGreen[i];
  }

  return {
    filtered: fused,
    weights: {
      pos: Math.round(wp * 100),
      chrom: Math.round(wc * 100),
      green: Math.max(0, 100 - Math.round(wp * 100) - Math.round(wc * 100)),
    },
  };
}

interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

function butterworthLowpassCoeffs(fc: number, fs: number): BiquadCoeffs {
  const ita = 1.0 / Math.tan((Math.PI * fc) / fs);
  const q = Math.SQRT2;
  const b0 = 1.0 / (1.0 + q * ita + ita * ita);
  return {
    b0,
    b1: 2 * b0,
    b2: b0,
    a1: 2 * (1 - ita * ita) * b0,
    a2: (1 - q * ita + ita * ita) * b0,
  };
}

function butterworthHighpassCoeffs(fc: number, fs: number): BiquadCoeffs {
  const ita = Math.tan((Math.PI * fc) / fs);
  const q = Math.SQRT2;
  const b0 = 1.0 / (1.0 + q * ita + ita * ita);
  return {
    b0,
    b1: -2 * b0,
    b2: b0,
    a1: 2 * (ita * ita - 1) * b0,
    a2: (1 - q * ita + ita * ita) * b0,
  };
}

function applyBiquad(x: Float64Array, c: BiquadCoeffs): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    y[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return y;
}

function zeroPhaseBandpass(
  signal: Float64Array,
  fs: number,
  lowHz: number,
  highHz: number
): Float64Array {
  const N = signal.length;
  if (N < 16) return new Float64Array(signal);

  const m = mean(signal);
  const pad = Math.min(Math.round(fs), N - 1);
  const padded = new Float64Array(N + pad * 2);

  for (let i = 0; i < pad; i++) padded[i] = signal[pad - i] - m;
  for (let i = 0; i < N; i++) padded[pad + i] = signal[i] - m;
  for (let i = 0; i < pad; i++) padded[pad + N + i] = signal[N - 2 - i] - m;

  const hp = butterworthHighpassCoeffs(lowHz, fs);
  const lp = butterworthLowpassCoeffs(highHz, fs);

  let tmp = applyBiquad(padded, hp);
  tmp = applyBiquad(tmp, lp);

  const rev = new Float64Array(tmp.length);
  for (let i = 0; i < tmp.length; i++) rev[i] = tmp[tmp.length - 1 - i];
  rev.set(applyBiquad(rev, hp));
  rev.set(applyBiquad(rev, lp));

  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = rev[tmp.length - 1 - (pad + i)];
  }
  return out;
}

function fftReal(signal: Float64Array, fftSize: number): Float64Array {
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);

  const len = Math.min(signal.length, fftSize);
  for (let i = 0; i < len; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
    re[i] = signal[i] * hann;
  }

  let j = 0;
  for (let i = 1; i < fftSize; i++) {
    let bit = fftSize >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
    }
  }

  for (let size = 2; size <= fftSize; size <<= 1) {
    const half = size >> 1;
    const angle = (-2 * Math.PI) / size;
    const wStepRe = Math.cos(angle);
    const wStepIm = Math.sin(angle);

    for (let start = 0; start < fftSize; start += size) {
      let wRe = 1;
      let wIm = 0;
      for (let k = 0; k < half; k++) {
        const i1 = start + k;
        const i2 = i1 + half;
        const tRe = wRe * re[i2] - wIm * im[i2];
        const tIm = wRe * im[i2] + wIm * re[i2];

        re[i2] = re[i1] - tRe;
        im[i2] = im[i1] - tIm;
        re[i1] += tRe;
        im[i1] += tIm;

        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        wIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
      }
    }
  }

  const halfBins = fftSize >> 1;
  const power = new Float64Array(halfBins);
  for (let i = 0; i < halfBins; i++) {
    power[i] = re[i] * re[i] + im[i] * im[i];
  }
  return power;
}

function evaluateCardiacSpectrum(filtered: Float64Array, fs: number) {
  const fftInputLen = Math.min(360, filtered.length);
  const fftSlice = filtered.slice(filtered.length - fftInputLen);
  const fftSize = 2048;
  const power = fftReal(fftSlice, fftSize);
  const binResHz = fs / fftSize;

  const minBin = Math.max(1, Math.floor(0.75 / binResHz));
  const maxBin = Math.min(power.length - 2, Math.ceil(3.2 / binResHz));

  let peakBin = minBin;
  let maxCombScore = 0;
  let maxPower = 0;
  let totalBandPower = 0;

  for (let i = minBin; i <= maxBin; i++) {
    totalBandPower += power[i];
    const h2 = i * 2;
    const harmonicBoost =
      h2 < power.length - 1 ? 0.30 * Math.max(power[h2 - 1], power[h2], power[h2 + 1]) : 0;
    const combScore = power[i] + harmonicBoost;
    if (combScore > maxCombScore) {
      maxCombScore = combScore;
      peakBin = i;
      maxPower = power[i];
    }
  }

  const candFreq = peakBin * binResHz;
  if (candFreq > 1.6) {
    const subBin = Math.round(peakBin / 2);
    if (subBin >= minBin && subBin <= maxBin) {
      let localSubMax = 0;
      let localSubBin = subBin;
      for (
        let k = Math.max(minBin, subBin - 2);
        k <= Math.min(maxBin, subBin + 2);
        k++
      ) {
        if (power[k] > localSubMax) {
          localSubMax = power[k];
          localSubBin = k;
        }
      }
      if (localSubMax >= maxPower * 0.48) {
        peakBin = localSubBin;
        maxPower = localSubMax;
      }
    }
  }

  const pLeft = power[peakBin - 1] ?? 0;
  const pCenter = power[peakBin] ?? 0;
  const pRight = power[peakBin + 1] ?? 0;
  const denom = pLeft - 2 * pCenter + pRight;
  const delta = Math.abs(denom) > 1e-12 ? (0.5 * (pLeft - pRight)) / denom : 0;
  const refinedBin = peakBin + Math.max(-0.5, Math.min(0.5, delta));
  const dominantFreqHz = refinedBin * binResHz;

  const halfWidthBins = Math.max(2, Math.round(0.15 / binResHz));
  let signalPower = 0;
  for (let i = minBin; i <= maxBin; i++) {
    const nearFund = Math.abs(i - peakBin) <= halfWidthBins;
    const nearHarmonic = Math.abs(i - peakBin * 2) <= halfWidthBins;
    if (nearFund || nearHarmonic) signalPower += power[i];
  }
  const noisePower = Math.max(1e-12, totalBandPower - signalPower);
  const snrDb = Number(
    (10 * Math.log10(Math.max(0.05, signalPower / noisePower))).toFixed(1)
  );

  return { power, binResHz, maxPower, dominantFreqHz, snrDb };
}

function detectSystolicPeaksAndPoincare(
  waveform: number[],
  fs: number
): {
  peakIndices: number[];
  rmssdMs: number | null;
  sdnnMs: number | null;
  sd1Ms: number | null;
  sd2Ms: number | null;
  poincarePoints: PoincarePoint[];
} {
  const N = waveform.length;
  if (N < fs * 2) {
    return {
      peakIndices: [],
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      poincarePoints: [],
    };
  }

  const sigma = stdDev(waveform);
  const threshold = sigma * 0.35;
  const minDist = Math.round(0.32 * fs);

  const candidates: number[] = [];
  for (let i = 1; i < N - 1; i++) {
    if (
      waveform[i] > threshold &&
      waveform[i] >= waveform[i - 1] &&
      waveform[i] > waveform[i + 1]
    ) {
      if (candidates.length === 0) {
        candidates.push(i);
      } else {
        const last = candidates[candidates.length - 1];
        if (i - last >= minDist) {
          candidates.push(i);
        } else if (waveform[i] > waveform[last]) {
          candidates[candidates.length - 1] = i;
        }
      }
    }
  }

  if (candidates.length < 4) {
    return {
      peakIndices: candidates,
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      poincarePoints: [],
    };
  }

  const rawIbis: number[] = [];
  for (let i = 1; i < candidates.length; i++) {
    const ibiMs = ((candidates[i] - candidates[i - 1]) / fs) * 1000;
    if (ibiMs >= 330 && ibiMs <= 1450) {
      rawIbis.push(ibiMs);
    }
  }

  if (rawIbis.length < 3) {
    return {
      peakIndices: candidates,
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      poincarePoints: [],
    };
  }

  const sorted = [...rawIbis].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const cleanIbis = rawIbis.filter(
    (v) => v >= med * 0.75 && v <= med * 1.25
  );

  if (cleanIbis.length < 3) {
    return {
      peakIndices: candidates,
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      poincarePoints: [],
    };
  }

  let sqDiffSum = 0;
  const poincarePoints: PoincarePoint[] = [];
  const diffAxis: number[] = [];
  const sumAxis: number[] = [];

  for (let i = 1; i < cleanIbis.length; i++) {
    const a = cleanIbis[i - 1];
    const b = cleanIbis[i];
    const d = b - a;
    sqDiffSum += d * d;
    poincarePoints.push({
      ibiN: Math.round(a),
      ibiNext: Math.round(b),
    });
    diffAxis.push((b - a) / Math.SQRT2);
    sumAxis.push((b + a) / Math.SQRT2);
  }

  const rmssdMs = Math.round(Math.sqrt(sqDiffSum / (cleanIbis.length - 1)));
  const sdnnMs = Math.round(stdDev(cleanIbis));
  const sd1Ms = Math.round(stdDev(diffAxis));
  const sd2Ms = Math.round(stdDev(sumAxis));

  return {
    peakIndices: candidates,
    rmssdMs,
    sdnnMs,
    sd1Ms,
    sd2Ms,
    poincarePoints,
  };
}

function computeRespComponentSnr(signal4Hz: Float64Array): number {
  const fftSize = 512;
  const power = fftReal(signal4Hz, fftSize);
  const binResHz = RESP_FS / fftSize;
  const minBin = Math.max(1, Math.floor(0.12 / binResHz));
  const maxBin = Math.min(power.length - 2, Math.ceil(0.52 / binResHz));

  let peakBin = minBin;
  let maxPower = 0;
  let total = 0;
  for (let i = minBin; i <= maxBin; i++) {
    total += power[i];
    if (power[i] > maxPower) {
      maxPower = power[i];
      peakBin = i;
    }
  }

  const halfBins = Math.max(2, Math.round(0.05 / binResHz));
  let sigPower = 0;
  for (let i = minBin; i <= maxBin; i++) {
    if (Math.abs(i - peakBin) <= halfBins) sigPower += power[i];
  }
  const noise = Math.max(1e-12, total - sigPower);
  return 10 * Math.log10(Math.max(0.05, sigPower / noise));
}

/**
 * Computes normalized cross-correlation coherence (%) between
 * Respiratory Sinus Arrhythmia (RIFV) and Amplitude Modulation (RIAV)
 * across lags up to ±1.5s to measure cardiorespiratory synchronization.
 */
function computeCardiorespiratoryCoherence(
  a: Float64Array,
  b: Float64Array
): number | null {
  const N = Math.min(a.length, b.length);
  if (N < RESP_FS * 8) return null;

  const sa = stdDev(a);
  const sb = stdDev(b);
  if (sa < 1e-6 || sb < 1e-6) return null;

  const ma = mean(a);
  const mb = mean(b);
  const maxLag = Math.round(1.5 * RESP_FS); // ±6 samples at 4 Hz
  let bestCorr = 0;

  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let num = 0;
    let denA = 0;
    let denB = 0;
    for (let i = 0; i < N; i++) {
      const j = i + lag;
      if (j < 0 || j >= N) continue;
      const va = a[i] - ma;
      const vb = b[j] - mb;
      num += va * vb;
      denA += va * va;
      denB += vb * vb;
    }
    const denom = Math.sqrt(denA * denB);
    if (denom > 1e-9) {
      const corr = Math.abs(num / denom);
      if (corr > bestCorr) bestCorr = corr;
    }
  }

  return Math.max(0, Math.min(99, Math.round(bestCorr * 100)));
}

function estimateRespiration(
  r30: Float64Array,
  g30: Float64Array,
  b30: Float64Array,
  durationSec: number,
  algorithm: RppgAlgorithm,
  mode: CaptureMode,
  signalState: SignalQualityState
): {
  respirationBrpm: number | null;
  respSnrDb: number;
  respFreqHz: number | null;
  respWaveform: number[];
  respPeakIndices: number[];
  coherencePct: number | null;
} {
  const N = g30.length;
  if (N < TARGET_FS * 4) {
    return {
      respirationBrpm: null,
      respSnrDb: 0,
      respFreqHz: null,
      respWaveform: [],
      respPeakIndices: [],
      coherencePct: null,
    };
  }

  const rawBvp = selectBvpSignal(r30, g30, b30, algorithm, mode, TARGET_FS);
  const cardiacBvp = zeroPhaseBandpass(rawBvp, TARGET_FS, 0.7, 3.5);

  const sigmaCard = stdDev(cardiacBvp) || 1;
  const minPeakDist = Math.round(0.32 * TARGET_FS);
  const peakIdx: number[] = [];
  for (let i = 1; i < N - 1; i++) {
    if (
      cardiacBvp[i] > sigmaCard * 0.2 &&
      cardiacBvp[i] >= cardiacBvp[i - 1] &&
      cardiacBvp[i] > cardiacBvp[i + 1]
    ) {
      if (peakIdx.length === 0) {
        peakIdx.push(i);
      } else {
        const last = peakIdx[peakIdx.length - 1];
        if (i - last >= minPeakDist) {
          peakIdx.push(i);
        } else if (cardiacBvp[i] > cardiacBvp[last]) {
          peakIdx[peakIdx.length - 1] = i;
        }
      }
    }
  }

  const ampAnchors: Array<{ idx: number; amp: number }> = [];
  const hrAnchors: Array<{ idx: number; instBpm: number }> = [];

  for (let p = 0; p < peakIdx.length; p++) {
    const pk = peakIdx[p];
    const searchStart =
      p === 0 ? Math.max(0, pk - Math.round(0.5 * TARGET_FS)) : peakIdx[p - 1];
    let minVal = cardiacBvp[pk];
    for (let k = searchStart; k < pk; k++) {
      if (cardiacBvp[k] < minVal) minVal = cardiacBvp[k];
    }
    ampAnchors.push({ idx: pk, amp: Math.max(0, cardiacBvp[pk] - minVal) });

    if (p > 0) {
      const dtSec = (pk - peakIdx[p - 1]) / TARGET_FS;
      if (dtSec >= 0.33 && dtSec <= 1.45) {
        hrAnchors.push({ idx: pk, instBpm: 60 / dtSec });
      }
    }
  }

  const riav30 = new Float64Array(N);
  if (ampAnchors.length >= 4) {
    let aIdx = 0;
    for (let i = 0; i < N; i++) {
      if (i <= ampAnchors[0].idx) {
        riav30[i] = ampAnchors[0].amp;
      } else if (i >= ampAnchors[ampAnchors.length - 1].idx) {
        riav30[i] = ampAnchors[ampAnchors.length - 1].amp;
      } else {
        while (aIdx < ampAnchors.length - 2 && ampAnchors[aIdx + 1].idx < i) aIdx++;
        const b0 = ampAnchors[aIdx];
        const b1 = ampAnchors[aIdx + 1];
        const t = (i - b0.idx) / (b1.idx - b0.idx || 1);
        riav30[i] = b0.amp + t * (b1.amp - b0.amp);
      }
    }
  } else {
    const halfWin = Math.round(0.35 * TARGET_FS);
    for (let i = 0; i < N; i++) {
      let acc = 0,
        cnt = 0;
      for (let k = Math.max(0, i - halfWin); k <= Math.min(N - 1, i + halfWin); k++) {
        acc += Math.abs(cardiacBvp[k]);
        cnt++;
      }
      riav30[i] = cnt > 0 ? acc / cnt : 0;
    }
  }

  const rifv30 = new Float64Array(N);
  const hasRifv = hrAnchors.length >= 5;
  if (hasRifv) {
    let hIdx = 0;
    for (let i = 0; i < N; i++) {
      if (i <= hrAnchors[0].idx) {
        rifv30[i] = hrAnchors[0].instBpm;
      } else if (i >= hrAnchors[hrAnchors.length - 1].idx) {
        rifv30[i] = hrAnchors[hrAnchors.length - 1].instBpm;
      } else {
        while (hIdx < hrAnchors.length - 2 && hrAnchors[hIdx + 1].idx < i) hIdx++;
        const h0 = hrAnchors[hIdx];
        const h1 = hrAnchors[hIdx + 1];
        const t = (i - h0.idx) / (h1.idx - h0.idx || 1);
        rifv30[i] = h0.instBpm + t * (h1.instBpm - h0.instBpm);
      }
    }
  }

  const stride = TARGET_FS / RESP_FS;
  const outLen = Math.floor(N / stride);
  if (outLen < 16) {
    return {
      respirationBrpm: null,
      respSnrDb: 0,
      respFreqHz: null,
      respWaveform: [],
      respPeakIndices: [],
      coherencePct: null,
    };
  }

  const mg = mean(g30) || 1;
  const riav4 = new Float64Array(outLen);
  const riiv4 = new Float64Array(outLen);
  const rifv4 = new Float64Array(outLen);

  for (let i = 0; i < outLen; i++) {
    const s = Math.floor(i * stride);
    const e = Math.min(N, Math.floor((i + 1) * stride));
    let sumA = 0,
      sumI = 0,
      sumF = 0,
      cnt = 0;
    for (let k = s; k < e; k++) {
      sumA += riav30[k];
      sumI += -(g30[k] / mg - 1);
      if (hasRifv) sumF += rifv30[k];
      cnt++;
    }
    riav4[i] = cnt > 0 ? sumA / cnt : 0;
    riiv4[i] = cnt > 0 ? sumI / cnt : 0;
    rifv4[i] = cnt > 0 && hasRifv ? sumF / cnt : 0;
  }

  const filtRiav = zeroPhaseBandpass(riav4, RESP_FS, 0.12, 0.55);
  const filtRiiv = zeroPhaseBandpass(riiv4, RESP_FS, 0.12, 0.55);
  const filtRifv = hasRifv
    ? zeroPhaseBandpass(rifv4, RESP_FS, 0.12, 0.55)
    : new Float64Array(outLen);

  const stdA = stdDev(filtRiav) || 1;
  const stdI = stdDev(filtRiiv) || 1;
  const stdF = stdDev(filtRifv) || 1;

  const snrA = computeRespComponentSnr(filtRiav);
  const snrI = computeRespComponentSnr(filtRiiv);
  const snrF = hasRifv ? computeRespComponentSnr(filtRifv) : -20;

  const wA = Math.exp(Math.max(-4, snrA) / 4) * 1.4;
  const wI = Math.exp(Math.max(-4, snrI) / 4) * 0.7;
  const wF = hasRifv ? Math.exp(Math.max(-4, snrF) / 4) * 0.9 : 0;
  const wSum = wA + wI + wF || 1;

  const fused = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    fused[i] =
      (wA * (filtRiav[i] / stdA) +
        wI * (filtRiiv[i] / stdI) +
        wF * (filtRifv[i] / stdF)) /
      wSum;
  }

  const fusedStd = stdDev(fused) || 1;
  const respWaveform = Array.from(fused).map((v) =>
    Math.max(-3.0, Math.min(3.0, v / fusedStd))
  );

  const respPeakIndices: number[] = [];
  const minBreathDist = Math.round(1.8 * RESP_FS);
  for (let i = 1; i < respWaveform.length - 1; i++) {
    if (
      respWaveform[i] > 0.25 &&
      respWaveform[i] >= respWaveform[i - 1] &&
      respWaveform[i] > respWaveform[i + 1]
    ) {
      if (respPeakIndices.length === 0) {
        respPeakIndices.push(i);
      } else {
        const last = respPeakIndices[respPeakIndices.length - 1];
        if (i - last >= minBreathDist) {
          respPeakIndices.push(i);
        } else if (respWaveform[i] > respWaveform[last]) {
          respPeakIndices[respPeakIndices.length - 1] = i;
        }
      }
    }
  }

  const fftSize = 512;
  const power = fftReal(fused, fftSize);
  const binResHz = RESP_FS / fftSize;

  const minBin = Math.max(1, Math.floor(0.12 / binResHz));
  const maxBin = Math.min(power.length - 2, Math.ceil(0.52 / binResHz));

  let peakBin = minBin;
  let maxPower = 0;
  let totalBandPower = 0;
  for (let i = minBin; i <= maxBin; i++) {
    totalBandPower += power[i];
    if (power[i] > maxPower) {
      maxPower = power[i];
      peakBin = i;
    }
  }

  const pL = power[peakBin - 1] ?? 0;
  const pC = power[peakBin] ?? 0;
  const pR = power[peakBin + 1] ?? 0;
  const denom = pL - 2 * pC + pR;
  const delta = Math.abs(denom) > 1e-12 ? (0.5 * (pL - pR)) / denom : 0;
  const refinedBin = peakBin + Math.max(-0.5, Math.min(0.5, delta));
  const respFreqHz = refinedBin * binResHz;
  const estimatedBrpm = Math.round(respFreqHz * 60);

  const halfBins = Math.max(2, Math.round(0.05 / binResHz));
  let sigPower = 0;
  for (let i = minBin; i <= maxBin; i++) {
    if (Math.abs(i - peakBin) <= halfBins) sigPower += power[i];
  }
  const noisePower = Math.max(1e-12, totalBandPower - sigPower);
  const respSnrDb = Number(
    (10 * Math.log10(Math.max(0.05, sigPower / noisePower))).toFixed(1)
  );

  const validResp =
    durationSec >= MIN_SECONDS_FOR_RESPIRATION &&
    respSnrDb >= 0.0 &&
    signalState !== "no_skin"
      ? estimatedBrpm
      : null;

  const coherencePct =
    validResp !== null && hasRifv
      ? computeCardiorespiratoryCoherence(filtRiav, filtRifv)
      : null;

  return {
    respirationBrpm: validResp,
    respSnrDb,
    respFreqHz: validResp ? Number(respFreqHz.toFixed(3)) : null,
    respWaveform,
    respPeakIndices,
    coherencePct,
  };
}

export function analyzeRppgBuffer(
  samples: RgbSample[],
  algorithm: RppgAlgorithm,
  mode: CaptureMode,
  options?: { enableNlms?: boolean; enableAwb?: boolean; kalman?: KalmanBpmTracker }
): RppgMetrics {
  const enableNlms = options?.enableNlms ?? true;
  const enableAwb = options?.enableAwb ?? true;
  const n = samples.length;
  const recent = samples.slice(-30);
  const avgMotion =
    recent.length > 0
      ? recent.reduce((acc, s) => acc + s.motion, 0) / recent.length
      : 0;
  const avgSkin =
    recent.length > 0
      ? recent.reduce((acc, s) => acc + s.skinPct, 0) / recent.length
      : 0;
  const avgLuma =
    recent.length > 0
      ? recent.reduce((acc, s) => acc + s.luma, 0) / recent.length
      : 0;
  const avgSpec =
    recent.length > 0
      ? recent.reduce((acc, s) => acc + (s.specularRejectedPct ?? 0), 0) /
        recent.length
      : 0;

  let fps = 0;
  if (recent.length >= 2) {
    const dtSec = (recent[recent.length - 1].t - recent[0].t) / 1000;
    fps = dtSec > 0 ? Math.round((recent.length - 1) / dtSec) : 0;
  }

  const uniform = resampleUniform(
    samples,
    TARGET_FS,
    MAX_RESP_WINDOW_SECONDS,
    enableNlms,
    enableAwb,
    mode
  );

  if (n < 15 || uniform.r.length < 24) {
    return {
      bpm: null,
      rawFftBpm: null,
      confidence: 0,
      snrDb: 0,
      ambientCanceledDb: 0,
      awb: uniform.awb,
      algoWeights:
        algorithm === "FUSION"
          ? { pos: 42, chrom: 36, green: 22 }
          : algorithm === "CHROM"
          ? { pos: 0, chrom: 100, green: 0 }
          : algorithm === "GREEN" || mode === "finger"
          ? { pos: 0, chrom: 0, green: 100 }
          : { pos: 100, chrom: 0, green: 0 },
      rmssdMs: null,
      sdnnMs: null,
      sd1Ms: null,
      sd2Ms: null,
      coherencePct: null,
      poincarePoints: [],
      respirationBrpm: null,
      respSnrDb: 0,
      respFreqHz: null,
      respWaveform: [],
      respPeakIndices: [],
      roiWeights: { forehead: 34, leftCheek: 33, rightCheek: 33 },
      fps,
      skinCoveragePct: Math.round(avgSkin),
      brightness: Math.round(avgLuma),
      motionIndex: Number(avgMotion.toFixed(1)),
      specularRejectedPct: Number(avgSpec.toFixed(1)),
      signalState: n === 0 ? "idle" : "calibrating",
      waveform: [],
      peakIndices: [],
      spectrum: [],
      dominantFreqHz: null,
      bufferSeconds: Number(uniform.durationSec.toFixed(1)),
    };
  }

  const cardiacMaxSamples = Math.floor(MAX_CARDIAC_WINDOW_SECONDS * TARGET_FS);
  const cardStart = Math.max(0, uniform.r.length - cardiacMaxSamples);

  const r = uniform.r.subarray(cardStart);
  const g = uniform.g.subarray(cardStart);
  const b = uniform.b.subarray(cardStart);

  let filtered: Float64Array;
  let roiWeights = { forehead: 34, leftCheek: 33, rightCheek: 33 };
  let algoWeights = { pos: 100, chrom: 0, green: 0 };

  if (
    mode !== "finger" &&
    uniform.forehead &&
    uniform.leftCheek &&
    uniform.rightCheek
  ) {
    const regions = [
      { key: "forehead" as const, ch: uniform.forehead },
      { key: "leftCheek" as const, ch: uniform.leftCheek },
      { key: "rightCheek" as const, ch: uniform.rightCheek },
    ];

    const regionSignals: Array<{
      key: "forehead" | "leftCheek" | "rightCheek";
      sig: Float64Array;
      rawWeight: number;
      algoW: { pos: number; chrom: number; green: number };
    }> = [];

    for (const reg of regions) {
      if (reg.ch.validRatio < 0.25) {
        regionSignals.push({
          key: reg.key,
          sig: new Float64Array(r.length),
          rawWeight: 0,
          algoW: { pos: 0, chrom: 0, green: 0 },
        });
        continue;
      }
      const resReg = extractBandpassedByAlgorithm(
        reg.ch.r.subarray(cardStart),
        reg.ch.g.subarray(cardStart),
        reg.ch.b.subarray(cardStart),
        algorithm,
        mode,
        TARGET_FS
      );
      const filtR = resReg.filtered;
      const specR = evaluateCardiacSpectrum(filtR, TARGET_FS);
      const sd = stdDev(filtR) || 1;
      const normSig = new Float64Array(filtR.length);
      for (let i = 0; i < filtR.length; i++) normSig[i] = filtR[i] / sd;

      const prior = reg.key === "forehead" ? 1.15 : 1.0;
      const w = prior * Math.exp(Math.max(-5, Math.min(18, specR.snrDb)) / 3.5);
      regionSignals.push({
        key: reg.key,
        sig: normSig,
        rawWeight: w,
        algoW: resReg.weights,
      });
    }

    const totalW = regionSignals.reduce((acc, item) => acc + item.rawWeight, 0);
    if (totalW > 0) {
      filtered = new Float64Array(r.length);
      const refSig =
        regionSignals.find((x) => x.rawWeight > 0)?.sig ?? regionSignals[0].sig;
      let accPos = 0;
      let accChrom = 0;
      let accGreen = 0;
      for (const item of regionSignals) {
        const wNorm = item.rawWeight / totalW;
        roiWeights[item.key] = Math.round(wNorm * 100);
        accPos += wNorm * item.algoW.pos;
        accChrom += wNorm * item.algoW.chrom;
        accGreen += wNorm * item.algoW.green;
        const alignedSig = alignPolarityToRef(item.sig, refSig);
        for (let i = 0; i < filtered.length; i++) {
          filtered[i] += wNorm * alignedSig[i];
        }
      }
      const pInt = Math.round(accPos);
      const cInt = Math.round(accChrom);
      algoWeights = {
        pos: pInt,
        chrom: cInt,
        green: Math.max(0, 100 - pInt - cInt),
      };
    } else {
      const fb = extractBandpassedByAlgorithm(r, g, b, algorithm, mode, TARGET_FS);
      filtered = fb.filtered;
      algoWeights = fb.weights;
    }
  } else {
    const fb = extractBandpassedByAlgorithm(r, g, b, algorithm, mode, TARGET_FS);
    filtered = fb.filtered;
    algoWeights = fb.weights;
    if (mode === "finger") {
      roiWeights = { forehead: 100, leftCheek: 0, rightCheek: 0 };
    }
  }

  const displayLen = Math.min(180, filtered.length);
  const displaySlice = Array.from(
    filtered.slice(filtered.length - displayLen)
  );
  const displayStd = stdDev(displaySlice) || 1;
  const normalizedWave = displaySlice.map((v) =>
    Math.max(-3.2, Math.min(3.2, v / displayStd))
  );

  const { power, binResHz, maxPower, dominantFreqHz, snrDb } =
    evaluateCardiacSpectrum(filtered, TARGET_FS);
  const rawEstimatedBpm = Math.round(dominantFreqHz * 60);

  const spectrum: SpectrumBin[] = [];
  const specStart = Math.floor(0.6 / binResHz);
  const specEnd = Math.min(power.length - 1, Math.ceil(3.5 / binResHz));
  const normBase = maxPower > 0 ? maxPower : 1;
  for (let i = specStart; i <= specEnd; i++) {
    const f = i * binResHz;
    spectrum.push({
      freqHz: Number(f.toFixed(3)),
      bpm: Math.round(f * 60),
      power: Number((power[i] / normBase).toFixed(3)),
    });
  }

  // Compute HRV & Poincaré geometry across full cardiac window (up to 12s)
  const fullCardSlice = Array.from(filtered);
  const fullCardStd = stdDev(fullCardSlice) || 1;
  const fullCardNorm = fullCardSlice.map((v) => v / fullCardStd);
  const hrvStats = detectSystolicPeaksAndPoincare(fullCardNorm, TARGET_FS);

  // Peak indices specifically inside the 6s visible oscilloscope trace
  const wavePeaks = detectSystolicPeaksAndPoincare(normalizedWave, TARGET_FS).peakIndices;

  let signalState: SignalQualityState = "calibrating";
  if (mode !== "calibration") {
    if (avgSkin < 15) {
      signalState = "no_skin";
    } else if (avgLuma < 42) {
      signalState = "low_light";
    } else if (avgMotion > 11.5) {
      signalState = "motion";
    } else if (uniform.durationSec < MIN_SECONDS_FOR_ESTIMATE) {
      signalState = "calibrating";
    } else if (snrDb >= 1.0) {
      signalState = "nominal";
    } else {
      signalState = "motion";
    }
  } else {
    signalState =
      uniform.durationSec < MIN_SECONDS_FOR_ESTIMATE
        ? "calibrating"
        : snrDb >= 1.0
        ? "nominal"
        : "motion";
  }

  const confidence =
    uniform.durationSec < MIN_SECONDS_FOR_ESTIMATE
      ? Math.round((uniform.durationSec / MIN_SECONDS_FOR_ESTIMATE) * 35)
      : Math.max(
          0,
          Math.min(
            99,
            Math.round(45 + snrDb * 6.5 - Math.max(0, avgMotion - 3) * 3)
          )
        );

  const validRawBpm =
    uniform.durationSec >= MIN_SECONDS_FOR_ESTIMATE &&
    snrDb >= 0.5 &&
    signalState !== "no_skin"
      ? rawEstimatedBpm
      : null;

  const kalmanBpm = options?.kalman
    ? options.kalman.update(
        validRawBpm,
        snrDb,
        signalState === "motion" || signalState === "no_skin"
      )
    : validRawBpm;

  const resp = estimateRespiration(
    uniform.r,
    uniform.g,
    uniform.b,
    uniform.durationSec,
    algorithm,
    mode,
    signalState
  );

  return {
    bpm: kalmanBpm,
    rawFftBpm: validRawBpm,
    confidence,
    snrDb,
    ambientCanceledDb: uniform.ambientCanceledDb,
    awb: uniform.awb,
    algoWeights,
    rmssdMs: validRawBpm ? hrvStats.rmssdMs : null,
    sdnnMs: validRawBpm ? hrvStats.sdnnMs : null,
    sd1Ms: validRawBpm ? hrvStats.sd1Ms : null,
    sd2Ms: validRawBpm ? hrvStats.sd2Ms : null,
    coherencePct: resp.coherencePct,
    poincarePoints: validRawBpm ? hrvStats.poincarePoints : [],
    respirationBrpm: resp.respirationBrpm,
    respSnrDb: resp.respSnrDb,
    respFreqHz: resp.respFreqHz,
    respWaveform: resp.respWaveform,
    respPeakIndices: resp.respPeakIndices,
    roiWeights,
    fps,
    skinCoveragePct: Math.round(avgSkin),
    brightness: Math.round(avgLuma),
    motionIndex: Number(avgMotion.toFixed(1)),
    specularRejectedPct: Number(avgSpec.toFixed(1)),
    signalState,
    waveform: normalizedWave,
    peakIndices: wavePeaks,
    spectrum,
    dominantFreqHz: validRawBpm ? Number(dominantFreqHz.toFixed(3)) : null,
    bufferSeconds: Number(uniform.durationSec.toFixed(1)),
  };
}

export function generateSyntheticSample(
  tMs: number,
  targetBpm: number,
  noiseLevel: number,
  targetRespBrpm = 16
): RgbSample {
  const f = targetBpm / 60;
  const fResp = targetRespBrpm / 60;
  const respPhase = (2 * Math.PI * fResp * tMs) / 1000;
  // Physiological RSA (Respiratory Sinus Arrhythmia) modulates beat timing smoothly
  const rsaFreqShift = 0.14 * Math.sin(respPhase);
  const phase = (2 * Math.PI * f * tMs) / 1000 + rsaFreqShift;

  const riavModulation = 1.0 + 0.28 * Math.sin(respPhase);
  const riivBaseline = 0.16 * Math.sin(respPhase - 0.35);

  const pulse =
    riavModulation *
    (0.72 * Math.sin(phase) +
      0.28 * Math.sin(2 * phase - 0.65) +
      0.08 * Math.sin(3 * phase - 1.1));

  // Simulated 1.9 Hz indoor LED / screen flicker present in both background & face
  const ambientFlicker = 1.45 * Math.sin((2 * Math.PI * 1.9 * tMs) / 1000);

  // Simulated slow room color-temperature drift (warm tungsten <-> cool daylight at 0.06 Hz)
  const colorDrift = Math.sin((2 * Math.PI * 0.06 * tMs) / 1000);
  const illumR = 1.0 + 0.14 * colorDrift;
  const illumG = 1.0 + 0.02 * colorDrift;
  const illumB = 1.0 - 0.16 * colorDrift;

  const motionDrift =
    noiseLevel > 0 ? Math.sin(tMs * 0.0023) * noiseLevel * 1.4 : 0;
  const rand = (Math.random() - 0.5) * noiseLevel * 0.6;

  const baseR = 186 - 0.32 * pulse - 0.08 * riivBaseline + ambientFlicker * 0.9 + motionDrift + rand;
  const baseG = 142 - 0.95 * pulse - riivBaseline + ambientFlicker + motionDrift * 1.15 + rand;
  const baseB = 124 - 0.45 * pulse - 0.12 * riivBaseline + ambientFlicker * 0.85 + motionDrift * 1.05 + rand;

  const r = baseR * illumR;
  const g = baseG * illumG;
  const b = baseB * illumB;

  const bgR = (130 + ambientFlicker * 0.9) * illumR;
  const bgG = (132 + ambientFlicker) * illumG;
  const bgB = (128 + ambientFlicker * 0.85) * illumB;

  const cheekNoise = (Math.random() - 0.5) * (noiseLevel + 0.4) * 1.8;

  return {
    t: tMs,
    r,
    g,
    b,
    bgR,
    bgG,
    bgB,
    motion: noiseLevel * 1.5 + Math.random() * 0.6,
    skinPct: 92,
    luma: 152,
    specularRejectedPct: 1.8,
    regions: {
      forehead: { r, g, b, valid: true },
      leftCheek: {
        r: (baseR + rand * 0.4) * illumR,
        g: (baseG + rand * 0.4) * illumG,
        b: (baseB + rand * 0.4) * illumB,
        valid: true,
      },
      rightCheek: {
        r: (baseR + cheekNoise) * illumR,
        g: (baseG + cheekNoise) * illumG,
        b: (baseB + cheekNoise) * illumB,
        valid: true,
      },
    },
  };
}
