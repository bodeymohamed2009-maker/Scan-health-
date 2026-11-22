import type { BiometricProfile, RppgMetrics, SessionReading } from "../types/rppg";

export interface AgeAdjustedNorms {
  hrMaxBpm: number | null;
  rmssdFloorMs: number;
  sd1FloorMs: number;
  expectedRmssdRange: [number, number];
}

/**
 * Tanaka maximum HR (208 - 0.7 * age) & age-stratified resting RMSSD floors
 * because parasympathetic HRV naturally declines with healthy aging.
 */
export function getAgeAdjustedNorms(age: number | null | undefined): AgeAdjustedNorms {
  if (!age || age < 8 || age > 110) {
    return {
      hrMaxBpm: null,
      rmssdFloorMs: 19,
      sd1FloorMs: 13,
      expectedRmssdRange: [22, 65],
    };
  }
  const hrMaxBpm = Math.round(208 - 0.7 * age);
  if (age < 30) {
    return { hrMaxBpm, rmssdFloorMs: 22, sd1FloorMs: 15, expectedRmssdRange: [28, 78] };
  }
  if (age < 45) {
    return { hrMaxBpm, rmssdFloorMs: 19, sd1FloorMs: 13, expectedRmssdRange: [22, 62] };
  }
  if (age < 60) {
    return { hrMaxBpm, rmssdFloorMs: 15, sd1FloorMs: 11, expectedRmssdRange: [17, 48] };
  }
  return { hrMaxBpm, rmssdFloorMs: 12, sd1FloorMs: 9, expectedRmssdRange: [13, 38] };
}

export interface HrvTrendPoint {
  id: string;
  timestamp: string;
  bpm: number;
  rmssdMs: number | null;
  sdnnMs: number | null;
  sd1Ms: number | null;
  sd2Ms: number | null;
  sdRatio: number | null; // SD2 / SD1 sympathovagal balance index
  coherencePct: number | null;
  snrDb: number;
  isAnomalous: boolean;
  isCurrentPreview?: boolean;
}

export type TrendDirection = "improving" | "stable" | "declining" | "insufficient";
export type AlertSeverity = "none" | "nominal" | "caution" | "warning";

export type AnomalyFlagCode =
  | "vagal_suppression"
  | "sd_ratio_imbalance"
  | "sustained_tachy_drift"
  | "coherence_drop";

export interface HrvAnomalyAlert {
  severity: AlertSeverity;
  consecutiveCount: number;
  flags: AnomalyFlagCode[];
  title: string;
  summary: string;
  details: string[];
  recommendations: string[];
}

export interface HrvTrendAnalysis {
  points: HrvTrendPoint[];
  direction: TrendDirection;
  norms: AgeAdjustedNorms;
  baselineRmssdMs: number | null;
  baselineSd1Ms: number | null;
  baselineSdRatio: number | null;
  baselineBpm: number | null;
  baselineCoherencePct: number | null;
  latestRmssdMs: number | null;
  latestSd1Ms: number | null;
  latestSdRatio: number | null;
  latestBpm: number | null;
  latestCoherencePct: number | null;
  rmssdDeltaPct: number | null;
  bpmDeltaPct: number | null;
  rmssdSlopePerSession: number | null;
  alert: HrvAnomalyAlert;
}

function mean(vals: number[]): number | null {
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function stdDev(vals: number[], avg: number): number {
  if (vals.length < 2) return 0;
  const variance =
    vals.reduce((acc, v) => acc + (v - avg) * (v - avg), 0) / vals.length;
  return Math.sqrt(variance);
}

function linearSlope(vals: number[]): number | null {
  const n = vals.length;
  if (n < 2) return null;
  const xMean = (n - 1) / 2;
  const yMean = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - xMean;
    num += dx * (vals[i] - yMean);
    den += dx * dx;
  }
  return den > 0 ? num / den : 0;
}

function computeSdRatio(sd1: number | null, sd2: number | null): number | null {
  if (sd1 === null || sd2 === null || sd1 <= 0) return null;
  return Number((sd2 / sd1).toFixed(2));
}

