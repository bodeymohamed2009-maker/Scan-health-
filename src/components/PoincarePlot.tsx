import { useState } from "react";
import type { PoincarePoint } from "../types/rppg";

interface PoincarePlotProps {
  points: PoincarePoint[];
  sd1Ms: number | null;
  sd2Ms: number | null;
  coherencePct: number | null;
}

export function PoincarePlot({
  points,
  sd1Ms,
  sd2Ms,
  coherencePct,
}: PoincarePlotProps) {
  const [hovered, setHovered] = useState<PoincarePoint | null>(null);

  const size = 280;
  const pad = 34;
  const plot = size - pad * 2;
  const minIbi = 400;
  const maxIbi = 1250;

  const mapCoord = (val: number) => {
    const clamped = Math.max(minIbi, Math.min(maxIbi, val));
    return ((clamped - minIbi) / (maxIbi - minIbi)) * plot;
  };

  const hasPoints = points.length >= 2;
  const meanIbi = hasPoints
    ? points.reduce((acc, p) => acc + p.ibiN, 0) / points.length
    : 800;

  const cx = pad + mapCoord(meanIbi);
  const cy = size - pad - mapCoord(meanIbi);
  const rx = sd2Ms ? Math.max(8, (sd2Ms / (maxIbi - minIbi)) * plot * 1.4) : 14;
  const ry = sd1Ms ? Math.max(6, (sd1Ms / (maxIbi - minIbi)) * plot * 1.4) : 10;

  return (
    <div className="bg-[#0d131f] border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 tracking-wide">
            مخطط بوانكاريه للتوازن العصبي (Poincaré Plot)
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            العلاقة بين نبضة وأخرى (SD1 للعصب الحائر · SD2 للتوازن الكلي)
          </p>
        </div>

        <div
          dir="ltr"
          className="text-xs font-mono tabular-nums text-cyan-300 bg-[#070b12] border border-slate-800 rounded-md px-2.5 py-1 shrink-0"
        >
          {hovered
            ? `(${hovered.ibiN}, ${hovered.ibiNext}) ms`
            : sd1Ms !== null && sd2Ms !== null
            ? `SD1 ${sd1Ms} · SD2 ${sd2Ms} ms`
            : "Awaiting ≥4 beats"}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
        <div dir="ltr" className="sm:col-span-7 flex justify-center">
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className="w-full max-w-[260px] aspect-square bg-[#070b12] border border-slate-800 rounded-lg select-none"
          >
            {/* Grid lines */}
            {[500, 750, 1000].map((ms) => {
              const p = mapCoord(ms);
              return (
                <g key={ms}>
                  <line
                    x1={pad + p}
                    y1={pad}
                    x2={pad + p}
                    y2={size - pad}
                    stroke="#1e293b"
                    strokeWidth={0.8}
                    strokeDasharray="3 3"
                  />
                  <line
                    x1={pad}
                    y1={size - pad - p}
                    x2={size - pad}
                    y2={size - pad - p}
                    stroke="#1e293b"
                    strokeWidth={0.8}
                    strokeDasharray="3 3"
                  />
                  <text
                    x={pad + p}
                    y={size - 12}
                    textAnchor="middle"
                    fill="#64748b"
                    fontSize="9"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {ms}
                  </text>
                  <text
                    x={pad - 6}
                    y={size - pad - p + 3}
                    textAnchor="end"
                    fill="#64748b"
                    fontSize="9"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {ms}
                  </text>
                </g>
              );
            })}

            {/* Frame */}
            <rect
              x={pad}
              y={pad}
              width={plot}
              height={plot}
              fill="none"
              stroke="#334155"
              strokeWidth={1}
            />

            {/* Identity diagonal IBI[n] = IBI[n+1] */}
            <line
              x1={pad}
              y1={size - pad}
              x2={size - pad}
              y2={pad}
              stroke="#334155"
              strokeWidth={1}
              strokeDasharray="4 3"
            />

            {hasPoints ? (
              <>
                <ellipse
                  cx={cx}
                  cy={cy}
                  rx={rx}
                  ry={ry}
                  transform={`rotate(-45 ${cx} ${cy})`}
                  fill="rgba(6, 182, 212, 0.12)"
                  stroke="#06b6d4"
                  strokeWidth={1.2}
                />

                {points.map((pt, i) => {
                  const px = pad + mapCoord(pt.ibiN);
                  const py = size - pad - mapCoord(pt.ibiNext);
                  return (
                    <circle
                      key={`${i}-${pt.ibiN}`}
                      cx={px}
                      cy={py}
                      r={3.2}
                      fill="#10b981"
                      stroke="#070b12"
                      strokeWidth={1}
                      className="cursor-pointer"
                      onMouseEnter={() => setHovered(pt)}
                      onMouseLeave={() => setHovered(null)}
                    />
                  );
                })}
              </>
            ) : (
              <text
                x={size / 2}
                y={size / 2}
                textAnchor="middle"
                fill="#64748b"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                Collecting IBI pairs...
              </text>
            )}
          </svg>
        </div>

        {/* Autonomic Metrics Breakdown */}
        <div className="sm:col-span-5 flex flex-col gap-2.5">
          <div className="bg-[#070b12] border border-slate-800 rounded-lg p-3">
            <span className="block text-[11px] text-slate-400">
              النشاط الباراسمبثاوي (SD1)
            </span>
            <span
              dir="ltr"
              className="block font-mono text-lg font-bold text-emerald-400 tabular-nums mt-0.5"
            >
              {sd1Ms !== null ? `${sd1Ms} ms` : "--"}
            </span>
          </div>

          <div className="bg-[#070b12] border border-slate-800 rounded-lg p-3">
            <span className="block text-[11px] text-slate-400">
              التباين طويل المدى (SD2)
            </span>
            <span
              dir="ltr"
              className="block font-mono text-lg font-bold text-cyan-400 tabular-nums mt-0.5"
            >
              {sd2Ms !== null ? `${sd2Ms} ms` : "--"}
            </span>
          </div>

          <div className="bg-[#070b12] border border-slate-800 rounded-lg p-3">
            <span className="block text-[11px] text-slate-400">
              تناغم القلب والتنفس (Coherence)
            </span>
            <span
              dir="ltr"
              className="block font-mono text-lg font-bold text-teal-300 tabular-nums mt-0.5"
            >
              {coherencePct !== null ? `${coherencePct}%` : "--"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
