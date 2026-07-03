import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtDate } from "../format";

export default function TrendChart({
  data,
}: {
  data: Array<{ id: number; startTs: string; consumption: number }>;
}) {
  if (data.length < 2) {
    return <div className="empty">Not enough trips for a trend yet</div>;
  }
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
        <CartesianGrid stroke="#232b35" strokeDasharray="3 6" vertical={false} />
        <XAxis
          dataKey="startTs"
          tickFormatter={(v: string) => fmtDate(v).slice(0, 6)}
          stroke="#4d5660"
          tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }}
          tickLine={false}
        />
        <YAxis
          stroke="#4d5660"
          tick={{ fontSize: 11, fontFamily: "JetBrains Mono" }}
          tickLine={false}
          axisLine={false}
          unit=""
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
          formatter={(value) => [`${Number(value).toFixed(2)} kWh/100km`, "consumption"]}
        />
        <Line
          type="monotone"
          dataKey="consumption"
          stroke="#2fe6b0"
          strokeWidth={2}
          dot={{ r: 3, fill: "#2fe6b0", strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
