import { Modal, Platform, StyleSheet, Text, TouchableOpacity, View, ActivityIndicator } from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as FileSystem from "expo-file-system/legacy";
import { colors } from "../../lib/theme";

// Shows a PDF the app has in hand (the job report preview) without a native
// PDF module: react-native-webview is already in the binary (the signature
// pad uses it).
//  - iOS: WKWebView renders a local PDF file itself.
//  - Android: WebView cannot render PDFs, so the pages are drawn by pdf.js
//    (from cdnjs, like the rest of the preview it needs signal anyway) from
//    the base64 the app already holds.

const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174";

/** The Android viewer page: every page of the PDF drawn to the phone's width. */
export function pdfViewerHtml(base64: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=4">
<style>body{margin:0;background:#e2e8f0;font-family:sans-serif}canvas{display:block;width:100%;margin:0 0 8px;background:#fff}
#msg{padding:24px;color:#475569;text-align:center}</style></head><body><div id="msg">Loading the report…</div>
<script src="${PDFJS}/pdf.min.js"></script><script>
(function(){
  var msg=document.getElementById('msg');
  if(!window.pdfjsLib){msg.textContent='The viewer could not load. Check your connection.';return;}
  pdfjsLib.GlobalWorkerOptions.workerSrc='${PDFJS}/pdf.worker.min.js';
  var raw=atob(${JSON.stringify(base64)});var bytes=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  pdfjsLib.getDocument({data:bytes}).promise.then(function(pdf){
    msg.remove();var chain=Promise.resolve();
    for(var n=1;n<=pdf.numPages;n++)(function(n){chain=chain.then(function(){return pdf.getPage(n).then(function(page){
      var scale=(window.innerWidth*2)/page.getViewport({scale:1}).width;var vp=page.getViewport({scale:scale});
      var c=document.createElement('canvas');c.width=vp.width;c.height=vp.height;document.body.appendChild(c);
      return page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;});});})(n);
  }).catch(function(){msg.textContent='The report could not be shown.';});
})();
</script></body></html>`;
}

export function PdfPreview({
  visible,
  title,
  fileUri,
  base64,
  onClose,
}: {
  visible: boolean;
  title: string;
  /** The PDF saved in the app cache (iOS shows it directly). */
  fileUri: string | null;
  /** The same PDF as base64 (Android draws it with pdf.js). */
  base64: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const ready = Platform.OS === "ios" ? !!fileUri : !!base64;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <TouchableOpacity onPress={onClose} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.close}>Close</Text>
        </TouchableOpacity>
      </View>
      {!ready ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.blue600} />
        </View>
      ) : Platform.OS === "ios" ? (
        <WebView
          source={{ uri: fileUri! }}
          originWhitelist={["*"]}
          allowFileAccess
          allowingReadAccessToURL={FileSystem.cacheDirectory ?? undefined}
          style={styles.web}
        />
      ) : (
        <WebView
          source={{ html: pdfViewerHtml(base64!), baseUrl: "https://localhost/" }}
          originWhitelist={["*"]}
          javaScriptEnabled
          style={styles.web}
        />
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: { flex: 1, fontSize: 16, fontWeight: "800", color: colors.slate900 },
  close: { fontSize: 16, fontWeight: "700", color: colors.blue600 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  web: { flex: 1, backgroundColor: colors.bg },
});
