import { DurableObject } from "cloudflare:workers";
import {
  createCryptoBrowserSession,
  type CryptoBrowserSession,
} from "../sources/crypto-browser-egress";
import { handleCryptoEgressRequest } from "./crypto-browser-egress";

// 最後一次請求後超過此時間沒有新請求，就關閉瀏覽器（呼叫端通常會主動關閉）。
const IDLE_CLOSE_MS = 90_000;

export class CryptoBrowserEgress extends DurableObject<{ BROWSER: Fetcher }> {
  private session?: CryptoBrowserSession;

  async fetch(request: Request) {
    await this.ctx.storage.setAlarm(Date.now() + IDLE_CLOSE_MS);
    return handleCryptoEgressRequest(
      request,
      () => (this.session ??= createCryptoBrowserSession(this.env.BROWSER)),
      () => this.dispose(),
    );
  }

  async alarm() {
    await this.dispose();
  }

  private async dispose() {
    const session = this.session;
    this.session = undefined;
    await session?.dispose();
  }
}
