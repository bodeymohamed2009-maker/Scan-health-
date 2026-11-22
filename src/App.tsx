import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BookmarkPlus,
  Camera,
  CheckCircle2,
  Cpu,
  FileText,
  Flashlight,
  HeartPulse,
  Info,
  Play,
  ShieldAlert,
  Sparkles,
  Square,
  Waves,
  Wind,
} from "lucide-react";
import { PoincarePlot } from "./components/PoincarePlot";
import { RespirationChart } from "./components/RespirationChart";
import { SessionLogTable } from "./components/SessionLogTable";
import { SessionReportModal } from "./components/SessionReportModal";
import { SpectrumChart } from "./components/SpectrumChart";
import { WaveformChart } from "./components/WaveformChart";
import { RoiFrameExtractor } from "./dsp/roiExtractor";
import {
  KalmanBpmTracker,
  analyzeRppgBuffer,
  generateSyntheticSample,
} from "./dsp/rppgEngine";
import type {
  CaptureMode,
  RgbSample,
  RoiBox,
  RppgAlgorithm,
  RppgMetrics,
  ScanDuration,
  SessionReading,
  SignalQualityState,
} from "./types/rppg";

const INITIAL_METRICS: RppgMetrics = {
  bpm: null,
  rawFftBpm: null,
  confidence: 0,
  snrDb: 0,
  ambientCanceledDb: 0,
  awb: {
    enabled: true,
    gainR: 1,
    gainG: 1,
    gainB: 1,
    colorTempK: 5500,
    driftReducedPct: 0,
  },
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
  fps: 0,
  skinCoveragePct: 0,
  brightness: 0,
  motionIndex: 0,
  specularRejectedPct: 0,
  signalState: "idle",
  waveform: [],
  peakIndices: [],
  spectrum: [],
  dominantFreqHz: null,
  bufferSeconds: 0,
};

