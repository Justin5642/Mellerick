import { Text } from "react-native";
import { useIsOfficeOrAdmin } from "../guards/useRole";

const AUD = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

export function formatMoney(amount: number | null | undefined): string {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  return AUD.format(Number(amount));
}

export interface MoneyTextProps {
  amount: number | null | undefined;
  className?: string;
  /** Placeholder shown to technicians (who must never see dollar figures). */
  redacted?: string;
}

// Role-aware money renderer. This is the single structural enforcement of the
// "technicians never see dollars" rule — office/admin see the formatted amount,
// technicians always see the redaction placeholder, regardless of the value
// passed. Use this everywhere a dollar figure would render.
export function MoneyText({ amount, className, redacted = "—" }: MoneyTextProps) {
  const canSeeMoney = useIsOfficeOrAdmin();
  return <Text className={className}>{canSeeMoney ? formatMoney(amount) : redacted}</Text>;
}
