"""ONDA C (QA/seguranca): `located_by_unit_chart` e `/records`.

Complementa `test_dashboard_located.py` (nao o substitui): multiunidade com
"Outras" + filtros, consistencia barra <-> lista, PII em respostas/auditoria/
eventos, validacao hostil, oraculos 404, metodos HTTP, paginacao estavel,
desempate do top-N, numero de queries constante e escopo por `owner_unit_id`.
Somente SQLite em memoria (nada toca o Supabase).
"""
from __future__ import annotations

import json
import uuid

import pytest
from sqlalchemy import event, select
from test_dashboard_equipment import BASE, add, api, hdr  # noqa: F401  (fixture `api`)
from test_dashboard_located import PANEL, SECRET, chart, multi, records
from test_user_admin_db import auth_headers

from app.models.assets import Asset
from app.models.audit import AuditLog
from app.services import dashboard_equipment_service as des
from app.services import dashboard_located_service as dls

VOLATILE = {"event_id", "occurred_at", "timestamp", "request_id", "id", "ts", "time", "request"}  # request.path difere por desenho
PERSONAL = {"responsible", "responsavel", "responsible_person_id", "email", "phone", "notes", "cpf"}


def top(monkeypatch, n):
    monkeypatch.setattr(des, "TOP_UNIDADES", n)
    monkeypatch.setattr(dls, "TOP_UNIDADES", n)


def all_records(api, who, query):
    """Todas as paginas (page_size=50) -> lista de itens; falha se uma pagina repetir/perder id."""
    items, page = [], 1
    while True:
        body = records(api, who, f"{query}&page={page}&page_size=50").get_json()
        items += body["items"]
        if page >= body["pages"]:
            break
        page += 1
    return items, body["total"]


def world5(api, monkeypatch, top_n=2):
    """UA(5) UB(4) UC(3) UD(2) no escopo do `multi`; UE(20) FORA do escopo dele."""
    ud, uc, ue = api.world.unit("UD"), api.world.unit("UC"), api.world.unit("UE")
    multi(api, uc, ud)  # UA, UB, UC, UD (UE fora)
    plan = [(api.ua, "A", 5), (api.ub, "B", 4), (uc, "C", 3), (ud, "D", 2), (ue, "E", 20)]
    for unit, tag, n in plan:
        for i in range(n):
            cat, loc = [("NOTEBOOK", "SIM"), ("MESA", "NAO"), (None, "DESCONHECIDO")][i % 3]
            add(api, unit, f"{tag}-{i:02d}", cat, located=loc)
    top(monkeypatch, top_n)
    return uc, ud, ue


# --- 1. IDOR / BOLA multiunidade ---------------------------------------------------------


def test_outras_e_exatamente_o_complemento_do_top_dentro_do_escopo(api, monkeypatch):
    world5(api, monkeypatch)
    rows = chart(api, "multi").get_json()["dados"]["unidades"]
    assert [r["unidade"] for r in rows] == ["UA", "UB", "Outras"]
    assert rows[2]["total"] == 5  # UC(3)+UD(2); UE (fora do escopo) nunca entra
    items, total = all_records(api, "multi", "?unit_id=outras")
    assert total == 5 == len(items)
    assert {i["unidade"] for i in items} == {"UC", "UD"}
    assert not [i for i in items if i["patrimony_number"].startswith("E-")]
    for unit in ("UE",):  # a unidade de fora nao aparece nem como rotulo
        assert unit not in json.dumps(chart(api, "multi").get_json())


@pytest.mark.parametrize("who", ["ua", "rh", "adm", "ub"])
def test_outras_nunca_expoe_unidade_fora_do_escopo_para_perfis_de_uma_unidade(api, monkeypatch, who):
    world5(api, monkeypatch, top_n=0)  # tudo e "Outras"
    body = records(api, who, "?unit_id=outras").get_json()
    own = {"ub": {"UB"}}.get(who, {"UA"})
    assert {i["unidade"] for i in body["items"]} <= own
    assert body["total"] == {"ub": 4}.get(who, 5)


