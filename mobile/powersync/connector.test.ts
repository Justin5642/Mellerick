import { MellerickConnector, POWERSYNC_URL, type SessionSource } from "./connector";

function sessions(token: string | null, expiresAt: Date | null = null): SessionSource {
  return {
    getAccessToken: async () => (token === null ? null : { token, expiresAt }),
  };
}

describe("fetchCredentials", () => {
  it("returns null when signed out — the SDK treats that as 'not signed in'", async () => {
    const c = new MellerickConnector(sessions(null), jest.fn());
    await expect(c.fetchCredentials()).resolves.toBeNull();
  });

  it("returns the instance endpoint and the CURRENT Supabase token", async () => {
    const exp = new Date("2026-07-27T12:00:00Z");
    const c = new MellerickConnector(sessions("jwt-123", exp), jest.fn());
    await expect(c.fetchCredentials()).resolves.toEqual({
      endpoint: POWERSYNC_URL,
      token: "jwt-123",
      expiresAt: exp,
    });
  });

  it("omits expiresAt when the session does not carry one", async () => {
    const c = new MellerickConnector(sessions("jwt-123"), jest.fn());
    await expect(c.fetchCredentials()).resolves.toEqual({
      endpoint: POWERSYNC_URL,
      token: "jwt-123",
    });
  });
});

describe("uploadData — the read-only tripwire", () => {
  it("does nothing when there is no CRUD (the expected steady state)", async () => {
    const onViolation = jest.fn();
    const c = new MellerickConnector(sessions("t"), onViolation);
    const db = { getNextCrudTransaction: jest.fn().mockResolvedValue(null) };
    await c.uploadData(db as never);
    expect(onViolation).not.toHaveBeenCalled();
  });

  it("drains unexpected CRUD (so the sync loop cannot wedge), reports it, and throws in dev", async () => {
    const onViolation = jest.fn();
    const c = new MellerickConnector(sessions("t"), onViolation);
    const complete = jest.fn().mockResolvedValue(undefined);
    const db = {
      getNextCrudTransaction: jest.fn().mockResolvedValue({
        crud: [
          { op: "PUT", table: "jobs", id: "j1" },
          { op: "DELETE", table: "job_notes", id: "n1" },
        ],
        complete,
      }),
    };
    await expect(c.uploadData(db as never)).rejects.toThrow(/READ-ONLY/);
    expect(complete).toHaveBeenCalled();
    expect(onViolation).toHaveBeenCalledWith("PUT jobs#j1, DELETE job_notes#n1");
    // complete() ran BEFORE the throw — order is the whole point of the drain.
    expect(complete.mock.invocationCallOrder[0]).toBeLessThan(
      onViolation.mock.invocationCallOrder[0]
    );
  });
});
