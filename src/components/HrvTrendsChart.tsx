import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, TrendingDown, TrendingUp } from "lucide-react";
import { analyzeHrvTrends, type HrvTrendPoint } from "../dsp/hrvTrends";
import type { BiometricProfile, SessionReading } from "../types/rppg";

interface HrvTrendsChartProps {
  readings: SessionReading[];
  profile?: BiometricProfile;
}

type TrendMetricKey = "rmssd" | "ratio" | "bpm" | "coherence";

const METRIC_META: Record<
  TrendMetricKey,
  { label: string; unit: string; color: string; yMinFloor: number }
> = {
  rmssd: {
    label: "RMSSD",
    unit: "ms",
    color: "#10b981",
    yMinFloor: 0,
  },
  ratio: {
    label: "SD2 / SD1",
    unit: "x",
    color: "#22d3ee",
    yMinFloor: 0,
  },
  bpm: {
    label: "BPM",
    unit: "bpm",
    color: "#38bdf8",
    yMinFloor: 40,
  },
  coherence: {
    label: "Coherence",
    unit: "%",
    color: "#2dd4bf",
    yMinFloor: 0,
  },
};

function getMetricValue(pt: HrvTrendPoint, key: TrendMetricKey): number | null {
  if (key === "rmssd") return pt.rmssdMs;
  if (key === "ratio") return pt.sdRatio;
  if (key === "bpm") return pt.bpm;
  return pt.coherencePct;
}

