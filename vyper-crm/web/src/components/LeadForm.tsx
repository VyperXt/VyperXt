import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useErrorToast, useStages } from "../lib/app-state";
import { parseBRL } from "../lib/format";
import type { Lead } from "../lib/types";
import { Button, Field, Modal } from "./ui";

export function NewLeadModal({ open, onClose, stageId }: { open: boolean; onClose: () => void; stageId?: number }) {
  const qc = useQueryClient();
  const onError = useErrorToast();
  const stages = useStages();
  const empty = { name: "", phone: "", email: "", company: "", interest: "", value: "", notes: "", stageId: stageId ?? 0 };
  // Quem usa o modal passa uma key diferente a cada abertura, então o estado sempre começa limpo
  const [f, setF] = useState(empty);
  const value = parseBRL(f.value);
  const valueInvalid = Number.isNaN(value);
  const m = useMutation({
    mutationFn: () =>
      api<Lead>("/leads", {
        body: {
          name: f.name,
          phone: f.phone || null,
          email: f.email || null,
          company: f.company || null,
          interest: f.interest || null,
          notes: f.notes || null,
          value,
          stageId: f.stageId || stageId || null,
          chatMode: "human",
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads"] });
      setF(empty);
      onClose();
    },
    onError,
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  return (
    <Modal open={open} onClose={onClose} title="Novo lead">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          m.mutate();
        }}
      >
        <Field label="Nome">
          <input className="input" value={f.name} onChange={set("name")} autoFocus />
        </Field>
        <Field label="WhatsApp (com DDD)">
          <input className="input" value={f.phone} onChange={set("phone")} placeholder="11 99999-8888" />
        </Field>
        <Field label="E-mail">
          <input className="input" type="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label="Empresa">
          <input className="input" value={f.company} onChange={set("company")} />
        </Field>
        <Field label="Interesse">
          <input className="input" value={f.interest} onChange={set("interest")} />
        </Field>
        <Field label="Valor (R$)" hint={valueInvalid ? "Valor inválido. Ex.: 1.500,00" : undefined}>
          <input className="input" inputMode="decimal" placeholder="1.500,00" value={f.value} onChange={set("value")} />
        </Field>
        <Field label="Etapa">
          <select className="input" value={f.stageId || stageId || stages.data?.[0]?.id || ""} onChange={(e) => setF({ ...f, stageId: Number(e.target.value) })}>
            {stages.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Anotações">
            <textarea className="input" rows={2} value={f.notes} onChange={set("notes")} />
          </Field>
        </div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={m.isPending} disabled={valueInvalid}>
            Criar lead
          </Button>
        </div>
      </form>
    </Modal>
  );
}
