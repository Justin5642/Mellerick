import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useAuth } from "../lib/auth-context";
import { supabase } from "../lib/supabase";
import { colors } from "../lib/theme";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);

  async function handleLogin() {
    if (!email || !password) {
      setError("Enter your email and password");
      return;
    }
    setError(null);
    setLoading(true);
    const { error } = await signIn(email.trim(), password);
    setLoading(false);
    if (error) setError(error);
  }

  // The reset link opens the office web app's /update-password page — the
  // mobile app has no screen of its own to complete this on, since Supabase's
  // recovery flow needs a browser to land the link in.
  async function handleForgotPassword() {
    if (!email) {
      setError("Enter your email above first, then tap Forgot password");
      return;
    }
    setError(null);
    setResetLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${API_BASE_URL}/update-password`,
    });
    setResetLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    Alert.alert(
      "Check your email",
      "We've sent a password reset link. Open it on a computer or phone browser to set a new password, then come back and sign in here."
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.content}>
        <Image source={require("../assets/logo.png")} style={styles.logoImage} resizeMode="contain" />
        <Text style={styles.title}>Mellerick Field</Text>
        <Text style={styles.subtitle}>Sign in to view your jobs</Text>

        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <Text style={styles.label}>Email</Text>
        <TextInput
          testID="login-email"
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          testID="login-password"
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          secureTextEntry
          autoCapitalize="none"
        />

        <TouchableOpacity testID="login-submit" style={styles.button} onPress={handleLogin} disabled={loading}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
        </TouchableOpacity>

        <TouchableOpacity style={styles.forgotLink} onPress={handleForgotPassword} disabled={resetLoading}>
          <Text style={styles.forgotLinkText}>{resetLoading ? "Sending…" : "Forgot password?"}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, justifyContent: "center", paddingHorizontal: 28 },
  logoImage: {
    width: 180,
    height: 90,
    alignSelf: "center",
    marginBottom: 16,
  },
  title: { fontSize: 24, fontWeight: "700", color: colors.slate900, textAlign: "center" },
  subtitle: { fontSize: 14, color: colors.slate500, textAlign: "center", marginTop: 4, marginBottom: 28 },
  label: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginBottom: 6, marginTop: 12 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    backgroundColor: colors.card,
    color: colors.slate900,
  },
  button: {
    backgroundColor: colors.blue600,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 24,
  },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  forgotLink: { marginTop: 16, alignItems: "center" },
  forgotLinkText: { color: colors.blue600, fontSize: 13, fontWeight: "600" },
  errorBox: {
    backgroundColor: colors.red100,
    borderRadius: 8,
    padding: 10,
    marginBottom: 8,
  },
  errorText: { color: colors.red600, fontSize: 13 },
});