export function HrvTrendsChart({ readings, profile }: HrvTrendsChartProps) {
  const [selectedMetric, setSelectedMetric] = useState<TrendMetricKey>("rmssd");
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const analysis = useMemo(
    () => analyzeHrvTrends(readings, undefined, profile),
    [readings, profile]
  );
  const { points, alert, direction } = analysis;

  const width = 640;
  const height = 210;
  const padL = 42;
  const padR = 18;
  const padT = 18;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const plotted = useMemo(() => {
    const items: Array<{ index: number; point: HrvTrendPoint; value: number }> = [];
    points.forEach((pt, idx) => {
      const val = getMetricValue(pt, selectedMetric);
      if (val !== null) {
        items.push({ index: idx, point: pt, value: val });
      }
    });
    return items;
  }, [points, selectedMetric]);

  const meta = METRIC_META[selectedMetric];

  const baselineVal =
    selectedMetric === "rmssd"
      ? analysis.baselineRmssdMs
      : selectedMetric === "ratio"
      ? analysis.baselineSdRatio
      : selectedMetric === "bpm"
      ? analysis.baselineBpm
      : analysis.baselineCoherencePct;

  const { minVal, maxVal } = useMemo(() => {
    const vals = plotted.map((p) => p.value);
    if (baselineVal !== null) vals.push(baselineVal);
    if (vals.length === 0) return { minVal: 0, maxVal: 100 };
    const rawMin = Math.min(...vals);
    const rawMax = Math.max(...vals);
    const span = Math.max(selectedMetric === "ratio" ? 1.2 : 12, rawMax - rawMin);
    return {
      minVal: Math.max(meta.yMinFloor, Math.floor(rawMin - span * 0.25)),
      maxVal: Math.ceil(rawMax + span * 0.25),
    };
  }, [plotted, baselineVal, meta.yMinFloor, selectedMetric]);

  const mapX = (pos: number, count: number) => {
    if (count <= 1) return padL + plotW / 2;
    return padL + (pos / (count - 1)) * plotW;
  };

  const mapY = (val: number) => {
    const ratio = (val - minVal) / Math.max(1e-6, maxVal - minVal);
    return padT + plotH - Math.max(0, Math.min(1, ratio)) * plotH;
  };

  const polylineStr = plotted
    .map((item, idx) => `${mapX(idx, plotted.length).toFixed(1)},${mapY(item.value).toFixed(1)}`)
    .join(" ");

  const areaPathStr =
    plotted.length >= 2
      ? `M ${mapX(0, plotted.length).toFixed(1)} ${(padT + plotH).toFixed(1)} ` +
        plotted
          .map(
            (item, idx) =>
              `L ${mapX(idx, plotted.length).toFixed(1)} ${mapY(item.value).toFixed(1)}`
          )
          .join(" ") +
        ` L ${mapX(plotted.length - 1, plotted.length).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
      : "";

  const hoveredItem = hoveredIdx !== null ? plotted[hoveredIdx] ?? null : null;

  const directionBadge =
    direction === "declining"
      ? {
          text:
            alert.consecutiveCount >= 2
              ? `انحراف متتالي (${alert.consecutiveCount} قراءات)`
              : "اتجاه هابط في HRV",
          cls: "bg-amber-950/70 border-amber-500/40 text-amber-300",
          icon: <TrendingDown className="w-3.5 h-3.5" />,
        }
      : direction === "improving"
      ? {
          text: "تحسّن في التعافي العصبي",
          cls: "bg-emerald-950/70 border-emerald-500/40 text-emerald-300",
          icon: <TrendingUp className="w-3.5 h-3.5" />,
        }
      : direction === "stable"
      ? {
          text: "اتجاه مستقر ومتوازن",
          cls: "bg-cyan-950/60 border-cyan-500/40 text-cyan-300",
          icon: <CheckCircle2 className="w-3.5 h-3.5" />,
        }
      : {
          text: "بانتظار قراءتين على الأقل",
          cls: "bg-slate-900 border-slate-700 text-slate-400",
          icon: null,
        };

  return (
    <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h3 className="text-sm font-semibold text-slate-100 tracking-wide">
              تحليل اتجاهات النبض والتوازن العصبي بمرور الوقت (HRV Trends)
            </h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[11px] font-medium border rounded-md ${directionBadge.cls}`}
            >
              {directionBadge.icon}
              <span>{directionBadge.text}</span>
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            تتبّع زمني لمؤشرات التعافي العصبي واكتشاف الانحرافات المتتالية مقارنة بخط
            الأساس الشخصي
          </p>
        </div>

        <div
          dir="ltr"
          className="inline-flex items-center gap-1 p-1 bg-[#070b12] border border-slate-800 rounded-lg self-start md:self-auto"
        >
          {(["rmssd", "ratio", "bpm", "coherence"] as TrendMetricKey[]).map(
            (key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSelectedMetric(key);
                  setHoveredIdx(null);
                }}
                className={`px-2.5 py-1.5 text-[11px] font-mono font-semibold rounded-md transition-colors cursor-pointer ${
                  selectedMetric === key
                    ? "bg-slate-800 text-cyan-300"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                {METRIC_META[key].label}
              </button>
            )
          )}
        </div>
      </div>

      {/* Interactive Trend Chart */}
      <div className="relative bg-[#070b12] border border-slate-800 rounded-lg p-3">
        {hoveredItem && (
          <div
            dir="ltr"
            className="mb-2 flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-slate-900/90 border border-slate-700 rounded-md text-[11px] font-mono tabular-nums text-slate-200"
          >
            <span className="text-cyan-300">{hoveredItem.point.timestamp}</span>
            <span>
              RMSSD: {hoveredItem.point.rmssdMs ?? "--"} ms · SD1/SD2:{" "}
              {hoveredItem.point.sd1Ms ?? "--"}/{hoveredItem.point.sd2Ms ?? "--"} ·{" "}
              {hoveredItem.point.bpm} BPM · Coh:{" "}
              {hoveredItem.point.coherencePct ?? "--"}%
            </span>
          </div>
        )}

        {plotted.length >= 2 ? (
          <div dir="ltr" className="w-full">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-48 select-none overflow-visible"
            >
              {/* Horizontal grid lines */}
              {[0, 0.5, 1].map((frac) => {
                const y = padT + frac * plotH;
                const val = maxVal - frac * (maxVal - minVal);
                return (
                  <g key={frac}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={width - padR}
                      y2={y}
                      stroke="#1e293b"
                      strokeWidth={0.8}
                      strokeDasharray="3 3"
                    />
                    <text
                      x={padL - 6}
                      y={y + 3}
                      textAnchor="end"
                      fill="#64748b"
                      fontSize="9"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      {selectedMetric === "ratio" ? val.toFixed(1) : Math.round(val)}
                    </text>
                  </g>
                );
              })}

              {/* Personal baseline line */}
              {baselineVal !== null && (
                <g>
                  <line
                    x1={padL}
                    y1={mapY(baselineVal)}
                    x2={width - padR}
                    y2={mapY(baselineVal)}
                    stroke="#64748b"
                    strokeWidth={1}
                    strokeDasharray="5 4"
                  />
                  <text
                    x={width - padR}
                    y={mapY(baselineVal) - 4}
                    textAnchor="end"
                    fill="#94a3b8"
                    fontSize="8.5"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    Baseline {baselineVal}
                    {meta.unit}
                  </text>
                </g>
              )}

              {/* Shaded area under curve */}
              {areaPathStr && (
                <path d={areaPathStr} fill={meta.color} fillOpacity={0.08} />
              )}

              {/* Primary trend polyline */}
              <polyline
                fill="none"
                stroke={meta.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={polylineStr}
              />

              {/* Interactive Points (anomalous consecutive readings highlighted in amber/rose) */}
              {plotted.map((item, idx) => {
                const px = mapX(idx, plotted.length);
                const py = mapY(item.value);
                const flagged = item.point.isAnomalous;
                return (
                  <g key={item.point.id}>
                    <circle
                      cx={px}
                      cy={py}
                      r={flagged ? 5 : 4}
                      fill={flagged ? "#f43f5e" : meta.color}
                      stroke="#070b12"
                      strokeWidth={1.5}
                      className="cursor-pointer"
                      onMouseEnter={() => setHoveredIdx(idx)}
                      onMouseLeave={() => setHoveredIdx(null)}
                    />
                    {(idx === 0 ||
                      idx === plotted.length - 1 ||
                      plotted.length <= 7) && (
                      <text
                        x={px}
                        y={height - 7}
                        textAnchor="middle"
                        fill="#64748b"
                        fontSize="8.5"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {item.point.timestamp.slice(0, 5)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        ) : (
          <div className="h-40 flex flex-col items-center justify-center text-center px-4">
            <p className="text-xs font-medium text-slate-300">
              تظهر رسمة اتجاهات {meta.label} وتنبيهات الانحراف العصبي تلقائياً فور
              تسجيل جلستين (قراءتين) أو أكثر.
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              أكمل مسحاً مدته 15 أو 30 ثانية أو اضغط «حفظ لقطة القراءة الحالية» لبناء
              منحناك المرجعي الشخصي.
            </p>
          </div>
        )}
      </div>

      {/* Trend Summary Cards + Alert Preview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-[#070b12] border border-slate-800 rounded-lg p-3">
          <span className="block text-[11px] text-slate-400">
            متوسط RMSSD المرجعي
          </span>
          <span
            dir="ltr"
            className="block font-mono text-base font-bold text-emerald-400 tabular-nums mt-0.5"
          >
            {analysis.baselineRmssdMs !== null
              ? `${analysis.baselineRmssdMs} ms`
              : "--"}
          </span>
          <span
            dir="ltr"
            className="block font-mono text-[10px] text-slate-500 mt-0.5"
          >
            {analysis.rmssdDeltaPct !== null
              ? `Latest ${analysis.rmssdDeltaPct >= 0 ? "+" : ""}${analysis.rmssdDeltaPct}%`
              : "Needs ≥2 readings"}
          </span>
        </div>

        <div className="bg-[#070b12] border border-slate-800 rounded-lg p-3">
          <span className="block text-[11px] text-slate-400">
            توازن SD2 / SD1 الحالي
          </span>
          <span
            dir="ltr"
            className="block font-mono text-base font-bold text-cyan-300 tabular-nums mt-0.5"
          >
            {analysis.latestSdRatio !== null ? `${analysis.latestSdRatio}x` : "--"}
          </span>
          <span
            dir="ltr"
            className="block font-mono text-[10px] text-slate-500 mt-0.5"
          >
            {analysis.baselineSdRatio !== null
              ? `Baseline ${analysis.baselineSdRatio}x`
              : "Optimal 1.0–2.5x"}
          </span>
        </div>

        <div className="bg-[#070b12] border border-slate-800 rounded-lg p-3">
          <span className="block text-[11px] text-slate-400">
            ميل التغير (Slope / جلسة)
          </span>
          <span
            dir="ltr"
            className="block font-mono text-base font-bold text-slate-100 tabular-nums mt-0.5"
          >
            {analysis.rmssdSlopePerSession !== null
              ? `${analysis.rmssdSlopePerSession >= 0 ? "+" : ""}${analysis.rmssdSlopePerSession} ms`
              : "--"}
          </span>
          <span className="block text-[10px] text-slate-500 mt-0.5">
            عبر {points.length} قراءات مسجلة
          </span>
        </div>

        <div
          className={`border rounded-lg p-3 ${
            alert.severity === "warning"
              ? "bg-rose-950/35 border-rose-500/40"
              : alert.severity === "caution"
              ? "bg-amber-950/35 border-amber-500/40"
              : "bg-[#070b12] border-slate-800"
          }`}
        >
          <span className="block text-[11px] text-slate-400">
            رصد الانحراف المتتالي
          </span>
          <div className="flex items-center gap-1.5 mt-0.5">
            {(alert.severity === "warning" || alert.severity === "caution") && (
              <AlertTriangle
                className={`w-4 h-4 shrink-0 ${
                  alert.severity === "warning" ? "text-rose-400" : "text-amber-400"
                }`}
              />
            )}
            <span className="text-xs font-bold text-white">
              {alert.severity === "warning"
                ? `تنبيه (${alert.consecutiveCount} متتالية)`
                : alert.severity === "caution"
                ? `ملاحظة (${alert.consecutiveCount} متتالية)`
                : alert.severity === "nominal"
                ? "متزن ولا توجد انحرافات"
                : "قيد التجميع"}
            </span>
          </div>
          <span className="block text-[10px] text-slate-400 mt-0.5">
            يظهر التفصيل داخل نافذة التقرير
          </span>
        </div>
      </div>
    </div>
  );
}
