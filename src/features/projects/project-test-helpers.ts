import type { StorageLike } from "./project-repository";

export class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  failWrites = false;
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites)
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

export function createTestServices(storage = new MemoryStorage()) {
  let id = 0;
  let sequence = Promise.resolve();
  return {
    storage,
    newId: () => `test-id-${++id}`,
    now: () => "2026-10-19T00:00:00.000Z",
    withLock: (_key: string, work: () => void) => {
      const next = sequence.then(work);
      sequence = next.catch(() => {});
      return next;
    },
  };
}
