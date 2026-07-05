import { Link } from "react-router-dom";
import { api } from "../api";
import { useApi } from "../hooks";
import StatCard from "../components/StatCard";
import TrendChart from "../components/TrendChart";
import { fmtConsumption, fmtDate, fmtKm, fmtKwh, fmtMoney, fmtMonth } from "../format";

export default function Dashboard() {
  const stats = useApi(api.stats);
  const monthly = useApi(api.monthly);
  const trips = useApi(() => api.trips(5, 0));
  const charges = useApi(() => api.charging(5, 0));
  const settings = useApi(api.settings);
  const currency = settings.data?.currency ?? "EUR";
  const s = stats.data;

  return (
    <div className="reveal">
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Lifetime totals across everything the tracker has recorded.</p>

      {stats.error && <div className="error-banner">{stats.error}</div>}

      <div className="grid stats">
        <StatCard label="Distance" value={s ? fmtKm(s.totalDistanceKm) : "—"} unit="km" />
        <StatCard label="Avg consumption" value={s ? fmtKwh(s.avgConsumption) : "—"} unit="kWh/100km" />
        <StatCard label="Energy charged" value={s ? fmtKwh(s.totalChargedKwh) : "—"} unit="kWh" />
        <StatCard label="Charge cost" value={s ? fmtMoney(s.totalChargeCost, currency) : "—"} />
        <StatCard label="Trips" value={s?.tripCount ?? "—"} />
        <StatCard label="Charges" value={s?.chargeCount ?? "—"} />
      </div>

      <div className="panel mt">
        <div className="stat-label">Consumption trend — last {s?.trend.length ?? 0} trips</div>
        <div className="mt">
          <TrendChart data={s?.trend ?? []} />
        </div>
      </div>

      <div className="panel mt">
        <div className="stat-label">Monthly breakdown</div>
        <div className="table-wrap mt">
          <table>
            <thead>
              <tr>
                <th>Month</th>
                <th className="num">Distance</th>
                <th className="num">Charged</th>
                <th className="num">Cost</th>
                <th className="num">Consumption</th>
                <th className="num">Trips</th>
              </tr>
            </thead>
            <tbody>
              {(monthly.data ?? []).map((m) => (
                <tr key={m.month}>
                  <td>{fmtMonth(m.month)}</td>
                  <td className="num">{fmtKm(m.distanceKm)} km</td>
                  <td className="num">{fmtKwh(m.chargedKwh)} kWh</td>
                  <td className="num">{fmtMoney(m.chargeCost, currency)}</td>
                  <td className="num muted">{fmtConsumption(m.avgConsumption)} kWh/100</td>
                  <td className="num">{m.tripCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {monthly.data && monthly.data.length === 0 && <div className="empty">No activity yet</div>}
        </div>
      </div>

      <div className="grid two mt">
        <div className="panel">
          <div className="row spread">
            <div className="stat-label">Recent trips</div>
            <Link className="btn ghost sm" to="/trips">All trips</Link>
          </div>
          <div className="table-wrap mt">
            <table>
              <tbody>
                {(trips.data?.items ?? []).map((t) => (
                  <tr key={t.id}>
                    <td>{fmtDate(t.startTs)}</td>
                    <td className="num">{fmtKm(t.distanceKm)} km</td>
                    <td className="num muted">{fmtKwh(t.consumption)} kWh/100</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {trips.data && trips.data.items.length === 0 && <div className="empty">No trips yet</div>}
          </div>
        </div>

        <div className="panel">
          <div className="row spread">
            <div className="stat-label">Recent charges</div>
            <Link className="btn ghost sm" to="/charging">All charges</Link>
          </div>
          <div className="table-wrap mt">
            <table>
              <tbody>
                {(charges.data?.items ?? []).map((c) => (
                  <tr key={c.id}>
                    <td>{fmtDate(c.startTs)}</td>
                    <td className="num">{fmtKwh(c.energyKwh)} kWh</td>
                    <td className="num muted">{fmtMoney(c.cost, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {charges.data && charges.data.items.length === 0 && <div className="empty">No charges yet</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
