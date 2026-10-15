import { DurableObject } from "cloudflare:workers";
import { createFubonStaticCache, proxyFubonEgress } from "./fubon-egress";

export class FubonEgress extends DurableObject {
  private readonly staticCache = createFubonStaticCache(this.ctx.storage);

  fetch(request: Request) {
    return proxyFubonEgress(request, fetch, this.staticCache);
  }
}
