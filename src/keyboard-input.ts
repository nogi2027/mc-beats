export type KeyboardPress<T> = {
  key: string;
  token: object;
  status: 'pending' | 'started';
  value: T;
};

/** Tracks physical keyboard ownership across an async audio-start boundary. */
export class KeyboardPressRegistry<T> {
  private readonly entries = new Map<string, KeyboardPress<T>>();

  has(key: string) { return this.entries.has(key); }

  reserve(key: string, value: T): KeyboardPress<T> | null {
    if (this.entries.has(key)) return null;
    const entry: KeyboardPress<T> = { key, token: {}, status: 'pending', value };
    this.entries.set(key, entry);
    return entry;
  }

  isCurrent(entry: KeyboardPress<T>) { return this.entries.get(entry.key) === entry && this.entries.get(entry.key)?.token === entry.token; }

  markStarted(entry: KeyboardPress<T>) {
    if (!this.isCurrent(entry)) return false;
    entry.status = 'started';
    return true;
  }

  take(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    return entry;
  }

  values() { return [...this.entries.values()]; }

  clear() { this.entries.clear(); }
}
