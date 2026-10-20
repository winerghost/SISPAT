import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

// Rota /og: imagem de compartilhamento (route handler: os arquivos opengraph-image
// quebram o build com a raiz force-dynamic — '/_not-found' sem entry) (1200x630) no tema Factory: canvas #101010, logo
// da AGU, eyebrow mono e título. Sem dados do sistema (é pública).
export const runtime = "nodejs";
const size = { width: 1200, height: 630 };

export async function GET() {
  const logo = await readFile(join(process.cwd(), "src/assets/brand/agu-logo.png"));
  const logoSrc = `data:image/png;base64,${logo.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#101010",
          color: "#eeeeee",
          fontFamily: "sans-serif",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoSrc} width={320} height={190} alt="" style={{ filter: "brightness(1.25)" }} />
        <div
          style={{
            marginTop: 48,
            fontSize: 26,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#eeeeee",
            fontFamily: "monospace",
          }}
        >
          Unidade Estadual de Administração em Tocantins
        </div>
        <div style={{ marginTop: 20, fontSize: 64, fontWeight: 400 }}>SISPAT-AGU</div>
        <div style={{ marginTop: 12, fontSize: 28, color: "#b8b3b0" }}>Sistema de Gestão Patrimonial</div>
        <div style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: 8, background: "#ee6018" }} />
      </div>
    ),
    size,
  );
}
