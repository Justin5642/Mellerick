import { useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Button } from "../design/components/Button";
import { colors } from "../lib/theme";
import type { ClockPrompt, PromptCandidate } from "../lib/dwellPrompt";

// The in-app half of the clock prompts (lib/dwellPrompt.ts). Shown by
// LocationTrackingProvider while the app is open — the notification is the
// other half, for a phone in a pocket. Asks; never decides. No money here,
// or anywhere in the prompts: job numbers, titles and times only.

export type ClockPromptAnswer =
  | { kind: "clock-on"; jobId: string }
  | { kind: "decline" }
  | { kind: "clock-off" }
  | { kind: "still-working" };

export function ClockPromptSheet({
  prompt,
  busy,
  onAnswer,
}: {
  prompt: ClockPrompt | null;
  busy: boolean;
  onAnswer: (answer: ClockPromptAnswer) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  if (!prompt) return null;
  const candidates: PromptCandidate[] = prompt.kind === "clock-on" ? prompt.candidates : [];
  const chosen = prompt.kind === "clock-on" ? (candidates.length === 1 ? candidates[0].jobId : picked) : null;
  const dismiss = () => onAnswer(prompt.kind === "clock-on" ? { kind: "decline" } : { kind: "still-working" });

  return (
    <Modal visible transparent animationType="slide" onRequestClose={dismiss}>
      <View className="flex-1 justify-end bg-black/40">
        <View className="bg-white dark:bg-slate-900 rounded-t-2xl px-6 pt-5 pb-8">
          <View className="flex-row items-center mb-3">
            <Ionicons name={prompt.kind === "clock-on" ? "location" : "time"} size={24} color={colors.blue600} />
            <Text accessibilityRole="header" className="ml-2 text-lg font-bold text-slate-900 dark:text-slate-100">
              {prompt.title}
            </Text>
          </View>
          <Text className="text-base leading-6 text-slate-700 dark:text-slate-300 mb-4">{prompt.body}</Text>

          {prompt.kind === "clock-on" && candidates.length > 1 ? (
            <ScrollView style={{ maxHeight: 240 }} className="mb-4">
              {candidates.map((c) => {
                const selected = picked === c.jobId;
                return (
                  <Pressable
                    key={c.jobId}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => setPicked(c.jobId)}
                    className={`flex-row items-center rounded-lg border px-3 py-3 mb-2 ${
                      selected ? "border-blue-600 bg-blue-50 dark:bg-blue-950" : "border-slate-200 dark:border-slate-700"
                    }`}
                  >
                    <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={colors.blue600} />
                    <View className="ml-3 flex-1">
                      <Text className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        {c.jobNumber != null ? `#${c.jobNumber} ` : ""}
                        {c.title}
                      </Text>
                      {c.place ? <Text className="text-sm text-slate-500 dark:text-slate-400">{c.place}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : null}

          <View className="gap-3">
            {prompt.kind === "clock-on" ? (
              <>
                <Button
                  title={candidates.length > 1 ? "Clock on to this job" : "Yes — clock on"}
                  size="lg"
                  loading={busy}
                  disabled={!chosen}
                  onPress={() => chosen && onAnswer({ kind: "clock-on", jobId: chosen })}
                />
                <Button title="No, I'm not on site" variant="ghost" disabled={busy} onPress={() => onAnswer({ kind: "decline" })} />
              </>
            ) : (
              <>
                <Button
                  title={prompt.kind === "left-site" ? "Yes — clock off" : "Clock off now"}
                  size="lg"
                  loading={busy}
                  onPress={() => onAnswer({ kind: "clock-off" })}
                />
                <Button title="Still working" variant="ghost" disabled={busy} onPress={() => onAnswer({ kind: "still-working" })} />
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}
