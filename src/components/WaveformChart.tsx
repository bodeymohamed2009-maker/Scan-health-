import { useState } from "react";

interface WaveformChartProps {
  waveform: number[];
  peakIndices: number[];
  fps: number;
}

export function WaveformChart({
  waveform,
  peakIndices,
  fps,
}: WaveformChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const width = 560;
  const height = 180;
  const padX = 14;
  const padY = 18;
  const plotW = width - padX * 2;
  const plotH = height - padY * 2;

  const hasData = waveform.length >= 4;

  const points = hasData
    ? waveform
        .map((val, i) => {
          const x = padX + (i / (waveform.length - 1)) * plotW;
          const clamped = Math.max(-3, Math.min(3, val));
          const y = padY + ((3 - clamped) / 6) * plotH;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : "";

  const hoveredVal =
    hoverIdx !== null && hasData && waveform[hoverIdx] !== undefined
      ? waveform[hoverIdx]
      : null;

  return (
    <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 tracking-wide">
            موجة النبض الفلترية (BVP Oscilloscope)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            نطاق التمرير 0.70–3.50 Hz · رصد القمم الانقباضية
          </p>
        </div>

        <div
          dir="ltr"
          className="text-xs font-mono tabular-nums text-cyan-300 bg-[#070b12] border border-slate-800 rounded-md px-2.5 py-1"
        >
          {hoveredVal !== null
            ? `amp: ${hoveredVal.toFixed(2)}σ`
            : `${waveform.length} pts · ${fps || 30} Hz`}
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
            setHoverIdx(Math.round(norm * (waveform.length - 1)));
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

          {[0.2, 0.4, 0.6, 0.8].map((frac) => (
            <line
              key={frac}
              x1={padX + plotW * frac}
              y1={padY}
              x2={padX + plotW * frac}
              y2={height - padY}
              stroke="#1e293b"
              strokeWidth={0.8}
              strokeDasharray="3 3"
            />
          ))}

          {hasData ? (
            <>
              <polyline
                fill="none"
                stroke="#06b6d4"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                points={points}
              />

              {peakIndices.map((idx) => {
                const v = waveform[idx];
                if (v === undefined) return null;
                const cx = padX + (idx / (waveform.length - 1)) * plotW;
                const cy =
                  padY + ((3 - Math.max(-3, Math.min(3, v))) / 6) * plotH;
                return (
                  <circle
                    key={idx}
                    cx={cx}
                    cy={cy}
                    r={3.2}
                    fill="#10b981"
                    stroke="#070b12"
                    strokeWidth={1.2}
                  />
                );
              })}

              {hoverIdx !== null && hoveredVal !== null && (
                <line
                  x1={padX + (hoverIdx / (waveform.length - 1)) * plotW}
                  y1={padY}
                  x2={padX + (hoverIdx / (waveform.length - 1)) * plotW}
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
              fontSize="12"
              fontFamily="JetBrains Mono, monospace"
            >
              Awaiting signal acquisition...
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
