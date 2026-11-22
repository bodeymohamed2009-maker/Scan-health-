import { AlertTriangle, CheckCircle2, Info, Printer, TrendingDown, TrendingUp, X } from "lucide-react";
import { analyzeHrvTrends } from "../dsp/hrvTrends";
import type {
  BiometricProfile,
  CaptureMode,
  RppgAlgorithm,
  RppgMetrics,
  SessionReading,
} from "../types/rppg";

interface SessionReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  metrics: RppgMetrics;
  readings: SessionReading[];
  profile?: BiometricProfile;
  mode: CaptureMode;
  algorithm: RppgAlgorithm;
  nlmsEnabled: boolean;
  awbEnabled: boolean;
  durationSec: number;
}

export function SessionReportModal({
  isOpen,
  onClose,
  metrics,
  readings,
  profile,
  mode,
  algorithm,
  nlmsEnabled,
  awbEnabled,
  durationSec,
}: SessionReportModalProps) {
  if (!isOpen) return null;

  const timestamp = new Date().toLocaleString("en-GB", { hour12: false });
  const trends = analyzeHrvTrends(readings, metrics, profile);
  const { alert, norms } = trends;
  const sdRatio =
    metrics.sd1Ms && metrics.sd2Ms && metrics.sd1Ms > 0
      ? Number((metrics.sd2Ms / metrics.sd1Ms).toFixed(2))
      : null;
  const recentStrip = trends.points.slice(-5);
  const hrMaxPct =
    norms.hrMaxBpm && metrics.bpm !== null
      ? Math.round((metrics.bpm / norms.hrMaxBpm) * 100)
      : null;
  const bmi =
    profile?.heightCm && profile?.weightKg && profile.heightCm > 0
      ? Number(
          (
            profile.weightKg /
            Math.pow(profile.heightCm / 100, 2)
          ).toFixed(1)
        )
      : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="تقرير القياس البصري"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-[#0d131f] print:bg-white border border-slate-700 print:border-slate-300 rounded-xl overflow-hidden text-slate-100 print:text-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 print:border-slate-200 no-print">
          <div>
            <h2 className="text-base font-bold text-white">
              التقرير الفني لجلسة القياس البصري (rPPG Summary)
            </h2>
            <p dir="ltr" className="font-mono text-xs text-slate-400 mt-0.5">
              {timestamp} ·{" "}
              {algorithm === "FUSION"
                ? "TRI-FUSION (POS+CHROM+GREEN)"
                : algorithm}{" "}
              · {mode.toUpperCase()}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 rounded-lg transition-colors cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>طباعة / حفظ PDF</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              aria-label="إغلاق التقرير"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-5 max-h-[80vh] overflow-y-auto">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-[#070b12] print:bg-slate-50 border border-slate-800 print:border-slate-200 rounded-lg p-3.5">
              <span className="block text-xs text-slate-400 print:text-slate-500">
                نبض القلب (Kalman BPM)
              </span>
              <span
                dir="ltr"
                className="block font-mono text-2xl font-bold text-cyan-400 print:text-slate-950 tabular-nums mt-1"
              >
                {metrics.bpm !== null ? `${metrics.bpm} BPM` : "--"}
              </span>
            </div>

            <div className="bg-[#070b12] print:bg-slate-50 border border-slate-800 print:border-slate-200 rounded-lg p-3.5">
              <span className="block text-xs text-slate-400 print:text-slate-500">
                معدل التنفس (RIAV/RIFV)
              </span>
              <span
                dir="ltr"
                className="block font-mono text-2xl font-bold text-teal-400 print:text-slate-950 tabular-nums mt-1"
              >
                {metrics.respirationBrpm !== null
                  ? `${metrics.respirationBrpm} BrPM`
                  : "--"}
              </span>
            </div>

            <div className="bg-[#070b12] print:bg-slate-50 border border-slate-800 print:border-slate-200 rounded-lg p-3.5">
              <span className="block text-xs text-slate-400 print:text-slate-500">
                تناغم القلب والتنفس
              </span>
              <span
                dir="ltr"
                className="block font-mono text-2xl font-bold text-emerald-400 print:text-slate-950 tabular-nums mt-1"
              >
                {metrics.coherencePct !== null
                  ? `${metrics.coherencePct}%`
                  : "--"}
              </span>
            </div>
          </div>

          {/* Smart HRV Trends & Consecutive Autonomic Anomaly Alert */}
          <div
            role={
              alert.severity === "warning" || alert.severity === "caution"
                ? "alert"
                : "status"
            }
            className={`rounded-lg border p-4 space-y-2.5 ${
              alert.severity === "warning"
                ? "bg-rose-950/45 print:bg-rose-50 border-rose-500/50 print:border-rose-300"
                : alert.severity === "caution"
                ? "bg-amber-950/40 print:bg-amber-50 border-amber-500/50 print:border-amber-300"
                : alert.severity === "nominal"
                ? "bg-emerald-950/35 print:bg-emerald-50 border-emerald-500/40 print:border-emerald-300"
                : "bg-[#070b12] print:bg-slate-50 border-slate-800 print:border-slate-200"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                {alert.severity === "warning" ? (
                  <AlertTriangle className="w-4 h-4 text-rose-400 print:text-rose-600 shrink-0 mt-0.5" />
                ) : alert.severity === "caution" ? (
                  <AlertTriangle className="w-4 h-4 text-amber-400 print:text-amber-600 shrink-0 mt-0.5" />
                ) : alert.severity === "nominal" ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 print:text-emerald-600 shrink-0 mt-0.5" />
                ) : (
                  <Info className="w-4 h-4 text-cyan-400 print:text-cyan-600 shrink-0 mt-0.5" />
                )}
                <div>
                  <h3
                    className={`text-xs font-bold ${
                      alert.severity === "warning"
                        ? "text-rose-300 print:text-rose-900"
                        : alert.severity === "caution"
                        ? "text-amber-300 print:text-amber-900"
                        : alert.severity === "nominal"
                        ? "text-emerald-300 print:text-emerald-900"
                        : "text-slate-200 print:text-slate-900"
                    }`}
                  >
                    {alert.title}
                  </h3>
                  <p className="text-[11px] text-slate-300 print:text-slate-700 mt-1 leading-relaxed">
                    {alert.summary}
                  </p>
                </div>
              </div>

              {trends.direction !== "insufficient" && (
                <span
                  dir="ltr"
                  className="inline-flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 rounded bg-slate-900/80 print:bg-white border border-slate-700 print:border-slate-300 text-slate-300 print:text-slate-700 shrink-0"
                >
                  {trends.direction === "declining" ? (
                    <TrendingDown className="w-3 h-3 text-rose-400" />
                  ) : trends.direction === "improving" ? (
                    <TrendingUp className="w-3 h-3 text-emerald-400" />
                  ) : null}
                  <span>{trends.points.length} pts</span>
                </span>
              )}
            </div>

            {alert.details.length > 0 && (
              <ul className="space-y-1 pr-6 text-[11px] text-slate-200 print:text-slate-800 list-disc">
                {alert.details.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}

            {alert.recommendations.length > 0 && (
              <div className="pt-2 border-t border-slate-800/70 print:border-slate-300/70">
                <span className="block text-[10px] font-semibold text-slate-300 print:text-slate-700 mb-1">
                  توصيات فورية مقترحة:
                </span>
                <ul className="space-y-1 pr-5 text-[11px] text-slate-300 print:text-slate-700 list-disc">
                  {alert.recommendations.map((rec) => (
                    <li key={rec}>{rec}</li>
                  ))}
                </ul>
              </div>
            )}

            {recentStrip.length >= 2 && (
              <div className="pt-2 border-t border-slate-800/70 print:border-slate-300/70">
                <span className="block text-[10px] text-slate-400 print:text-slate-600 mb-1.5">
                  مسار آخر {recentStrip.length} قراءات (RMSSD · SD2/SD1 · BPM):
                </span>
                <div
                  dir="ltr"
                  className="grid grid-cols-2 sm:grid-cols-5 gap-1.5 text-[10px] font-mono tabular-nums"
                >
                  {recentStrip.map((pt) => (
                    <div
                      key={pt.id}
                      className={`rounded px-2 py-1 border ${
                        pt.isAnomalous
                          ? "bg-rose-950/50 print:bg-rose-100 border-rose-500/40 text-rose-200 print:text-rose-900"
                          : "bg-[#070b12]/80 print:bg-white border-slate-800 print:border-slate-300 text-slate-300 print:text-slate-800"
                      }`}
                    >
                      <span className="block text-[9px] text-slate-400 print:text-slate-500">
                        {pt.timestamp}
                      </span>
                      <span className="block font-semibold">
                        {pt.rmssdMs !== null ? `${pt.rmssdMs}ms` : "--"} ·{" "}
                        {pt.sdRatio !== null ? `${pt.sdRatio}x` : "--"}
                      </span>
                      <span className="block text-[9px] text-cyan-400 print:text-slate-600">
                        {pt.bpm} BPM
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="border border-slate-800 print:border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-right text-xs">
              <tbody className="divide-y divide-slate-800 print:divide-slate-200">
                {(profile?.age || profile?.heightCm) && (
                  <tr>
                    <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                      الملف البيومتري والمعايرة العمرية
                    </td>
                    <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                      {profile?.age ? `Age ${profile.age}y` : ""}
                      {profile?.age && profile?.heightCm ? " · " : ""}
                      {profile?.heightCm ? `${profile.heightCm} cm` : ""}
                      {bmi !== null ? ` · BMI ${bmi}` : ""}
                      {norms.hrMaxBpm
                        ? ` · HRmax ${norms.hrMaxBpm}${
                            hrMaxPct !== null ? ` (${hrMaxPct}%)` : ""
                          }`
                        : ""}
                    </td>
                  </tr>
                )}
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    تقلب النبض (RMSSD / SDNN)
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {metrics.rmssdMs ?? "--"} ms / {metrics.sdnnMs ?? "--"} ms
                    {profile?.age
                      ? ` · Norm ${norms.expectedRmssdRange[0]}–${norms.expectedRmssdRange[1]} ms`
                      : ""}
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    مؤشر بوانكاريه والتوازن (SD1 / SD2 · Ratio)
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {metrics.sd1Ms ?? "--"} ms / {metrics.sd2Ms ?? "--"} ms
                    {sdRatio !== null ? ` · ${sdRatio}x` : ""}
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    جودة الطيف (Cardiac SNR / Resp SNR)
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {metrics.snrDb.toFixed(1)} dB / {metrics.respSnrDb.toFixed(1)} dB
                  </td>
                </tr>
                {algorithm === "FUSION" && (
                  <tr>
                    <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                      أوزان الدمج الثلاثي (POS / CHROM / GREEN)
                    </td>
                    <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                      {metrics.algoWeights.pos}% / {metrics.algoWeights.chrom}% /{" "}
                      {metrics.algoWeights.green}%
                    </td>
                  </tr>
                )}
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    توازن اللون الأبيض التكيفي (AWB)
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {awbEnabled && mode !== "finger"
                      ? `Von Kries (${metrics.awb.colorTempK}K · R×${metrics.awb.gainR.toFixed(2)} G×${metrics.awb.gainG.toFixed(2)} B×${metrics.awb.gainB.toFixed(2)})`
                      : "Disabled"}
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    إلغاء وميض الإضاءة الخلفي (NLMS)
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {nlmsEnabled
                      ? `Active (-${metrics.ambientCanceledDb.toFixed(1)} dB attenuated)`
                      : "Disabled"}
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    أوزان دمج المناطق (الجبهة / الخد الأيسر / الخد الأيمن)
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {metrics.roiWeights.forehead}% / {metrics.roiWeights.leftCheek}% /{" "}
                    {metrics.roiWeights.rightCheek}%
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    مدة العينة ومعدل الإطارات
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {Math.round(durationSec)}s · {metrics.fps || 30} FPS
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-slate-400 print:text-slate-600 leading-relaxed border-t border-slate-800 print:border-slate-200 pt-3">
            ملاحظة علمية: هذا التقرير ناتج عن تحليل بصري لموجات النبض عبر كاميرا
            RGB للأغراض البحثية والتعليمية، ولا يغني عن الفحص الطبي أو أجهزة
            قياس الأكسجين المعتمدة (660/940 nm).
          </p>
        </div>
      </div>
    </div>
  );
}
