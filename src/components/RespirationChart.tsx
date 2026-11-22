import { useState } from "react";

interface RespirationChartProps {
  respWaveform: number[];
  respPeakIndices: number[];
  respirationBrpm: number | null;
  respFreqHz: number | null;
  respSnrDb: number;
  bufferSeconds: number;
}

export function RespirationChart({
  respWaveform,
  respPeakIndices,
  respirationBrpm,
  respFreqHz,
  respSnrDb,
  bufferSeconds,
}: RespirationChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 560;
  const height = 180;
  const padX = 16;
  const padY = 18;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const hasData = respWaveform.length >= 6;

  const points = hasData
    ? respWaveform
        .map((val, i) => {
          const x = padX + (i / (respWaveform.length - 1)) * plotW;
          const clamped = Math.max(-3, Math.min(3, val));
          const y = padY + ((3 - clamped) / 6) * plotH;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : "";

  const hoveredVal =
    hoverIdx !== null && hasData && respWaveform[hoverIdx] !== undefined
      ? respWaveform[hoverIdx]
      : null;

  return (
    <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 tracking-wide">
            موجة التنفس المدمجة (RIAV + RIIV + RIFV)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            تضمين سعة النبض وخط الأساس واضطراب النظم الجيبي (0.12–0.55 Hz)
          </p>
        </div>

        <div
          dir="ltr"
          className="text-xs font-mono tabular-nums text-teal-300 bg-[#070b12] border border-slate-800 rounded-md px-2.5 py-1 shrink-0"
        >
          {hoveredVal !== null
            ? `mod: ${hoveredVal.toFixed(2)}σ`
            : respirationBrpm !== null && respFreqHz !== null
            ? `${respirationBrpm} BrPM · SNR ${respSnrDb.toFixed(1)} dB`
            : `${Math.min(12, bufferSeconds).toFixed(1)} / 12.0s`}
        </div>
      </div>

      <div dir="ltr" className="relative w-full">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-44 bg-[#070b12] border border-slate-800 rounded-lg cursor-crosshair select-none"
          onMouseMove={(e) => {
            if (!hasData) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const relX = (e.clientX - rect.left) / rect.width;
            const norm = Math.max(
              0,
              Math.min(1, (relX * width - padX) / plotW)
            );
            setHoverIdx(Math.round(norm * (respWaveform.length - 1)));
          }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {[0.25, 0.5, 0.75].map((frac) => (
            <line
              key={frac}
              x1={padX}
              y1={padY + plotH * frac}
              x2={width - padX}
              y2={padY + plotH * frac}
              stroke="#1e293b"
              strokeWidth={frac === 0.5 ? 1.2 : 0.8}
              strokeDasharray={frac === 0.5 ? undefined : "4 4"}
            />
          ))}

          {hasData ? (
            <>
              <polyline
                fill="none"
                stroke="#14b8a6"
                strokeWidth="2.2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={points}
              />

              {respPeakIndices.map((idx) => {
                const v = respWaveform[idx];
                if (v === undefined) return null;
                const cx = padX + (idx / (respWaveform.length - 1)) * plotW;
                const cy =
                  padY + ((3 - Math.max(-3, Math.min(3, v))) / 6) * plotH;
                return (
                  <circle
                    key={idx}
                    cx={cx}
                    cy={cy}
                    r={3.5}
                    fill="#2dd4bf"
                    stroke="#070b12"
                    strokeWidth={1.3}
                  />
                );
              })}

              {hoverIdx !== null && hoveredVal !== null && (
                <line
                  x1={padX + (hoverIdx / (respWaveform.length - 1)) * plotW}
                  y1={padY}
                  x2={padX + (hoverIdx / (respWaveform.length - 1)) * plotW}
                  y2={height - padY}
                  stroke="#e2e8f0"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
              )}
            </>
          ) : (
            <text
              x={width / 2}
              y={height / 2}
              textAnchor="middle"
              fill="#64748b"
              fontSize="11"
              fontFamily="JetBrains Mono, monospace"
            >
              Extracting 4.0 Hz respiratory modulation...
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
