import { useState } from "react";
import { api, type Trip } from "../api";
import { useApi } from "../hooks";
import Modal from "../components/Modal";
import MapView from "../components/MapView";
import { fmtDate, fmtDuration, fmtKm, fmtKwh, isoToLocalInput, localInputToIso } from "../format";

const PAGE = 50;

type Draft = {
  startTs: string;
  endTs: string;
  startOdometer: string;
  endOdometer: string;
  startSoc: string;
  endSoc: string;
  notes: string;
};

const emptyDraft: Draft = {
  startTs: "",
  endTs: "",
  startOdometer: "",
  endOdometer: "",
  startSoc: "",
  endSoc: "",
  notes: "",
};

function draftFrom(t: Trip): Draft {
  return {
    startTs: isoToLocalInput(t.startTs),
    endTs: isoToLocalInput(t.endTs),
    startOdometer: t.startOdometer?.toString() ?? "",
    endOdometer: t.endOdometer?.toString() ?? "",
    startSoc: t.startSoc?.toString() ?? "",
    endSoc: t.endSoc?.toString() ?? "",
    notes: t.notes ?? "",
  };
}

function toPayload(d: Draft): Partial<Trip> {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  return {
    startTs: localInputToIso(d.startTs) ?? undefined,
    endTs: localInputToIso(d.endTs),
    startOdometer: num(d.startOdometer),
    endOdometer: num(d.endOdometer),
    startSoc: num(d.startSoc),
    endSoc: num(d.endSoc),
    notes: d.notes.trim() === "" ? null : d.notes,
  };
}

export default function Trips() {
  const [offset, setOffset] = useState(0);
  const page = useApi(() => api.trips(PAGE, offset));
  const [editing, setEditing] = useState<Trip | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [mapTrip, setMapTrip] = useState<number | null>(null);
  const positions = useApi(
    () => (mapTrip ? api.tripPositions(mapTrip) : Promise.resolve([])),
  );

  const open = (t: Trip | "new") => {
    setEditing(t);
    setDraft(t === "new" ? emptyDraft : draftFrom(t));
    setSaveError(null);
  };

  const save = async () => {
    try {
      const payload = toPayload(draft);
      if (!payload.startTs) throw new Error("Start time is required");
      if (editing === "new") await api.createTrip(payload);
      else if (editing) await api.updateTrip(editing.id, payload);
      setEditing(null);
      await page.reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (t: Trip) => {
    if (!window.confirm(`Delete trip from ${fmtDate(t.startTs)}?`)) return;
    await api.deleteTrip(t.id);
    await page.reload();
  };

  const showMap = async (id: number) => {
    setMapTrip(id === mapTrip ? null : id);
    setTimeout(() => void positions.reload(), 0);
  };

  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;

  return (
    <div className="reveal">
      <div className="row spread">
        <div>
          <h1 className="page-title">Trips</h1>
          <p className="page-sub">{total} recorded — newest first.</p>
        </div>
        <button className="btn" onClick={() => open("new")}>+ Add trip</button>
      </div>

      {page.error && <div className="error-banner">{page.error}</div>}

      <div className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Start</th><th>Duration</th><th>Distance</th><th>Energy</th>
                <th>Consumption</th><th>SOC</th><th>Notes</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.startTs)}</td>
                  <td className="num">{fmtDuration(t.durationMin)}</td>
                  <td className="num">{fmtKm(t.distanceKm)} km</td>
                  <td className="num">{fmtKwh(t.energyKwh)} kWh</td>
                  <td className="num">{fmtKwh(t.consumption)}</td>
                  <td className="num muted">
                    {t.startSoc ?? "—"}→{t.endSoc ?? "—"}%
                  </td>
                  <td className="muted" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {t.notes ?? ""}
                  </td>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <button className="btn ghost sm" onClick={() => void showMap(t.id)}>Map</button>
                      <button className="btn ghost sm" onClick={() => open(t)}>Edit</button>
                      <button className="btn danger sm" onClick={() => void remove(t)}>Del</button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length === 0 && !page.loading && <div className="empty">No trips recorded yet</div>}
        </div>

        {mapTrip !== null && (
          <div className="mt">
            {positions.data && positions.data.length > 0 ? (
              <MapView points={positions.data} />
            ) : (
              <div className="empty">No route positions stored for this trip</div>
            )}
          </div>
        )}

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
        <Modal title={editing === "new" ? "Add trip" : "Edit trip"} onClose={() => setEditing(null)}>
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
            <label className="field"><span>Start odometer (km)</span>
              <input type="number" step="0.1" value={draft.startOdometer}
                onChange={(e) => setDraft({ ...draft, startOdometer: e.target.value })} />
            </label>
            <label className="field"><span>End odometer (km)</span>
              <input type="number" step="0.1" value={draft.endOdometer}
                onChange={(e) => setDraft({ ...draft, endOdometer: e.target.value })} />
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
          <label className="field"><span>Notes</span>
            <textarea rows={2} value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </label>
          <p className="faint" style={{ fontSize: 13 }}>
            Distance, energy and consumption are computed from odometer/SOC when left blank.
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
