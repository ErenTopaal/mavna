import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { BuiltLedger, type BuiltRecord, signedBy } from "./built.js";

const user = Keypair.random();
const other = Keypair.random();

function buildTx(sequence = "1", destination = Keypair.random().publicKey()): Transaction {
  return new TransactionBuilder(new Account(user.publicKey(), sequence), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.createAccount({ destination, startingBalance: "1" }))
    .setTimeout(300)
    .build();
}

function recordFor(tx: Transaction, over: Partial<BuiltRecord> = {}): BuiltRecord {
  return {
    hash: xdr.encodeBytes(tx.hash(), "hex"),
    kind: "preparation",
    destination: "0xabc",
    signer: user.publicKey(),
    sourceChainId: "base",
    expiresAtUnix: 2000,
    ...over,
  };
}

describe("BuiltLedger", () => {
  it("hands a record out once, then forgets it", () => {
    const ledger = new BuiltLedger();
    const record = recordFor(buildTx());
    ledger.record(record, 900);
    expect(ledger.take(record.hash, "preparation", 1000)).toEqual(record);
    expect(ledger.take(record.hash, "preparation", 1000)).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it("returns undefined for the wrong kind and keeps the record", () => {
    const ledger = new BuiltLedger();
    const record = recordFor(buildTx());
    ledger.record(record, 900);
    expect(ledger.take(record.hash, "settlement", 1000)).toBeUndefined();
    expect(ledger.size).toBe(1);
    expect(ledger.take(record.hash, "preparation", 1000)).toEqual(record);
  });

  it("returns undefined for an expired record and prunes it", () => {
    const ledger = new BuiltLedger();
    const record = recordFor(buildTx(), { expiresAtUnix: 1500 });
    ledger.record(record, 900);
    expect(ledger.take(record.hash, "preparation", 1500)).toBeUndefined();
    expect(ledger.size).toBe(0);
  });

  it("prunes every expired record on each take", () => {
    const ledger = new BuiltLedger();
    const live = recordFor(buildTx("1"), { expiresAtUnix: 5000 });
    ledger.record(live, 900);
    ledger.record(recordFor(buildTx("2"), { expiresAtUnix: 1000 }), 900);
    ledger.record(recordFor(buildTx("3"), { expiresAtUnix: 1200 }), 900);
    expect(ledger.take("unknown", "preparation", 2000)).toBeUndefined();
    expect(ledger.size).toBe(1);
    expect(ledger.take(live.hash, "preparation", 2000)).toEqual(live);
  });

  it("prunes every expired record on each record too", () => {
    // A server asked to build far more often than anything is signed would
    // otherwise keep every abandoned build until the next signed one arrives.
    const ledger = new BuiltLedger();
    ledger.record(recordFor(buildTx("1"), { expiresAtUnix: 1000 }), 900);
    ledger.record(recordFor(buildTx("2"), { expiresAtUnix: 1200 }), 900);
    ledger.record(recordFor(buildTx("3"), { expiresAtUnix: 5000 }), 1300);
    expect(ledger.size).toBe(1);
  });

  it("returns undefined for a hash it never built", () => {
    expect(new BuiltLedger().take("00", "preparation", 0)).toBeUndefined();
  });
});

describe("signedBy", () => {
  it("is true for the signer's own signature", () => {
    const tx = buildTx();
    tx.sign(user);
    expect(signedBy(tx, user.publicKey())).toBe(true);
  });

  it("is false when only another key signed", () => {
    const tx = buildTx();
    tx.sign(other);
    expect(signedBy(tx, user.publicKey())).toBe(false);
  });

  it("is false for an unsigned transaction", () => {
    expect(signedBy(buildTx(), user.publicKey())).toBe(false);
  });

  it("is false when the hint matches but the signature covers a different transaction", () => {
    const signedElsewhere = buildTx("1");
    signedElsewhere.sign(user);
    const target = buildTx("2");
    const [copied] = signedElsewhere.signatures;
    if (copied === undefined) throw new Error("expected a signature");
    target.signatures.push(copied);
    expect(signedBy(target, user.publicKey())).toBe(false);
  });
});

describe("a ledger written down and read back", () => {
  it("still knows what it built, and nothing it already handed out", () => {
    const ledger = new BuiltLedger();
    const kept = buildTx("1");
    const taken = buildTx("2");
    ledger.record(recordFor(kept), 0);
    ledger.record(recordFor(taken), 0);
    ledger.take(xdr.encodeBytes(taken.hash(), "hex"), "preparation", 0);

    const restored = BuiltLedger.fromSnapshot(ledger.snapshot(), 0);
    expect(restored.size).toBe(1);
    expect(restored.take(xdr.encodeBytes(kept.hash(), "hex"), "preparation", 0)).toBeDefined();
  });

  it("does not bring back a record that expired while the process was down", () => {
    const ledger = new BuiltLedger();
    ledger.record(recordFor(buildTx("1"), { expiresAtUnix: 100 }), 0);
    expect(BuiltLedger.fromSnapshot(ledger.snapshot(), 200).size).toBe(0);
  });
});

describe("what anonymous builds can make the ledger hold", () => {
  it("keeps the latest few open records per account and kind", () => {
    const ledger = new BuiltLedger();
    const txs = ["1", "2", "3", "4"].map((sequence) => buildTx(sequence));
    for (const tx of txs) ledger.record(recordFor(tx, { kind: "settlement" }), 0);
    ledger.record(recordFor(buildTx("5")), 0);
    expect(ledger.size).toBe(4);
    expect(
      ledger.take(
        txs[0] === undefined ? "" : xdr.encodeBytes(txs[0].hash(), "hex"),
        "settlement",
        0,
      ),
    ).toBeUndefined();
    expect(
      ledger.take(
        txs[3] === undefined ? "" : xdr.encodeBytes(txs[3].hash(), "hex"),
        "settlement",
        0,
      ),
    ).toBeDefined();
  });

  it("closes a record at its own earlier bound when it has one", () => {
    const ledger = new BuiltLedger();
    const tx = buildTx("1");
    ledger.record(recordFor(tx, { expiresAtUnix: 86_400, openUntilUnix: 330 }), 0);
    expect(ledger.size).toBe(1);
    expect(ledger.take(xdr.encodeBytes(tx.hash(), "hex"), "preparation", 331)).toBeUndefined();
  });

  it("says when it holds as many open records as it may", () => {
    const ledger = new BuiltLedger(2);
    ledger.record(recordFor(buildTx("1"), { signer: Keypair.random().publicKey() }), 0);
    expect(ledger.full(0)).toBe(false);
    ledger.record(recordFor(buildTx("2"), { signer: Keypair.random().publicKey() }), 0);
    expect(ledger.full(0)).toBe(true);
    // expired ones do not count
    expect(ledger.full(5_000)).toBe(false);
  });
});

describe("round 2: whose builds a new build may push out", () => {
  it("never drops one client's open build because another asked for the same account", () => {
    const ledger = new BuiltLedger();
    const owners = buildTx("1");
    ledger.record(recordFor(owners), 0, "203.0.113.1");
    for (const sequence of ["2", "3", "4", "5"]) {
      ledger.record(recordFor(buildTx(sequence)), 0, "198.51.100.9");
    }
    expect(ledger.take(xdr.encodeBytes(owners.hash(), "hex"), "preparation", 0)).toBeDefined();
  });

  it("still keeps only the latest few that one client asked for", () => {
    const ledger = new BuiltLedger();
    const txs = ["1", "2", "3", "4"].map((sequence) => buildTx(sequence));
    for (const tx of txs) ledger.record(recordFor(tx), 0, "203.0.113.1");
    expect(
      ledger.take(xdr.encodeBytes((txs[0] as Transaction).hash(), "hex"), "preparation", 0),
    ).toBeUndefined();
    expect(
      ledger.take(xdr.encodeBytes((txs[3] as Transaction).hash(), "hex"), "preparation", 0),
    ).toBeDefined();
  });
});
