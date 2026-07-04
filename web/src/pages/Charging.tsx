import { useState } from "react";
import { api, type ChargingSession } from "../api";
import { useApi } from "../hooks";
import Modal from "../components/Modal";
import { fmtDate, fmtKwh, fmtMoney, isoToLocalInput, localInputToIso } from "../format";

const PAGE = 50;

type Draft = {
  startTs: string;
  endTs: string;
  startSoc: string;
  endSoc: string;
  energyKwh: string;
  cost: string;
  pricePerKwh: string;
  maxPowerKw: string;
  chargerType: "" | "home" | "ac" | "dc";
  location: string;
  notes: string;
};

const emptyDraft: Draft = {
  startTs: "", endTs: "", startSoc: "", endSoc: "", energyKwh: "",
  cost: "", pricePerKwh: "", maxPowerKw: "", chargerType: "home", location: "", notes: "",
};

function draftFrom(c: ChargingSession): Draft {
  return {
    startTs: isoToLocalInput(c.startTs),
    endTs: isoToLocalInput(c.endTs),
    startSoc: c.startSoc?.toString() ?? "",
    endSoc: c.endSoc?.toString() ?? "",
    energyKwh: c.energyKwh?.toString() ?? "",
    cost: c.cost?.toString() ?? "",
    pricePerKwh: c.pricePerKwh?.toString() ?? "",
    maxPowerKw: c.maxPowerKw?.toString() ?? "",
    chargerType: c.chargerType ?? "",
    location: c.location ?? "",
    notes: c.notes ?? "",
  };
}

function toPayload(d: Draft): Partial<ChargingSession> {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return {
    startTs: localInputToIso(d.startTs) ?? undefined,
    endTs: localInputToIso(d.endTs),
    startSoc: num(d.startSoc),
    endSoc: num(d.endSoc),
    energyKwh: num(d.energyKwh),
    cost: num(d.cost),
    pricePerKwh: num(d.pricePerKwh),
    maxPowerKw: num(d.maxPowerKw),
    chargerType: d.chargerType === "" ? null : d.chargerType,
    location: d.location.trim() === "" ? null : d.location,
    notes: d.notes.trim() === "" ? null : d.notes,
  };
}

const TYPE_LABEL: Record<string, string> = { home: "Home", ac: "AC", dc: "DC" };

