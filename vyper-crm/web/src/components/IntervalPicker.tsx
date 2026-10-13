/** Escolha do espaçamento entre as primeiras mensagens de um disparo (evita bloqueio do número). */

const INTERVAL_PRESETS = [1, 2, 5, 10, 15, 30];

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

/** Escolhe de quanto em quanto tempo sai cada primeira mensagem (evita bloqueio do número). */
export function IntervalPicker({ value, onChange, count }: { value: number; onChange: (v: number) => void; count: number }) {
  const custom = !INTERVAL_PRESETS.includes(value);
  const total = Math.max(0, count - 1) * value;
  const risky = value < 2 && count > 5;
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-slate-600">Intervalo entre cada envio</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {INTERVAL_PRESETS.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={value === m}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${
              value === m ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"
            }`}
          >
            {m} min
          </button>
        ))}
        <label
          className={`flex items-center gap-1 rounded-full py-0.5 pr-2.5 pl-1 text-xs ring-1 ${
            custom ? "bg-brand-50 ring-brand-600" : "bg-white ring-slate-300"
          }`}
        >
          <input
            type="number"
            min={1}
            max={120}
            value={value}
            onChange={(e) => onChange(Math.min(120, Math.max(1, Math.round(Number(e.target.value) || 1))))}
            className="w-12 rounded-full bg-transparent px-1.5 py-0.5 text-center outline-none"
            aria-label="Intervalo personalizado em minutos"
          />
          min
        </label>
      </div>
      <p className={`rounded-lg p-2.5 text-xs ring-1 ${risky ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-white text-slate-600 ring-slate-200"}`}>
        {count > 1 ? (
          <>
            A 1ª sai agora e as outras {count - 1} a cada ~{value} min. A última sai em cerca de <b>{formatDuration(total)}</b>.
          </>
        ) : (
          <>A mensagem sai agora.</>
        )}{" "}
        Fora do horário de envio das configurações, elas esperam a próxima janela. Os envios ficam salvos (sobrevivem a um
        reinício do CRM) e aparecem em Automações → Mensagens agendadas.
        {risky && " Intervalos curtos com muitos contatos novos aumentam o risco de bloqueio: prefira 5 min ou mais."}
      </p>
    </div>
  );
}

/** Prévia da primeira mensagem com as variáveis trocadas (mesma regra do servidor, simplificada). */
export function previewFirstMessage(template: string, who: { name?: string | null; company?: string | null }): string {
  const name = (who.name ?? "").trim();
  const firstName = name.split(/\s+/)[0] ?? "";
  const company = (who.company || name).trim();
  return template
    .replace(/\{nome\}/g, name)
    .replace(/\{primeiro_nome\}/g, firstName)
    .replace(/\{empresa\}/g, company)
    .replace(/,\s*!/g, "!")
    .replace(/,\s*\?/g, "?")
    .replace(/ {2,}/g, " ");
}
