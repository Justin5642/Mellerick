import { render, fireEvent, screen } from "@testing-library/react-native";
import { SyncStatusPillView } from "./SyncStatusPillView";

describe("SyncStatusPillView", () => {
  it("renders nothing when fully synced", () => {
    render(<SyncStatusPillView pending={0} failed={0} onRetry={() => {}} />);
    expect(screen.queryByTestId("sync-status-pending")).toBeNull();
    expect(screen.queryByTestId("sync-status-failed")).toBeNull();
  });

  it("shows a non-actionable syncing pill while writes are pending", () => {
    render(<SyncStatusPillView pending={3} failed={0} onRetry={() => {}} />);
    expect(screen.getByTestId("sync-status-pending")).toBeTruthy();
    expect(screen.getByText("Syncing 3…")).toBeTruthy();
    expect(screen.queryByTestId("sync-status-failed")).toBeNull();
  });

  it("shows a tappable retry pill when writes have terminally failed, and calls onRetry", () => {
    const onRetry = jest.fn();
    render(<SyncStatusPillView pending={0} failed={2} onRetry={onRetry} />);
    const pill = screen.getByTestId("sync-status-failed");
    expect(screen.getByText("2 not synced · Retry")).toBeTruthy();
    fireEvent.press(pill);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("prioritizes the failed (needs-attention) state over pending", () => {
    render(<SyncStatusPillView pending={5} failed={1} onRetry={() => {}} />);
    expect(screen.getByTestId("sync-status-failed")).toBeTruthy();
    expect(screen.queryByTestId("sync-status-pending")).toBeNull();
  });
});
