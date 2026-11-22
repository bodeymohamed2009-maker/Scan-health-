import { Download, Trash2 } from "lucide-react";
import type { SessionReading } from "../types/rppg";

interface SessionLogTableProps {
  readings: SessionReading[];
  onExportCsv: () => void;
  onClear: () => void;
}

function formatModeLabel(mode: SessionReading["mode"]): string {
  if (mode === "face") return "الوجه (rPPG)";
  if (mode === "finger") return "الإصبع (PPG)";
  return "معايرة مخبرية";
}

export function SessionLogTable({
  readings,
  onExportCsv,
  onClear,
}: SessionLogTableProps) {
  return (
    <section
      id="history"
      className="max-w-7xl mx-auto px-6 py-10 border-t border-slate-800/80"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
        <div>
          <h2 className="text-lg font-bold text-white tracking-wide">
            سجل القياسات السريرية المحفوظة
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            القراءات المسجلة محلياً مع مؤشر بوانكاريه SD1 والتناغم التنفسي وجودة الطيف SNR
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {readings.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-300 bg-[#0d131f] border border-slate-700 hover:bg-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>مسح السجل</span>
            </button>
          )}
          <button
            type="button"
            onClick={onExportCsv}
            disabled={readings.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 disabled:bg-slate-800 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>تصدير CSV</span>
          </button>
        </div>
      </div>

      <div className="bg-[#0d131f] border border-slate-800 rounded-xl overflow-hidden">
        {readings.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            لا توجد قراءات محفوظة بعد. شغّل القياس وسيتم تسجيل القراءة تلقائياً
            عند اكتمال المدة أو عند الضغط على «حفظ لقطة».
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="bg-[#070b12] border-b border-slate-800 text-xs font-semibold text-slate-400">
                  <th className="py-3 px-4">الوقت</th>
                  <th className="py-3 px-4">النمط</th>
                  <th className="py-3 px-4">الخوارزمية</th>
                  <th className="py-3 px-4">النبض (BPM)</th>
                  <th className="py-3 px-4">التنفس (BrPM)</th>
                  <th className="py-3 px-4">التناغم</th>
                  <th className="py-3 px-4">RMSSD / SD1</th>
                  <th className="py-3 px-4">SNR</th>
                  <th className="py-3 px-4">المدة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80 text-sm">
                {readings.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-800/40">
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-slate-400 tabular-nums text-right"
                    >
                      {row.timestamp}
                    </td>
                    <td className="py-3 px-4 text-xs font-medium text-slate-200">
                      {formatModeLabel(row.mode)}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-slate-300">
                      {row.algorithm}
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono font-bold text-cyan-300 tabular-nums text-right"
                    >
                      {row.bpm} BPM
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono font-semibold text-teal-300 tabular-nums text-right"
                    >
                      {row.respirationBrpm !== null
                        ? `${row.respirationBrpm} BrPM`
                        : "—"}
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-emerald-300 tabular-nums text-right"
                    >
                      {row.coherencePct !== null
                        ? `${row.coherencePct}%`
                        : "—"}
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-slate-300 tabular-nums text-right"
                    >
                      {row.rmssdMs !== null ? `${row.rmssdMs}` : "—"} /{" "}
                      {row.sd1Ms !== null ? `${row.sd1Ms} ms` : "—"}
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-slate-300 tabular-nums text-right"
                    >
                      {row.snrDb.toFixed(1)} dB
                    </td>
                    <td
                      dir="ltr"
                      className="py-3 px-4 font-mono text-xs text-slate-400 tabular-nums text-right"
                    >
                      {row.durationSec}s
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
