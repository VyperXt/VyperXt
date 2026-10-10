/**
 * Executa tarefas por chave (ex.: por lead) com:
 * - debounce: espera o lead parar de mandar mensagens antes de rodar a IA;
 * - execução serial: nunca roda duas tarefas da mesma chave ao mesmo tempo;
 * - coalescência: se chegar algo novo durante a execução, roda de novo só uma vez no final.
 */
export class KeyedRunner {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Map<string, Promise<void>>();
  private queued = new Map<string, () => Promise<void>>();

  constructor(private onError: (err: unknown, key: string) => void = () => {}) {}

  schedule(key: string, delayMs: number, task: () => Promise<void>): void {
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    if (delayMs <= 0) {
      this.timers.delete(key);
      this.start(key, task);
      return;
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.start(key, task);
      }, delayMs),
    );
  }

  private start(key: string, task: () => Promise<void>): void {
    if (this.running.has(key)) {
      this.queued.set(key, task);
      return;
    }
    const run = (async () => {
      try {
        await task();
      } catch (err) {
        this.onError(err, key);
      }
    })().finally(() => {
      this.running.delete(key);
      const next = this.queued.get(key);
      if (next) {
        this.queued.delete(key);
        this.start(key, next);
      }
    });
    this.running.set(key, run);
  }

  /** Já há uma execução marcada (esperando o atraso ou na fila) para esta chave? */
  hasPending(key: string): boolean {
    return this.timers.has(key) || this.queued.has(key);
  }

  /** Aguarda tudo terminar (usado nos testes e no desligamento). */
  async drain(): Promise<void> {
    while (this.timers.size > 0 || this.running.size > 0 || this.queued.size > 0) {
      if (this.running.size > 0) {
        await Promise.all(this.running.values());
      } else {
        await new Promise((r) => setTimeout(r, 10));
      }
    }
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.queued.clear();
  }
}
