import NetInfo from "@react-native-community/netinfo";

// Connectivity seam. The processor asks `isOnline()` before draining and
// subscribes to reconnections to kick a drain. Tests provide a fake.
export interface Connectivity {
  isOnline(): Promise<boolean>;
  // Subscribe to online transitions; returns an unsubscribe fn.
  onOnline(cb: () => void): () => void;
}

export const netInfoConnectivity: Connectivity = {
  async isOnline() {
    const state = await NetInfo.fetch();
    return state.isConnected === true && state.isInternetReachable !== false;
  },
  onOnline(cb) {
    let wasOnline = false;
    return NetInfo.addEventListener((state) => {
      const online = state.isConnected === true && state.isInternetReachable !== false;
      if (online && !wasOnline) cb();
      wasOnline = online;
    });
  },
};
