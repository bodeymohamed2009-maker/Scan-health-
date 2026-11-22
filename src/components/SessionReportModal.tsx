import { Printer, X } from "lucide-react";
import type { CaptureMode, RppgAlgorithm, RppgMetrics } from "../types/rppg";

interface SessionReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  metrics: RppgMetrics;
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
  mode,
  algorithm,
  nlmsEnabled,
  awbEnabled,
  durationSec,
}: SessionReportModalProps) {
  if (!isOpen) return null;

  const timestamp = new Date().toLocaleString("en-GB", { hour12: false });

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
              {timestamp} · {algorithm} · {mode.toUpperCase()}
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

          <div className="border border-slate-800 print:border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-right text-xs">
              <tbody className="divide-y divide-slate-800 print:divide-slate-200">
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    تقلب النبض (RMSSD / SDNN)
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {metrics.rmssdMs ?? "--"} ms / {metrics.sdnnMs ?? "--"} ms
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-4 text-slate-400 print:text-slate-600">
                    مؤشر بوانكاريه (SD1 / SD2)
                  </td>
                  <td dir="ltr" className="py-2.5 px-4 font-mono tabular-nums">
                    {metrics.sd1Ms ?? "--"} ms / {metrics.sd2Ms ?? "--"} ms
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
