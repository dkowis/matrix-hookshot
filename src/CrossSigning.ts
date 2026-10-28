import { Logger } from "matrix-appservice-bridge";
import { Appservice, Intent, MatrixClient, MatrixError } from "matrix-bot-sdk";
import type { UserTokenStore } from "./tokens/UserTokenStore";

const log = new Logger("CrossSigning");

const RECOVERY_KEY_NAMESPACE = "cross-signing-recovery-key";

/** Cross-signs each intent's device once its crypto client is ready, creating an identity if the user has none. */
export class CrossSigningBootstrap {
  private tokenStore?: UserTokenStore;
  private readonly waiting: Intent[] = [];

  constructor(appservice: Appservice) {
    appservice.on("intent.new", (intent: Intent) => {
      // enableEncryption is memoised and replaces underlyingClient with a new crypto-enabled client.
      intent.enableEncryption().then(
        () => {
          if (this.tokenStore) {
            void this.bootstrap(intent, this.tokenStore);
          } else {
            this.waiting.push(intent);
          }
        },
        // Appservice logs encryption setup failures.
        () => undefined,
      );
    });
  }

  public start(tokenStore: UserTokenStore) {
    this.tokenStore = tokenStore;
    for (const intent of this.waiting.splice(0)) {
      void this.bootstrap(intent, tokenStore);
    }
  }

  private async bootstrap(intent: Intent, tokenStore: UserTokenStore) {
    const userId = intent.userId;
    const client = intent.underlyingClient;
    try {
      const recoveryKey = await tokenStore.getGenericToken(
        RECOVERY_KEY_NAMESPACE,
        userId,
      );
      if (recoveryKey) {
        await client.crypto.confirmIdentityWithRecoveryKey(recoveryKey);
        return;
      }
      if (await this.hasStoredIdentity(client)) {
        log.warn(
          `${userId} has a cross-signing identity but no stored recovery key; not cross-signing its device`,
        );
        return;
      }
      log.info(`Creating cross-signing identity for ${userId}`);
      const newRecoveryKey = await client.crypto.createIdentity();
      await tokenStore.storeGenericToken(
        RECOVERY_KEY_NAMESPACE,
        userId,
        newRecoveryKey,
      );
      log.info(`Created cross-signing identity for ${userId}`);
    } catch (ex) {
      log.warn(`Failed to set up cross-signing for ${userId}`, ex);
    }
  }

  // Throws on errors other than M_NOT_FOUND so a failed request never leads to replacing an identity.
  private async hasStoredIdentity(client: MatrixClient): Promise<boolean> {
    try {
      await client.getAccountData("m.cross_signing.master");
      return true;
    } catch (ex) {
      if (ex instanceof MatrixError && ex.errcode === "M_NOT_FOUND") {
        return false;
      }
      throw ex;
    }
  }
}
