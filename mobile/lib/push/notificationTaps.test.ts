jest.mock("expo-notifications", () => ({ useLastNotificationResponse: jest.fn() }));
jest.mock("expo-router", () => ({ useRouter: jest.fn() }));
jest.mock("../auth-context", () => ({ useAuth: jest.fn() }));

import { routeForNotification } from "./notificationTaps";

describe("routeForNotification", () => {
  it("opens the job a job_assigned push is about", () => {
    const jobId = "3f1c2a9e-1b2c-4d5e-8f90-1234567890ab";
    expect(routeForNotification({ type: "job_assigned", jobId })).toBe(`/job/${jobId}`);
  });

  it("ignores payloads it does not recognise", () => {
    expect(routeForNotification(undefined)).toBeNull();
    expect(routeForNotification({})).toBeNull();
    expect(routeForNotification({ jobId: 42 })).toBeNull();
  });

  it("refuses a jobId that is not a uuid, so a payload cannot steer the router elsewhere", () => {
    expect(routeForNotification({ jobId: "../settings" })).toBeNull();
  });
});
