import { Logger } from "matrix-appservice-bridge";
import { Appservice, Intent } from "matrix-bot-sdk";

const log = new Logger("CrossSigning");

interface CrossSigningMachine {
  crossSigningStatus(): Promise<{ hasSelfSigning: boolean }>;
}

const pending = new Map<string, Promise<void>>();

/** Creates a cross-signing identity for each intent whose crypto store has none. */
export function bootstrapCrossSigningOnReady(appservice: Appservice) {
  appservice.on("intent.new", (intent: Intent) => {
    intent.underlyingClient.on("crypto.ready", () => {
      void ensureCrossSigned(intent);
    });
  });
}

function ensureCrossSigned(intent: Intent): Promise<void> {
  const existing = pending.get(intent.userId);
  if (existing) {
    return existing;
  }
  const promise = bootstrap(intent).catch((ex) => {
    pending.delete(intent.userId);
    log.warn(`Failed to set up cross-signing for ${intent.userId}`, ex);
  });
  pending.set(intent.userId, promise);
  return promise;
}

async function bootstrap(intent: Intent) {
  const crypto = intent.underlyingClient.crypto;
  // CryptoClient does not expose the OlmMachine.
  const machine = (
    crypto as unknown as { engine: { machine: CrossSigningMachine } }
  ).engine.machine;
  const status = await machine.crossSigningStatus();
  if (status.hasSelfSigning) {
    log.debug(`${intent.userId} already has local cross-signing keys`);
    return;
  }
  log.info(`Creating cross-signing identity for ${intent.userId}`);
  // The recovery key is not kept: the private keys live in the crypto store.
  await crypto.createIdentity();
  log.info(`Created cross-signing identity for ${intent.userId}`);
}