@pytest.mark.parametrize(
    "flt",
    ["", "&familia=TI", "&familia=MOBILIARIO", "&familia=NAO_CLASSIFICADO", "&categoria=NOTEBOOK", "&categoria=MESA"],
)
def test_outras_com_filtros_coerente_com_o_grafico_e_cliques_batem_com_barras(api, monkeypatch, flt):
    world5(api, monkeypatch)
    q = flt.replace("&", "?", 1) if flt else ""
    body = chart(api, "multi", q).get_json()["dados"]
    extra = flt  # records exige unit_id: anexa filtros depois
    seen_ids, grand = set(), 0
    for row in body["unidades"]:
        unit = "outras" if row["unit_id"] is None else row["unit_id"]
        for sid, expected in [*row["valores"].items(), (None, row["total"])]:
            loc = f"&located={sid}" if sid else ""
            got = records(api, "multi", f"?unit_id={unit}{loc}{extra}&page_size=200").get_json()
            assert got["total"] == expected, (row["unidade"], sid, flt)
            if sid is None:
                ids = {i["id"] for i in got["items"]}
                assert len(ids) == len(got["items"]) == expected  # sem duplicata
                assert not ids & seen_ids  # barras disjuntas
                seen_ids |= ids
        grand += row["total"]
    assert grand == body["total"] == len(seen_ids)  # nada perdido entre as barras


def test_unidade_alheia_inexistente_e_sem_bens_tem_a_mesma_resposta_byte_a_byte(api):
    ghost_unit = api.world.unit("UVAZIA")  # existe, sem bens
    add(api, api.ub, "B-1", "NOTEBOOK", located="SIM")
    r = [records(api, "ua", f"?unit_id={u}") for u in (api.ub, uuid.uuid4(), ghost_unit, uuid.UUID(int=0))]
    assert len({x.status_code for x in r}) == 1 == len({x.get_data() for x in r})
    assert r[0].status_code == 200


def test_escopo_por_owner_unit_id_aparece_no_grafico_e_na_lista_igualmente(api):
    """Bem de UB cuja unidade DONA e UA: em /assets o USER de UA o ve; o painel segue a mesma
    regra (paridade) e a lista do clique concorda com a barra."""
    api.world.asset(api.ub, "OWN-1", owner_unit_id=api.ua, located="SIM", equipment_category="NOTEBOOK")
    bars = by = {u["unidade"]: u for u in chart(api, "ua").get_json()["dados"]["unidades"]}
    assert by["UB"]["total"] == 1
    got = records(api, "ua", f"?unit_id={api.ub}").get_json()
    assert got["total"] == 1 and got["items"][0]["patrimony_number"] == "OWN-1"
    assert bars  # registrado como achado informativo (rotulo de unidade vizinha visivel por escopo de /assets)


# --- 2. PII ------------------------------------------------------------------------------


def test_pii_ausente_em_respostas_auditoria_e_eventos_nos_tres_perfis(api):
    name, email, cpf, phone = SECRET
    person = api.world.person(api.ua, name)
    room = api.world.room(api.ua, "Sala 1")
    add(
        api, api.ua, "PII-9", "NOTEBOOK", located="NAO", responsible_person_id=person, room_id=room,
        notes=f"{name} {email} {cpf} {phone}", desc="(1) NOTEBOOK",
    )
    texts = []
    for who in ("ua", "rh", "adm"):
        for url in (
            f"?unit_id={api.ua}", "?unit_id=outras", f"?unit_id={api.ua}&located=NAO&sort=-located",
            "?sort=responsible", "?unit_id=outras&sort=responsible_person_id",  # 400
        ):
            resp = records(api, who, url)
            texts.append(resp.get_data(as_text=True))
            assert not PERSONAL & {k for it in (resp.get_json().get("items") or []) for k in it}
        texts.append(chart(api, who).get_data(as_text=True))
        texts.append(records(api, who, "?unit_id=outras", panel="sync_status").get_data(as_text=True))
    with api.world.session() as db:
        texts += [json.dumps(r.__dict__, default=str) for r in db.execute(select(AuditLog)).scalars()]
    texts += [json.dumps(c.args[0], default=str) for c in api.events.call_args_list]
    blob = "\n".join(texts)
    for secret in (*SECRET, str(person)):
        assert secret not in blob


