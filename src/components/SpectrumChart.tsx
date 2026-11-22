import { useState } from "react";
import type { SpectrumBin } from "../types/rppg";

interface SpectrumChartProps {
  spectrum: SpectrumBin[];
  dominantFreqHz: number | null;
  bpm: number | null;
}

export function SpectrumChart({
  spectrum,
  dominantFreqHz,
  bpm,
}: SpectrumChartProps) {
  const [hoverBin, setHoverBin] = useState<SpectrumBin | null>(null);

  const width = 560;
  const height = 180;
  const padX = 28;
  const padTop = 16;
  const padBottom = 26;
  const plotW = width - padX * 2;
  const plotH = height - padTop - padBottom;

  const minFreq = 0.6;
  const maxFreq = 3.5;

  const hasData = spectrum.length > 2;

  const polylinePoints = hasData
    ? spectrum
        .map((bin) => {
          const x =
            padX + ((bin.freqHz - minFreq) / (maxFreq - minFreq)) * plotW;
          const y = padTop + (1 - Math.min(1, bin.power)) * plotH;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ")
    : "";

  const areaPoints = hasData
    ? `${padX},${padTop + plotH} ${polylinePoints} ${padX + plotW},${
        padTop + plotH
      }`
    : "";

  const peakX =
    dominantFreqHz !== null
      ? padX + ((dominantFreqHz - minFreq) / (maxFreq - minFreq)) * plotW
      : null;

  return (
    <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 tracking-wide">
            التحليل الطيفي (1024-pt FFT Spectrum)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            الطاقة الترددية للنبض بين 36 و 210 نبضة/دقيقة
          </p>
        </div>

        <div
          dir="ltr"
          className="text-xs font-mono tabular-nums text-cyan-300 bg-[#070b12] border border-slate-800 rounded-md px-2.5 py-1"
        >
          {hoverBin
            ? `${hoverBin.freqHz.toFixed(2)} Hz (${hoverBin.bpm} BPM)`
            : dominantFreqHz && bpm
            ? `Peak: ${dominantFreqHz.toFixed(2)} Hz · ${bpm} BPM`
            : "0.60 – 3.50 Hz"}
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
            const targetFreq =
              minFreq +
              Math.max(0, Math.min(1, (relX * width - padX) / plotW)) *
                (maxFreq - minFreq);
            let nearest = spectrum[0];
            let bestDist = Infinity;
            for (const b of spectrum) {
              const d = Math.abs(b.freqHz - targetFreq);
              if (d < bestDist) {
                bestDist = d;
                nearest = b;
              }
            }
            setHoverBin(nearest);
          }}
          onMouseLeave={() => setHoverBin(null)}
        >
          {[0, 0.5, 1].map((frac) => (
            <line
              key={frac}
              x1={padX}
              y1={padTop + plotH * frac}
              x2={width - padX}
              y2={padTop + plotH * frac}
              stroke="#1e293b"
              strokeWidth={1}
            />
          ))}

          {[1.0, 1.5, 2.0, 2.5, 3.0].map((hz) => {
            const x = padX + ((hz - minFreq) / (maxFreq - minFreq)) * plotW;
            return (
              <g key={hz}>
                <line
                  x1={x}
                  y1={padTop}
                  x2={x}
                  y2={padTop + plotH}
                  stroke="#1e293b"
                  strokeWidth={0.8}
                  strokeDasharray="3 3"
                />
                <text
                  x={x}
                  y={height - 8}
                  textAnchor="middle"
                  fill="#64748b"
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {hz.toFixed(1)}Hz ({Math.round(hz * 60)})
                </text>
              </g>
            );
          })}

          {hasData ? (
            <>
              <polygon fill="#06b6d4" fillOpacity="0.16" points={areaPoints} />
              <polyline
                fill="none"
                stroke="#06b6d4"
                strokeWidth="2"
                strokeLinejoin="round"
                points={polylinePoints}
              />

              {peakX !== null && (
                <g>
                  <line
                    x1={peakX}
                    y1={padTop}
                    x2={peakX}
                    y2={padTop + plotH}
                    stroke="#10b981"
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                  />
                  <circle
                    cx={peakX}
                    cy={padTop + 4}
                    r={3.5}
                    fill="#10b981"
                  />
                </g>
              )}

              {hoverBin && (
                <line
                  x1={
                    padX +
                    ((hoverBin.freqHz - minFreq) / (maxFreq - minFreq)) * plotW
                  }
                  y1={padTop}
                  x2={
                    padX +
                    ((hoverBin.freqHz - minFreq) / (maxFreq - minFreq)) * plotW
                  }
                  y2={padTop + plotH}
                  stroke="#e2e8f0"
                  strokeWidth={1}
                />
              )}
            </>
          ) : (
            <text
              x={width / 2}
              y={height / 2 - 4}
              textAnchor="middle"
              fill="#64748b"
              fontSize="12"
              fontFamily="JetBrains Mono, monospace"
            >
              Computing FFT spectrum...
            </text>
          )}
        </svg>
      </div>
    </div>
  );
}
