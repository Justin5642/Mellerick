import { View, Text } from "react-native";
import { getStatusClassName, type StatusDomain } from "../tokens/status";

// Humanize a status value ("in_progress" -> "In Progress") to match the web's
// capitalize + underscore-to-space treatment.
function label(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface StatusPillProps {
  domain: StatusDomain;
  value: string;
  /** Override the displayed text; defaults to the humanized value. */
  children?: string;
}

// The single brand element for status/priority/role/etc. Reads its colors from
// the ported token map (design/tokens/status.ts), never inline — so a color
// tweak happens in one place and the web↔mobile parity guard can enforce it.
export function StatusPill({ domain, value, children }: StatusPillProps) {
  const className = getStatusClassName(domain, value);
  return (
    <View className={`self-start rounded-full px-2 py-0.5 ${className}`}>
      <Text className={`text-xs font-medium ${className}`}>{children ?? label(value)}</Text>
    </View>
  );
}
