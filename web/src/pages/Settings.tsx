import { useEffect, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";

type Form = {
  vw_username: string;
  vw_password: string;
  vw_vin: string;
  poll_interval: string;
  battery_capacity_kwh: string;
  price_per_kwh: string;
  currency: string;
  position_tracking: boolean;
  soc_delta_detection: boolean;
  soc_delta_threshold: string;
};

export default function Settings() {
  const settings = useApi(api.settings);
  const status = useApi(api.status);
  const [form, setForm] = useState<Form | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passwordSet, setPasswordSet] = useState(false);

  useEffect(() => {
    const d = settings.data;
    if (!d || form) return;
    setPasswordSet(d.vw_password_set === "true");
    setForm({
      vw_username: d.vw_username ?? "",
      vw_password: "",
      vw_vin: d.vw_vin ?? "",
      poll_interval: d.poll_interval ?? "5",
      battery_capacity_kwh: d.battery_capacity_kwh ?? "77",
      price_per_kwh: d.price_per_kwh ?? "",
      currency: d.currency ?? "EUR",
      position_tracking: (d.position_tracking ?? "true") === "true",
      soc_delta_detection: d.soc_delta_detection === "true",
      soc_delta_threshold: d.soc_delta_threshold ?? "2",
    });
  }, [settings.data, form]);

  const save = async (): Promise<boolean> => {
    if (!form) return false;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await api.saveSettings({
        ...form,
        poll_interval: Number(form.poll_interval),
        battery_capacity_kwh: Number(form.battery_capacity_kwh),
        price_per_kwh: form.price_per_kwh === "" ? undefined : Number(form.price_per_kwh),
        soc_delta_threshold: Number(form.soc_delta_threshold),
      });
      setMsg("Settings saved.");
      if (form.vw_password) setPasswordSet(true);
      setForm({ ...form, vw_password: "" });
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const connectAndSync = async () => {
    if (!(await save())) return;
    setBusy(true);
    try {
      const r = await api.connect();
      setMsg(
        r.connected
          ? `Connected via ${r.state === "api" ? "WeConnect API" : "web portal"} and synced.`
          : `Could not connect: ${r.lastError ?? "unknown error"}`
      );
      await status.reload();
    } finally {
      setBusy(false);
    }
  };

  const conn = status.data?.connection;

  if (!form) return <div className="empty">Loading…</div>;

  return (
    <div className="reveal" style={{ maxWidth: 640 }}>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">
        Connection:{" "}
        <span className={`badge ${conn?.state === "disconnected" || !conn ? "err" : "on"}`}>
          <span className="dot" />
          {conn?.state ?? "…"}
        </span>
      </p>

      {msg && <div className="error-banner" style={{ borderColor: "rgba(47,230,176,.4)", background: "rgba(47,230,176,.07)", color: "var(--accent)" }}>{msg}</div>}
      {err && <div className="error-banner">{err}</div>}

      <div className="panel">
        <div className="stat-label">VW account</div>
        <div className="form-row mt">
          <label className="field"><span>Email</span>
            <input autoComplete="off" value={form.vw_username}
              onChange={(e) => setForm({ ...form, vw_username: e.target.value })} />
          </label>
          <label className="field"><span>Password {passwordSet ? "(set — leave blank to keep)" : ""}</span>
            <input type="password" autoComplete="new-password" placeholder={passwordSet ? "••••••••" : ""}
              value={form.vw_password}
              onChange={(e) => setForm({ ...form, vw_password: e.target.value })} />
          </label>
        </div>
        <label className="field"><span>VIN (auto-detected on first connect)</span>
          <input value={form.vw_vin} onChange={(e) => setForm({ ...form, vw_vin: e.target.value })} />
        </label>
      </div>

      <div className="panel mt">
        <div className="stat-label">Polling & vehicle</div>
        <div className="form-row mt">
          <label className="field"><span>Poll interval (1–60 min)</span>
            <input type="number" min={1} max={60} value={form.poll_interval}
              onChange={(e) => setForm({ ...form, poll_interval: e.target.value })} />
          </label>
          <label className="field"><span>Battery capacity (kWh)</span>
            <input type="number" step="0.1" value={form.battery_capacity_kwh}
              onChange={(e) => setForm({ ...form, battery_capacity_kwh: e.target.value })} />
          </label>
        </div>
        <div className="form-row">
          <label className="field"><span>Electricity price / kWh</span>
            <input type="number" step="0.001" value={form.price_per_kwh}
              onChange={(e) => setForm({ ...form, price_per_kwh: e.target.value })} />
          </label>
          <label className="field"><span>Currency</span>
            <input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="panel mt">
        <div className="stat-label">Detection</div>
        <label className="field mt" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input type="checkbox" checked={form.position_tracking}
            onChange={(e) => setForm({ ...form, position_tracking: e.target.checked })} />
          <span style={{ margin: 0 }}>Record trip start/end positions</span>
        </label>
        <label className="field" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input type="checkbox" checked={form.soc_delta_detection}
            onChange={(e) => setForm({ ...form, soc_delta_detection: e.target.checked })} />
          <span style={{ margin: 0 }}>Detect charging from SOC changes (heuristic)</span>
        </label>
        {form.soc_delta_detection && (
          <label className="field"><span>Min SOC rise to count as a charge (%)</span>
            <input type="number" min={1} max={50} value={form.soc_delta_threshold}
              onChange={(e) => setForm({ ...form, soc_delta_threshold: e.target.value })} />
          </label>
        )}
      </div>

      <div className="row mt">
        <button className="btn ghost" onClick={() => void save()} disabled={busy}>Save</button>
        <button className="btn" onClick={() => void connectAndSync()} disabled={busy}>
          {busy ? "Working…" : "Connect & Sync"}
        </button>
      </div>
    </div>
  );
}
