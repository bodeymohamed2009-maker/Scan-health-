export type CaptureMode = "face" | "finger" | "calibration";
export type RppgAlgorithm = "FUSION" | "POS" | "CHROM" | "GREEN";
export type ScanDuration = 15 | 30 | 0; // 0 = continuous

export type SignalQualityState =
  | "idle"
  | "calibrating"
  | "nominal"
  | "paused"
  | "motion"
  | "low_light"
  | "no_skin";

export type ZoneGuidance =
  | "ok"
  | "no_face"
  | "off_center"
  | "too_far"
  | "too_close"
  | "low_light";

export interface RoiRgbTriplet {
  r: number;
  g: number;
  b: number;
  valid: boolean;
}

export interface AwbSampleState {
  gainR: number;
  gainG: number;
  gainB: number;
  colorTempK: number;
  applied: boolean;
}

export interface AwbTelemetry {
  enabled: boolean;
  gainR: number;
  gainG: number;
  gainB: number;
  colorTempK: number;
  driftReducedPct: number;
}

export interface RgbSample {
  t: number; // performance.now() in ms
  r: number;
  g: number;
  b: number;
  bgR?: number;
  bgG?: number;
  bgB?: number;
  motion: number;
  skinPct: number;
  luma: number;
  specularRejectedPct?: number;
  awb?: AwbSampleState;
  regions?: {
    forehead: RoiRgbTriplet;
    leftCheek: RoiRgbTriplet;
    rightCheek: RoiRgbTriplet;
  };
}

export interface RoiBox {
  x: number; // normalized 0..1
  y: number; // normalized 0..1
  w: number; // normalized 0..1
  h: number; // normalized 0..1
  label: string;
  kind?: "skin" | "background";
}

export interface FaceBox {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

export interface RoiExtractionResult {
  r: number;
  g: number;
  b: number;
  bgR: number;
  bgG: number;
  bgB: number;
  skinCoveragePct: number;
  brightness: number;
  motionIndex: number;
  specularRejectedPct: number;
  faceCenter: { x: number; y: number };
  faceBox: FaceBox;
  inZone: boolean;
  zoneGuidance: ZoneGuidance;
  roiBoxes: RoiBox[];
  hasValidTarget: boolean;
  awb?: AwbSampleState;
  regions?: {
    forehead: RoiRgbTriplet;
    leftCheek: RoiRgbTriplet;
    rightCheek: RoiRgbTriplet;
  };
}

export interface SpectrumBin {
  freqHz: number;
  bpm: number;
  power: number;
}

export interface PoincarePoint {
  ibiN: number;
  ibiNext: number;
}

export interface RppgMetrics {
  bpm: number | null;
  rawFftBpm: number | null;
  confidence: number;
  snrDb: number;
  ambientCanceledDb: number;
  awb: AwbTelemetry;
  algoWeights: {
    pos: number;
    chrom: number;
    green: number;
  };
  rmssdMs: number | null;
  sdnnMs: number | null;
  sd1Ms: number | null;
  sd2Ms: number | null;
  coherencePct: number | null;
  poincarePoints: PoincarePoint[];
  respirationBrpm: number | null;
  respSnrDb: number;
  respFreqHz: number | null;
  respWaveform: number[];
  respPeakIndices: number[];
  roiWeights: {
    forehead: number;
    leftCheek: number;
    rightCheek: number;
  };
  fps: number;
  skinCoveragePct: number;
  brightness: number;
  motionIndex: number;
  specularRejectedPct: number;
  signalState: SignalQualityState;
  waveform: number[];
  peakIndices: number[];
  spectrum: SpectrumBin[];
  dominantFreqHz: number | null;
  bufferSeconds: number;
}

export interface BiometricProfile {
  age: number | null;
  heightCm: number | null;
  weightKg: number | null;
}

export interface SessionReading {
  id: string;
  timestamp: string;
  mode: CaptureMode;
  algorithm: RppgAlgorithm;
  bpm: number;
  respirationBrpm: number | null;
  rmssdMs: number | null;
  sdnnMs: number | null;
  sd1Ms: number | null;
  sd2Ms: number | null;
  coherencePct: number | null;
  snrDb: number;
  durationSec: number;
}
