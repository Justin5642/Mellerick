import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ImageBackground,
  FlatList,
  Alert,
  ActionSheetIOS,
  Platform,
  Modal,
  ActivityIndicator,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { Ionicons } from "@expo/vector-icons";
import ViewShot from "react-native-view-shot";
import * as FileSystem from "expo-file-system/legacy";
import { decode } from "base64-arraybuffer";
import { supabase } from "../../lib/supabase";
import { colors, photoTagColors } from "../../lib/theme";

interface Photo {
  id: string;
  storage_path: string;
  photo_type: string;
  created_at: string;
}

interface PendingPhoto {
  uri: string;
  capturedAt: Date;
  coords: { lat: number; lng: number } | null;
}

const PHOTO_TYPES = ["before", "after", "general"] as const;
const COMPANY_NAME = "Mellerick Pty Ltd";

async function getLocationBestEffort(): Promise<{ lat: number; lng: number } | null> {
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    const pos = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    if (!pos) return null;
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch {
    return null;
  }
}

export function JobPhotosTab({
  jobId,
  currentUserId,
  jobNumber,
  siteLabel,
}: {
  jobId: string;
  currentUserId: string;
  jobNumber?: number;
  siteLabel?: string | null;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [photoType, setPhotoType] = useState<(typeof PHOTO_TYPES)[number]>("general");
  const [pending, setPending] = useState<PendingPhoto | null>(null);
  const [pendingType, setPendingType] = useState<(typeof PHOTO_TYPES)[number]>("general");
  const [saving, setSaving] = useState(false);
  const [viewingPhoto, setViewingPhoto] = useState<Photo | null>(null);
  const shotRef = useRef<ViewShot>(null);

  const loadPhotos = useCallback(async () => {
    const { data } = await supabase
      .from("job_photos")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false });
    setPhotos((data as any) ?? []);
    for (const p of (data as any) ?? []) {
      supabase.storage
        .from("job-photos")
        .createSignedUrl(p.storage_path, 3600)
        .then(({ data: signed }) => {
          if (signed?.signedUrl) setUrls((prev) => ({ ...prev, [p.storage_path]: signed.signedUrl }));
        });
    }
  }, [jobId]);

  useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  function chooseType() {
    return new Promise<(typeof PHOTO_TYPES)[number] | null>((resolve) => {
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          { options: ["Cancel", "Before", "After", "General"], cancelButtonIndex: 0 },
          (index) => {
            if (index === 0) resolve(null);
            else resolve(PHOTO_TYPES[index - 1]);
          }
        );
      } else {
        resolve(photoType);
      }
    });
  }

  async function uploadAsset(base64: string, type: string) {
    const path = `${jobId}/${Date.now()}_${Math.round(Math.random() * 1e6)}.jpg`;
    const { error: uploadError } = await supabase.storage.from("job-photos").upload(path, decode(base64), {
      contentType: "image/jpeg",
    });
    if (uploadError) {
      Alert.alert("Upload failed", uploadError.message);
      return;
    }
    await supabase.from("job_photos").insert({
      job_id: jobId,
      uploaded_by: currentUserId,
      storage_path: path,
      photo_type: type,
    });
  }

  // Camera captures go through a timestamp preview: date/time, the job's
  // street address, and (best-effort) GPS are burned into the image before
  // it's uploaded, so the evidence travels with the photo itself, not just
  // as DB metadata.
  async function handleCameraCapture() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Camera access is required");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7 });
    if (result.canceled || !result.assets?.length) return;

    const capturedAt = new Date();
    setLocating(true);
    const coords = await getLocationBestEffort();
    setLocating(false);

    setPendingType(photoType);
    setPending({ uri: result.assets[0].uri, capturedAt, coords });
  }

  async function handleGalleryPick() {
    const type = (await chooseType()) ?? photoType;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Photo library access is required");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.6, base64: true, allowsMultipleSelection: true });
    if (result.canceled || !result.assets?.length) return;

    setUploading(true);
    for (const asset of result.assets) {
      if (asset.base64) {
        await uploadAsset(asset.base64, type);
      }
    }
    await loadPhotos();
    setUploading(false);
  }

  async function confirmPending() {
    if (!pending) return;
    setSaving(true);
    try {
      const capturedUri = await shotRef.current?.capture?.();
      if (!capturedUri) throw new Error("Could not stamp photo");
      const base64 = await FileSystem.readAsStringAsync(capturedUri, { encoding: FileSystem.EncodingType.Base64 });
      await uploadAsset(base64, pendingType);
      setPending(null);
      await loadPhotos();
    } catch (e: any) {
      Alert.alert("Upload failed", e?.message ?? "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(photo: Photo) {
    await supabase.storage.from("job-photos").remove([photo.storage_path]);
    await supabase.from("job_photos").delete().eq("id", photo.id);
    setPhotos((prev) => prev.filter((p) => p.id !== photo.id));
    setViewingPhoto((v) => (v?.id === photo.id ? null : v));
  }

  function confirmDelete(photo: Photo) {
    Alert.alert("Delete photo", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => handleDelete(photo) },
    ]);
  }

  function formatTimestamp(d: Date) {
    return d.toLocaleString("en-AU", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  const jobRefLine = [jobNumber ? `Job #${jobNumber}` : null, siteLabel].filter(Boolean).join(" — ");

  return (
    <View style={styles.container}>
      {Platform.OS !== "ios" && (
        <View style={styles.typeRow}>
          {PHOTO_TYPES.map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.typeChip, photoType === t && styles.typeChipActive]}
              onPress={() => setPhotoType(t)}
            >
              <Text style={[styles.typeChipText, photoType === t && styles.typeChipTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.actionRow}>
        <TouchableOpacity style={styles.actionButton} onPress={handleCameraCapture} disabled={uploading || locating}>
          <Text style={styles.actionButtonText}>{locating ? "Locating..." : "📷 Timestamp Camera"}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionButton} onPress={handleGalleryPick} disabled={uploading || locating}>
          <Text style={styles.actionButtonText}>{uploading ? "Uploading..." : "🖼️ Gallery"}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={photos}
        keyExtractor={(p) => p.id}
        numColumns={3}
        scrollEnabled={false}
        columnWrapperStyle={{ gap: 8 }}
        contentContainerStyle={{ gap: 8, marginTop: 12 }}
        ListEmptyComponent={<Text style={styles.emptyText}>No photos yet</Text>}
        renderItem={({ item }) => {
          const tag = photoTagColors[item.photo_type] ?? photoTagColors.general;
          return (
            <TouchableOpacity
              style={styles.photoCell}
              onPress={() => setViewingPhoto(item)}
              onLongPress={() => confirmDelete(item)}
            >
              {urls[item.storage_path] ? (
                <Image source={{ uri: urls[item.storage_path] }} style={styles.photoImage} />
              ) : (
                <View style={[styles.photoImage, styles.photoLoading]} />
              )}
              <View style={[styles.photoTag, { backgroundColor: tag.bg }]}>
                <Text style={[styles.photoTagText, { color: tag.text }]}>{item.photo_type}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />

      <Modal visible={!!pending} animationType="slide" onRequestClose={() => !saving && setPending(null)}>
        <View style={styles.previewScreen}>
          {pending && (
            <ViewShot ref={shotRef} options={{ format: "jpg", quality: 0.85 }} style={styles.shotWrap}>
              {/* Overlays are children of ImageBackground (not siblings layered
                  over a native <Image>) so react-native-view-shot flattens them
                  into the same node it snapshots. On the New Architecture
                  (default in Expo SDK 54) absolutely-positioned siblings over an
                  <Image> get dropped from the capture; collapsable={false} keeps
                  Fabric from folding the overlay views out of the tree. */}
              <ImageBackground
                source={{ uri: pending.uri }}
                style={styles.previewImage}
                resizeMode="cover"
                collapsable={false}
              >
                <View style={styles.watermarkTag} collapsable={false}>
                  <Text style={styles.watermarkTagText}>{COMPANY_NAME}</Text>
                </View>
                <View style={styles.stampBar} collapsable={false}>
                  <Text style={styles.stampTime}>{formatTimestamp(pending.capturedAt)}</Text>
                  {!!jobRefLine && <Text style={styles.stampMeta}>{jobRefLine}</Text>}
                  {pending.coords && (
                    <Text style={styles.stampMeta}>
                      {pending.coords.lat.toFixed(5)}, {pending.coords.lng.toFixed(5)}
                    </Text>
                  )}
                </View>
              </ImageBackground>
            </ViewShot>
          )}

          <View style={styles.previewControls}>
            <View style={styles.typeRow}>
              {PHOTO_TYPES.map((t) => (
                <TouchableOpacity
                  key={t}
                  style={[styles.typeChip, pendingType === t && styles.typeChipActive]}
                  onPress={() => setPendingType(t)}
                >
                  <Text style={[styles.typeChipText, pendingType === t && styles.typeChipTextActive]}>{t}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.previewButtonRow}>
              <TouchableOpacity
                style={[styles.previewButton, styles.retakeButton]}
                onPress={() => setPending(null)}
                disabled={saving}
              >
                <Text style={styles.retakeButtonText}>Retake</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.previewButton, styles.useButton]}
                onPress={confirmPending}
                disabled={saving}
              >
                {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.useButtonText}>Use Photo</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!viewingPhoto}
        animationType="fade"
        transparent
        onRequestClose={() => setViewingPhoto(null)}
      >
        <View style={styles.viewerScreen}>
          {viewingPhoto && (
            <>
              <TouchableOpacity style={styles.viewerBackdrop} activeOpacity={1} onPress={() => setViewingPhoto(null)} />
              {urls[viewingPhoto.storage_path] ? (
                <Image
                  source={{ uri: urls[viewingPhoto.storage_path] }}
                  style={styles.viewerImage}
                  resizeMode="contain"
                />
              ) : (
                <ActivityIndicator color="#fff" style={styles.viewerImage} />
              )}
              <View style={styles.viewerTopBar}>
                <View style={[styles.photoTag, { backgroundColor: (photoTagColors[viewingPhoto.photo_type] ?? photoTagColors.general).bg }]}>
                  <Text style={[styles.photoTagText, { color: (photoTagColors[viewingPhoto.photo_type] ?? photoTagColors.general).text }]}>
                    {viewingPhoto.photo_type}
                  </Text>
                </View>
                <TouchableOpacity style={styles.viewerCloseButton} onPress={() => setViewingPhoto(null)}>
                  <Ionicons name="close" size={24} color="#fff" />
                </TouchableOpacity>
              </View>
              <View style={styles.viewerBottomBar}>
                <Text style={styles.viewerDate}>{new Date(viewingPhoto.created_at).toLocaleString("en-AU")}</Text>
                <TouchableOpacity style={styles.viewerDeleteButton} onPress={() => confirmDelete(viewingPhoto)}>
                  <Ionicons name="trash-outline" size={18} color="#fff" />
                  <Text style={styles.viewerDeleteText}>Delete</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  typeRow: { flexDirection: "row", gap: 8, marginBottom: 12 },
  typeChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  typeChipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  typeChipText: { fontSize: 12, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  typeChipTextActive: { color: "#fff" },
  actionRow: { flexDirection: "row", gap: 8 },
  actionButton: { flex: 1, backgroundColor: colors.blue100, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  actionButtonText: { color: colors.blue600, fontWeight: "600", fontSize: 13 },
  photoCell: { flex: 1 / 3, aspectRatio: 1, borderRadius: 8, overflow: "hidden", backgroundColor: colors.slate100, position: "relative" },
  photoImage: { width: "100%", height: "100%" },
  photoLoading: { backgroundColor: colors.slate100 },
  photoTag: { position: "absolute", top: 4, left: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  photoTagText: { fontSize: 9, fontWeight: "700", textTransform: "capitalize" },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },

  previewScreen: { flex: 1, backgroundColor: colors.black },
  shotWrap: { flex: 1, position: "relative" },
  previewImage: { width: "100%", height: "100%" },
  watermarkTag: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  watermarkTagText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  stampBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  stampTime: { color: "#fff", fontSize: 16, fontWeight: "700" },
  stampMeta: { color: "#e2e8f0", fontSize: 12, marginTop: 2 },
  previewControls: { backgroundColor: colors.slate900, padding: 16, paddingBottom: 28, gap: 12 },
  previewButtonRow: { flexDirection: "row", gap: 12 },
  previewButton: { flex: 1, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  retakeButton: { backgroundColor: "rgba(255,255,255,0.1)" },
  retakeButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  useButton: { backgroundColor: colors.blue600 },
  useButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },

  viewerScreen: { flex: 1, backgroundColor: "rgba(0,0,0,0.92)", alignItems: "center", justifyContent: "center" },
  viewerBackdrop: { ...StyleSheet.absoluteFillObject },
  viewerImage: { width: "100%", height: "80%" },
  viewerTopBar: {
    position: "absolute",
    top: 50,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  viewerCloseButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  viewerBottomBar: {
    position: "absolute",
    bottom: 40,
    left: 16,
    right: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  viewerDate: { color: "#e2e8f0", fontSize: 13 },
  viewerDeleteButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(220,38,38,0.85)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  viewerDeleteText: { color: "#fff", fontWeight: "600", fontSize: 13 },
});
