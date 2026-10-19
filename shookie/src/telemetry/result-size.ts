import { types } from "node:util";

export type SizeStatus = "exact" | "capped" | "unknown";
export type ResultSize = {
  totalResultBytes: number | null; totalResultBytesStatus: SizeStatus;
  dataJsonBytes: number | null; dataJsonBytesStatus: SizeStatus;
  textJsonBytes: number | null; textJsonBytesStatus: SizeStatus;
  contentJsonBytes: number | null; contentJsonBytesStatus: SizeStatus;
  partial: boolean | null; truncated: boolean | null;
  resultStatus: "success" | "error" | "partial" | "cancelled" | "unknown";
};
const CAP = 65_536;
/** Counts JSON UTF-8 bytes of one primitive string, including quotes/escaping.
 * No serialization, toJSON, getter, enumeration or large temporary buffer.
 */
function stringBytes(value: string): { bytes: number; status: SizeStatus } {
  let bytes = 2;
  for (let i = 0; i < value.length && bytes < CAP; i++) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else if (c >= 0xd800 && c <= 0xdfff) bytes += 6; // JSON escapes unpaired surrogates
    else bytes += 3;
  }
  return { bytes: Math.min(bytes, CAP), status: bytes >= CAP ? "capped" : "exact" };
}
/** Total object size remains unknown: even Object.keys can allocate without bound.
 * Only fixed own data-property string fields get separate measurements, never summed.
 */
export function resultSize(value: unknown): ResultSize {
  const result: ResultSize = {
    totalResultBytes: null, totalResultBytesStatus: "unknown",
    dataJsonBytes: null, dataJsonBytesStatus: "unknown",
    textJsonBytes: null, textJsonBytesStatus: "unknown",
    contentJsonBytes: null, contentJsonBytesStatus: "unknown",
    partial: null, truncated: null, resultStatus: "unknown",
  };
  if (value !== null && typeof value === "object") {
    try {
      if (types.isProxy(value) || Array.isArray(value)) return result;
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return result;
      for (const key of ["partial", "truncated", "status", "data", "text", "content"] as const) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) continue;
        const field = descriptor.value;
        if ((key === "partial" || key === "truncated") && typeof field === "boolean") result[key] = field;
        if (key === "status" && (field === "success" || field === "error" || field === "partial" || field === "cancelled")) result.resultStatus = field;
        if ((key === "data" || key === "text" || key === "content") && typeof field === "string") {
          const size = stringBytes(field);
          result[`${key}JsonBytes`] = size.bytes;
          result[`${key}JsonBytesStatus`] = size.status;
        }
      }
    } catch { /* reflection failures stay unknown; never propagate */ }
    return result;
  }
  if (typeof value === "string") {
    const size = stringBytes(value); result.totalResultBytes = size.bytes; result.totalResultBytesStatus = size.status;
    return result;
  }
  let bytes: number;
  if (value === null) bytes = 4;
  else if (typeof value === "boolean") bytes = value ? 4 : 5;
  else if (typeof value === "number") bytes = Number.isFinite(value) ? String(value).length : 4;
  else return result;
  result.totalResultBytes = bytes; result.totalResultBytesStatus = "exact";
  return result;
}
