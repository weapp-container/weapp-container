interface AbilityListener { id: number; callback: (foreground: boolean, destroyed: boolean) => void; }

/** ArkUI page and UIAbility share one executor-local lifecycle source. */
class AbilityLifecycleSource {
  foreground: boolean = true;
  destroyed: boolean = false;
  private sequence: number = 0;
  private listeners: Array<AbilityListener> = [];

  subscribe(callback: (foreground: boolean, destroyed: boolean) => void): number {
    this.sequence += 1;
    this.listeners.push({ id: this.sequence, callback });
    return this.sequence;
  }

  unsubscribe(id: number): void { this.listeners = this.listeners.filter((listener: AbilityListener) => listener.id !== id); }

  setForeground(visible: boolean): void {
    if (this.destroyed || visible === this.foreground) return;
    this.foreground = visible;
    this.publish();
  }

  reset(): void { this.destroyed = false; this.foreground = true; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.foreground = false;
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners.slice()) listener.callback(this.foreground, this.destroyed);
  }
}

export const abilityLifecycle = new AbilityLifecycleSource();