@pytest.mark.parametrize(
    "sort",
    ["responsible", "responsible_person_id", "notes", "email", "owner_unit_id", "-version", "unit_id", "room", "password"],
)
def test_sort_so_por_allowlist_nao_ordena_por_campo_sensivel(api, sort):
    r = records(api, "ua", f"?unit_id={api.ua}&sort={sort}")
    assert r.status_code == 400 and sort not in r.get_data(as_text=True)


# --- 3. Validacao hostil -----------------------------------------------------------------

HOSTILE = [
    "?unit_id=outras&unit_id=outras", "?unit_id=outras&page=1&page=2", "?unit_id=outras&page_size=50&page_size=100",
    "?unit_id=outras&located=SIM&located=NAO", "?unit_id=outras&sort=located&sort=-located",
    "?unit_id=outras&page_size=0", "?unit_id=outras&page_size=-50", "?unit_id=outras&page_size=51",
    "?unit_id=outras&page_size=201",
    "?unit_id=outras&page=-1", "?unit_id=outras&page=abc", "?unit_id=outras&page=",
    "?unit_id=%27%20OR%201%3D1--", "?unit_id=1;DROP%20TABLE%20assets", "?unit_id=outras%27%20UNION%20SELECT",
    "?unit_id=%3Cscript%3Ealert(1)%3C/script%3E", "?unit_id=outras%00", "?unit_id=%00",
    "?unit_id=" + "a" * 5000, "?unit_id=outras&sort=" + "x" * 5000, "?unit_id=outras&located=" + "S" * 5000,
    "?unit_id=оutras", "?unit_id=%EF%BD%8Futras", "?unit_id=outras%E2%80%8B",  # homoglifos / zero-width
    "?unit_id=outras&located=%00SIM", "?unit_id=outras&familia=ti", "?unit_id=outras&categoria=NOTEBOOK%00",
    "?unit_id=outras&unit_id=" + str(uuid.uuid4()), "?unit_id=outras&q=x", "?unit_id=outras&search=x",
    "?unit_id=outras&owner_unit_id=" + str(uuid.uuid4()), "?unit_id=outras&" + "k=v&" * 200,
    "?unit_id=outras&located[]=SIM", "?unit_id[]=outras", "?unit_id[$ne]=x",
]


@pytest.mark.parametrize("query", HOSTILE)
@pytest.mark.parametrize("who", ["ua", "adm"])
def test_consulta_hostil_400_sem_eco_e_sem_500(api, query, who):
    r = records(api, who, query)
    assert r.status_code == 400, (query[:60], r.status_code)
    text = r.get_data(as_text=True)
    probes = ("script", "DROP", "UNION", "OR 1=1", "xxxx", "aaaa", "SSSS", "оutras", "\x00", "abc", "TABLE")
    assert not [p for p in probes if p in text]
    assert "Traceback" not in text and "sqlalchemy" not in text.lower()


@pytest.mark.parametrize("raw", ["50.0", "1e2", "+50", " 50"])
def test_page_size_numerico_alternativo_so_passa_se_cair_na_allowlist(api, raw):
    r = records(api, "ua", f"?unit_id=outras&page_size={raw.replace(' ', '%20')}")
    assert r.status_code == 400 or r.get_json()["page_size"] in (50, 100, 200)


def test_pagina_gigante_nao_estoura_500(api):
    seed_small(api)
    for page in ("999999999", "99999999999999999999", str(2**63)):
        r = records(api, "ua", f"?unit_id={api.ua}&page={page}")
        assert r.status_code in (200, 400), (page, r.status_code)
    r = records(api, "ua", f"?unit_id={api.ua}&page=999999999")
    if r.status_code == 200:
        assert r.get_json()["items"] == []


