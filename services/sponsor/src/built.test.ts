import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  type Transaction,
  TransactionBuilder,
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
    hash: tx.hash().toString("hex"),
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
