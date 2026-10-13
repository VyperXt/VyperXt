import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderAsync } from "@resvg/resvg-js";

/** Maior SVG aceito (em bytes) */
export const MAX_SVG_BYTES = 2 * 1024 * 1024;
const DEFAULT_WIDTH = 1080;
const MAX_WIDTH = 4096;

// Fonte padrão para textos sem font-family que exista: no Docker instalamos DejaVu e Noto; no Windows há Arial.
const DEFAULT_FAMILY = process.platform === "win32" ? "Arial" : process.platform === "darwin" ? "Helvetica" : "DejaVu Sans";
// No Linux sem fontconfig (imagem node:22-slim) as fontes do sistema não são achadas sozinhas: apontamos as pastas
const FONT_DIRS =
  process.platform === "win32" || process.platform === "darwin"
    ? []
    : ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".fonts"), path.join(os.homedir(), ".local/share/fonts")].filter(
        (d) => existsSync(d),
      );

/**
 * Converte um SVG (arte feita pela IA) em PNG. Nada é buscado fora: links externos e arquivos locais
 * referenciados pelo SVG são removidos antes; só ficam referências internas (#id) e imagens embutidas (data:).
 */
export async function renderSvgToPng(svg: string, opts: { width?: number } = {}): Promise<Buffer> {
  if (Buffer.byteLength(svg, "utf8") > MAX_SVG_BYTES) {
    throw new Error(`SVG grande demais (máximo ${MAX_SVG_BYTES / 1024 / 1024} MB).`);
  }
  if (!/<svg[\s>]/i.test(svg)) throw new Error("O conteúdo não é um SVG.");
  const width = Math.round(Math.min(Math.max(opts.width ?? DEFAULT_WIDTH, 16), MAX_WIDTH));
  try {
    const image = await renderAsync(sanitizeSvg(svg), {
      fitTo: { mode: "width", value: width },
      font: {
        loadSystemFonts: true,
        fontDirs: FONT_DIRS,
        defaultFontFamily: DEFAULT_FAMILY,
        sansSerifFamily: DEFAULT_FAMILY,
      },
      logLevel: "off",
    });
    return Buffer.from(image.asPng());
  } catch (err) {
    throw new Error(`Não foi possível converter o SVG em imagem: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Remove o que poderia buscar algo fora do SVG: DOCTYPE/entidades, href/xlink:href que não sejam "#id" ou
 * imagem embutida (data:image/png|jpeg|gif|webp) e @import em <style>.
 */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/\s(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (attr, _q, dq: string | undefined, sq: string | undefined) => {
      const value = (dq ?? sq ?? "").trim();
      return isSafeHref(value) ? attr : "";
    })
    .replace(/@import[^;]*;?/gi, "");
}

function isSafeHref(value: string): boolean {
  if (value.startsWith("#")) return true;
  return /^data:image\/(png|jpe?g|gif|webp)[;,]/i.test(value);
}
