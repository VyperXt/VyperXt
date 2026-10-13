import { describe, expect, it } from "vitest";
import { MAX_SVG_BYTES, renderSvgToPng, sanitizeSvg } from "../src/lib/render-image.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Largura e altura gravadas no cabeçalho IHDR do PNG */
function pngSize(png: Buffer) {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const ART =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1350">' +
  '<rect width="1080" height="1350" fill="#0b3d91"/>' +
  '<text x="540" y="600" font-family="Noto Sans, DejaVu Sans, Arial, sans-serif" font-size="72" fill="#fff" text-anchor="middle">Ação Promoção ç ã é</text>' +
  "</svg>";

describe("renderSvgToPng", () => {
  it("converte um SVG com acentos em PNG de 1080 de largura (proporção mantida)", async () => {
    const png = await renderSvgToPng(ART);
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(pngSize(png)).toEqual({ width: 1080, height: 1350 });
    expect(png.length).toBeGreaterThan(1000);
  });

  it("respeita a largura pedida", async () => {
    const png = await renderSvgToPng(ART, { width: 540 });
    expect(pngSize(png)).toEqual({ width: 540, height: 675 });
  });

  it("o texto é desenhado (há fonte com acentos no sistema)", async () => {
    const empty = await renderSvgToPng(ART.replace(/<text[\s\S]*<\/text>/, ""));
    const withText = await renderSvgToPng(ART);
    expect(withText.equals(empty)).toBe(false);
  });

  it("recusa SVG grande demais ou que não é SVG", async () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(MAX_SVG_BYTES)}--></svg>`;
    await expect(renderSvgToPng(huge)).rejects.toThrow(/grande demais/);
    await expect(renderSvgToPng("<html><body>oi</body></html>")).rejects.toThrow(/não é um SVG/);
    await expect(renderSvgToPng("<svg xmlns='http://www.w3.org/2000/svg'><rect")).rejects.toThrow(/Não foi possível converter/);
  });

  it("tira links externos e arquivos locais antes de desenhar (nada é buscado fora)", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">' +
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<style>@import url("https://evil.test/a.css"); rect { fill: red; }</style>' +
      '<image href="https://evil.test/x.png" width="10" height="10"/>' +
      "<image xlink:href='/etc/passwd' width='10' height='10'/>" +
      '<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>' +
      '<use href="#a"/><rect id="a" width="5" height="5"/></svg>';
    const clean = sanitizeSvg(svg);
    expect(clean).not.toMatch(/evil\.test/);
    expect(clean).not.toMatch(/etc\/passwd/);
    expect(clean).not.toMatch(/ENTITY|DOCTYPE/);
    expect(clean).toContain('href="data:image/png;base64,iVBORw0KGgo="');
    expect(clean).toContain('href="#a"');
    const png = await renderSvgToPng(svg, { width: 20 });
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  });
});