function isPointAutonomicallyDeviant(
  pt: HrvTrendPoint,
  baselineRmssd: number | null,
  baselineBpm: number | null,
  norms: AgeAdjustedNorms
): { deviant: boolean; reasons: AnomalyFlagCode[] } {
  const reasons: AnomalyFlagCode[] = [];

  // 1. Vagal withdrawal / suppressed HRV (age-adjusted floor OR sharp drop from baseline)
  const lowAbsRmssd = pt.rmssdMs !== null && pt.rmssdMs < norms.rmssdFloorMs;
  const lowAbsSd1 = pt.sd1Ms !== null && pt.sd1Ms < norms.sd1FloorMs;
  const relativeRmssdDrop =
    pt.rmssdMs !== null &&
    baselineRmssd !== null &&
    baselineRmssd >= norms.rmssdFloorMs &&
    (pt.rmssdMs - baselineRmssd) / baselineRmssd <= -0.25;

  if (lowAbsRmssd || lowAbsSd1 || relativeRmssdDrop) {
    reasons.push("vagal_suppression");
  }

  // 2. Sympathovagal imbalance via Poincaré SD2/SD1 ratio
  if (pt.sdRatio !== null && (pt.sdRatio > 2.75 || pt.sdRatio < 0.72)) {
    reasons.push("sd_ratio_imbalance");
  }

  // 3. Elevated resting BPM coupled with reduced or low HRV
  const highAbsBpm = pt.bpm >= 98;
  const relativeBpmRise =
    baselineBpm !== null &&
    baselineBpm > 0 &&
    (pt.bpm - baselineBpm) / baselineBpm >= 0.14;
  if (
    (highAbsBpm || relativeBpmRise) &&
    (pt.rmssdMs === null ||
      pt.rmssdMs < norms.expectedRmssdRange[0] + 6 ||
      (baselineRmssd !== null && pt.rmssdMs < baselineRmssd * 0.9))
  ) {
    reasons.push("sustained_tachy_drift");
  }

  // 4. Cardiorespiratory desynchronization (low RSA coherence)
  if (pt.coherencePct !== null && pt.coherencePct < 40) {
    reasons.push("coherence_drop");
  }

  const deviant =
    reasons.includes("vagal_suppression") ||
    reasons.length >= 2 ||
    (pt.sdRatio !== null && pt.sdRatio > 3.1);

  return { deviant, reasons };
}

/**
 * Analyzes chronological HRV trends across recorded sessions (readings are stored newest-first
 * in SessionLogTable, so we reverse to chronological order) and detects consecutive autonomic
 * deviations for smart alerts inside SessionReportModal.
 */
