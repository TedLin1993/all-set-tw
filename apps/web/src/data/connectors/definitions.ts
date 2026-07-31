import {
  connectorCatalog,
  supportedConnectorIds,
  type ConnectorFormFieldKey,
} from "@taiwan-fin-hub/core";
import type { ConnectorField, ConnectorId } from "./types";

export interface ConnectorDefinition {
  id: ConnectorId;
  title: string;
  description: string;
}

export const connectorDefinitions: ConnectorDefinition[] =
  supportedConnectorIds.map((id) => ({
    id,
    title: connectorCatalog[id].title,
    description: connectorCatalog[id].description,
  }));

type ConnectorFieldMap = {
  [TConnectorId in ConnectorId]: Array<
    ConnectorField<ConnectorFormFieldKey<TConnectorId>>
  >;
};

export const connectorFields = {
  einvoice: [
    { key: "mobile", label: "手機號碼（電子發票帳號）", type: "text" },
    { key: "password", label: "電子發票 App 登入密碼", type: "password" },
    { key: "fetchDetails", label: "同步品項明細", type: "checkbox" },
  ],
  tdcc: [
    { key: "userId", label: "身分證字號", type: "text" },
    { key: "password", label: "集保 App 密碼", type: "password" },
  ],
  esun: [
    { key: "userId", label: "身分證字號／統編", type: "text" },
    { key: "account", label: "使用者名稱", type: "text" },
    { key: "password", label: "使用者密碼", type: "password" },
  ],
  cathaybk: [
    { key: "userId", label: "身分證字號／統編", type: "text" },
    { key: "account", label: "用戶代號", type: "text" },
    { key: "password", label: "網銀密碼", type: "password" },
  ],
  sinopac: [
    { key: "userId", label: "身分證字號／統編", type: "text" },
    { key: "account", label: "行動／網路銀行使用者代碼", type: "text" },
    { key: "password", label: "網路密碼", type: "password" },
  ],
  taishin: [
    { key: "userId", label: "身分證字號／統編", type: "text" },
    { key: "account", label: "使用者代號", type: "text" },
    { key: "password", label: "使用者密碼", type: "password" },
  ],
  ctbc: [
    { key: "userId", label: "身分證字號／統編", type: "text" },
    { key: "account", label: "使用者代號", type: "text" },
    { key: "password", label: "網路密碼", type: "password" },
  ],
} satisfies ConnectorFieldMap;
