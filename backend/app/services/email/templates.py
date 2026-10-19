"""Templates FIXOS de e-mail (texto + HTML) com autoescape.

- Os templates sao constantes deste modulo; nenhum template ou HTML vem do
  cliente. Todo valor de contexto e higienizado (controles removidos,
  tamanho limitado) e o HTML e renderizado com `autoescape=True` (Jinja2,
  ja presente em requirements.lock com hashes como dependencia do Flask).
- Links so sao aceitos se baterem (esquema+host+caminho) com uma URL da
  allowlist informada pelo chamador (ex.: INVITE_ALLOWED_REDIRECT_URLS).
- StrictUndefined: variavel ausente falha em vez de sair vazia.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable
from urllib.parse import urlsplit

from jinja2 import Environment, StrictUndefined

from app.services.email.address import has_control_chars

MAX_FIELD_LENGTH = 500
MAX_PARAGRAPHS = 10
_ASCII_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class TemplateError(ValueError):
    """Template desconhecido, contexto invalido ou link nao autorizado."""


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    text: str
    html: str


_TEMPLATES: dict[str, dict[str, str]] = {
    "notification": {
        "subject": "SISPAT-AGU: {title}",
        "text": (
            "{{ title }}\n\n{% for p in paragraphs %}{{ p }}\n\n{% endfor %}"
            "{% if action_url %}{{ action_label }}: {{ action_url }}\n\n{% endif %}"
            "-- SISPAT-AGU (mensagem automatica; nao responda)\n"
        ),
        "html": (
            '<!doctype html><html lang="pt-BR"><body>'
            "<h1>{{ title }}</h1>"
            "{% for p in paragraphs %}<p>{{ p }}</p>{% endfor %}"
            '{% if action_url %}<p><a href="{{ action_url }}" rel="noopener noreferrer">'
            "{{ action_label }}</a></p>{% endif %}"
            "<hr><p><small>SISPAT-AGU (mensagem automatica; nao responda)</small></p>"
            "</body></html>"
        ),
    },
    "invite": {
        "subject": "SISPAT-AGU: convite de acesso",
        "text": (
            "Ola, {{ recipient_name }}.\n\nVoce foi convidado(a) para acessar o SISPAT-AGU.\n"
            "Ativar acesso: {{ action_url }}\n\n"
            "Se nao reconhece este convite, ignore esta mensagem.\n"
        ),
        "html": (
            '<!doctype html><html lang="pt-BR"><body>'
            "<p>Ola, {{ recipient_name }}.</p>"
            "<p>Voce foi convidado(a) para acessar o SISPAT-AGU.</p>"
            '<p><a href="{{ action_url }}" rel="noopener noreferrer">Ativar acesso</a></p>'
            "<p><small>Se nao reconhece este convite, ignore esta mensagem.</small></p>"
            "</body></html>"
        ),
    },
}

_html_env = Environment(autoescape=True, undefined=StrictUndefined)
# Falso positivo de XSS: _text_env so renderiza a parte text/plain do e-mail,
# nunca HTML; o corpo HTML usa _html_env (autoescape=True).
_text_env = Environment(autoescape=False, undefined=StrictUndefined)  # nosec B701  # nosemgrep


def clean_text(value: Any, *, limit: int = MAX_FIELD_LENGTH) -> str:
    """Troca controles por espaco, colapsa espacos/quebras e limita o tamanho."""
    text = _ASCII_CONTROL.sub(" ", str(value))
    text = " ".join(text.split())
    return text[:limit]


def validate_link(url: Any, allowed_urls: Iterable[str]) -> str:
    """Aceita a URL somente se esquema+host+caminho coincidirem com a allowlist."""
    if not isinstance(url, str) or not url or has_control_chars(url) or " " in url:
        raise TemplateError("Link nao autorizado.")
    parts = urlsplit(url)
    if parts.scheme != "https" and not (
        parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")
    ):
        raise TemplateError("Link nao autorizado.")
    if parts.username or parts.password or not parts.hostname:
        raise TemplateError("Link nao autorizado.")
    key = (parts.scheme, parts.netloc.lower(), parts.path)
    for allowed in allowed_urls:
        a = urlsplit(allowed)
        if key == (a.scheme, a.netloc.lower(), a.path):
            return url
    raise TemplateError("Link nao autorizado.")


def render_email(
    template: str,
    context: dict[str, Any],
    *,
    allowed_links: Iterable[str] = (),
) -> RenderedEmail:
    """Renderiza um template fixo. Levanta `TemplateError` em entrada invalida."""
    spec = _TEMPLATES.get(template)
    if spec is None:
        raise TemplateError("Template desconhecido.")
    ctx: dict[str, Any] = {}
    for key, value in context.items():
        if key == "paragraphs":
            if not isinstance(value, (list, tuple)) or len(value) > MAX_PARAGRAPHS:
                raise TemplateError("Contexto invalido.")
            ctx[key] = [clean_text(p) for p in value]
        elif key == "action_url":
            ctx[key] = validate_link(value, list(allowed_links)) if value else ""
        else:
            ctx[key] = clean_text(value, limit=200 if key == "title" else MAX_FIELD_LENGTH)
    ctx.setdefault("paragraphs", [])
    ctx.setdefault("action_url", "")
    ctx.setdefault("action_label", "Abrir")
    if template == "invite" and not ctx["action_url"]:
        raise TemplateError("Contexto invalido.")
    try:
        subject = spec["subject"].replace("{title}", ctx.get("title", ""))
        return RenderedEmail(
            subject=clean_text(subject, limit=150),
            text=_text_env.from_string(spec["text"]).render(**ctx),
            html=_html_env.from_string(spec["html"]).render(**ctx),
        )
    except Exception:  # noqa: BLE001 - variavel ausente etc.
        raise TemplateError("Contexto invalido.") from None
