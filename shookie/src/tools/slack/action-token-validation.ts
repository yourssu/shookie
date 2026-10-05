/** Keep the existing trusted-event token acceptance rule shared with diagnostics. */
export function isUsableSlackActionToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\u0000-\u0020]/.test(value);
}
