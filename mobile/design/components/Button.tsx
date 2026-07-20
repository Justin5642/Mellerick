import { Pressable, Text, ActivityIndicator, View } from "react-native";
import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const container: Record<ButtonVariant, string> = {
  primary: "bg-brand dark:bg-brand-dark",
  secondary: "bg-slate-100 dark:bg-slate-800",
  ghost: "bg-transparent",
  destructive: "bg-red-600 dark:bg-red-500",
};
const labelColor: Record<ButtonVariant, string> = {
  primary: "text-white",
  secondary: "text-slate-900 dark:text-slate-100",
  ghost: "text-brand dark:text-brand-dark",
  destructive: "text-white",
};
const sizing: Record<ButtonSize, string> = {
  sm: "h-9 px-3", // 36pt
  md: "h-11 px-4", // 44pt — min touch target
  lg: "h-12 px-5",
};

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
  accessibilityLabel?: string;
}

export function Button({
  title,
  onPress,
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  icon,
  accessibilityLabel,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  function handlePress() {
    Haptics.selectionAsync();
    onPress?.();
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={handlePress}
      className={`flex-row items-center justify-center gap-2 rounded-lg active:opacity-80 ${sizing[size]} ${container[variant]} ${isDisabled ? "opacity-50" : ""}`}
    >
      {loading ? (
        <ActivityIndicator size="small" color={variant === "secondary" || variant === "ghost" ? "#2563eb" : "#ffffff"} />
      ) : (
        <>
          {icon ? <View>{icon}</View> : null}
          <Text className={`text-sm font-semibold ${labelColor[variant]}`}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}