export function analyzeHrvTrends(
  readings: SessionReading[],
  currentMetrics?: RppgMetrics,
  profile?: BiometricProfile
): HrvTrendAnalysis {
  const norms = getAgeAdjustedNorms(profile?.age);
  // Reverse newest-first readings into chronological order (oldest -> newest)
  const chronological: HrvTrendPoint[] = [...readings]
    .reverse()
    .map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      bpm: r.bpm,
      rmssdMs: r.rmssdMs,
      sdnnMs: r.sdnnMs,
      sd1Ms: r.sd1Ms,
      sd2Ms: r.sd2Ms,
      sdRatio: computeSdRatio(r.sd1Ms, r.sd2Ms),
      coherencePct: r.coherencePct,
      snrDb: r.snrDb,
      isAnomalous: false,
    }));

  // If inspecting live metrics in modal before manual snapshot, include it when distinct from latest saved row
  if (currentMetrics && currentMetrics.bpm !== null) {
    const last = chronological[chronological.length - 1];
    const matchesLatest =
      last &&
      last.bpm === currentMetrics.bpm &&
      last.rmssdMs === currentMetrics.rmssdMs &&
      last.sd1Ms === currentMetrics.sd1Ms;

    if (!matchesLatest) {
      chronological.push({
        id: "current-live-session",
        timestamp: "الآن",
        bpm: currentMetrics.bpm,
        rmssdMs: currentMetrics.rmssdMs,
        sdnnMs: currentMetrics.sdnnMs,
        sd1Ms: currentMetrics.sd1Ms,
        sd2Ms: currentMetrics.sd2Ms,
        sdRatio: computeSdRatio(currentMetrics.sd1Ms, currentMetrics.sd2Ms),
        coherencePct: currentMetrics.coherencePct,
        snrDb: currentMetrics.snrDb,
        isAnomalous: false,
        isCurrentPreview: true,
      });
    }
  }

  const validRmssds = chronological
    .map((p) => p.rmssdMs)
    .filter((v): v is number => v !== null);
  const validSd1s = chronological
    .map((p) => p.sd1Ms)
    .filter((v): v is number => v !== null);
  const validRatios = chronological
    .map((p) => p.sdRatio)
    .filter((v): v is number => v !== null);
  const validBpms = chronological.map((p) => p.bpm);
  const validCoherences = chronological
    .map((p) => p.coherencePct)
    .filter((v): v is number => v !== null);

  // Reference baseline: use earlier sessions when >= 3 exist so recent shifts stand out clearly
  const baselineSlice =
    chronological.length >= 4
      ? chronological.slice(0, Math.max(2, chronological.length - 2))
      : chronological.length >= 2
      ? chronological.slice(0, chronological.length - 1)
      : chronological;

  const baseRmssds = baselineSlice
    .map((p) => p.rmssdMs)
    .filter((v): v is number => v !== null);
  const baseSd1s = baselineSlice
    .map((p) => p.sd1Ms)
    .filter((v): v is number => v !== null);
  const baseRatios = baselineSlice
    .map((p) => p.sdRatio)
    .filter((v): v is number => v !== null);
  const baseBpms = baselineSlice.map((p) => p.bpm);
  const baseCoherences = baselineSlice
    .map((p) => p.coherencePct)
    .filter((v): v is number => v !== null);

  const baselineRmssdRaw = mean(baseRmssds.length > 0 ? baseRmssds : validRmssds);
  const baselineSd1Raw = mean(baseSd1s.length > 0 ? baseSd1s : validSd1s);
  const baselineSdRatioRaw = mean(baseRatios.length > 0 ? baseRatios : validRatios);
  const baselineBpmRaw = mean(baseBpms.length > 0 ? baseBpms : validBpms);
  const baselineCoherenceRaw = mean(
    baseCoherences.length > 0 ? baseCoherences : validCoherences
  );

  const baselineRmssdMs = baselineRmssdRaw !== null ? Math.round(baselineRmssdRaw) : null;
  const baselineSd1Ms = baselineSd1Raw !== null ? Math.round(baselineSd1Raw) : null;
  const baselineSdRatio =
    baselineSdRatioRaw !== null ? Number(baselineSdRatioRaw.toFixed(2)) : null;
  const baselineBpm = baselineBpmRaw !== null ? Math.round(baselineBpmRaw) : null;
  const baselineCoherencePct =
    baselineCoherenceRaw !== null ? Math.round(baselineCoherenceRaw) : null;

  // Tag individual points and count trailing consecutive anomalies
  const pointEvaluations = chronological.map((pt) => {
    const res = isPointAutonomicallyDeviant(pt, baselineRmssdRaw, baselineBpmRaw, norms);
    pt.isAnomalous = res.deviant;
    return res;
  });

  let consecutiveCount = 0;
  const trailingFlags = new Set<AnomalyFlagCode>();
  for (let i = pointEvaluations.length - 1; i >= 0; i--) {
    if (pointEvaluations[i].deviant) {
      consecutiveCount++;
      for (const f of pointEvaluations[i].reasons) trailingFlags.add(f);
    } else {
      break;
    }
  }

  // Also detect persistent monotonic decline across last >= 3 readings (e.g. RMSSD dropping step-by-step)
  let monotonicRmssdDrop = false;
  if (validRmssds.length >= 3) {
    const tail = validRmssds.slice(-3);
    const totalDropPct = tail[0] > 0 ? (tail[2] - tail[0]) / tail[0] : 0;
    if (tail[0] > tail[1] && tail[1] > tail[2] && totalDropPct <= -0.22) {
      monotonicRmssdDrop = true;
      trailingFlags.add("vagal_suppression");
      consecutiveCount = Math.max(consecutiveCount, 2);
      chronological[chronological.length - 1].isAnomalous = true;
      chronological[chronological.length - 2].isAnomalous = true;
    }
  }

  const latest = chronological[chronological.length - 1] ?? null;
  const latestRmssdMs = latest?.rmssdMs ?? null;
  const latestSd1Ms = latest?.sd1Ms ?? null;
  const latestSdRatio = latest?.sdRatio ?? null;
  const latestBpm = latest?.bpm ?? null;
  const latestCoherencePct = latest?.coherencePct ?? null;

  const rmssdDeltaPct =
    latestRmssdMs !== null && baselineRmssdRaw !== null && baselineRmssdRaw > 0
      ? Math.round(((latestRmssdMs - baselineRmssdRaw) / baselineRmssdRaw) * 100)
      : null;

  const bpmDeltaPct =
    latestBpm !== null && baselineBpmRaw !== null && baselineBpmRaw > 0
      ? Math.round(((latestBpm - baselineBpmRaw) / baselineBpmRaw) * 100)
      : null;

  const slope = linearSlope(validRmssds);
  const rmssdSlopePerSession = slope !== null ? Number(slope.toFixed(1)) : null;

  let direction: TrendDirection = "insufficient";
  if (chronological.length >= 2) {
    const sdRmssd = baselineRmssdRaw !== null ? stdDev(validRmssds, baselineRmssdRaw) : 0;
    if (consecutiveCount >= 2 || (slope !== null && slope <= -3.5) || (rmssdDeltaPct !== null && rmssdDeltaPct <= -18)) {
      direction = "declining";
    } else if ((slope !== null && slope >= 2.5) || (rmssdDeltaPct !== null && rmssdDeltaPct >= 12 && sdRmssd >= 0)) {
      direction = "improving";
    } else {
      direction = "stable";
    }
  }

  // Construct Smart Alert for SessionReportModal
  let alert: HrvAnomalyAlert;
  const flags = Array.from(trailingFlags);

  if (chronological.length < 2) {
    alert = {
      severity: "none",
      consecutiveCount: 0,
      flags: [],
      title: "بانتظار المزيد من القراءات لتفعيل تحليل الاتجاه",
      summary:
        "سجّل جلستين متتاليتين على الأقل ليتمكن المحرك من مقارنة تذبذب HRV لديك ورصد أي انحراف عصبي مبكر.",
      details: [],
      recommendations: [],
    };
  } else if (consecutiveCount >= 2 || monotonicRmssdDrop) {
    const isCritical = consecutiveCount >= 3 || flags.length >= 2;
    const details: string[] = [];

    if (flags.includes("vagal_suppression")) {
      details.push(
        latestRmssdMs !== null && baselineRmssdMs !== null
          ? `هبوط متتالي في مؤشر التعافي الباراسمبثاوي RMSSD (${latestRmssdMs} ms مقابل متوسطك المرجعي ${baselineRmssdMs} ms${
              rmssdDeltaPct !== null ? ` · ${rmssdDeltaPct}%` : ""
            }).`
          : "انخفاض متتالي في تقلب النبض (RMSSD / SD1) مما يشير إلى إجهاد في نشاط العصب الحائر."
      );
    }
    if (flags.includes("sd_ratio_imbalance") && latestSdRatio !== null) {
      details.push(
        `اختلال نسبة التوازن العصبي SD2/SD1 إلى ${latestSdRatio} (المدى المتوازن عادة بين 1.0 و 2.5).`
      );
    }
    if (flags.includes("sustained_tachy_drift") && latestBpm !== null) {
      details.push(
        `تسارع متواصل في نبض الراحة (${latestBpm} BPM${
          baselineBpm !== null ? ` مقابل ${baselineBpm} BPM` : ""
        }) بالتزامن مع تراجع HRV.`
      );
    }
    if (flags.includes("coherence_drop") && latestCoherencePct !== null) {
      details.push(
        `تراجع تناغم القلب مع التنفس (Coherence) إلى ${latestCoherencePct}% عبر قراءات متتالية.`
      );
    }

    alert = {
      severity: isCritical ? "warning" : "caution",
      consecutiveCount,
      flags,
      title: isCritical
        ? `تنبيه ذكي: انحراف عصبي متتالي عبر ${consecutiveCount} قراءات`
        : `ملاحظة استباقية: بوادر إجهاد عصبي في آخر قراءتين`,
      summary:
        "رصد المحرك انحرافاً غير معتاد في مؤشرات التوازن العصبي الذاتي (HRV / Poincaré) مقارنةً بخط الأساس الشخصي أو الحدود الفسيولوجية المستقرة.",
      details,
      recommendations: [
        "احرص على أخذ استراحة قصيرة وممارسة تنفس بطيء منتظم (6 أنفاس/دقيقة لمدة 3 دقائق) ثم أعد القياس في وضع جلوس هادئ.",
        "تأكد أن القراءات لم تتأثر بحركة متكررة أو إضاءة ضعيفة (راجع ثبات مؤشر SNR > 5 dB).",
        "هذا التنبيه مؤشر استرشادي بحثي لمتابعة الإجهاد والتعافي؛ إذا استمر الانحراف مع إرهاق أو أعراض غير معتادة يُنصح بمراجعة مختص.",
      ],
    };
  } else {
    alert = {
      severity: "nominal",
      consecutiveCount: 0,
      flags: [],
      title: "التوازن العصبي واتجاه HRV مستقران",
      summary: `تمت مقارنة ${chronological.length} قراءات متتالية؛ مؤشرات RMSSD (${
        latestRmssdMs ?? "--"
      } ms) ونسبة SD2/SD1 (${
        latestSdRatio ?? "--"
      }) وتناغم التنفس ضمن النطاق المتوازن دون انحرافات متتالية مقلقة.`,
      details: [],
      recommendations: [],
    };
  }

  return {
    points: chronological,
    direction,
    norms,
    baselineRmssdMs,
    baselineSd1Ms,
    baselineSdRatio,
    baselineBpm,
    baselineCoherencePct,
    latestRmssdMs,
    latestSd1Ms,
    latestSdRatio,
    latestBpm,
    latestCoherencePct,
    rmssdDeltaPct,
    bpmDeltaPct,
    rmssdSlopePerSession,
    alert,
  };
}
