import { Logger } from "matrix-appservice-bridge";
import { Appservice, Intent } from "matrix-bot-sdk";
import type { UserTokenStore } from "./tokens/UserTokenStore";

const log = new Logger("CrossSigning");

const RECOVERY_KEY_NAMESPACE = "cross-signing-recovery-key";

/** Cross-signs each intent's device once its crypto client is ready, creating an identity if the user has none. */
export class CrossSigningBootstrap {
  private tokenStore?: UserTokenStore;
  private readonly waiting: Intent[] = [];

  constructor(appservice: Appservice) {
    appservice.on("intent.new", (intent: Intent) => {
      intent.underlyingClient.on("crypto.ready", () => {
        if (this.tokenStore) {
          void this.bootstrap(intent, this.tokenStore);
        } else {
          this.waiting.push(intent);
        }
      });
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
    const crypto = intent.underlyingClient.crypto;
    try {
      if (!(await crypto.isRecoveryAvailable())) {
        log.info(`Creating cross-signing identity for ${userId}`);
        const recoveryKey = await crypto.createIdentity();
        await tokenStore.storeGenericToken(
          RECOVERY_KEY_NAMESPACE,
          userId,
          recoveryKey,
        );
        log.info(`Created cross-signing identity for ${userId}`);
        return;
      }
      const recoveryKey = await tokenStore.getGenericToken(
        RECOVERY_KEY_NAMESPACE,
        userId,
      );
      if (!recoveryKey) {
        log.warn(
          `${userId} has recovery set up but no stored recovery key; not cross-signing its device`,
        );
        return;
      }
      await crypto.confirmIdentityWithRecoveryKey(recoveryKey);
    } catch (ex) {
      log.warn(`Failed to set up cross-signing for ${userId}`, ex);
    }
  }
}
