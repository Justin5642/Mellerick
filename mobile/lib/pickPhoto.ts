import { Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";

// One photo from the camera or the photo library, for the office's uploads on
// the phone (a supplier invoice on the PO tab, a job document). Null when
// cancelled or not allowed. The binary has no document (PDF) picker, so these
// are photos only; resize with lib/imageUpload.ts prepareImage before sending.
export async function pickPhoto(source: "camera" | "library"): Promise<string | null> {
  const perm = source === "camera" ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    Alert.alert(
      source === "camera" ? "Camera needed" : "Photos needed",
      `Allow ${source === "camera" ? "camera" : "photo library"} access in Settings to attach it.`
    );
    return null;
  }
  const res = source === "camera" ? await ImagePicker.launchCameraAsync({ quality: 1 }) : await ImagePicker.launchImageLibraryAsync({ quality: 1 });
  if (res.canceled || !res.assets?.length) return null;
  return res.assets[0].uri;
}
