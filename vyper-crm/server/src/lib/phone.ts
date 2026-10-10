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
  return canonicalBrazilianMobile(canonicalArgentineMobile(digits));
}

/**
 * Celular argentino no formato local, com o 15 depois do código de área (+54 11 15 2345-6789),
 * vira o formato do WhatsApp, com o 9 depois do 54 (5491123456789). Código de área: 2 a 4 dígitos.
 */
function canonicalArgentineMobile(digits: string): string {
  if (!/^54(?!9)\d{12}$/.test(digits)) return digits;
  for (const areaLen of [2, 3, 4]) {
    if (digits.slice(2 + areaLen, 4 + areaLen) === "15") {
      return `549${digits.slice(2, 2 + areaLen)}${digits.slice(4 + areaLen)}`;
    }
  }
  return digits;
}

/** 55 + DDD + celular de 8 dígitos (começando com 6–9) → insere o 9: 553199998888 → 5531999998888 */
function canonicalBrazilianMobile(digits: string): string {
  const m = digits.match(/^55(\d{2})([6-9]\d{7})$/);
  return m ? `55${m[1]}9${m[2]}` : digits;
}

/**
 * Formas do mesmo número que o WhatsApp pode usar (para achar o lead sem duplicar):
 * - Brasil: com e sem o 9 do celular (5531999998888 ↔ 553199998888)
 * - México: 521 + 10 dígitos ↔ 52 + 10 dígitos
 * - Argentina: 549 + 10 dígitos ↔ 54 + 10 dígitos
 * O primeiro item é sempre o próprio número.
 */
export function phoneVariants(digits: string): string[] {
  const out = [digits];
  const br = digits.match(/^55(\d{2})9([6-9]\d{7})$/);
  if (br) out.push(`55${br[1]}${br[2]}`);
  const brOld = digits.match(/^55(\d{2})([6-9]\d{7})$/);
  if (brOld) out.push(`55${brOld[1]}9${brOld[2]}`);
  const mx = digits.match(/^52(1?)(\d{10})$/);
  if (mx) out.push(mx[1] ? `52${mx[2]}` : `521${mx[2]}`);
  const ar = digits.match(/^54(9?)(\d{10})$/);
  if (ar) out.push(ar[1] ? `54${ar[2]}` : `549${ar[2]}`);
  return [...new Set(out)];
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
