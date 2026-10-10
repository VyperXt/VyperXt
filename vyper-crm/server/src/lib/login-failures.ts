/**
 * Conta tentativas de login por conta numa janela de tempo (em memória; reiniciar o CRM zera).
 * Para e-mails que não existem, use maxKeys (o mapa não cresce sem limite).
 */
export class LoginFailures {
  private byUser = new Map<string, number[]>();

  /** maxKeys: limite de chaves guardadas (as mais antigas saem primeiro) */
  constructor(private opts: { max: number; windowMs: number; maxKeys?: number }) {}

  private recent(key: string, now: number): number[] {
    const list = (this.byUser.get(key) ?? []).filter((t) => now - t < this.opts.windowMs);
    if (list.length) this.byUser.set(key, list);
    else this.byUser.delete(key);
    return list;
  }

  /** Segundos até poder tentar de novo (0 = liberado). */
  retryAfterSeconds(key: string, now: number): number {
    const list = this.recent(key, now);
    if (list.length < this.opts.max) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.opts.max]! + this.opts.windowMs - now) / 1000));
  }

  add(key: string, now: number): void {
    const list = [...this.recent(key, now), now];
    this.byUser.delete(key); // reinsere no fim (a mais recente)
    this.byUser.set(key, list);
    const max = this.opts.maxKeys ?? Infinity;
    for (const oldest of this.byUser.keys()) {
      if (this.byUser.size <= max) break;
      this.byUser.delete(oldest);
    }
  }

  clear(key: string): void {
    this.byUser.delete(key);
  }
}
