"""Templates fixos: autoescape, links so da allowlist, contexto estrito."""
from __future__ import annotations

import pytest

from app.services.email.templates import TemplateError, render_email, validate_link

ALLOWED = ["https://app.example.test/convite/aceitar"]


def test_script_neutralizado_no_html():
    out = render_email("notification", {"title": "<script>alert(1)</script>",
                                        "paragraphs": ['<img src=x onerror=alert(1)>']})
    assert "<script>" not in out.html and "&lt;script&gt;" in out.html
    assert "<img" not in out.html and "&lt;img" in out.html


def test_aspas_no_nome_nao_quebram_atributo():
    out = render_email("invite", {"recipient_name": '"><script>x</script>',
                                  "action_url": ALLOWED[0] + "?t=1"}, allowed_links=ALLOWED)
    assert "<script>" not in out.html
    assert 'href="https://app.example.test/convite/aceitar?t=1"' in out.html


def test_assunto_sem_quebra_de_linha():
    out = render_email("notification", {"title": "Oi\r\nBcc: x@y.com"})
    assert "\r" not in out.subject and "\n" not in out.subject


@pytest.mark.parametrize("url", [
    "javascript:alert(1)", "http://app.example.test/convite/aceitar", "https://evil.test/convite/aceitar",
    "https://app.example.test/outro", "https://u:p@app.example.test/convite/aceitar",
    "https://app.example.test/convite/aceitar\r\nX: y", "//evil.test", "",
])
def test_links_fora_da_allowlist_recusados(url):
    with pytest.raises(TemplateError):
        validate_link(url, ALLOWED)


def test_template_desconhecido_e_variavel_ausente():
    with pytest.raises(TemplateError):
        render_email("../etc/passwd", {})
    with pytest.raises(TemplateError):
        render_email("notification", {})  # title ausente (StrictUndefined)
    with pytest.raises(TemplateError):
        render_email("invite", {"recipient_name": "x"})


def test_html_de_texto_nao_e_escapado_mas_sem_html_no_corpo_html():
    out = render_email("notification", {"title": "T", "paragraphs": ["a & b"]})
    assert "a &amp; b" in out.html and "a & b" in out.text
