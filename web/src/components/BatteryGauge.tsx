/** Instrument-cluster battery arc: 270° sweep, target-SOC tick, glowing SOC readout. */
export default function BatteryGauge({
  soc,
  targetSoc,
  charging,
}: {
  soc: number | null;
  targetSoc: number | null;
  charging: boolean;
}) {
  const size = 220;
  const stroke = 14;
  const r = (size - stroke) / 2 - 6;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = 135;
  const sweep = 270;

  const polar = (angleDeg: number, radius = r) => {
    const a = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
  };
  const arcPath = (fromDeg: number, toDeg: number) => {
    const s = polar(fromDeg);
    const e = polar(toDeg);
    const large = toDeg - fromDeg > 180 ? 1 : 0;
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
  };

  const pct = soc == null ? 0 : Math.max(0, Math.min(100, soc));
  const color = pct <= 15 ? "var(--red)" : pct <= 30 ? "var(--amber)" : "var(--accent)";

  const targetAngle = targetSoc != null ? startAngle + (targetSoc / 100) * sweep : null;
  const tickOuter = targetAngle != null ? polar(targetAngle, r + stroke / 2 + 4) : null;
  const tickInner = targetAngle != null ? polar(targetAngle, r - stroke / 2 - 4) : null;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`Battery ${pct}%`}>
      <path d={arcPath(startAngle, startAngle + sweep)} fill="none" stroke="var(--line)" strokeWidth={stroke} strokeLinecap="round" />
      {pct > 0 && (
        <path
          d={arcPath(startAngle, startAngle + (pct / 100) * sweep)}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 6px ${charging ? color : "transparent"})`, transition: "all 600ms" }}
        />
      )}
      {tickOuter && tickInner && (
        <line x1={tickInner.x} y1={tickInner.y} x2={tickOuter.x} y2={tickOuter.y} stroke="var(--blue)" strokeWidth={3} strokeLinecap="round" />
      )}
      <text x={cx} y={cy - 4} textAnchor="middle" fill="var(--text)" style={{ font: "700 44px var(--font-num)" }}>
        {soc == null ? "—" : Math.round(pct)}
      </text>
      <text x={cx} y={cy + 22} textAnchor="middle" fill="var(--text-dim)" style={{ font: "600 13px var(--font-label)", letterSpacing: "0.25em" }}>
        {charging ? "CHARGING" : "SOC %"}
      </text>
      {targetSoc != null && (
        <text x={cx} y={cy + 44} textAnchor="middle" fill="var(--blue)" style={{ font: "12px var(--font-num)" }}>
          target {targetSoc}%
        </text>
      )}
    </svg>
  );
}
