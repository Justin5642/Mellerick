import { Text, type StyleProp, type TextStyle } from "react-native";
import { useIsOfficeOrAdmin } from "../guards/useRole";

const AUD = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });

export function formatMoney(amount: number | null | undefined): string {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  return AUD.format(Number(amount));
}

export interface MoneyTextProps {
  amount: number | null | undefined;
  className?: string;
  style?: StyleProp<TextStyle>;
  /** Placeholder shown to technicians (who must never see dollar figures). */
  redacted?: string;
}

// Role-aware money renderer. This is the single structural enforcement of the
// "technicians never see dollars" rule — office/admin see the formatted amount,
// technicians always see the redaction placeholder, regardless of the value
// passed. Use this everywhere a dollar figure would render. Accepts either a
// NativeWind className or a StyleSheet style.
export function MoneyText({ amount, className, style, redacted = "—" }: MoneyTextProps) {
  const canSeeMoney = useIsOfficeOrAdmin();
  return <Text className={className} style={style}>{canSeeMoney ? formatMoney(amount) : redacted}</Text>;
}
