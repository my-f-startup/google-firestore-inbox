import type { ExternalEffect } from "./types";

/** The `code` of a Firestore error when `create` finds an existing document. */
const ALREADY_EXISTS = 6;

/** Another delivery of the message holds it: it is being handled, or it was handled at the same time. */
export class InboxBusyError extends Error {
  constructor(public readonly key: string) {
    super(`The message ${key} is being handled by another delivery`);
    this.name = "InboxBusyError";
  }
}

/** Another delivery took over the message while this one was handling it, so this one stopped. */
export class LeaseLostError extends Error {
  constructor(public readonly key: string) {
    super(`Another delivery took over the message ${key}`);
    this.name = "LeaseLostError";
  }
}

/** An unverifiable effect was interrupted: it may or may not have happened, so a person must decide. */
export class UnverifiableEffectError extends Error {
  constructor(
    public readonly key: string,
    public readonly effect: string
  ) {
    super(`The effect ${effect} of ${key} was interrupted and cannot be checked or repeated`);
    this.name = "UnverifiableEffectError";
  }
}

export const inboxKey = (handler: string, messageId: string): string => `${handler}:${messageId}`;

export const isAlreadyExists = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  ((error as { code?: unknown }).code === ALREADY_EXISTS ||
    String((error as { message?: unknown }).message).includes("ALREADY_EXISTS"));

export const assertValidEffects = (effects: readonly ExternalEffect[]): void => {
  const names = new Set<string>();
  for (const effect of effects) {
    if (names.has(effect.name)) throw new Error(`The effect name ${effect.name} is used twice`);
    names.add(effect.name);
    if (effect.class === "checkable" && !effect.happened) {
      throw new Error(`The checkable effect ${effect.name} needs a happened function`);
    }
  }
};