def seed_small(api):
    for i in range(4):
        add(api, api.ua, f"S-{i}", "NOTEBOOK", located="SIM")


def _denied(api):
    return [c.args[0] for c in api.events.call_args_list if c.args[0]["event_type"] == "ACCESS_DENIED"]


def test_404_idem_corpo_status_e_evento_para_inexistente_e_proibido(api):
    seed_small(api)
    api.events.reset_mock()
    shots = []
    for panel in ("nao_existe", "sync_status", "unclassified_review", "classification_overrides", "LOCATED_BY_UNIT_CHART", "located-by-unit-chart"):
        api.events.reset_mock()
        r = records(api, "ua", f"?unit_id={api.ua}", panel=panel)
        ev = _denied(api)
        norm = {k: v for k, v in (ev[0] if ev else {}).items() if k not in VOLATILE}
        shots.append((r.status_code, r.get_data(), json.dumps(norm or None, sort_keys=True, default=str)))
        assert len(ev) == 1
    assert len({s[0] for s in shots}) == 1 and shots[0][0] in (404,)
    assert len({s[1] for s in shots}) == 1  # corpo identico
    assert len({s[2] for s in shots}) == 1 and shots[0][2] != "null"  # mesmo evento ACCESS_DENIED


def test_404_vem_antes_de_validar_a_query_sem_oraculo(api):
    # painel proibido/inexistente + query invalida = 404 igual ao 404 com query valida
    ok = records(api, "ua", f"?unit_id={api.ua}", panel="sync_status")
    bad = records(api, "ua", "?lixo=1&page=-9", panel="sync_status")
    ghost = records(api, "ua", "?lixo=1&page=-9", panel="nao_existe")
    assert ok.status_code == bad.status_code == ghost.status_code == 404
    assert ok.get_data() == bad.get_data() == ghost.get_data()
    # painel valido + query invalida = 400 (so quem pode ver o painel distingue)
    assert records(api, "ua", "?lixo=1").status_code == 400


def test_data_painel_inexistente_e_proibido_identicos_e_query_ruim_da_400_nos_dois(api):
    def data(who, panel, q=""):
        return api.client.get(f"{BASE}/panels/{panel}/data{q}", headers=hdr(who))

    a, b = data("ua", "nao_existe"), data("ua", "sync_status")
    assert a.status_code == b.status_code == 404 and a.get_data() == b.get_data()
    assert data("ua", "nao_existe", "?lixo=1").status_code == data("ua", "sync_status", "?lixo=1").status_code == 400


# --- 4. Autenticacao / metodos -----------------------------------------------------------


@pytest.mark.parametrize("suffix", ["data", "records?unit_id=outras"])
def test_adm_sem_aal2_negado_em_data_e_records(api, suffix):
    url = f"{BASE}/panels/{PANEL}/{suffix}"
    h1, h2 = auth_headers("eq-adm", aal="aal1"), auth_headers("eq-adm", aal="aal2")
    assert api.client.get(url, headers=h1).status_code in (401, 403)
    assert api.client.get(url, headers=h2).status_code == 200
    assert api.client.get(url).status_code == 401
    assert api.client.get(url, headers={"Authorization": "Bearer "}).status_code == 401


@pytest.mark.parametrize("method", ["post", "put", "delete", "patch"])
@pytest.mark.parametrize("suffix", ["data", "records?unit_id=outras"])
@pytest.mark.parametrize("who", [None, "ua", "adm"])
def test_metodos_de_escrita_nao_existem_ou_negam(api, method, suffix, who):
    seed_small(api)
    url = f"{BASE}/panels/{PANEL}/{suffix}"
    r = getattr(api.client, method)(url, json={"unit_id": "x"}, headers=hdr(who) if who else {})
    assert r.status_code in (401, 403, 405), (method, who, r.status_code)
    with api.world.session() as db:
        assert db.query(Asset).count() == 4  # nada mudou


