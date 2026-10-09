/**
 * Normaliza um telefone para apenas dígitos com DDI.
 * Números digitados sem DDI (10 ou 11 dígitos, sem "+") são tratados como brasileiros e recebem o 55.
 * Ids do WhatsApp (com "@") e números de webhooks (international = true) já vêm com DDI.
 * Celulares brasileiros sempre ficam com o 9 na frente (formato canônico de 13 dígitos),
 * porque o WhatsApp às vezes manda o mesmo número sem o 9 (ex.: 553199998888@s.whatsapp.net).
 */
export function normalizePhone(
  input: string | null | undefined,
  opts: { international?: boolean } = {},
): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  const isJid = trimmed.includes("@");
  // Remove sufixos do WhatsApp (ex.: 5511999998888@s.whatsapp.net ou :12@s.whatsapp.net)
  const raw = trimmed.split("@")[0]!.split(":")[0]!;
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const hasCountryCode = opts.international || isJid || raw.startsWith("+") || raw.startsWith("00");
  if (raw.startsWith("00")) digits = digits.slice(2);
  if (!hasCountryCode && (digits.length === 10 || digits.length === 11)) digits = `55${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return canonicalBrazilianMobile(digits);
}

/** 55 + DDD + celular de 8 dígitos (começando com 6–9) → insere o 9: 553199998888 → 5531999998888 */
function canonicalBrazilianMobile(digits: string): string {
  const m = digits.match(/^55(\d{2})([6-9]\d{7})$/);
  return m ? `55${m[1]}9${m[2]}` : digits;
}

/**
 * Para repassar um número JÁ normalizado a funções que normalizam de novo (createLead/updateLead):
 * o "+" garante que o DDI não seja confundido com DDD (ex.: +1 415..., +33 6...).
 */
export function asPhoneInput(digits: string): string {
  return `+${digits}`;
}

export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return "";
  const m = digits.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  if (m) return `+55 (${m[1]}) ${m[2]}-${m[3]}`;
  return `+${digits}`;
}
