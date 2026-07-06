import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoryRange, SocPoint } from "../api";
import { fmtDate, fmtTime } from "../format";

const RANGE_LABEL: Record<HistoryRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/** Contiguous spans where the car was charging, as [startTs, endTs] pairs. */
function chargingRuns(data: SocPoint[]): Array<{ from: string; to: string }> {
  const runs: Array<{ from: string; to: string }> = [];
  let start: string | null = null;
  let prev: string | null = null;
  for (const p of data) {
    if (p.isCharging) {
      if (start === null) start = p.ts;
      prev = p.ts;
    } else if (start !== null && prev !== null) {
      runs.push({ from: start, to: prev });
      start = null;
      prev = null;
    }
  }
  if (start !== null && prev !== null) runs.push({ from: start, to: prev });
  return runs;
}

export default function BatteryHistoryChart({
  data,
  range,
  loading,
}: {
  data: SocPoint[];
  range: HistoryRange;
  loading?: boolean;
}) {
  // Only the first fetch flips `loading`; range switches keep the prior data
  // on screen until the new range arrives, so no empty flash there.
  if (loading && data.length === 0) {
    return <div className="empty">Loading battery history…</div>;
  }
  if (data.length < 2) {
    return <div className="empty">No battery data in the last {RANGE_LABEL[range]} yet</div>;
  }
  const tickFmt = (v: string) => (range === "24h" ? fmtTime(v) : fmtDate(v).slice(0, 6));
  const hasTarget = data.some((p) => p.targetSoc != null);
  const runs = chargingRuns(data);

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
        <CartesianGrid stroke="#232b35" strokeDasharray="3 6" vertical={false} />
        {runs.map((r) => (
          <ReferenceArea
            key={r.from}
            x1={r.from}
            x2={r.to}
            fill="#2fe6b0"
            fillOpacity={0.08}
            strokeOpacity={0}
          />
        ))}
        <XAxis
          dataKey="ts"
          tickFormatter={tickFmt}
          stroke="#4d5660"
          tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          stroke="#4d5660"
          tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }}
          tickLine={false}
          axisLine={false}
          unit="%"
          width={54}
        />
        <Tooltip
          contentStyle={{
            background: "#171c23",
            border: "1px solid #2f3a47",
            borderRadius: 8,
            fontFamily: "JetBrains Mono",
            fontSize: 12,
          }}
          labelFormatter={(v) => fmtDate(String(v))}
          formatter={(value, name) => [
            `${Math.round(Number(value))}%`,
            name === "targetSoc" ? "target" : "battery",
          ]}
        />
        {hasTarget && (
          <Line
            type="stepAfter"
            dataKey="targetSoc"
            stroke="#4d5660"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            dot={false}
            activeDot={false}
            connectNulls
            isAnimationActive={false}
          />
        )}
        <Line
          type="monotone"
          dataKey="soc"
          stroke="#2fe6b0"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
