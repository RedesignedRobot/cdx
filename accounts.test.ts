import { expect, spyOn, test } from "bun:test";
import { rejectPinnedAccountFlag } from "./accounts.ts";
import type { Lane } from "./ledger.ts";

test("respawn warns and retains its account even if the requested account is unknown", () => {
  const lane = { account: "pinned", codexHome: "/accounts/pinned" } as Lane;
  const warning = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const requested of ["pinned", "other", "unknown"]) {
      expect(() => rejectPinnedAccountFlag("respawn", lane, requested, { respawn: true })).not.toThrow();
      expect(warning).toHaveBeenLastCalledWith(expect.stringContaining('pinned to account "pinned"; ignoring --account'));
      expect(lane.account).toBe("pinned");
    }
    expect(() => rejectPinnedAccountFlag("resume", lane, "other")).toThrow("--account is not valid");
  } finally {
    warning.mockRestore();
  }
});
