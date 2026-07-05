// Minimal RFC 4180 CSV serialiser/parser. Hand-rolled to avoid a dependency:
// the only tricky data is the vehicle_status `raw` JSON blob, which is full of
// commas and quotes — standard RFC 4180 quoting handles it. Values are quoted
// only when they contain a delimiter, quote, or newline; embedded quotes are
// doubled. Rows are joined with CRLF (Excel-friendly); the parser accepts both
// LF and CRLF line endings.

type Cell = string | number | boolean | null | undefined;

function serializeCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "true" : "false") : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function serializeCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(serializeCell).join(",")];
  for (const row of rows) lines.push(row.map(serializeCell).join(","));
  return lines.join("\r\n");
}

/**
 * Parse CSV text into an array of string rows (header row included). Handles
 * quoted fields containing commas, newlines, and escaped ("") quotes. A single
 * trailing newline is ignored; blank lines otherwise become a one-empty-cell
 * row. Returns [] for empty input.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false; // did the current row have any content/field yet?

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    sawAny = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (c === ",") {
      endField();
      sawAny = true;
    } else if (c === "\r") {
      // swallow; the following \n (if any) closes the row
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") {
      endRow();
    } else {
      field += c;
      sawAny = true;
    }
  }

  // Flush the final field/row unless the input ended exactly on a line break.
  if (sawAny || field.length > 0 || row.length > 0) endRow();

  return rows;
}
