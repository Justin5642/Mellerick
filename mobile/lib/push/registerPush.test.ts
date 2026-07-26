import { registerForPush } from "./registerPush";
import type { PushGateway, PermissionStatus } from "./gateway";

function fakeGateway(over: Partial<PushGateway> & { device?: boolean; status?: PermissionStatus } = {}): PushGateway & {
  requested: () => number;
} {
  let requestCount = 0;
  return {
    isDevice: () => over.device ?? true,
    getPermissionStatus: over.getPermissionStatus ?? (async () => over.status ?? "granted"),
    requestPermission:
      over.requestPermission ??
      (async () => {
        requestCount++;
        return over.status === "undetermined" ? "granted" : over.status ?? "granted";
      }),
    getExpoPushToken: over.getExpoPushToken ?? (async () => "ExponentPushToken[abc]"),
    requested: () => requestCount,
  };
}

describe("registerForPush", () => {
  it("returns no-device on a simulator (no token attempt)", async () => {
    const g = fakeGateway({ device: false });
    expect(await registerForPush(g, "proj")).toEqual({ status: "no-device", token: null });
  });

  it("requests permission only when undetermined, then registers", async () => {
    const g = fakeGateway({ status: "undetermined" });
    const res = await registerForPush(g, "proj");
    expect(res).toEqual({ status: "registered", token: "ExponentPushToken[abc]" });
    expect(g.requested()).toBe(1);
  });

  it("does NOT re-request when permission is already granted", async () => {
    const g = fakeGateway({ status: "granted" });
    await registerForPush(g, "proj");
    expect(g.requested()).toBe(0);
  });

  it("returns denied when the user refuses (no token attempt)", async () => {
    const getToken = jest.fn(async () => "tok");
    const g = fakeGateway({ status: "denied", getExpoPushToken: getToken });
    expect(await registerForPush(g, "proj")).toEqual({ status: "denied", token: null });
    expect(getToken).not.toHaveBeenCalled();
  });

  it("degrades to unavailable (never throws) when the token fetch fails", async () => {
    const g = fakeGateway({
      status: "granted",
      getExpoPushToken: async () => {
        throw new Error("no APNs credentials");
      },
    });
    expect(await registerForPush(g, "proj")).toEqual({ status: "unavailable", token: null });
  });

  it("passes the projectId through to the token request", async () => {
    const getToken = jest.fn(async (p: string) => `tok-${p}`);
    const g = fakeGateway({ status: "granted", getExpoPushToken: getToken });
    const res = await registerForPush(g, "proj-123");
    expect(getToken).toHaveBeenCalledWith("proj-123");
    expect(res.token).toBe("tok-proj-123");
  });
});
