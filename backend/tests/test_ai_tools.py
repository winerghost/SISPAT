"""Ferramentas somente leitura do assistente e parser do protocolo (Etapa 4b)."""
from __future__ import annotations

import uuid

import pytest
from test_ai_dash_support import add_assets, add_person, add_room, build_world

from app.models.rbac import User  # noqa: F401
from app.services.ai.assistant import MAX_TOOL_CALLS, parse_reply
from app.services.ai.tools import TOOLS, ToolContext, execute_tool

CTX_PATCH = "app.services.alerts.service.get_db_session"


@pytest.fixture()
def tw(monkeypatch):
    world = build_world(monkeypatch)
    monkeypatch.setattr(CTX_PATCH, world.session)
    ua, ub = world.unit("A"), world.unit("B")
    uid = world.user("User A", role="USER", units=[ua])
    rh = world.user("Rita", role="RH", units=[ua])
    return world, ua, ub, uid, rh


def _run(world, user_id, name, args=None, role="USER"):
    with world.session() as db:
        return execute_tool(name, args, ToolContext(db=db, user_id=user_id, role_codes=frozenset({role})))


def test_allowlist_fechada():
    assert set(TOOLS) == {"contar_bens", "listar_alertas", "bens_por_sala", "contagem_responsaveis"}
    assert MAX_TOOL_CALLS == 3


def test_contar_bens_filtros_e_escopo(tw):
    world, ua, ub, uid, _ = tw
    add_assets(world, ua, 6)
    add_assets(world, ua, 5, located=False)
    add_assets(world, ub, 20)
    assert _run(world, uid, "contar_bens").result == {"category": "todos", "count": 11}
    assert _run(world, uid, "contar_bens", {"filtro": "sem_localizacao"}).result["count"] == 5


def test_bens_por_sala_nao_mistura_salas_de_outra_unidade(tw):
    world, ua, ub, uid, _ = tw
    mine, other = add_room(world, ua, "Sala 1"), add_room(world, ub, "Sala Alheia")
    add_assets(world, ua, 6, room=mine)
    add_assets(world, ua, 3, room=other)  # sala de OUTRA unidade referenciada por engano
    out = _run(world, uid, "bens_por_sala", {"limite": 10}).result
    assert out == {"items": [{"room_label": "Sala 1", "count": 6}]}


def test_resultado_de_responsaveis_so_tem_inteiros_para_rh(tw):
    world, ua, _ub, _uid, rh = tw
    person = add_person(world, ua, "Fulano", "f@exemplo.invalid")
    add_assets(world, ua, 6, responsible=person)
    add_assets(world, ua, 5)
    for name in ("contagem_responsaveis", "contar_bens"):
        out = _run(world, rh, name, {"filtro": "sem_responsavel"} if name == "contar_bens" else None, "RH")
        assert out.status == "ok"
        assert all(isinstance(v, (int, str)) for v in out.result.values())
        assert "Fulano" not in str(out.result)
    assert TOOLS["contagem_responsaveis"].touches_responsibles is True


def test_listar_alertas_devolve_so_codigo_severidade_e_contagem(tw):
    world, ua, _ub, uid, _ = tw
    add_assets(world, ua, 6, located=False)
    out = _run(world, uid, "listar_alertas").result["alerts"]
    assert out and all(set(a) == {"alert_type", "severity", "count"} for a in out)


@pytest.mark.parametrize("name", ["drop", "", None, 3, ["contar_bens"], "contar_bens "])
def test_nome_fora_da_allowlist_recusado(tw, name):
    world, _ua, _ub, uid, _ = tw
    out = _run(world, uid, name)
    assert out.status == "refused" and out.result == {"status": "recusada"}


@pytest.mark.parametrize(
    "name,args",
    [("contar_bens", {"unit_id": str(uuid.uuid4())}), ("contar_bens", {"filtro": "x"}),
     ("listar_alertas", {"a": 1}), ("bens_por_sala", {"limite": 0}), ("bens_por_sala", {"limite": 21}),
     ("bens_por_sala", {"limite": True}), ("contar_bens", "todos")],
)
def test_argumentos_invalidos_recusados(tw, name, args):
    world, _ua, _ub, uid, _ = tw
    assert _run(world, uid, name, args).status == "invalid"


def test_erro_interno_da_ferramenta_nao_vaza(tw, monkeypatch):
    world, _ua, _ub, uid, _ = tw
    monkeypatch.setattr("app.services.ai.tools._scoped_assets", lambda *a, **k: 1 / 0)
    out = _run(world, uid, "contar_bens")
    assert out.status == "invalid" and "division" not in str(out.result)


def test_usuario_sem_unidade_ve_zero(tw):
    world, *_ = tw
    nobody = world.user("Ninguem", role="USER", units=[])
    assert _run(world, nobody, "contar_bens").result["count"] == 0


@pytest.mark.parametrize(
    "text,kind",
    [("Há 6 bens.", "text"), ('{"tool":"contar_bens","args":{}}', "call"),
     ('```json\n{"tool":"listar_alertas"}\n```', "call"), ('{"tool":', "malformed"),
     ('{"tool":"a","extra":1}', "malformed"), ('{"x":1}', "malformed"), ("[1]", "text")],
)
def test_parse_reply(text, kind):
    assert parse_reply(text).kind == kind
