/** Minimal change notification for the plugin's view-model objects. */
export class Observable {
  private readonly listeners = new Set<() => void>();

  /** Register a listener; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