export default function Charging() {
  const [offset, setOffset] = useState(0);
  const page = useApi(() => api.charging(PAGE, offset));
  const settings = useApi(api.settings);
  const currency = settings.data?.currency ?? "EUR";
  const [editing, setEditing] = useState<ChargingSession | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saveError, setSaveError] = useState<string | null>(null);

  const open = (c: ChargingSession | "new") => {
    setEditing(c);
    if (c === "new") {
      setDraft({ ...emptyDraft, pricePerKwh: settings.data?.price_per_kwh ?? "" });
    } else {
      setDraft(draftFrom(c));
    }
    setSaveError(null);
  };

  const save = async () => {
    try {
      const payload = toPayload(draft);
      if (!payload.startTs) throw new Error("Start time is required");
      if (editing === "new") await api.createCharge(payload);
      else if (editing) await api.updateCharge(editing.id, payload);
      setEditing(null);
      await page.reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (c: ChargingSession) => {
    if (!window.confirm(`Delete charge from ${fmtDate(c.startTs)}?`)) return;
    await api.deleteCharge(c.id);
    await page.reload();
  };

  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;
  const summary = page.data?.summary;

  return (
    <div className="reveal">
      <div className="row spread">
        <div>
          <h1 className="page-title">Charging</h1>
          <p className="page-sub">
            {summary
              ? `${summary.count} sessions · ${fmtKwh(summary.totalEnergyKwh)} kWh · ${fmtMoney(summary.totalCost, currency)}`
              : "…"}
          </p>
        </div>
        <button className="btn" onClick={() => open("new")}>+ Add charge</button>
      </div>

      {page.error && <div className="error-banner">{page.error}</div>}

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Start</th><th>SOC</th><th>Energy</th><th>Cost</th>
                <th>Type</th><th>Location</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id}>
                  <td>{fmtDate(c.startTs)}</td>
                  <td className="num muted">{c.startSoc ?? "—"}→{c.endSoc ?? "—"}%</td>
                  <td className="num">{fmtKwh(c.energyKwh)} kWh</td>
                  <td className="num">{fmtMoney(c.cost, currency)}</td>
                  <td>{c.chargerType ? <span className="badge">{TYPE_LABEL[c.chargerType]}</span> : "—"}</td>
                  <td className="muted">{c.location ?? ""}</td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <button className="btn ghost sm" onClick={() => open(c)}>Edit</button>
                      <button className="btn danger sm" onClick={() => void remove(c)}>Del</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && !page.loading && <div className="empty">No charging sessions yet</div>}
        </div>

        {total > PAGE && (
          <div className="row mt">
            <button className="btn ghost sm" disabled={offset === 0}
              onClick={() => { setOffset(Math.max(0, offset - PAGE)); setTimeout(() => void page.reload(), 0); }}>
              ← Newer
            </button>
            <span className="muted">{offset + 1}–{Math.min(offset + PAGE, total)} of {total}</span>
            <button className="btn ghost sm" disabled={offset + PAGE >= total}
              onClick={() => { setOffset(offset + PAGE); setTimeout(() => void page.reload(), 0); }}>
              Older →
            </button>
          </div>
        )}
      </div>

      {editing !== null && (
        <Modal title={editing === "new" ? "Add charge" : "Edit charge"} onClose={() => setEditing(null)}>
          {saveError && <div className="error-banner">{saveError}</div>}
          <div className="form-row">
            <label className="field"><span>Start (local time)</span>
              <input type="datetime-local" value={draft.startTs}
                onChange={(e) => setDraft({ ...draft, startTs: e.target.value })} />
            </label>
            <label className="field"><span>End (local time)</span>
              <input type="datetime-local" value={draft.endTs}
                onChange={(e) => setDraft({ ...draft, endTs: e.target.value })} />
            </label>
          </div>
          <div className="form-row">
            <label className="field"><span>Start SOC %</span>
              <input type="number" min={0} max={100} value={draft.startSoc}
                onChange={(e) => setDraft({ ...draft, startSoc: e.target.value })} />
            </label>
            <label className="field"><span>End SOC %</span>
              <input type="number" min={0} max={100} value={draft.endSoc}
                onChange={(e) => setDraft({ ...draft, endSoc: e.target.value })} />
            </label>
          </div>
          <div className="form-row">
            <label className="field"><span>Energy (kWh)</span>
              <input type="number" step="0.01" value={draft.energyKwh}
                onChange={(e) => setDraft({ ...draft, energyKwh: e.target.value })} />
            </label>
            <label className="field"><span>Max power (kW)</span>
              <input type="number" step="0.1" value={draft.maxPowerKw}
                onChange={(e) => setDraft({ ...draft, maxPowerKw: e.target.value })} />
            </label>
          </div>
          <div className="form-row">
            <label className="field"><span>Price per kWh</span>
              <input type="number" step="0.001" value={draft.pricePerKwh}
                onChange={(e) => setDraft({ ...draft, pricePerKwh: e.target.value })} />
            </label>
            <label className="field"><span>Cost</span>
              <input type="number" step="0.01" value={draft.cost}
                onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
            </label>
          </div>
          <div className="form-row">
            <label className="field"><span>Charger type</span>
              <select value={draft.chargerType}
                onChange={(e) => setDraft({ ...draft, chargerType: e.target.value as Draft["chargerType"] })}>
                <option value="">Unknown</option>
                <option value="home">Home</option>
                <option value="ac">AC</option>
                <option value="dc">DC</option>
              </select>
            </label>
            <label className="field"><span>Location</span>
              <input value={draft.location}
                onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
            </label>
          </div>
          <label className="field"><span>Notes</span>
            <textarea rows={2} value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </label>
          <p className="faint" style={{ fontSize: 13 }}>
            Energy is computed from SOC delta when blank; cost from energy × price.
          </p>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn" onClick={() => void save()}>Save</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
