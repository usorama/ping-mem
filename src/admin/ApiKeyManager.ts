import { AdminStore } from "./AdminStore.js";

export class ApiKeyManager {
  private store: AdminStore;

  constructor(store: AdminStore) {
    this.store = store;
  }

  ensureSeedKey(rawKey: string | undefined): void {
    if (!rawKey) {
      return;
    }
    this.store.ensureSeedApiKey(rawKey);
  }

  hasSeedKey(): boolean {
    return this.store.hasAnyActiveKey();
  }

  isValid(rawKey: string | undefined): boolean {
    if (!rawKey) {
      return false;
    }
    return this.store.isApiKeyValid(rawKey);
  }
}
