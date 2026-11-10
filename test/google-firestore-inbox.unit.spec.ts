import assert from "node:assert";
import { describe, it } from "node:test";
import { assertValidEffects, inboxKey, isAlreadyExists } from "../src/support";

const noop = () => Promise.resolve();

void describe("inboxKey", () => {
  void it("joins the handler and the message id", () => {
    assert.strictEqual(inboxKey("userDataRemoval", "m1"), "userDataRemoval:m1");
  });
});

void describe("isAlreadyExists", () => {
  void it("recognizes the Firestore code of an existing document", () => {
    assert.strictEqual(isAlreadyExists(Object.assign(new Error("exists"), { code: 6 })), true);
  });

  void it("recognizes the status in the message", () => {
    assert.strictEqual(isAlreadyExists(new Error("6 ALREADY_EXISTS: Document already exists")), true);
  });

  void it("rejects other errors", () => {
    assert.strictEqual(isAlreadyExists(new Error("deadline exceeded")), false);
    assert.strictEqual(isAlreadyExists(undefined), false);
  });
});

void describe("assertValidEffects", () => {
  void it("accepts effects with distinct names", () => {
    assert.doesNotThrow(() =>
      assertValidEffects([
        { name: "a", class: "repeatable", run: noop },
        { name: "b", class: "checkable", run: noop, happened: () => Promise.resolve(false) },
      ])
    );
  });

  void it("rejects a name used twice", () => {
    assert.throws(
      () =>
        assertValidEffects([
          { name: "a", class: "repeatable", run: noop },
          { name: "a", class: "keyed", run: noop },
        ]),
      /used twice/
    );
  });

  void it("rejects a checkable effect without a happened function", () => {
    assert.throws(() => assertValidEffects([{ name: "a", class: "checkable", run: noop }]), /needs a happened/);
  });
});
