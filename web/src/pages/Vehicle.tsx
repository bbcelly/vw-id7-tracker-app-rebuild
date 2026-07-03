import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import BatteryGauge from "../components/BatteryGauge";
import MapView from "../components/MapView";
import { fmtDate, fmtKm } from "../format";

function Badge({ on, warn, label }: { on: boolean | null; warn?: boolean; label: string }) {
  const cls = on === true ? (warn ? "badge warn" : "badge on") : "badge";
  return (
    <span className={cls}>
      <span className="dot" />
      {label}
    </span>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  api: "WeConnect API",
  web: "Web portal (limited)",
  disconnected: "Disconnected",
};

export default function Vehicle() {
  const status = useApi(api.status, 30_000); // auto-refresh
  const [syncing, setSyncing] = useState(false);
  const s = status.data?.snapshot ?? null;
  const conn = status.data?.connection;

  const sync = async () => {
    setSyncing(true);
    try {
      await api.sync();
      await status.reload();
    } finally {
      setSyncing(false);
    }
  };

  const stale =
    s && Date.now() - new Date(s.ts).getTime() > 3 * 60 * 60 * 1000; // >3h old

  return (
    <div className="reveal">
      <div className="row spread">
        <div>
          <h1 className="page-title">Vehicle</h1>
          <p className="page-sub">
            {conn ? SOURCE_LABEL[conn.state] : "…"}
            {s ? ` · last data ${fmtDate(s.ts)}` : ""}
          </p>
        </div>
        <button className="btn" onClick={() => void sync()} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>

      {status.error && <div className="error-banner">{status.error}</div>}
      {conn?.state === "disconnected" && conn.lastError && (
        <div className="error-banner">
          VW unreachable ({conn.lastError}) — showing the last stored snapshot.
        </div>
      )}
      {stale && conn?.state !== "disconnected" && (
        <div className="error-banner">Data is {fmtDate(s!.ts)} — the car may be asleep.</div>
      )}

      {!s ? (
        <div className="panel empty">No vehicle data yet — configure credentials in Settings and sync.</div>
      ) : (
        <div className="grid two">
          <div className="panel" style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
            <BatteryGauge soc={s.soc} targetSoc={s.targetSoc} charging={s.isCharging === true} />
            <div className="row" style={{ justifyContent: "center" }}>
              <Badge on={s.isCharging} label={s.isCharging ? "Charging" : "Not charging"} />
              <Badge on={s.isPlugged} label={s.isPlugged ? "Plugged in" : "Unplugged"} />
              <Badge on={s.isParked} label={s.isParked === false ? "Driving" : "Parked"} warn={s.isParked === false} />
            </div>
            <div className="grid stats mt" style={{ width: "100%" }}>
              <div>
                <div className="stat-label">Range</div>
                <div className="stat-value">{s.rangeKm != null ? Math.round(s.rangeKm) : "—"}<span className="unit">km</span></div>
              </div>
              <div>
                <div className="stat-label">Odometer</div>
                <div className="stat-value">{fmtKm(s.odometerKm)}<span className="unit">km</span></div>
              </div>
            </div>
            <div className="row mt" style={{ width: "100%" }}>
              <span className="badge">{`Climate: ${status.data?.climatisationState ?? "unknown"}`}</span>
              <span className="badge">{`Locks: ${status.data?.doorLockStatus ?? "unknown"}`}</span>
              <span className="badge">{`Source: ${s.source}`}</span>
            </div>
          </div>

          <div className="panel">
            <div className="stat-label">Parked location</div>
            <div className="mt">
              {s.lat != null && s.lon != null ? (
                <MapView points={[{ lat: s.lat, lon: s.lon }]} height={340} />
              ) : (
                <div className="empty">
                  {s.isParked === false ? "Driving — VW reports position only while parked" : "No position available"}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
