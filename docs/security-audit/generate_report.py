#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gera `relatorio-auditoria-seguranca.pdf` a partir de `achados.md`.

Uso:
    (venv) python docs/security-audit/generate_report.py

Dependências (instaladas apenas no venv local `docs/security-audit/.venv`,
nunca global/--user): reportlab, matplotlib.

Este script faz um parsing simples e específico (não genérico) de
`achados.md`, suficiente apenas para extrair as seções que este relatório
precisa. Não é um parser de Markdown de uso geral.

Nota sobre os números de severidade usados no resumo executivo:
`achados.md`, seção 5.1, lista a contagem "bruta" por severidade, mas a
própria seção 5.2 (nota de reconciliação) aponta uma inconsistência entre
a tabela 5.1 e a tabela 5.2 quanto à nota informativa "HS256 vs. JWKS", e
resolve explicitamente a contagem líquida de achados reais (excluindo
verificações "OK" como SEC-2, e excluindo N/A) como:

    1 Média, 3 Baixa, 6 Informativa  (total 10)

Essa é a contagem líquida/reconciliada que o próprio documento declara
como correta, e é a que este script usa nos gráficos e no resumo
executivo, citando a fonte (achados.md, seção 5.2, nota de reconciliação).
Os achados "N/A" (categorias 3-IDOR e 5-XSS, não aplicáveis nesta fase) e
a verificação SEC-2 ("OK", sem achado) são reportados separadamente, não
somados como vulnerabilidades.
"""

from __future__ import annotations

import io
import re
import sys
from datetime import date
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.platypus import (
    Flowable,
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

# ---------------------------------------------------------------------------
# Caminhos e constantes
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
ACHADOS_PATH = ROOT / "achados.md"
OUTPUT_PATH = ROOT / "relatorio-auditoria-seguranca.pdf"

REPORT_TITLE = "Relatório de Auditoria de Segurança — SISPAT-AGU"
TODAY = date.today().strftime("%d/%m/%Y")

# Paleta exata exigida
COLOR_CRITICA = colors.HexColor("#B91C1C")
COLOR_ALTA = colors.HexColor("#EA580C")
COLOR_MEDIA = colors.HexColor("#D97706")
COLOR_BAIXA = colors.HexColor("#2563EB")
COLOR_PONTO_FORTE = colors.HexColor("#059669")
COLOR_NA = colors.HexColor("#9CA3AF")  # cinza neutro só para N/A (fora da paleta de severidade)
COLOR_INFORMATIVA = colors.HexColor("#6B7280")  # cinza-azulado para "Informativa" (fora das 4 severidades nomeadas)

SEVERITY_COLORS_HEX = {
    "Crítica": "#B91C1C",
    "Alta": "#EA580C",
    "Média": "#D97706",
    "Baixa": "#2563EB",
    "Informativa": "#6B7280",
}
SEVERITY_COLORS_RL = {
    "Crítica": COLOR_CRITICA,
    "Alta": COLOR_ALTA,
    "Média": COLOR_MEDIA,
    "Baixa": COLOR_BAIXA,
    "Informativa": COLOR_INFORMATIVA,
}

# Contagem líquida/reconciliada de achados reais por severidade
# (ver nota no docstring do módulo — fonte: achados.md secao 5.2, nota de reconciliação)
SEVERITY_COUNTS = {
    "Crítica": 0,
    "Alta": 0,
    "Média": 1,
    "Baixa": 3,
    "Informativa": 6,
}

# Contagem de achados reais por categoria (excluindo N/A e verificações "OK")
# Categoria 1 (RLS): RLS-1(Média) + RLS-4(Baixa) + RLS-2(Info) + RLS-3(Info) + nota HS256/JWKS(Info) = 5
# Categoria 2 (Permissão no cliente): PERM-1(Info) = 1
# Categoria 3 (IDOR): não aplicável nesta fase = 0
# Categoria 4 (Segredos expostos): SEC-1(Baixa) + SEC-5(Baixa) + SEC-3(Info) + SEC-4(Info) = 4 (SEC-2 é "OK", não contado)
# Categoria 5 (XSS): não aplicável nesta fase = 0
CATEGORY_COUNTS = [
    ("1. Isolamento\nde dados (RLS)", 5),
    ("2. Permissão\nno cliente", 1),
    ("3. IDOR", 0),
    ("4. Segredos\nexpostos", 4),
    ("5. XSS", 0),
]

PAGE_SIZE = A4
MARGIN = 2 * cm

# ---------------------------------------------------------------------------
# Fonte: preferir DejaVu Sans (boa cobertura de acentuação PT-BR) se disponível
# via matplotlib; para o PDF usamos as fontes padrão do ReportLab (Helvetica),
# que já cobrem corretamente os caracteres acentuados do português via latin-1/
# CP1252 embutido no PDF (ReportLab usa WinAnsiEncoding por padrão nas fontes
# Base14, que cobre à, ã, ç, é, ê, í, ó, ô, ú etc.).
# ---------------------------------------------------------------------------

FONT_REGULAR = "Helvetica"
FONT_BOLD = "Helvetica-Bold"
FONT_OBLIQUE = "Helvetica-Oblique"
FONT_MONO = "Courier"
FONT_MONO_BOLD = "Courier-Bold"


# ---------------------------------------------------------------------------
# Parsing simples e específico de achados.md
# ---------------------------------------------------------------------------


def read_source() -> str:
    if not ACHADOS_PATH.exists():
        raise FileNotFoundError(f"Não encontrei {ACHADOS_PATH}")
    return ACHADOS_PATH.read_text(encoding="utf-8")


def extract_section(text: str, start_heading: str, end_headings: list[str]) -> str:
    """Extrai o conteúdo entre um heading `## N. Título` (ou `### ...`) e o
    próximo heading de nível igual ou maior dentre `end_headings`, ou fim do
    texto."""
    start_idx = text.find(start_heading)
    if start_idx == -1:
        return ""
    start_idx += len(start_heading)
    end_idx = len(text)
    for h in end_headings:
        idx = text.find(h, start_idx)
        if idx != -1:
            end_idx = min(end_idx, idx)
    return text[start_idx:end_idx].strip()


def extract_strong_points(text: str) -> list[str]:
    """Extrai a lista numerada da seção '## 3. Pontos fortes'."""
    section = extract_section(text, "## 3. Pontos fortes", ["\n---\n\n## 4."])
    items = re.findall(r"^\d+\.\s+(.*?)(?=\n\d+\.\s|\Z)", section, flags=re.S | re.M)
    cleaned = []
    for it in items:
        it = " ".join(it.strip().split())
        cleaned.append(it)
    return cleaned


def extract_findings_by_category(text: str) -> list[dict]:
    """Extrai, por categoria (### Categoria N — ...), os blocos de achado
    (#### CODIGO — título) com severidade, arquivos/evidência e descrição.
    """
    cat_section = extract_section(text, "## 4. Achados detalhados por categoria", ["\n---\n\n## 5."])
    categories = re.split(r"\n### ", cat_section)
    results = []
    for block in categories:
        block = block.strip()
        if block.startswith("### "):
            # O primeiro bloco do split mantém o prefixo "### " porque a
            # seção começa diretamente com o heading, sem newline anterior.
            block = block[4:].strip()
        if not block.startswith("Categoria"):
            continue
        title_line, _, rest = block.partition("\n")
        cat_title = title_line.strip()
        findings = re.split(r"\n#### ", rest)
        parsed_findings = []
        for f in findings:
            f = f.strip()
            if not f:
                continue
            f_title_line, _, f_body = f.partition("\n")
            # Remove separador markdown "---" residual de fim de seção/categoria
            f_body = re.sub(r"\n+-{3,}\s*$", "", f_body.rstrip())
            sev_match = re.search(r"\*\*Severidade:\*\*\s*(.+)", f_body)
            severity_raw = sev_match.group(1).strip() if sev_match else "N/A"
            # Normaliza severidade para uma das chaves conhecidas
            severity_norm = normalize_severity(severity_raw)
            # Arquivo(s): tenta capturar a linha "**Arquivo(s):**" ou "**Evidência:**"
            file_match = re.search(r"\*\*Arquivos?:\*\*\s*(.+)", f_body)
            if not file_match:
                file_match = re.search(r"\*\*Evidência(?:[^:]*)?:\*\*\s*(.+)", f_body)
            file_ref = file_match.group(1).strip() if file_match else "—"
            file_ref = re.sub(r"\s+", " ", file_ref)
            # descrição curta: a linha "Por que é relevante" ou primeira frase relevante
            desc_match = re.search(r"\*\*Por que[^:]*:\*\*\s*(.+)", f_body)
            if desc_match:
                desc = desc_match.group(1).strip()
            else:
                desc = first_non_metadata_bullet(f_body)
            desc = re.sub(r"\s+", " ", desc)
            parsed_findings.append(
                {
                    "codigo_titulo": f_title_line.strip(),
                    "severidade": severity_norm,
                    "arquivo": file_ref,
                    "descricao": desc,
                }
            )
        results.append({"categoria": cat_title, "achados": parsed_findings})
    return results


def normalize_severity(raw: str) -> str:
    raw_low = raw.lower()
    # Casos híbridos declarados no próprio texto-fonte (ex.: "Baixa/Informativa
    # (auto-documentada...)") são reclassificados como Informativa, igual à
    # nota de reconciliação da seção 5.2 de achados.md.
    if "informativa" in raw_low:
        return "Informativa"
    if "crítica" in raw_low or "critica" in raw_low:
        return "Crítica"
    if "alta" in raw_low:
        return "Alta"
    if "média" in raw_low or "media" in raw_low:
        return "Média"
    if "baixa" in raw_low:
        return "Baixa"
    if "n/a" in raw_low:
        return "N/A"
    return "Informativa"


_METADATA_LABEL_PREFIXES = (
    "severidade",
    "arquivo",
    "arquivos",
    "evidência",
    "evidencia",
    "confirmação",
    "confirmacao",
    "por que",
    "condições",
    "condicoes",
    "recomendação",
    "recomendacao",
)


def first_non_metadata_bullet(body: str) -> str:
    """Encontra o primeiro item de lista (`- texto` ou `- **Label:** texto`)
    cujo rótulo não é um dos campos de metadado conhecidos (Severidade,
    Arquivo(s), Evidência, Por que..., Recomendação etc.) — usado como
    descrição de fallback quando não há um rótulo "Por que..." explícito."""
    items = re.split(r"\n-\s+", "\n" + body.strip())
    for item in items:
        item = item.strip()
        if not item:
            continue
        label_match = re.match(r"\*\*([^*:]+):\*\*\s*(.*)", item, flags=re.S)
        if label_match:
            label = label_match.group(1).strip().lower()
            if any(label.startswith(p) for p in _METADATA_LABEL_PREFIXES):
                continue
            return label_match.group(2).strip() or item
        # item de texto puro, sem rótulo em negrito — é a descrição
        return item
    return body.strip().split("\n")[0].strip()


def extract_recommendations(text: str) -> str:
    return extract_section(text, "## 6. Recomendações priorizadas", ["\n---\n\n## 7."])


def extract_issues(text: str) -> list[str]:
    """Extrai cada bloco --- ISSUE n --- ... --- FIM ISSUE n --- com os
    delimitadores preservados."""
    pattern = re.compile(r"--- ISSUE \d+ ---.*?--- FIM ISSUE \d+ ---", re.S)
    return pattern.findall(text)


# ---------------------------------------------------------------------------
# Geração dos gráficos (matplotlib -> PNG em memória)
# ---------------------------------------------------------------------------


def make_donut_chart() -> io.BytesIO:
    labels = []
    sizes = []
    colors_list = []
    for sev, count in SEVERITY_COUNTS.items():
        if count <= 0:
            continue
        labels.append(f"{sev} ({count})")
        sizes.append(count)
        colors_list.append(SEVERITY_COLORS_HEX[sev])

    fig, ax = plt.subplots(figsize=(4.6, 4.2), dpi=200)
    wedges, _texts = ax.pie(
        sizes,
        colors=colors_list,
        startangle=90,
        wedgeprops=dict(width=0.42, edgecolor="white", linewidth=1.5),
    )
    total = sum(sizes)
    ax.text(0, 0, f"{total}\nachados", ha="center", va="center", fontsize=15, fontweight="bold", color="#1F2937")
    ax.legend(
        wedges,
        labels,
        loc="lower center",
        bbox_to_anchor=(0.5, -0.22),
        ncol=2,
        frameon=False,
        fontsize=9.5,
    )
    ax.set_title("Achados por severidade (líquido, excl. N/A)", fontsize=11.5, fontweight="bold", color="#1F2937", pad=10)
    ax.set_aspect("equal")
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf


def make_bar_chart() -> io.BytesIO:
    cats = [c for c, _ in CATEGORY_COUNTS]
    vals = [v for _, v in CATEGORY_COUNTS]
    bar_color = "#2563EB"

    fig, ax = plt.subplots(figsize=(6.4, 4.0), dpi=200)
    bars = ax.bar(cats, vals, color=bar_color, width=0.55, zorder=3)
    for rect, v in zip(bars, vals):
        ax.text(
            rect.get_x() + rect.get_width() / 2,
            rect.get_height() + 0.08,
            str(v),
            ha="center",
            va="bottom",
            fontsize=10,
            fontweight="bold",
            color="#1F2937",
        )
    ax.set_ylim(0, max(vals) + 1.3)
    ax.set_yticks(range(0, max(vals) + 2))
    ax.set_ylabel("Nº de achados", fontsize=10)
    ax.set_title("Achados por categoria", fontsize=12, fontweight="bold", color="#1F2937", pad=10)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.spines["left"].set_color("#D1D5DB")
    ax.spines["bottom"].set_color("#D1D5DB")
    ax.tick_params(axis="x", labelsize=8.6)
    ax.tick_params(axis="y", labelsize=9)
    ax.grid(axis="y", color="#E5E7EB", linewidth=0.8, zorder=0)
    fig.tight_layout()

    buf = io.BytesIO()
    fig.savefig(buf, format="png", transparent=True, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf


# ---------------------------------------------------------------------------
# Cabeçalho / rodapé
# ---------------------------------------------------------------------------


def draw_header_footer(canv: pdf_canvas.Canvas, doc) -> None:
    canv.saveState()
    width, height = PAGE_SIZE

    # Cabeçalho
    canv.setFont(FONT_REGULAR, 8.2)
    canv.setFillColor(colors.HexColor("#4B5563"))
    canv.drawString(MARGIN, height - MARGIN + 0.55 * cm, REPORT_TITLE)
    canv.drawRightString(width - MARGIN, height - MARGIN + 0.55 * cm, "SISPAT-AGU · SecOps")
    canv.setStrokeColor(colors.HexColor("#D1D5DB"))
    canv.setLineWidth(0.6)
    canv.line(MARGIN, height - MARGIN + 0.35 * cm, width - MARGIN, height - MARGIN + 0.35 * cm)

    # Rodapé
    canv.setFont(FONT_REGULAR, 8)
    canv.setFillColor(colors.HexColor("#6B7280"))
    canv.line(MARGIN, MARGIN - 0.35 * cm, width - MARGIN, MARGIN - 0.35 * cm)
    canv.drawString(MARGIN, MARGIN - 0.6 * cm, f"{REPORT_TITLE} — {TODAY}")
    canv.drawRightString(width - MARGIN, MARGIN - 0.6 * cm, f"Página {doc.page}")
    canv.restoreState()


# ---------------------------------------------------------------------------
# Estilos
# ---------------------------------------------------------------------------


def build_styles():
    ss = getSampleStyleSheet()
    styles = {}
    styles["CoverTitle"] = ParagraphStyle(
        "CoverTitle",
        parent=ss["Title"],
        fontName=FONT_BOLD,
        fontSize=25,
        leading=31,
        textColor=colors.HexColor("#111827"),
        alignment=TA_LEFT,
        spaceAfter=10,
    )
    styles["CoverSub"] = ParagraphStyle(
        "CoverSub",
        parent=ss["Normal"],
        fontName=FONT_REGULAR,
        fontSize=12,
        leading=16,
        textColor=colors.HexColor("#374151"),
        spaceAfter=4,
    )
    styles["H1"] = ParagraphStyle(
        "H1",
        parent=ss["Heading1"],
        fontName=FONT_BOLD,
        fontSize=17,
        leading=21,
        textColor=colors.HexColor("#111827"),
        spaceBefore=4,
        spaceAfter=10,
        borderPadding=0,
    )
    styles["H2"] = ParagraphStyle(
        "H2",
        parent=ss["Heading2"],
        fontName=FONT_BOLD,
        fontSize=13,
        leading=17,
        textColor=colors.HexColor("#1F2937"),
        spaceBefore=12,
        spaceAfter=6,
    )
    styles["H3"] = ParagraphStyle(
        "H3",
        parent=ss["Heading3"],
        fontName=FONT_BOLD,
        fontSize=11,
        leading=14,
        textColor=colors.HexColor("#1F2937"),
        spaceBefore=8,
        spaceAfter=4,
    )
    styles["Body"] = ParagraphStyle(
        "Body",
        parent=ss["Normal"],
        fontName=FONT_REGULAR,
        fontSize=9.6,
        leading=13.4,
        alignment=TA_JUSTIFY,
        textColor=colors.HexColor("#1F2937"),
        spaceAfter=6,
    )
    styles["BodySmall"] = ParagraphStyle(
        "BodySmall",
        parent=styles["Body"],
        fontSize=8.6,
        leading=11.8,
    )
    styles["Bullet"] = ParagraphStyle(
        "Bullet",
        parent=styles["Body"],
        leftIndent=12,
        bulletIndent=0,
        spaceAfter=5,
    )
    styles["Note"] = ParagraphStyle(
        "Note",
        parent=styles["Body"],
        fontName=FONT_OBLIQUE,
        fontSize=8.6,
        leading=11.6,
        textColor=colors.HexColor("#6B7280"),
    )
    styles["Mono"] = ParagraphStyle(
        "Mono",
        parent=ss["Normal"],
        fontName=FONT_MONO,
        fontSize=7.6,
        leading=10.2,
        textColor=colors.HexColor("#111827"),
        backColor=colors.HexColor("#F3F4F6"),
        borderPadding=(5, 6, 5, 6),
        spaceBefore=3,
        spaceAfter=6,
    )
    styles["IssueDelim"] = ParagraphStyle(
        "IssueDelim",
        parent=ss["Normal"],
        fontName=FONT_MONO_BOLD,
        fontSize=9,
        leading=12,
        textColor=colors.white,
        backColor=colors.HexColor("#1F2937"),
        alignment=TA_CENTER,
        borderPadding=(4, 6, 4, 6),
        spaceBefore=10,
        spaceAfter=6,
    )
    styles["IssueTitle"] = ParagraphStyle(
        "IssueTitle",
        parent=ss["Normal"],
        fontName=FONT_BOLD,
        fontSize=11,
        leading=14,
        textColor=colors.HexColor("#111827"),
        spaceBefore=2,
        spaceAfter=6,
    )
    styles["IssueLabel"] = ParagraphStyle(
        "IssueLabel",
        parent=styles["Body"],
        fontName=FONT_BOLD,
        fontSize=9.4,
        spaceBefore=6,
        spaceAfter=2,
    )
    return styles


# ---------------------------------------------------------------------------
# Helpers de conteúdo (markdown simplificado -> texto/html do reportlab)
# ---------------------------------------------------------------------------


def md_inline_to_rl(text: str) -> str:
    """Converte um subconjunto pequeno de markdown inline (negrito, código,
    links) para marcação aceita pelo Paragraph do ReportLab, e escapa XML."""
    text = text.strip()
    # Escapa entidades XML primeiro
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    # Código inline `...`
    text = re.sub(r"`([^`]+)`", r'<font face="Courier" size="8.4" color="#B91C1C">\1</font>', text)
    # Negrito **...**
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    return text


def severity_chip(severity: str):
    """Retorna uma mini-Table (2 colunas internas simuladas via Table de 1
    célula com cor de fundo) representando o chip colorido de severidade."""
    color = SEVERITY_COLORS_RL.get(severity, COLOR_NA)
    text_color = colors.white
    t = Table(
        [[severity]],
        colWidths=[1.55 * cm if len(severity) <= 6 else 2.15 * cm],
        rowHeights=[0.46 * cm],
    )
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), color),
                ("TEXTCOLOR", (0, 0), (-1, -1), text_color),
                ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("FONTNAME", (0, 0), (-1, -1), FONT_BOLD),
                ("FONTSIZE", (0, 0), (-1, -1), 7.6),
                ("TOPPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("ROUNDEDCORNERS", [4, 4, 4, 4]),
            ]
        )
    )
    return t


# ---------------------------------------------------------------------------
# Montagem do PDF
# ---------------------------------------------------------------------------


def build_pdf(source_text: str) -> None:
    styles = build_styles()
    strong_points = extract_strong_points(source_text)
    findings_by_cat = extract_findings_by_category(source_text)
    recommendations_raw = extract_recommendations(source_text)
    issues = extract_issues(source_text)

    doc = SimpleDocTemplate(
        str(OUTPUT_PATH),
        pagesize=PAGE_SIZE,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN + 0.4 * cm,
        bottomMargin=MARGIN + 0.3 * cm,
        title=REPORT_TITLE,
        author="Agente de Segurança da Informação / SecOps",
    )

    story: list = []

    # ---------------- CAPA ----------------
    story.append(Spacer(1, 1.6 * cm))
    story.append(Paragraph("Relatório de Auditoria de Segurança", styles["CoverTitle"]))
    story.append(Paragraph("SISPAT-AGU", ParagraphStyle(
        "CoverTitle2", parent=styles["CoverTitle"], fontSize=20, textColor=colors.HexColor("#2563EB"),
    )))
    story.append(Spacer(1, 0.4 * cm))
    story.append(Paragraph(f"Data do relatório: {TODAY}", styles["CoverSub"]))
    story.append(Paragraph(
        "Auditor: Agente de Segurança da Informação / SecOps (auditoria de código real, sem especulação)",
        styles["CoverSub"],
    ))
    story.append(Paragraph(
        "Diretório raiz auditado: <font face=\"Courier\" size=\"9\">"
        "C:\\Users\\winer\\Videos\\School\\INVENTARIOAGU\\SISPAT-AGU</font>",
        styles["CoverSub"],
    ))
    story.append(Spacer(1, 0.9 * cm))

    story.append(Paragraph("Escopo auditado", styles["H3"]))
    escopo_items = [
        "Backend Flask (Python 3.12, factory create_app, Gunicorn) com SQLAlchemy 2.x e migrações Alembic "
        "(mais espelho .sql manual).",
        "Banco PostgreSQL via Supabase remoto (projeto tocbtonqnahmtegfkrmn) — inspecionado via código e via "
        "estado real do banco (MCP: list_tables, get_advisors, execute_sql).",
        "Autenticação via Supabase Auth (JWT HS256/PyJWT) e autorização via RBAC próprio (roles, permissions, "
        "escopo por unidade).",
        "Frontend Next.js 14 / React 18 / TypeScript / Tailwind (sem autenticação de frontend implementada "
        "ainda).",
        "Infraestrutura: Docker Compose (base + override dev), ausência de CI, ausência de repositório git "
        "inicializado.",
        "Categorias avaliadas: (1) isolamento de dados/RLS, (2) permissão definida no cliente, (3) IDOR, "
        "(4) segredos expostos, (5) XSS.",
    ]
    for it in escopo_items:
        story.append(Paragraph("• " + md_inline_to_rl(it), styles["Bullet"]))

    story.append(Spacer(1, 0.5 * cm))
    story.append(Paragraph("Nota metodológica", styles["H3"]))
    story.append(Paragraph(
        "Todo achado foi confirmado por leitura direta do código/config/migrações no momento da auditoria "
        "e/ou por consulta ao estado real do banco Supabase via MCP. Nenhum achado é especulativo; quando uma "
        "categoria não se aplica porque a funcionalidade correspondente ainda não existe (ex.: IDOR, XSS), "
        "isso é declarado explicitamente em vez de forçar um achado artificial. O mapeamento de cada categoria "
        "para a stack real do projeto foi feito da seguinte forma:",
        styles["Body"],
    ))
    metodologia_items = [
        "<b>Isolamento de dados (RLS/tenant):</b> leitura completa das migrações Alembic/SQL e consulta direta "
        "ao Supabase real via MCP (list_tables, get_advisors, execute_sql em pg_roles), cruzada com "
        "backend/app/database/session.py e backend/app/config/settings.py para confirmar qual credencial o "
        "backend usa (SQLAlchemy direto vs. API Supabase).",
        "<b>Permissão no cliente:</b> leitura integral do frontend Next.js (componentes de navegação/layout) "
        "cruzada com os blueprints Flask reais, para confirmar que nenhuma rota sensível depende apenas da UI.",
        "<b>IDOR:</b> enumeração completa (grep) de todas as rotas/blueprints Flask existentes em "
        "backend/app/ — sem amostragem.",
        "<b>Segredos expostos:</b> leitura integral de arquivos de configuração, Docker Compose, Dockerfiles, "
        "scripts e documentação, com grep por padrões de senha/token/chave em toda a árvore.",
        "<b>XSS:</b> grep exaustivo no frontend por dangerouslySetInnerHTML/innerHTML/eval/new Function, e no "
        "backend por render_template/Markup/Jinja.",
    ]
    for it in metodologia_items:
        story.append(Paragraph("• " + it, styles["Bullet"]))

    story.append(PageBreak())

    # ---------------- RESUMO EXECUTIVO ----------------
    story.append(Paragraph("Resumo executivo", styles["H1"]))
    story.append(Paragraph(
        "Esta auditoria identificou <b>10 achados reais</b> (excluindo verificações sem pendência e "
        "categorias não aplicáveis nesta fase), nenhum deles de severidade Crítica ou Alta. "
        "Duas categorias (IDOR e XSS) foram avaliadas como <b>não aplicáveis</b> nesta fase do projeto, "
        "porque a funcionalidade correspondente (endpoints de dados reais, renderização de conteúdo de "
        "usuário) ainda não existe — não por ausência de verificação.",
        styles["Body"],
    ))

    donut_buf = make_donut_chart()
    bar_buf = make_bar_chart()
    donut_img = Image(donut_buf, width=8.1 * cm, height=7.4 * cm)
    bar_img = Image(bar_buf, width=9.6 * cm, height=6.0 * cm)

    chart_table = Table(
        [[donut_img, bar_img]],
        colWidths=[8.3 * cm, 9.8 * cm],
    )
    chart_table.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(Spacer(1, 0.2 * cm))
    story.append(chart_table)
    story.append(Paragraph(
        "Nota sobre a contagem: a tabela-resumo de achados.md (seção 5) contém duas visões — uma contagem "
        "\"bruta\" por linha de tabela e uma nota de reconciliação que resolve a contagem líquida real de "
        "achados por severidade. Este relatório usa a contagem líquida reconciliada declarada no próprio "
        "documento-fonte (1 Média, 3 Baixa, 6 Informativa), excluindo a verificação SEC-2 (resultado \"OK\", "
        "sem achado) e as 2 categorias N/A (IDOR, XSS).",
        styles["Note"],
    ))

    story.append(Spacer(1, 0.3 * cm))
    severity_summary_data = [["Severidade", "Quantidade"]]
    for sev, count in SEVERITY_COUNTS.items():
        severity_summary_data.append([sev, str(count)])
    severity_summary_data.append(["N/A (categoria não aplicável nesta fase)", "2"])
    severity_summary_data.append(["Verificação sem achado (SEC-2)", "1"])
    sev_table = Table(severity_summary_data, colWidths=[10.5 * cm, 6.5 * cm])
    sev_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
        ("FONTNAME", (0, 1), (-1, -1), FONT_REGULAR),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F2937")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F4F6")]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D5DB")),
        ("ALIGN", (1, 0), (1, -1), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(sev_table)

    story.append(PageBreak())

    # ---------------- PONTOS FORTES E FRACOS ----------------
    story.append(Paragraph("Pontos fortes", styles["H1"]))
    story.append(Paragraph(
        "Os itens abaixo foram confirmados com evidência direta de código/config durante a auditoria "
        "(fonte: achados.md, seção 3).",
        styles["Body"],
    ))
    for idx, point in enumerate(strong_points, start=1):
        marker = Table(
            [[Paragraph("✓", ParagraphStyle("chk", fontName=FONT_BOLD, fontSize=10, textColor=colors.white, alignment=TA_CENTER))]],
            colWidths=[0.55 * cm],
            rowHeights=[0.55 * cm],
        )
        marker.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), COLOR_PONTO_FORTE),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ]))
        row = Table(
            [[marker, Paragraph(md_inline_to_rl(point), styles["BodySmall"])]],
            colWidths=[0.75 * cm, 15.95 * cm],
        )
        row.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(row)

    story.append(Spacer(1, 0.3 * cm))
    story.append(Paragraph("Pontos fracos (riscos centrais reais)", styles["H1"]))
    story.append(Paragraph(
        "Diferente dos pontos fortes, os riscos centrais reais identificados nesta auditoria são "
        "<b>poucos e de severidade limitada</b> — não há achados Crítica ou Alta. Os itens abaixo resumem "
        "apenas os riscos de maior relevância relativa (Média e Baixa); os demais achados (Informativa) são "
        "melhorias de robustez/documentação, não vulnerabilidades exploráveis hoje, e estão detalhados na "
        "seção de achados.",
        styles["Body"],
    ))
    weak_points = [
        ("Média", "RLS-1 — RLS habilitado em produção (Supabase), mas não reproduzível via migração "
                   "versionada. Se o schema for recriado a partir das migrações do repositório, o RLS não "
                   "será habilitado automaticamente, revertendo silenciosamente a postura fail-closed."),
        ("Baixa", "SEC-1 — Default de senha previsível (sispat_dev) para o Postgres de desenvolvimento "
                   "local, mitigado por profile explícito e bind em 127.0.0.1, mas ainda um padrão reutilizável "
                   "por engano."),
        ("Baixa", "SEC-5 — ProxyFix confia incondicionalmente nos cabeçalhos X-Forwarded-* sem validar o IP "
                   "de origem, mitigado hoje pela topologia de rede (bind em 127.0.0.1), mas frágil a mudanças "
                   "futuras de topologia."),
        ("Baixa", "RLS-4 — Extensão pg_trgm instalada no schema public em vez de um schema dedicado "
                   "(boa prática do Supabase, sem exploração identificada)."),
    ]
    for sev, desc in weak_points:
        chip = severity_chip(sev)
        row = Table(
            [[chip, Paragraph(md_inline_to_rl(desc), styles["BodySmall"])]],
            colWidths=[1.9 * cm, 14.8 * cm],
        )
        row.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 2),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ]))
        story.append(row)

    story.append(PageBreak())

    # ---------------- TABELA DE ACHADOS DETALHADOS ----------------
    story.append(Paragraph("Achados detalhados por categoria", styles["H1"]))
    for cat in findings_by_cat:
        real_findings = [f for f in cat["achados"] if f["severidade"] != "N/A"]
        story.append(Paragraph(cat["categoria"], styles["H2"]))
        if not real_findings:
            story.append(Paragraph(
                "Categoria não aplicável nesta fase (ver detalhes na seção de rascunho/achados-fonte) — "
                "nenhuma vulnerabilidade a listar porque a funcionalidade correspondente ainda não existe.",
                styles["Body"],
            ))
            continue

        table_data = [["Severidade", "Arquivo:linha", "Descrição"]]
        row_styles_extra = []
        for f in real_findings:
            chip = severity_chip(f["severidade"])
            desc_par = Paragraph(md_inline_to_rl(f["codigo_titulo"] + " — " + f["descricao"]), styles["BodySmall"])
            file_par = Paragraph(md_inline_to_rl(f["arquivo"]), ParagraphStyle(
                "FileCell", parent=styles["BodySmall"], fontName=FONT_MONO, fontSize=7.3, leading=9.6,
            ))
            table_data.append([chip, file_par, desc_par])

        achados_table = Table(table_data, colWidths=[1.9 * cm, 5.0 * cm, 9.8 * cm], repeatRows=1)
        achados_table.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
            ("FONTSIZE", (0, 0), (-1, 0), 9),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F2937")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("ALIGN", (0, 1), (0, -1), "CENTER"),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D5DB")),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F9FAFB")]),
            ("TOPPADDING", (0, 0), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(achados_table)
        story.append(Spacer(1, 0.35 * cm))

    story.append(PageBreak())

    # ---------------- RECOMENDAÇÕES ----------------
    story.append(Paragraph("Recomendações priorizadas", styles["H1"]))
    story.append(Paragraph(
        "Extraídas de achados.md, seção 6 — organizadas por prioridade de implementação.",
        styles["Note"],
    ))
    priority_blocks = re.split(r"\n\n(?=\*\*P\d)", recommendations_raw)
    priority_colors = {"P1": COLOR_MEDIA, "P2": COLOR_BAIXA, "P3": COLOR_PONTO_FORTE}
    for block in priority_blocks:
        block = block.strip()
        if not block:
            continue
        header_match = re.match(r"\*\*(P\d)\s*\(([^)]*)\):\*\*", block)
        if header_match:
            p_code, p_desc = header_match.groups()
            color = priority_colors.get(p_code, COLOR_BAIXA)
            header_par = Paragraph(
                md_inline_to_rl(f"{p_code} — {p_desc}"),
                ParagraphStyle(
                    "PrioHeader",
                    fontName=FONT_BOLD,
                    fontSize=10,
                    leading=13,
                    textColor=colors.white,
                ),
            )
            header_table = Table(
                [[header_par]],
                colWidths=[16.7 * cm],
            )
            header_table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), color),
                ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ]))
            story.append(Spacer(1, 0.25 * cm))
            story.append(header_table)
            body = block[header_match.end():].strip()
        else:
            body = block
        items = re.findall(r"^\d+\.\s+(.*?)(?=\n\d+\.\s|\Z)", body, flags=re.S | re.M)
        for it in items:
            it_clean = " ".join(it.strip().split())
            story.append(Paragraph("• " + md_inline_to_rl(it_clean), styles["Bullet"]))

    story.append(PageBreak())

    # ---------------- ISSUES PARA O GITHUB ----------------
    story.append(Paragraph("Issues para o GitHub", styles["H1"]))
    story.append(Paragraph(
        "Rascunhos de issues extraídos integralmente de achados.md, seção 7, preservando os delimitadores "
        "<font face=\"Courier\">--- ISSUE n ---</font> / <font face=\"Courier\">--- FIM ISSUE n ---</font>.",
        styles["Note"],
    ))

    for issue_text in issues:
        story.extend(render_issue_block(issue_text, styles))

    doc.build(story, onFirstPage=draw_header_footer, onLaterPages=draw_header_footer)


def render_issue_block(issue_text: str, styles) -> list:
    """Renderiza um bloco de issue completo como uma sequência de flowables,
    preservando os delimitadores e usando fonte monoespaçada para blocos de
    código (``` ```) e trechos com indentação típica de YAML/código dentro da
    issue."""
    flowables: list = []

    start_match = re.match(r"(--- ISSUE \d+ ---)\s*", issue_text)
    start_delim = start_match.group(1) if start_match else "--- ISSUE ---"
    inner = issue_text
    if start_match:
        inner = inner[start_match.end():]
    # end_match é recalculado sobre `inner` (já sem o prefixo), nunca sobre o
    # issue_text original — misturar os dois conjuntos de índices deixava um
    # resíduo duplicado do delimitador final no corpo do texto.
    end_match = re.search(r"(--- FIM ISSUE \d+ ---)\s*$", inner)
    end_delim = end_match.group(1) if end_match else "--- FIM ISSUE ---"
    if end_match:
        inner = inner[: end_match.start()]
    inner = inner.strip()

    flowables.append(Paragraph(start_delim, styles["IssueDelim"]))

    # Título
    title_match = re.match(r"\*\*Título:\*\*\s*(.+)", inner)
    if title_match:
        flowables.append(Paragraph(md_inline_to_rl(title_match.group(1)), styles["IssueTitle"]))
        inner = inner[title_match.end():].strip()

    # Divide em blocos de código (``` ... ```) e texto normal
    parts = re.split(r"```(?:yaml|yml|ts|python)?\n(.*?)```", inner, flags=re.S)
    # parts alterna: texto, codigo, texto, codigo, ...
    for i, part in enumerate(parts):
        if i % 2 == 1:
            # bloco de código
            code_lines = part.strip("\n").split("\n")
            code_escaped = "<br/>".join(
                l.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace(" ", "&nbsp;")
                for l in code_lines
            )
            flowables.append(Paragraph(code_escaped, styles["Mono"]))
            continue
        # texto normal: processa por linhas/labels em negrito conhecidos
        text_block = part.strip()
        if not text_block:
            continue
        flowables.extend(render_issue_text_block(text_block, styles))

    flowables.append(Paragraph(end_delim, styles["IssueDelim"]))
    flowables.append(Spacer(1, 0.25 * cm))

    return [KeepTogether(flowables[:2])] + flowables[2:]


KNOWN_LABELS = ("Labels sugeridas", "Descrição", "Evidência", "Impacto", "Sugestão de correção", "Critérios de aceite")


def render_issue_text_block(text_block: str, styles) -> list:
    flowables: list = []
    # Separa por linhas, agrupando parágrafos e listas de checklist "- [ ]"
    lines = text_block.split("\n")
    buffer: list[str] = []

    def flush_buffer():
        if not buffer:
            return
        joined = " ".join(l.strip() for l in buffer if l.strip())
        if joined:
            flowables.append(Paragraph(md_inline_to_rl(joined), styles["BodySmall"]))
        buffer.clear()

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush_buffer()
            continue
        label_match = re.match(r"\*\*(" + "|".join(KNOWN_LABELS) + r"):\*\*\s*(.*)", stripped)
        if label_match:
            flush_buffer()
            label, rest = label_match.groups()
            flowables.append(Paragraph(f"<b>{label}:</b>", styles["IssueLabel"]))
            if rest.strip():
                buffer.append(rest)
            continue
        if re.match(r"^- \[ \]", stripped) or re.match(r"^-\s", stripped):
            flush_buffer()
            item = re.sub(r"^- \[ \]\s*", "☐ ", stripped)
            item = re.sub(r"^-\s", "• ", item)
            flowables.append(Paragraph(md_inline_to_rl(item), ParagraphStyle(
                "IssueChecklist", parent=styles["BodySmall"], leftIndent=10, spaceAfter=2,
            )))
            continue
        if re.match(r"^\s*-\s", line) and line.startswith(" "):
            flush_buffer()
            item = re.sub(r"^\s*-\s", "– ", line)
            flowables.append(Paragraph(md_inline_to_rl(item.strip()), ParagraphStyle(
                "IssueSub", parent=styles["BodySmall"], leftIndent=16, spaceAfter=2,
            )))
            continue
        buffer.append(stripped)
    flush_buffer()
    return flowables


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    text = read_source()
    build_pdf(text)
    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"PDF gerado em: {OUTPUT_PATH} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
