import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { ScreenError, describeReadFailure } from "./ScreenError";

// The other half of the swallowed-error fix.
//
// Read modules now THROW instead of returning [] when a query fails. That is
// correct — an empty list was a lie — but it moves the problem to the screens:
// a screen that does `const data = await listMyJobs(id); setLoading(false)` now
// never reaches setLoading(false), and the technician sits on a spinner forever.
// That is WORSE than the wrong empty state, because it conveys nothing at all.
//
// So every screen needs one honest failure state, and it has to say the three
// things a person on a roof actually needs: something broke, it was not their
// fault, and here is the button that retries.

describe("describeReadFailure", () => {
  it("keeps the underlying message — it is the only diagnostic anyone gets", () => {
    const d = describeReadFailure(new Error('listMyJobs: permission denied for table jobs | code=42501'));
    expect(d.detail).toContain("listMyJobs");
    expect(d.detail).toContain("42501");
  });

  it("leads with plain language, not the Postgres string", () => {
    // The technician reads the headline; the detail is for whoever they call.
    const d = describeReadFailure(new Error("listMyJobs: permission denied"));
    expect(d.title).not.toContain("permission denied");
    expect(d.title.toLowerCase()).toContain("couldn't load");
  });

  it("names offline as offline, because that is the one cause the user can act on", () => {
    const d = describeReadFailure(new Error("Network request failed"));
    expect(d.title.toLowerCase()).toContain("offline");
    expect(d.isOffline).toBe(true);
  });

  it("treats a non-Error throw without crashing the error screen itself", () => {
    const d = describeReadFailure("something odd");
    expect(d.detail).toContain("something odd");
    expect(d.title).toBeTruthy();
  });

  it("never returns an empty detail — a blank error box is another silent failure", () => {
    expect(describeReadFailure(new Error("")).detail.length).toBeGreaterThan(0);
    expect(describeReadFailure(null).detail.length).toBeGreaterThan(0);
  });
});

describe("ScreenError", () => {
  it("shows the failure and calls onRetry", () => {
    const onRetry = jest.fn();
    const { getByText } = render(<ScreenError error={new Error("listMyJobs: boom")} onRetry={onRetry} />);
    fireEvent.press(getByText("Try again"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders without a retry handler — some screens have nothing to retry", () => {
    const { queryByText } = render(<ScreenError error={new Error("x")} />);
    expect(queryByText("Try again")).toBeNull();
  });

  it("surfaces the technical detail rather than hiding it", () => {
    // Hiding it is how the Staff screen stayed broken for the app's whole life.
    const { getByText } = render(<ScreenError error={new Error("listStaff: PGRST201 ambiguous embed")} />);
    expect(getByText(/PGRST201/)).toBeTruthy();
  });
});
