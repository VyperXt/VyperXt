import type { Lead } from "./types";

export function leadName(lead: Pick<Lead, "name" | "waName" | "phone" | "email">): string {
  return lead.name || lead.waName || (lead.phone ? formatPhone(lead.phone) : "") || lead.email || "Sem nome";
}

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return "";
  const m = digits.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return `+${digits}`;
}

/**
 * Lê um valor em reais como as pessoas digitam: "1.500", "1.500,50", "99,90", "99.90", "R$ 2 mil" não.
 * Vazio → null. Inválido → NaN.
 */
export function parseBRL(input: string): number | null {
  const s = input.replace(/R\$|\s/gi, "");
  if (!s) return null;
  let normalized: string;
  if (s.includes(",")) normalized = s.replace(/\./g, "").replace(",", "."); // vírgula = decimal
  else if (/^\d+\.\d{1,2}$/.test(s)) normalized = s; // "99.90" = decimal
  else normalized = s.replace(/\./g, ""); // "1.500" ou "1.500.000" = milhar
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return NaN;
  return Number(normalized);
}

/** Valor salvo → texto para editar no padrão brasileiro (1500.5 → "1500,5") */
export function toBRLInput(v: number | null | undefined): string {
  return v == null ? "" : String(v).replace(".", ",");
}

export const money = (v: number | null | undefined) =>
  v == null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "agora";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d`;
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function formatDelay(minutes: number): string {
  if (minutes === 0) return "na hora";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${+(minutes / 60).toFixed(1)} h`;
  return `${+(minutes / 1440).toFixed(1)} dia(s)`;
}

export const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  manual: "Manual",
  n8n: "n8n",
  formulario: "Formulário",
  importacao: "Importação",
  "captador-ia": "Captador IA",
  "prospeccao-ia": "Prospecção IA",
};

/** Erro gravado pelo servidor quando o envio falha porque o número não tem WhatsApp (igual ao do servidor). */
export const NOT_ON_WHATSAPP_ERROR = "Este número não tem WhatsApp (conferido com e sem o 9).";
