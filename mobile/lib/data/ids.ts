import * as Crypto from "expo-crypto";

// Client-side id generation. Every offline insert supplies its own UUID as the
// row PK, which is what makes replay idempotent (a retry can't create a second
// row). Injected into repositories as IdGen so they stay unit-testable.
export interface IdGen {
  newId(): string;
}

export const cryptoIdGen: IdGen = {
  newId: () => Crypto.randomUUID(),
};
