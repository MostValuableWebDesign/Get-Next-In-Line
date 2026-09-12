export function formatMoneyExact(cents: string | number | null | undefined, currency: string): string {
  if (cents == null || cents === "") return "—";
  const centsStr = String(cents);
  if (!/^-?\d+$/.test(centsStr)) return "—";

  const isNegative = centsStr.startsWith("-");
  const absStr = isNegative ? centsStr.slice(1) : centsStr;
  const paddedStr = absStr.padStart(3, "0");
  const dollarsStr = paddedStr.slice(0, -2);
  const fractionStr = paddedStr.slice(-2);

  const dollarsBigInt = isNegative && dollarsStr === "0" 
    ? -0 
    : BigInt(isNegative ? "-" + dollarsStr : dollarsStr);

  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const parts = formatter.formatToParts(dollarsBigInt as any);
  
  let result = "";
  for (const part of parts) {
    if (part.type === "fraction") {
      result += fractionStr;
    } else {
      result += part.value;
    }
  }
  return result;
}
