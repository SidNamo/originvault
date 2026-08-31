export function formatBytes(value: string | number | bigint): string {
  const bytes = typeof value === "bigint" ? value : BigInt(String(value || 0));
  if (bytes <= 0n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unit = 0;
  let divisor = 1n;
  while (unit < units.length - 1 && bytes >= divisor * 1024n) {
    divisor *= 1024n;
    unit += 1;
  }
  if (unit === 0) return `${bytes} B`;
  const tenths = (bytes * 10n) / divisor;
  return `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
}

export function gigabytesToBytes(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(normalized))
    throw new Error("할당량은 GB 단위 숫자로 입력하세요.");
  const [whole, fraction = ""] = normalized.split(".");
  const thousandths = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0"));
  return ((thousandths * 1024n * 1024n * 1024n) / 1000n).toString();
}

export function bytesToGigabytes(value: string | null): string {
  if (value === null) return "";
  const thousandths = (BigInt(value) * 1000n) / (1024n * 1024n * 1024n);
  return `${thousandths / 1000n}.${String(thousandths % 1000n).padStart(3, "0")}`.replace(
    /\.?0+$/,
    "",
  );
}