@pytest.mark.parametrize("suffix", ["data", "records?unit_id=outras"])
def test_head_e_options_sem_corpo_e_sem_burlar_autenticacao(api, suffix):
    seed_small(api)
    url = f"{BASE}/panels/{PANEL}/{suffix}"
    assert api.client.head(url).status_code == 401  # HEAD nao pula a autenticacao
    assert api.client.head(url, headers=auth_headers("eq-adm", aal="aal1")).status_code in (401, 403)
    h = api.client.head(url, headers=hdr("ua"))
    assert h.status_code == 200 and h.get_data() == b""
    o = api.client.options(url)
    assert o.status_code in (200, 204, 401, 403, 405) and b"SIM" not in o.get_data()
    assert "Access-Control-Allow-Origin" not in o.headers or o.headers["Access-Control-Allow-Origin"] != "*"


def test_cabecalhos_de_seguranca_da_resposta(api):
    seed_small(api)
    r = records(api, "ua", f"?unit_id={api.ua}")
    assert r.mimetype == "application/json" and r.headers["Cache-Control"] == "no-store"
    assert r.headers.get("X-Content-Type-Options") == "nosniff"


# --- 5. Corretude numerica ---------------------------------------------------------------


def test_soma_das_situacoes_igual_ao_total_ativo_por_unidade_e_global(api, monkeypatch):
    world5(api, monkeypatch, top_n=15)
    add(api, api.ua, "A-DEL", "NOTEBOOK", located="SIM", deleted=True)
    add(api, api.ua, "A-NULL", "NOTEBOOK", located=None)  # sem situacao => conta como DESCONHECIDO
    body = chart(api, "multi").get_json()["dados"]
    for r in body["unidades"]:
        assert sum(r["valores"].values()) == r["total"]
    by ={u["unidade"]: u for u in body["unidades"]}
    assert by["UA"]["total"] == 6 and by["UA"]["valores"]["DESCONHECIDO"] == 2  # i=2 + NULL
    assert body["total"] == sum(u["total"] for u in body["unidades"]) == 6 + 4 + 3 + 2


def test_desempate_do_top_n_e_deterministico_por_rotulo_e_id(api, monkeypatch):
    units = [api.world.unit(n) for n in ("ZZ", "MM", "AA", "KK")]
    multi(api, *units)
    for unit in (api.ua, api.ub, *units):  # todos com 2 bens => empate total
        for i in range(2):
            api.world.asset(unit, f"{uuid.uuid4().hex[:6]}-{i}", located="SIM")
    top(monkeypatch, 3)
    first = chart(api, "multi").get_json()["dados"]["unidades"]
    assert [r["unidade"] for r in first[:3]] == ["AA", "KK", "MM"]  # rotulo asc.
    assert first[3]["unidade"] == "Outras" and first[3]["total"] == 6
    assert chart(api, "multi").get_json()["dados"]["unidades"] == first
    names = {i["unidade"] for i in all_records(api, "multi", "?unit_id=outras")[0]}
    assert names == {"UA", "UB", "ZZ"}


@pytest.mark.parametrize("sort", ["patrimony_number", "-patrimony_number", "description", "-description", "located", "-located"])
def test_paginacao_estavel_sem_duplicar_nem_perder_com_empates(api, sort):
    for i in range(137):  # descricao e situacao repetidas => empates em todas as ordens
        add(api, api.ua, f"N{i % 40:03d}", "NOTEBOOK", located=("SIM", "NAO", "DESCONHECIDO")[i % 3], desc="IGUAL")
    items, total = all_records(api, "ua", f"?unit_id={api.ua}&sort={sort}")
    ids = [i["id"] for i in items]
    assert total == 137 == len(ids) == len(set(ids))
    again, _ = all_records(api, "ua", f"?unit_id={api.ua}&sort={sort}")
    assert [i["id"] for i in again] == ids  # repetivel


