import type { ConnectorId } from "@taiwan-fin-hub/shared";
import type { z } from "zod";
import { invoiceConfigSchema } from "./einvoice/protocol";
import { tdccConfigSchema } from "./tdcc/protocol";
import { esunConfigSchema } from "./esun/protocol";
import { cathaybkConfigSchema } from "./cathaybk/protocol";
import { sinopacConfigSchema } from "./sinopac/protocol";
import { taishinConfigSchema } from "./taishin/protocol";
import { ctbcConfigSchema } from "./ctbc/protocol";
import { skbankConfigSchema } from "./skbank/protocol";
import { obankConfigSchema } from "./obank/protocol";
import { nextbankConfigSchema } from "./nextbank/protocol";
import { firstbankConfigSchema } from "./firstbank/protocol";
import { hncbConfigSchema } from "./hncb/protocol";
import { rakutenConfigSchema } from "./rakuten/protocol";
import { kgibankConfigSchema } from "./kgibank/protocol";
import { megabankConfigSchema } from "./megabank/protocol";

export const connectorConfigSchemas = {
  einvoice: invoiceConfigSchema,
  tdcc: tdccConfigSchema,
  esun: esunConfigSchema,
  cathaybk: cathaybkConfigSchema,
  sinopac: sinopacConfigSchema,
  taishin: taishinConfigSchema,
  ctbc: ctbcConfigSchema,
  skbank: skbankConfigSchema,
  obank: obankConfigSchema,
  nextbank: nextbankConfigSchema,
  firstbank: firstbankConfigSchema,
  hncb: hncbConfigSchema,
  rakuten: rakutenConfigSchema,
  kgibank: kgibankConfigSchema,
  megabank: megabankConfigSchema,
} satisfies Record<ConnectorId, z.ZodType>;

export function parseConnectorConfig(
  connectorId: ConnectorId,
  config: unknown,
) {
  return connectorConfigSchemas[connectorId].parse(config);
}
