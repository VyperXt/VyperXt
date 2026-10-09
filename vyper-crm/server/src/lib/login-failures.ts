/**
 * Conta senhas erradas por usuário numa janela de tempo (em memória).
 * Só usuários que existem entram aqui, então o mapa não cresce com e-mails inventados.
 */
export class LoginFailures {
  private byUser = new Map<number, number[]>();

  constructor(private opts: { max: number; windowMs: number }) {}

  private recent(userId: number, now: number): number[] {
    const list = (this.byUser.get(userId) ?? []).filter((t) => now - t < this.opts.windowMs);
    if (list.length) this.byUser.set(userId, list);
    else this.byUser.delete(userId);
    return list;
  }

  /** Segundos até poder tentar de novo (0 = liberado). */
  retryAfterSeconds(userId: number, now: number): number {
    const list = this.recent(userId, now);
    if (list.length < this.opts.max) return 0;
    return Math.max(1, Math.ceil((list[list.length - this.opts.max]! + this.opts.windowMs - now) / 1000));
  }

  add(userId: number, now: number): void {
    this.byUser.set(userId, [...this.recent(userId, now), now]);
  }

  clear(userId: number): void {
    this.byUser.delete(userId);
  }
}
