import { describe, expect, it } from "vitest";
import {
  classifyScanStatus,
  remedyForStatus,
  SCAN_BASE_URL,
  type ScanStatusName,
  scanMessageUrl,
} from "./scan.js";

/**
 * Reading LayerZero's indexer without over-reading it.
 *
 * The statuses are LayerZero's own, taken from the OpenAPI document its testnet
 * scan API serves. What matters here is that each one is mapped deliberately:
 * an unmapped status silently treated as pending is a transfer that shows a
 * spinner forever, and one treated as failed is a user sending twice.
 */

const ALL: readonly ScanStatusName[] = [
  "INFLIGHT",
  "CONFIRMING",
  "FAILED",
  "DELIVERED",
  "BLOCKED",
  "PAYLOAD_STORED",
  "APPLICATION_BURNED",
  "APPLICATION_SKIPPED",
  "UNRESOLVABLE_COMMAND",
  "MALFORMED_COMMAND",
];

describe("what a status means for someone waiting on their money", () => {
  it("classifies every status LayerZero declares", () => {
    for (const name of ALL) {
      expect(["pending", "delivered", "stalled"]).toContain(classifyScanStatus(name));
    }
  });

  it("calls only DELIVERED delivered", () => {
    expect(classifyScanStatus("DELIVERED")).toBe("delivered");
    for (const name of ALL.filter((n) => n !== "DELIVERED")) {
      expect(classifyScanStatus(name)).not.toBe("delivered");
    }
  });

  /**
   * The important one. An unindexed transfer and a sent-but-unconfirmed one are
   * both simply still going, and reporting either as failed is how somebody is
   * talked into paying twice.
   */
  it("treats an unindexed message as still going, not as failed", () => {
    expect(classifyScanStatus(undefined)).toBe("pending");
    expect(classifyScanStatus("INFLIGHT")).toBe("pending");
    expect(classifyScanStatus("CONFIRMING")).toBe("pending");
  });
});

describe("what the user can do about it", () => {
  const url = "https://layerzeroscan.com/tx/0xabc";

  it("offers a stored payload to anyone willing to push it through", () => {
    const remedy = remedyForStatus("PAYLOAD_STORED", url, 1_000);
    expect(remedy.kind).toBe("claim");
    if (remedy.kind === "claim") expect(remedy.at).toBe(url);
  });

  it("tells someone blocked behind another transfer to wait, and why", () => {
    const remedy = remedyForStatus("BLOCKED", url, 1_000);
    expect(remedy.kind).toBe("wait");
    expect(remedy.because).toContain("in order");
  });

  it("says plainly when it is over, rather than inviting a retry forever", () => {
    for (const name of [
      "APPLICATION_BURNED",
      "APPLICATION_SKIPPED",
      "UNRESOLVABLE_COMMAND",
      "MALFORMED_COMMAND",
    ] as const) {
      expect(remedyForStatus(name, url, 1_000).kind).toBe("unrecoverable");
    }
  });

  it("never returns a message with no action beside it", () => {
    for (const name of ALL) {
      const remedy = remedyForStatus(name, url, 1_000);
      expect(remedy.because.length).toBeGreaterThan(0);
      expect(remedy.kind).toBeDefined();
    }
  });
});

describe("where to look", () => {
  it("points at the right indexer for the network", () => {
    expect(SCAN_BASE_URL.mainnet).toBe("https://scan.layerzero-api.com/v1");
    expect(SCAN_BASE_URL.testnet).toBe("https://scan-testnet.layerzero-api.com/v1");
  });

  it("points a person at the right explorer for the network", () => {
    expect(scanMessageUrl("mainnet", "0xabc")).toBe("https://layerzeroscan.com/tx/0xabc");
    expect(scanMessageUrl("testnet", "0xabc")).toBe("https://testnet.layerzeroscan.com/tx/0xabc");
  });
});

describe("a status LayerZero has not told us about", () => {
  const unknown = "SOMETHING_NEW" as ScanStatusName;

  it("is stalled, never delivered", () => {
    expect(classifyScanStatus(unknown)).toBe("stalled");
  });

  it("points at the scan page rather than claiming a fix", () => {
    const url = scanMessageUrl("testnet", "0xabc");
    const remedy = remedyForStatus(unknown, url, 1000);
    expect(remedy.kind).toBe("contact");
    if (remedy.kind === "contact") expect(remedy.reference).toBe(url);
  });
});
