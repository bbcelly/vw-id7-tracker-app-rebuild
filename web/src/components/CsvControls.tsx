import { useRef, useState } from "react";
import { api, type CsvEntity, type ImportResult } from "../api";

/**
 * Export / Import CSV controls for one entity. Export is a plain download link;
 * import reads the picked file as text, POSTs it, and shows a per-row summary.
 */
export default function CsvControls({
  entity,
  onImported,
}: {
  entity: CsvEntity;
  onImported?: () => void | Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.importCsv(entity, await file.text());
      setResult(res);
      await onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <a className="btn ghost sm" href={api.exportUrl(entity)} download>
        ↓ Export CSV
      </a>
      <button className="btn ghost sm" disabled={busy} onClick={() => fileRef.current?.click()}>
        {busy ? "Importing…" : "↑ Import CSV"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={(e) => void pick(e)}
      />
      {result && (
        <span className="muted" style={{ fontSize: 13 }}>
          {result.inserted} added, {result.updated} updated
          {result.failed > 0 && (
            <span style={{ color: "var(--danger, #d33)" }}>
              , {result.failed} failed
              {result.errors[0] && ` (row ${result.errors[0].row}: ${result.errors[0].message})`}
            </span>
          )}
        </span>
      )}
      {error && <span style={{ color: "var(--danger, #d33)", fontSize: 13 }}>{error}</span>}
    </div>
  );
}
