/**
 * Normaliza um telefone para apenas dígitos com DDI.
 * Números digitados sem DDI (10 ou 11 dígitos, sem "+") são tratados como brasileiros e recebem o 55.
 * Ids do WhatsApp (com "@") e números de webhooks (international = true) já vêm com DDI.
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
  return digits;
}

export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return "";
  const m = digits.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  if (m) return `+55 (${m[1]}) ${m[2]}-${m[3]}`;
  return `+${digits}`;
}