function getSignalStatusBadge(state: SignalQualityState): {
  label: string;
  toneClass: string;
} {
  switch (state) {
    case "nominal":
      return {
        label: "● إشارة مستقرة (Kalman Lock)",
        toneClass: "text-emerald-400",
      };
    case "calibrating":
      return {
        label: "○ جارٍ تجميع العينة...",
        toneClass: "text-cyan-400",
      };
    case "motion":
      return {
        label: "▲ حركة أو تشويش مرتفع",
        toneClass: "text-amber-400",
      };
    case "low_light":
      return {
        label: "▲ إضاءة غير كافية",
        toneClass: "text-amber-400",
      };
    case "no_skin":
      return {
        label: "✖ لم يتم رصد البشرة داخل الإطار",
        toneClass: "text-rose-400",
      };
    default:
      return {
        label: "○ جاهز للمسح البصري",
        toneClass: "text-slate-400",
      };
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const samplesRef = useRef<RgbSample[]>([]);
  const extractorRef = useRef<RoiFrameExtractor>(new RoiFrameExtractor());
  const kalmanRef = useRef<KalmanBpmTracker>(new KalmanBpmTracker());
  const lastAnalyzeTimeRef = useRef<number>(0);
  const scanStartTimeRef = useRef<number>(0);

  const [mode, setMode] = useState<CaptureMode>("face");
  const [algorithm, setAlgorithm] = useState<RppgAlgorithm>("POS");
  const [scanDuration, setScanDuration] = useState<ScanDuration>(15);
  const [nlmsEnabled, setNlmsEnabled] = useState<boolean>(true);
  const [awbEnabled, setAwbEnabled] = useState<boolean>(true);

  const [syntheticBpm, setSyntheticBpm] = useState<number>(74);
  const [syntheticRespBrpm, setSyntheticRespBrpm] = useState<number>(16);
  const [syntheticNoise, setSyntheticNoise] = useState<number>(0.4);

  const [isRunning, setIsRunning] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [torchEnabled, setTorchEnabled] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [roiBoxes, setRoiBoxes] = useState<RoiBox[]>([]);
  const [faceCenter, setFaceCenter] = useState<{ x: number; y: number }>({
    x: 0.5,
    y: 0.44,
  });
  const [metrics, setMetrics] = useState<RppgMetrics>(INITIAL_METRICS);
  const [readings, setReadings] = useState<SessionReading[]>([]);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const stopAcquisition = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsRunning(false);
    setTorchEnabled(false);
    setTorchSupported(false);
  }, []);

  const recordSnapshot = useCallback(
    (
      currentMetrics: RppgMetrics,
      activeMode: CaptureMode,
      activeAlgo: RppgAlgorithm,
      duration: number
    ) => {
      if (currentMetrics.bpm === null) return;
      const now = new Date();
      const timeLabel = now.toLocaleTimeString("en-GB", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const entry: SessionReading = {
        id: `${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: timeLabel,
        mode: activeMode,
        algorithm: activeAlgo,
        bpm: currentMetrics.bpm,
        respirationBrpm: currentMetrics.respirationBrpm,
        rmssdMs: currentMetrics.rmssdMs,
        sdnnMs: currentMetrics.sdnnMs,
        sd1Ms: currentMetrics.sd1Ms,
        sd2Ms: currentMetrics.sd2Ms,
        coherencePct: currentMetrics.coherencePct,
        snrDb: currentMetrics.snrDb,
        durationSec: Math.round(duration),
      };
      setReadings((prev) => [entry, ...prev].slice(0, 50));
      setSaveNotice(
        `تم تسجيل القراءة: ${currentMetrics.bpm} BPM${
          currentMetrics.respirationBrpm !== null
            ? ` · ${currentMetrics.respirationBrpm} BrPM`
            : ""
        }`
      );
    },
    []
  );

  const toggleTorch = useCallback(async (nextState: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ torch: nextState } as MediaTrackConstraintSet],
      });
      setTorchEnabled(nextState);
    } catch {
      setTorchSupported(false);
    }
  }, []);

  const startAcquisition = useCallback(async () => {
    stopAcquisition();
    setCameraError(null);
    setSaveNotice(null);
    samplesRef.current = [];
    extractorRef.current.reset();
    kalmanRef.current.reset();
    lastAnalyzeTimeRef.current = 0;
    scanStartTimeRef.current = performance.now();
    setElapsedSec(0);
    setFaceCenter({ x: 0.5, y: 0.44 });
    setMetrics({ ...INITIAL_METRICS, signalState: "calibrating" });

    if (mode === "calibration") {
      setIsRunning(true);
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError(
        "المتصفح أو البيئة الحالية لا تدعم الوصول للكاميرا. يمكنك استخدام «إشارة معايرة مخبرية» لاختبار كامل محرك NLMS + POS + Kalman."
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode === "finger" ? { ideal: "environment" } : "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });

      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];

      if (track && typeof track.getCapabilities === "function") {
        const caps = track.getCapabilities() as MediaTrackCapabilities & {
          torch?: boolean;
          whiteBalanceMode?: string[];
        };
        if (caps.torch) {
          setTorchSupported(true);
          if (mode === "finger") {
            try {
              await track.applyConstraints({
                advanced: [{ torch: true } as MediaTrackConstraintSet],
              });
              setTorchEnabled(true);
            } catch {
              setTorchEnabled(false);
            }
          }
        }
        if (caps.whiteBalanceMode?.includes("manual")) {
          try {
            await track.applyConstraints({
              advanced: [{ whiteBalanceMode: "manual" } as MediaTrackConstraintSet],
            });
          } catch {
            // Optional hardware lock
          }
        }
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setIsRunning(true);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "تعذر الوصول إلى الكاميرا";
      setCameraError(
        `تعذر تشغيل الكاميرا (${msg}). تأكد من منح الإذن أو اختر «إشارة معايرة مخبرية» لاختبار النظام.`
      );
      stopAcquisition();
    }
  }, [mode, stopAcquisition]);

  useEffect(() => {
    if (!isRunning) return;

    let lastSyntheticPush = 0;
    let cancelled = false;

    const tick = (now: number) => {
      if (cancelled) return;

      const elapsed = (now - scanStartTimeRef.current) / 1000;
      setElapsedSec(elapsed);

      if (mode === "calibration") {
        if (now - lastSyntheticPush >= 32) {
          lastSyntheticPush = now;
          const sample = generateSyntheticSample(
            now,
            syntheticBpm,
            syntheticNoise,
            syntheticRespBrpm
          );
          samplesRef.current.push(sample);
          if (samplesRef.current.length > 960) {
            samplesRef.current.shift();
          }
          setFaceCenter({ x: 0.5, y: 0.44 });
          setRoiBoxes([
            { x: 0.37, y: 0.20, w: 0.26, h: 0.12, label: "Forehead ROI", kind: "skin" },
            { x: 0.32, y: 0.44, w: 0.12, h: 0.14, label: "Cheek L", kind: "skin" },
            { x: 0.56, y: 0.44, w: 0.12, h: 0.14, label: "Cheek R", kind: "skin" },
            { x: 0.04, y: 0.06, w: 0.12, h: 0.18, label: "Ambient Ref L", kind: "background" },
            { x: 0.84, y: 0.06, w: 0.12, h: 0.18, label: "Ambient Ref R", kind: "background" },
          ]);
        }
      } else {
        const video = videoRef.current;
        const canvas = analysisCanvasRef.current;
        if (video && canvas && video.readyState >= 2) {
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const roi = extractorRef.current.extract(imgData, mode, awbEnabled);
            setRoiBoxes(roi.roiBoxes);
            setFaceCenter(roi.faceCenter);

            if (roi.hasValidTarget) {
              samplesRef.current.push({
                t: now,
                r: roi.r,
                g: roi.g,
                b: roi.b,
                bgR: roi.bgR,
                bgG: roi.bgG,
                bgB: roi.bgB,
                motion: roi.motionIndex,
                skinPct: roi.skinCoveragePct,
                luma: roi.brightness,
                specularRejectedPct: roi.specularRejectedPct,
                awb: roi.awb,
                regions: roi.regions,
              });
              if (samplesRef.current.length > 960) {
                samplesRef.current.shift();
              }
            } else {
              setMetrics((prev) => ({
                ...prev,
                skinCoveragePct: Math.round(roi.skinCoveragePct),
                brightness: Math.round(roi.brightness),
                motionIndex: Number(roi.motionIndex.toFixed(1)),
                specularRejectedPct: Number(roi.specularRejectedPct.toFixed(1)),
                awb: roi.awb
                  ? {
                      enabled: awbEnabled,
                      gainR: roi.awb.gainR,
                      gainG: roi.awb.gainG,
                      gainB: roi.awb.gainB,
                      colorTempK: roi.awb.colorTempK,
                      driftReducedPct: prev.awb.driftReducedPct,
                    }
                  : prev.awb,
                signalState:
                  roi.brightness < 38 && mode === "face" ? "low_light" : "no_skin",
              }));
            }
          }
        }
      }

      if (now - lastAnalyzeTimeRef.current >= 200) {
        lastAnalyzeTimeRef.current = now;
        const computed = analyzeRppgBuffer(
          samplesRef.current,
          algorithm,
          mode,
          {
            enableNlms: nlmsEnabled,
            enableAwb: awbEnabled,
            kalman: kalmanRef.current,
          }
        );
        setMetrics(computed);

        if (scanDuration > 0 && elapsed >= scanDuration) {
          if (computed.bpm !== null) {
            recordSnapshot(computed, mode, algorithm, scanDuration);
          }
          stopAcquisition();
          return;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [
    isRunning,
    mode,
    algorithm,
    nlmsEnabled,
    awbEnabled,
    scanDuration,
    syntheticBpm,
    syntheticRespBrpm,
    syntheticNoise,
    recordSnapshot,
    stopAcquisition,
  ]);

  useEffect(() => {
    return () => stopAcquisition();
  }, [stopAcquisition]);

  function handleModeChange(nextMode: CaptureMode) {
    if (isRunning) stopAcquisition();
    setMode(nextMode);
    setCameraError(null);
    setRoiBoxes([]);
    kalmanRef.current.reset();
    setMetrics(INITIAL_METRICS);
  }

  function handleExportCsv() {
    if (readings.length === 0) return;
    const header = [
      "timestamp",
      "mode",
      "algorithm",
      "bpm",
      "respiration_brpm",
      "coherence_pct",
      "rmssd_ms",
      "sdnn_ms",
      "sd1_ms",
      "sd2_ms",
      "snr_db",
      "duration_sec",
    ].join(",");
    const rows = readings.map((r) =>
      [
        r.timestamp,
        r.mode,
        r.algorithm,
        r.bpm,
        r.respirationBrpm ?? "",
        r.coherencePct ?? "",
        r.rmssdMs ?? "",
        r.sdnnMs ?? "",
        r.sd1Ms ?? "",
        r.sd2Ms ?? "",
        r.snrDb,
        r.durationSec,
      ].join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pulselab-rppg-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const statusBadge = getSignalStatusBadge(metrics.signalState);
  const progressPct =
    scanDuration > 0
      ? Math.min(100, Math.round((elapsedSec / scanDuration) * 100))
      : 0;

  return (
    <div className="min-h-screen bg-[#070b12] text-slate-200 flex flex-col">
      {/* Top Bar Contract: Single Row, 3 Zones */}
      <header className="sticky top-0 z-30 bg-[#070b12]/95 backdrop-blur-sm border-b border-slate-800 no-print">
        <div className="max-w-7xl mx-auto px-6 py-3.5 flex items-center justify-between gap-8">
          <a
            href="#"
            dir="ltr"
            className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            PulseLab Pro
          </a>

          <nav
            aria-label="التنقل الرئيسي"
            className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-400"
          >
            <a
              href="#console"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              جهاز القياس
            </a>
            <a
              href="#waveforms"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              التحليل الطيفي
            </a>
            <a
              href="#autonomic"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              التوازن العصبي
            </a>
            <a
              href="#science"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              الابتكارات العلمية
            </a>
            <a
              href="#distinction"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              تميّز
            </a>
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={isRunning ? stopAcquisition : startAcquisition}
              className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isRunning
                  ? "bg-rose-600 hover:bg-rose-500 text-white"
                  : "bg-cyan-400 hover:bg-cyan-300 text-slate-950"
              }`}
            >
              {isRunning ? (
                <>
                  <Square className="w-3.5 h-3.5" />
                  <span>إيقاف القياس</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>بدء القياس</span>
                </>
              )}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 no-print">
        {/* Precision Telemetry Ribbon */}
        <div className="bg-[#0d131f] border-b border-slate-800">
          <div className="max-w-7xl mx-auto px-6 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs text-slate-400">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>
                محطة rPPG بصرية متقدمة: موازنة اللون الأبيض AWB + تتبع وجه
                ديناميكي + إلغاء وميض الإضاءة NLMS + مرشح كالمان. للاستخدام البحثي
                وليس جهازاً طبياً.
              </span>
            </div>
            <div
              dir="ltr"
              className="flex items-center gap-3 font-mono text-cyan-300 tabular-nums shrink-0"
            >
              <span>
                {mode === "finger"
                  ? "AWB: Contact"
                  : awbEnabled
                  ? `AWB: ${metrics.awb.colorTempK}K`
                  : "AWB: OFF"}
              </span>
              <span className="text-slate-600">|</span>
              <span>
                {nlmsEnabled
                  ? `NLMS: -${metrics.ambientCanceledDb.toFixed(1)} dB`
                  : "NLMS: OFF"}
              </span>
            </div>
          </div>
        </div>

        {/* Asymmetric Split Console */}
        <section
          id="console"
          className="max-w-7xl mx-auto px-6 py-7 grid grid-cols-1 lg:grid-cols-12 gap-6 items-start"
        >
          {/* Left Control & Calibration Column (4 cols) */}
          <aside className="lg:col-span-4 bg-[#0d131f] border border-slate-800 rounded-xl p-5 flex flex-col gap-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-lg font-bold text-white tracking-wide">
                  وحدة التحكم والمعايرة
                </h1>
                <p className="text-xs text-slate-400 mt-0.5">
                  معالجة محلية كاملة 30 Hz دون رفع أي صور
                </p>
              </div>
              {metrics.bpm !== null && (
                <button
                  type="button"
                  onClick={() => setReportOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-cyan-300 bg-[#070b12] border border-slate-700 hover:border-cyan-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>التقرير</span>
                </button>
              )}
            </div>

            {/* Capture Mode */}
            <div>
              <span className="block text-xs font-semibold text-slate-300 mb-2">
                نمط الالتقاط البصري
              </span>
              <div className="grid grid-cols-1 gap-1.5 p-1 bg-[#070b12] border border-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => handleModeChange("face")}
                  className={`flex items-center justify-between px-3 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    mode === "face"
                      ? "bg-slate-800 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <span>كاميرا الوجه (تتبع ديناميكي)</span>
                  <span dir="ltr" className="font-mono text-[11px] text-cyan-400">
                    Multi-ROI
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleModeChange("finger")}
                  className={`flex items-center justify-between px-3 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    mode === "finger"
                      ? "bg-slate-800 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <span>الإصبع + الفلاش الخلفي (Contact PPG)</span>
                  <span dir="ltr" className="font-mono text-[11px] text-emerald-400">
                    R+G Contact
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => handleModeChange("calibration")}
                  className={`flex items-center justify-between px-3 py-2 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    mode === "calibration"
                      ? "bg-slate-800 text-white"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <span>إشارة معايرة مخبرية (بدون كاميرا)</span>
                  <span dir="ltr" className="font-mono text-[11px] text-teal-400">
                    Synthetic DSP
                  </span>
                </button>
              </div>
            </div>

            {/* Algorithm Selector */}
            {mode !== "finger" && (
              <div>
                <span className="block text-xs font-semibold text-slate-300 mb-2">
                  خوارزمية استخلاص النبض
                </span>
                <div
                  dir="ltr"
                  className="grid grid-cols-3 gap-1.5 p-1 bg-[#070b12] border border-slate-800 rounded-lg"
                >
                  {(["POS", "CHROM", "GREEN"] as RppgAlgorithm[]).map((algo) => (
                    <button
                      key={algo}
                      type="button"
                      onClick={() => setAlgorithm(algo)}
                      className={`py-2 text-xs font-mono font-semibold rounded-md transition-colors cursor-pointer ${
                        algorithm === algo
                          ? "bg-slate-800 text-cyan-300"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {algo}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Adaptive White Balance & NLMS Signal Conditioning Toggles */}
            {mode !== "finger" && (
              <div className="flex flex-col gap-2">
                <div className="bg-[#070b12] border border-slate-800 rounded-lg px-3.5 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <span className="block text-xs font-semibold text-slate-200">
                        توازن اللون الأبيض التكيفي (AWB)
                      </span>
                      <span className="block text-[11px] text-slate-400 mt-0.5">
                        تثبيت ألوان البشرة تحت إضاءة الغرفة المتغيرة
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={awbEnabled}
                      onClick={() => setAwbEnabled((v) => !v)}
                      className={`px-3 py-1.5 text-xs font-mono font-semibold rounded-md transition-colors shrink-0 cursor-pointer ${
                        awbEnabled
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                          : "bg-slate-800 text-slate-400 border border-slate-700"
                      }`}
                    >
                      {awbEnabled ? "ON" : "OFF"}
                    </button>
                  </div>
                  {awbEnabled && (
                    <div
                      dir="ltr"
                      className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px] font-mono text-slate-400 tabular-nums"
                    >
                      <span>CCT {metrics.awb.colorTempK}K</span>
                      <span>
                        R×{metrics.awb.gainR.toFixed(2)} G×{metrics.awb.gainG.toFixed(2)} B×{metrics.awb.gainB.toFixed(2)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 bg-[#070b12] border border-slate-800 rounded-lg px-3.5 py-2.5">
                  <div>
                    <span className="block text-xs font-semibold text-slate-200">
                      إلغاء وميض الإضاءة الخلفي (NLMS)
                    </span>
                    <span className="block text-[11px] text-slate-400 mt-0.5">
                      طرح تذبذب الشاشة وLED تلقائياً
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={nlmsEnabled}
                    onClick={() => setNlmsEnabled((v) => !v)}
                    className={`px-3 py-1.5 text-xs font-mono font-semibold rounded-md transition-colors shrink-0 cursor-pointer ${
                      nlmsEnabled
                        ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                        : "bg-slate-800 text-slate-400 border border-slate-700"
                    }`}
                  >
                    {nlmsEnabled ? "ON" : "OFF"}
                  </button>
                </div>
              </div>
            )}

            {/* Scan Window */}
            <div>
              <span className="block text-xs font-semibold text-slate-300 mb-2">
                مدة جلسة الفحص
              </span>
              <div className="grid grid-cols-3 gap-1.5 p-1 bg-[#070b12] border border-slate-800 rounded-lg">
                {(
                  [
                    { val: 15, label: "15 ثانية" },
                    { val: 30, label: "30 ثانية" },
                    { val: 0, label: "مستمر" },
                  ] as Array<{ val: ScanDuration; label: string }>
                ).map((item) => (
                  <button
                    key={item.val}
                    type="button"
                    onClick={() => setScanDuration(item.val)}
                    className={`py-2 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                      scanDuration === item.val
                        ? "bg-slate-800 text-white"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Calibration Test Sliders */}
            {mode === "calibration" && (
              <div className="bg-[#070b12] border border-slate-800 rounded-lg p-3.5 flex flex-col gap-3">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-slate-300">
                      تردد النبض المرجعي
                    </span>
                    <span
                      dir="ltr"
                      className="font-mono font-semibold text-cyan-300 tabular-nums"
                    >
                      {syntheticBpm} BPM
                    </span>
                  </div>
                  <input
                    type="range"
                    min={50}
                    max={140}
                    step={1}
                    value={syntheticBpm}
                    onChange={(e) => setSyntheticBpm(Number(e.target.value))}
                    className="w-full accent-cyan-400 cursor-pointer"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-slate-300">
                      معدل التنفس المرجعي
                    </span>
                    <span
                      dir="ltr"
                      className="font-mono font-semibold text-teal-300 tabular-nums"
                    >
                      {syntheticRespBrpm} BrPM
                    </span>
                  </div>
                  <input
                    type="range"
                    min={8}
                    max={28}
                    step={1}
                    value={syntheticRespBrpm}
                    onChange={(e) => setSyntheticRespBrpm(Number(e.target.value))}
                    className="w-full accent-teal-400 cursor-pointer"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold text-slate-300">
                      تشويش الحركة الاصطناعي
                    </span>
                    <span
                      dir="ltr"
                      className="font-mono font-semibold text-slate-300 tabular-nums"
                    >
                      {syntheticNoise.toFixed(1)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={3}
                    step={0.2}
                    value={syntheticNoise}
                    onChange={(e) => setSyntheticNoise(Number(e.target.value))}
                    className="w-full accent-cyan-400 cursor-pointer"
                  />
                </div>
              </div>
            )}

            {/* Live Diagnostics & Multi-ROI Fusion */}
            <div className="border-t border-slate-800 pt-4">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="bg-[#070b12] border border-slate-800 rounded-lg p-2.5">
                  <span className="block text-[11px] text-slate-400">
                    تغطية البشرة
                  </span>
                  <span
                    dir="ltr"
                    className="block font-mono text-sm font-semibold text-white tabular-nums mt-0.5"
                  >
                    {metrics.skinCoveragePct}%
                  </span>
                </div>
                <div className="bg-[#070b12] border border-slate-800 rounded-lg p-2.5">
                  <span className="block text-[11px] text-slate-400">
                    معدل الإطارات
                  </span>
                  <span
                    dir="ltr"
                    className="block font-mono text-sm font-semibold text-white tabular-nums mt-0.5"
                  >
                    {metrics.fps} FPS
                  </span>
                </div>
                <div className="bg-[#070b12] border border-slate-800 rounded-lg p-2.5">
                  <span className="block text-[11px] text-slate-400">
                    السطوع / عزل اللمعان
                  </span>
                  <span
                    dir="ltr"
                    className="block font-mono text-sm font-semibold text-white tabular-nums mt-0.5"
                  >
                    {metrics.brightness} · {metrics.specularRejectedPct}%
                  </span>
                </div>
                <div className="bg-[#070b12] border border-slate-800 rounded-lg p-2.5">
                  <span className="block text-[11px] text-slate-400">
                    مؤشر الحركة
                  </span>
                  <span
                    dir="ltr"
                    className="block font-mono text-sm font-semibold text-white tabular-nums mt-0.5"
                  >
                    {metrics.motionIndex.toFixed(1)} ΔY
                  </span>
                </div>
              </div>

              {mode !== "finger" && (
                <div className="mt-3 bg-[#070b12] border border-slate-800 rounded-lg p-3">
                  <div className="flex items-center justify-between text-[11px] font-semibold text-slate-300 mb-2">
                    <span>دمج المناطق الذكي (Multi-ROI SNR Fusion)</span>
                    <span dir="ltr" className="font-mono text-cyan-400">
                      Live Weights
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {[
                      { label: "الجبهة", val: metrics.roiWeights.forehead },
                      { label: "الخد الأيسر", val: metrics.roiWeights.leftCheek },
                      { label: "الخد الأيمن", val: metrics.roiWeights.rightCheek },
                    ].map((reg) => (
                      <div
                        key={reg.label}
                        className="flex items-center gap-2 text-[11px]"
                      >
                        <span className="w-16 text-slate-400 shrink-0">
                          {reg.label}
                        </span>
                        <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-cyan-400 transition-all duration-200"
                            style={{ width: `${reg.val}%` }}
                          />
                        </div>
                        <span
                          dir="ltr"
                          className="w-8 text-left font-mono text-slate-200 tabular-nums shrink-0"
                        >
                          {reg.val}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={isRunning ? stopAcquisition : startAcquisition}
                className={`w-full inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg transition-colors cursor-pointer ${
                  isRunning
                    ? "bg-rose-600 hover:bg-rose-500 text-white"
                    : "bg-cyan-400 hover:bg-cyan-300 text-slate-950"
                }`}
              >
                {isRunning ? (
                  <>
                    <Square className="w-4 h-4" />
                    <span>إيقاف الجلسة الحالية</span>
                  </>
                ) : (
                  <>
                    <Camera className="w-4 h-4" />
                    <span>
                      {mode === "calibration"
                        ? "تشغيل إشارة المعايرة"
                        : "تشغيل الكاميرا وبدء الفحص"}
                    </span>
                  </>
                )}
              </button>

              {isRunning && metrics.bpm !== null && (
                <button
                  type="button"
                  onClick={() =>
                    recordSnapshot(
                      metrics,
                      mode,
                      algorithm,
                      Math.max(1, elapsedSec)
                    )
                  }
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
                >
                  <BookmarkPlus className="w-4 h-4" />
                  <span>حفظ لقطة القراءة الحالية في السجل</span>
                </button>
              )}
            </div>
          </aside>

          {/* Right Main Telemetry & Optical Viewport (8 cols) */}
          <div className="lg:col-span-8 flex flex-col gap-5">
            {/* 5-Card Obsidian Telemetry Readouts */}
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
              {/* Kalman BPM Card */}
              <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>نبض القلب</span>
                  <HeartPulse className="w-4 h-4 text-cyan-400" />
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-white tabular-nums">
                    {metrics.bpm !== null ? metrics.bpm : "--"}
                  </span>
                  <span className="font-mono text-xs text-slate-400 uppercase">
                    BPM
                  </span>
                </div>
                <p
                  dir="ltr"
                  className="text-[11px] text-slate-400 mt-1 font-mono tabular-nums"
                >
                  {metrics.rawFftBpm !== null
                    ? `Kalman · FFT ${metrics.rawFftBpm}`
                    : "5s buffer required"}
                </p>
              </div>

              {/* Respiration Rate Card */}
              <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>معدل التنفس</span>
                  <Wind className="w-4 h-4 text-teal-400" />
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-white tabular-nums">
                    {metrics.respirationBrpm !== null
                      ? metrics.respirationBrpm
                      : "--"}
                  </span>
                  <span className="font-mono text-xs text-slate-400 uppercase">
                    BrPM
                  </span>
                </div>
                <p
                  dir="ltr"
                  className="text-[11px] text-slate-400 mt-1 font-mono tabular-nums"
                >
                  {metrics.respirationBrpm !== null
                    ? `SNR: ${metrics.respSnrDb.toFixed(1)} dB`
                    : `${Math.min(12, metrics.bufferSeconds).toFixed(0)}/12s buffer`}
                </p>
              </div>

              {/* Cardiorespiratory Coherence Card */}
              <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>التناغم القلبي</span>
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-white tabular-nums">
                    {metrics.coherencePct !== null
                      ? metrics.coherencePct
                      : "--"}
                  </span>
                  <span className="font-mono text-xs text-slate-400 uppercase">
                    %
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  تزامن RSA والتنفس
                </p>
              </div>

              {/* Signal SNR + HRV Card */}
              <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>جودة الإشارة</span>
                  <Waves className="w-4 h-4 text-cyan-400" />
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold text-white tabular-nums">
                    {metrics.bufferSeconds >= 2 ? metrics.snrDb.toFixed(1) : "--"}
                  </span>
                  <span className="font-mono text-xs text-slate-400 uppercase">
                    dB
                  </span>
                </div>
                <p className={`text-[11px] font-semibold mt-1 ${statusBadge.toneClass}`}>
                  {statusBadge.label}
                </p>
              </div>

              {/* Honest SpO2 Limitation Card */}
              <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4 col-span-2 md:col-span-1">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>الأكسجين (SpO2)</span>
                  <ShieldAlert className="w-4 h-4 text-amber-400" />
                </div>
                <div dir="ltr" className="mt-2 flex items-baseline gap-1.5">
                  <span className="font-mono text-xl font-bold text-slate-300">
                    N/A
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">
                    RGB Camera
                  </span>
                </div>
                <p className="text-[11px] text-amber-300 font-medium mt-1 leading-snug">
                  يتطلب مستشعر 660/940nm
                </p>
              </div>
            </div>

            {cameraError && (
              <div
                role="alert"
                className="bg-rose-950/60 border border-rose-800 rounded-xl p-4 flex items-start gap-3 text-sm text-rose-200"
              >
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <p className="text-xs leading-relaxed">{cameraError}</p>
              </div>
            )}

            {saveNotice && (
              <div className="bg-emerald-950/50 border border-emerald-800 rounded-xl px-4 py-2.5 flex items-center justify-between text-xs font-medium text-emerald-200">
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>{saveNotice}</span>
                </span>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => setReportOpen(true)}
                    className="underline font-semibold text-cyan-300 cursor-pointer"
                  >
                    عرض التقرير
                  </button>
                  <a href="#history" className="underline font-semibold">
                    السجل
                  </a>
                </div>
              </div>
            )}

            {/* Live Optical Camera & Dynamic Centroid HUD */}
            <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
                  <span>
                    {mode === "calibration"
                      ? "محاكاة بصرية + وميض إضاءة اصطناعي لاختبار NLMS & Multi-ROI"
                      : mode === "finger"
                      ? "عدسة الاتصال بالإصبع (Contact PPG)"
                      : "منظور تتبع الوجه الديناميكي + مستشعرات الوميض الخلفي"}
                  </span>
                </div>

                <div className="flex items-center gap-3">
                  {torchSupported && mode === "finger" && isRunning && (
                    <button
                      type="button"
                      onClick={() => toggleTorch(!torchEnabled)}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border cursor-pointer ${
                        torchEnabled
                          ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                          : "bg-slate-800 border-slate-700 text-slate-300"
                      }`}
                    >
                      <Flashlight className="w-3.5 h-3.5" />
                      <span>{torchEnabled ? "إيقاف الفلاش" : "تشغيل الفلاش"}</span>
                    </button>
                  )}

                  <span
                    dir="ltr"
                    className="font-mono text-xs text-cyan-300 tabular-nums"
                  >
                    {scanDuration > 0
                      ? `${Math.min(scanDuration, elapsedSec).toFixed(1)}s / ${scanDuration}s`
                      : `Buffer: ${metrics.bufferSeconds.toFixed(1)}s`}
                  </span>
                </div>
              </div>

              <canvas
                ref={analysisCanvasRef}
                width={160}
                height={120}
                className="hidden"
              />

              <div className="relative w-full aspect-video max-h-[380px] bg-[#04070c] rounded-lg overflow-hidden border border-slate-800 flex items-center justify-center">
                {mode !== "calibration" ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover ${
                      mode === "face" ? "-scale-x-100" : ""
                    }`}
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-slate-300 p-6 text-center">
                    <Cpu className="w-8 h-8 text-cyan-400" />
                    <p className="text-sm font-semibold text-white">
                      محاكاة بصرية كاملة لاختبار دقة الخوارزميات
                    </p>
                    <p dir="ltr" className="font-mono text-xs text-slate-400">
                      HR: {syntheticBpm} BPM · RR: {syntheticRespBrpm} BrPM · AWB:{" "}
                      {awbEnabled ? "ON" : "OFF"} · NLMS: {nlmsEnabled ? "ON" : "OFF"}
                    </p>
                  </div>
                )}

                {/* Dynamic Centroid-Locked ROIs & Ambient Reference Zones */}
                {mode !== "finger" && (
                  <svg
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className="pointer-events-none absolute inset-0 w-full h-full"
                  >
                    <ellipse
                      cx={(1 - faceCenter.x) * 100}
                      cy={faceCenter.y * 100}
                      rx="21"
                      ry="34"
                      fill="none"
                      stroke={
                        metrics.signalState === "nominal"
                          ? "#10b981"
                          : "#06b6d4"
                      }
                      strokeWidth="0.55"
                      strokeDasharray="2 1.5"
                    />
                    {isRunning &&
                      roiBoxes.map((box) => {
                        const mirroredX =
                          mode === "face"
                            ? (1 - box.x - box.w) * 100
                            : box.x * 100;
                        const isBg = box.kind === "background";
                        return (
                          <g key={box.label}>
                            <rect
                              x={mirroredX}
                              y={box.y * 100}
                              width={box.w * 100}
                              height={box.h * 100}
                              fill={
                                isBg
                                  ? "rgba(148, 163, 184, 0.08)"
                                  : "rgba(6, 182, 212, 0.14)"
                              }
                              stroke={isBg ? "#64748b" : "#22d3ee"}
                              strokeWidth="0.45"
                              strokeDasharray={isBg ? "1.5 1" : undefined}
                            />
                          </g>
                        );
                      })}
                  </svg>
                )}

                {mode === "finger" && isRunning && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="w-32 h-32 rounded-2xl border-2 border-dashed border-cyan-400 flex items-end justify-center p-2">
                      <span className="text-[11px] font-medium text-white bg-slate-900/80 px-2 py-0.5 rounded">
                        غطِّ العدسة بإصبعك بلطف
                      </span>
                    </div>
                  </div>
                )}

                {!isRunning && mode !== "calibration" && (
                  <div className="absolute inset-0 bg-[#04070c]/85 flex flex-col items-center justify-center gap-3 p-6 text-center">
                    <Camera className="w-8 h-8 text-cyan-400" />
                    <p className="text-sm font-semibold text-white">
                      {mode === "face"
                        ? "ضع وجهك داخل الإطار البيضاوي في إضاءة متساوية"
                        : "ضع طرف إصبعك برفق على الكاميرا الخلفية"}
                    </p>
                    <p className="text-xs text-slate-400 max-w-md leading-relaxed">
                      يتم تتبع مناطق الجلد ديناميكياً وطرح وميض الإضاءة الخلفي
                      عبر NLMS محلياً على جهازك دون إرسال أي بيانات.
                    </p>
                  </div>
                )}
              </div>

              {scanDuration > 0 && (
                <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-cyan-400 transition-all duration-200"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              )}
            </div>

            {/* Cardiac Oscilloscope & FFT Spectrum */}
            <div
              id="waveforms"
              className="grid grid-cols-1 xl:grid-cols-2 gap-5"
            >
              <WaveformChart
                waveform={metrics.waveform}
                peakIndices={metrics.peakIndices}
                fps={metrics.fps}
              />
              <SpectrumChart
                spectrum={metrics.spectrum}
                dominantFreqHz={metrics.dominantFreqHz}
                bpm={metrics.bpm}
              />
            </div>

            {/* Autonomic Poincaré Plot & Respiratory Modulation Wave */}
            <div
              id="autonomic"
              className="grid grid-cols-1 xl:grid-cols-2 gap-5"
            >
              <PoincarePlot
                points={metrics.poincarePoints}
                sd1Ms={metrics.sd1Ms}
                sd2Ms={metrics.sd2Ms}
                coherencePct={metrics.coherencePct}
              />
              <RespirationChart
                respWaveform={metrics.respWaveform}
                respPeakIndices={metrics.respPeakIndices}
                respirationBrpm={metrics.respirationBrpm}
                respFreqHz={metrics.respFreqHz}
                respSnrDb={metrics.respSnrDb}
                bufferSeconds={metrics.bufferSeconds}
              />
            </div>
          </div>
        </section>

        {/* Session Readings Log */}
        <SessionLogTable
          readings={readings}
          onExportCsv={handleExportCsv}
          onClear={() => setReadings([])}
        />

        {/* Scientific Innovations & Optical Physics Section */}
        <section
          id="science"
          className="max-w-7xl mx-auto px-6 py-12 border-t border-slate-800/80"
        >
          <div className="mb-8">
            <h2 className="text-xl font-bold text-white tracking-wide">
              المنهجية الهندسية والابتكارات المطبقة لرفع الدقة
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              كيف يتغلب هذا النظام على ضوضاء الإضاءة المنزلية والحركة، ولماذا يظل
              صادقاً علمياً حول حدود SpO2
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-5">
              <h3 className="text-sm font-bold text-white">
                1. تصحيح توازن اللون الأبيض + NLMS
              </h3>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                يعادل توازن اللون الأبيض التكيفي (Von Kries AWB) انحراف حرارة اللون
                تحت الإضاءة المتغيرة قبل طرح وميض المصابيح والشاشات عبر مرشح NLMS.
              </p>
            </div>

            <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-5">
              <h3 className="text-sm font-bold text-white">
                2. تتبع ديناميكي + دمج Multi-ROI
              </h3>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                تتحرك مربعات الجبهة والخدين مع مركز ثقل البشرة، مع عزل بكسلات
                اللمعان السطحي ودمج المناطق الثلاث بأوزان SoftMax حسب جودة الطيف.
              </p>
            </div>

            <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-5">
              <h3 className="text-sm font-bold text-white">
                3. مرشح كالمان + مخطط بوانكاريه
              </h3>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                يثبت مرشح كالمان قراءة BPM ضد القفزات المفاجئة، بينما يقيس مخطط
                Poincaré (SD1/SD2) وتناغم RSA التوازن بين العصب الحائر والتنفس.
              </p>
            </div>

            <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-5">
              <h3 className="text-sm font-bold text-white">
                4. حدود قياس الأكسجين (SpO2)
              </h3>
              <p className="text-xs text-slate-400 mt-2 leading-relaxed">
                أجهزة SpO2 الطبية تحتاج طولين موجيين (660 nm و940 nm)، بينما تحجب
                كاميرات الهواتف الأشعة تحت الحمراء بفلتر IR-Cut؛ لذا لا نصدر
                أرقام SpO2 وهمية.
              </p>
            </div>
          </div>
        </section>

        {/* Tamayyuz (Distinction, Achievements & Simple How-It-Works) Section */}
        <section
          id="distinction"
          className="max-w-7xl mx-auto px-6 py-12 border-t border-slate-800/80"
        >
          <div className="mb-8">
            <h2 className="text-xl font-bold text-white tracking-wide">
              تميّز — بماذا نختلف؟ وماذا أنجزنا؟ وكيف يعمل النظام ببساطة؟
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              شرح مبسّط وواضح لفكرة المشروع، وقيمته الهندسية، ورحلة الإشارة من
              عدسة الكاميرا حتى القراءة النهائية
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
            {/* Column 1: What Makes This Project Stand Out */}
            <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-6 flex flex-col gap-4">
              <div>
                <span
                  dir="ltr"
                  className="font-mono text-[11px] uppercase tracking-wider text-cyan-400"
                >
                  01 · WHY IT STANDS OUT
                </span>
                <h3 className="text-base font-bold text-white mt-1">
                  بماذا يتميّز هذا النظام عن الحلول التقليدية؟
                </h3>
              </div>

              <ul className="space-y-3 text-xs text-slate-300 leading-relaxed">
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-white">مقاومة إضاءة الغرفة والحركة:</strong>{" "}
                    معظم الأدوات البسيطة تتعطل عند تغيّر الإضاءة أو وميض الشاشات،
                    بينما يدمج نظامنا موازنة اللون الأبيض (<span dir="ltr" className="font-mono text-cyan-300">AWB</span>)
                    وإلغاء الوميض (<span dir="ltr" className="font-mono text-cyan-300">NLMS</span>)
                    ومرشح كالمان للحفاظ على ثبات القراءة.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-white">خصوصية 100% محلياً:</strong>{" "}
                    جميع الحسابات ومعالجة البكسلات تتم بالكامل داخل متصفح جهازك دون
                    رفع أي صورة أو فيديو لأي خادم خارجي.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-white">شفافية ومصداقية علمية:</strong>{" "}
                    لا يعرض أرقام <span dir="ltr" className="font-mono">SpO2</span>{" "}
                    تخمينية غير حقيقية، بل يركّز على ما تستطيع كاميرا RGB قياسه فعلياً
                    بدقة (النبض، التنفس، HRV، والتناغم العصبي).
                  </span>
                </li>
              </ul>
            </div>

            {/* Column 2: What Was Built in This Project */}
            <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-6 flex flex-col gap-4">
              <div>
                <span
                  dir="ltr"
                  className="font-mono text-[11px] uppercase tracking-wider text-teal-400"
                >
                  02 · WHAT WE BUILT
                </span>
                <h3 className="text-base font-bold text-white mt-1">
                  ماذا بنينا وأنجزنا داخل هذا المشروع؟
                </h3>
              </div>

              <ul className="space-y-3 text-xs text-slate-300 leading-relaxed">
                <li className="flex items-start gap-2.5">
                  <Sparkles className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-white">محرك معالجة إشارات حي (30 Hz DSP):</strong>{" "}
                    مبني من الصفر بلغة TypeScript لدعم خوارزميات{" "}
                    <span dir="ltr" className="font-mono text-cyan-300">POS / CHROM / GREEN</span>{" "}
                    مع تحويل طيفي <span dir="ltr" className="font-mono">1024-pt FFT</span>{" "}
                    وتتبّع ديناميكي للجبهة والخدين.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Sparkles className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-white">قياس متكامل للقلب والتنفس والأعصاب:</strong>{" "}
                    استخراج معدل التنفس عبر التعديل الثلاثي، وحساب التوازن الباراسمبثاوي
                    بمخطط بوانكاريه (<span dir="ltr" className="font-mono">SD1 / SD2</span>)
                    ونسبة تناغم القلب مع التنفس.
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Sparkles className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
                  <span>
                    <strong className="text-white">واجهة قياس وتوثيق احترافية:</strong>{" "}
                    راسم ذبذبات حي، وسجل جلسات قابل للتصدير بصيغة{" "}
                    <span dir="ltr" className="font-mono">CSV</span>، مع تقرير فني جاهز
                    للطباعة والحفظ كـ <span dir="ltr" className="font-mono">PDF</span>.
                  </span>
                </li>
              </ul>
            </div>
          </div>

          {/* Simple 4-Step Pipeline Explanation */}
          <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-6">
            <div className="mb-5">
              <span
                dir="ltr"
                className="font-mono text-[11px] uppercase tracking-wider text-emerald-400"
              >
                03 · HOW IT WORKS STEP BY STEP
              </span>
              <h3 className="text-base font-bold text-white mt-1">
                كيف يعمل النظام بطريقة سهلة؟ (من الكاميرا إلى النتيجة في 4 خطوات)
              </h3>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-[#070b12] border border-slate-800 rounded-lg p-4">
                <span
                  dir="ltr"
                  className="font-mono text-xs font-bold text-cyan-400"
                >
                  STEP 01
                </span>
                <h4 className="text-sm font-bold text-white mt-1.5">
                  رصد تغيّر لون البشرة
                </h4>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  مع كل نبضة قلب، يتدفق الدم في الشعيرات الدقيقة بالوجه فيتغير لون
                  الجلد بنسبة مجهرية لا تراها العين، لكن الكاميرا تلتقطها في قناة
                  اللون الأخضر والأحمر والأزرق.
                </p>
              </div>

              <div className="bg-[#070b12] border border-slate-800 rounded-lg p-4">
                <span
                  dir="ltr"
                  className="font-mono text-xs font-bold text-cyan-400"
                >
                  STEP 02
                </span>
                <h4 className="text-sm font-bold text-white mt-1.5">
                  تنظيف الإضاءة والوميض
                </h4>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  يثبّت نظام <span dir="ltr" className="font-mono">AWB</span> توازن
                  الألوان، ويراقب <span dir="ltr" className="font-mono">NLMS</span>{" "}
                  الخلفية لطرح أي اهتزاز في ضوء الغرفة، بينما تُختار أنقى منطقة من
                  الجبهة والخدين.
                </p>
              </div>

              <div className="bg-[#070b12] border border-slate-800 rounded-lg p-4">
                <span
                  dir="ltr"
                  className="font-mono text-xs font-bold text-cyan-400"
                >
                  STEP 03
                </span>
                <h4 className="text-sm font-bold text-white mt-1.5">
                  استخراج النبض والتنفس
                </h4>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  تفصل المرشحات الرقمية إيقاع القلب السريع عن إيقاع الشهيق والزفير
                  الأبطأ، ثم يحوّل تحليل الطيف (<span dir="ltr" className="font-mono">FFT</span>)
                  ومرشح كالمان الموجة إلى رقم <span dir="ltr" className="font-mono">BPM</span>{" "}
                  و <span dir="ltr" className="font-mono">BrPM</span> مستقر.
                </p>
              </div>

              <div className="bg-[#070b12] border border-slate-800 rounded-lg p-4">
                <span
                  dir="ltr"
                  className="font-mono text-xs font-bold text-cyan-400"
                >
                  STEP 04
                </span>
                <h4 className="text-sm font-bold text-white mt-1.5">
                  تحليل التوازن العصبي والتوثيق
                </h4>
                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                  يقيس النظام الفارق الزمني بين كل نبضة والتي تليها لرسم مخطط
                  بوانكاريه وحساب نسبة تناغم قلبك مع تنفسك، مع إمكانية حفظ التقرير
                  فوراً.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-800 bg-[#070b12] no-print">
        <div className="max-w-7xl mx-auto px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-500">
          <span>PulseLab Pro · محطة قياس النبض والتنفس البصري</span>
          <span dir="ltr" className="font-mono">
            Von Kries AWB · NLMS · Multi-ROI POS · Kalman · Poincaré SD1/SD2
          </span>
        </div>
      </footer>

      <SessionReportModal
        isOpen={reportOpen}
        onClose={() => setReportOpen(false)}
        metrics={metrics}
        mode={mode}
        algorithm={algorithm}
        nlmsEnabled={nlmsEnabled}
        awbEnabled={awbEnabled}
        durationSec={elapsedSec || metrics.bufferSeconds}
      />
    </div>
  );
}