def test_page_size_distinto_devolve_a_mesma_sequencia(api):
    for i in range(130):
        add(api, api.ua, f"Q{i:03d}", "NOTEBOOK", located="SIM", desc="X")
    seq = {}
    for size in (50, 100, 200):
        got, page = [], 1
        while True:
            b = records(api, "ua", f"?unit_id={api.ua}&sort=description&page={page}&page_size={size}").get_json()
            got += [i["id"] for i in b["items"]]
            if page >= b["pages"]:
                break
            page += 1
        seq[size] = got
    assert seq[50] == seq[100] == seq[200] and len(seq[50]) == 130


# --- 6. Performance basica: queries constantes -------------------------------------------


class QueryCounter:
    def __init__(self, engine):
        self.n, self.engine = 0, engine

    def __enter__(self):
        event.listen(self.engine, "before_cursor_execute", self._hit)
        return self

    def __exit__(self, *exc):
        event.remove(self.engine, "before_cursor_execute", self._hit)

    def _hit(self, *args, **kw):
        self.n += 1


def bulk(api, per_unit, units):
    cats = [("NOTEBOOK", "SIM"), ("MESA", "NAO"), (None, "DESCONHECIDO"), ("MONITOR", "SIM")]
    with api.world.session() as db:
        for unit in units:
            for i in range(per_unit):
                cat, loc = cats[i % 4]
                db.add(Asset(
                    id=uuid.uuid4(), patrimony_number=f"V{str(unit)[:4]}-{i:06d}", unit_id=unit, version=1,
                    located=loc, equipment_category=cat, description=f"BEM {i % 50}",
                ))


def counts(api, units_n, monkeypatch):
    out = {}
    with QueryCounter(api.world.engine) as qc:
        chart(api, "multi")
        out["chart"] = qc.n
        qc.n = 0
        records(api, "multi", f"?unit_id={api.ua}&located=SIM&sort=-description")
        out["unit"] = qc.n
        qc.n = 0
        records(api, "multi", "?unit_id=outras&page_size=200")
        out["outras"] = qc.n
    return out


@pytest.mark.parametrize("per_unit,n_units", [(2, 4), (267, 4), (3000, 6)])
def test_numero_de_queries_nao_cresce_com_o_volume(api, monkeypatch, per_unit, n_units, request):
    extras = [api.world.unit(f"X{i}") for i in range(n_units - 2)]
    multi(api, *extras)
    bulk(api, per_unit, [api.ua, api.ub, *extras])
    top(monkeypatch, 3)
    got = counts(api, n_units, monkeypatch)
    print("QUERIES", per_unit * n_units, n_units, got)
    assert max(got.values()) <= 16, got  # teto fixo: sem N+1 (auth + escopo + agregados + rotulos)
    request.config._located_counts = getattr(request.config, "_located_counts", {})
    request.config._located_counts[per_unit] = got
    if per_unit == 3000:
        base = request.config._located_counts.get(2)
        if base:  # constante frente ao volume (a quantidade de unidades pode variar em 1-2 queries de rotulo)
            assert got == base, (base, got)


# --- 8 (backend). XSS em rotulo/descricao: JSON puro, controle removido -----------------


def test_rotulos_hostis_saem_como_texto_json_sem_controle(api):
    room = api.world.room(api.ua, "<img src=x onerror=alert(1)>‮\x00Sala")
    add(api, api.ua, "XSS-1", "NOTEBOOK", located="SIM", room_id=room, desc="<script>alert(1)</script>​\x07 ok")
    r = records(api, "ua", f"?unit_id={api.ua}")
    assert r.mimetype == "application/json"
    item = r.get_json()["items"][0]
    assert item["description"] == "<script>alert(1)</script> ok"  # texto cru; React escapa
    assert "\x00" not in item["sala"] and "‮" not in item["sala"]


@pytest.mark.parametrize("panel", ["..%2Fx", "%00", "a/b"])
def test_painel_com_caracteres_estranhos_nunca_da_500_nem_eco(api, panel):
    r = records(api, "ua", f"?unit_id={api.ua}", panel=panel)
    assert r.status_code == 404
    assert panel not in r.get_data(as_text=True)
