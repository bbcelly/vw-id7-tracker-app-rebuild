import { describe, it, expect } from "vitest";
import { serializeCsv, parseCsv } from "../../src/domain/csv.js";

describe("serializeCsv", () => {
  it("emits a header row then data rows, joined with CRLF", () => {
    const csv = serializeCsv(["a", "b"], [[1, 2], [3, 4]]);
    expect(csv).toBe("a,b\r\n1,2\r\n3,4");
  });

  it("renders null/undefined as empty cells and booleans as true/false", () => {
    expect(serializeCsv(["x", "y", "z"], [[null, undefined, true]])).toBe(
      "x,y,z\r\n,,true"
    );
    expect(serializeCsv(["b"], [[false]])).toBe("b\r\nfalse");
  });

  it("quotes and escapes cells containing commas, quotes, or newlines", () => {
    const csv = serializeCsv(
      ["note"],
      [['has, comma'], ['has "quote"'], ["has\nnewline"]]
    );
    expect(csv).toBe('note\r\n"has, comma"\r\n"has ""quote"""\r\n"has\nnewline"');
  });
});

describe("parseCsv", () => {
  it("parses a simple table", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("accepts LF-only line endings and ignores a single trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("parses quoted fields with embedded commas, quotes, and newlines", () => {
    const csv = 'note\r\n"has, comma"\r\n"has ""quote"""\r\n"line1\nline2"';
    expect(parseCsv(csv)).toEqual([
      ["note"],
      ["has, comma"],
      ['has "quote"'],
      ["line1\nline2"],
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("round-trips a realistic JSON raw blob", () => {
    const raw = JSON.stringify({ soc: 80, msg: 'he said "hi", ok', arr: [1, 2] });
    const csv = serializeCsv(["id", "raw"], [[1, raw]]);
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual(["id", "raw"]);
    expect(parsed[1][1]).toBe(raw);
    expect(JSON.parse(parsed[1][1])).toEqual({
      soc: 80,
      msg: 'he said "hi", ok',
      arr: [1, 2],
    });
  });
});
