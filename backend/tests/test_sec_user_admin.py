"""Revisão AppSec da Etapa 2 (gestão de usuários, sessões, foto) — 2026-10-15.

Complementa `test_user_admin_*`/`test_avatar_*` (escritos pelo backend) com os
cenários de abuso que a revisão levantou. Evidência e achados `UA-*`:
`docs/security/evidence/settings-module-etapa2.md`.

Testes `xfail(strict=True, reason="UA-...")` FALHAM hoje e provam um achado
aberto: ao corrigir, o xfail vira XPASS (erro em modo strict) e deve ser
removido. Todo o resto é regressão de controles que já funcionam.

Infra: SQLite com o schema real + carregador REAL de `require_auth`
(`test_user_admin_db.py`); Redis/Supabase/Storage falsos; JWT sintéticos
assinados com o segredo FICTÍCIO de `tests/conftest.py`. Sem rede.
"""
from __future__ import annotations

import io
import time
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from PIL import Image
from werkzeug.test import EnvironBuilder, run_wsgi_app

from test_user_admin_db import (  # noqa: F401  (fixtures)
    api,
    auth_headers,
    recent_totp_amr,
    world,
)

from app.api.v1.user_admin_http import AVATAR_BODY_LIMIT
from app.auth.supabase_auth import session_predates_revocation
from app.models.audit import AuditLog

ADM_SUB = "auth-sec-adm"
ADM2_SUB = "auth-sec-adm-2"
USER_SUB = "auth-sec-user"
MULTI_SUB = "auth-sec-multi"


@pytest.fixture()
def scene(api):
    w = api.world
    x, y = w.unit("X"), w.unit("Y")
    actor = w.user("Adm Sec", role="ADM", units=[x], auth_user_id=ADM_SUB)
    adm2 = w.user("Adm Dois", role="ADM", units=[x], auth_user_id=ADM2_SUB)
    user_x = w.user("Pessoa X", role="USER", units=[x], auth_user_id=USER_SUB)
    # Pessoa com vínculo no escopo do ator (X) e FORA dele (Y).
    multi = w.user("Pessoa XY", role="USER", units=[x, y], auth_user_id=MULTI_SUB)
    only_y = w.user("Pessoa Y", role="USER", units=[y], auth_user_id="auth-sec-y")
    return SimpleNamespace(api=api, w=w, x=x, y=y, actor=actor, adm2=adm2, user_x=user_x,
                           multi=multi, only_y=only_y)


def _h(sub: str = ADM_SUB, **kwargs):
    kwargs.setdefault("amr", recent_totp_amr())
    return auth_headers(sub, **kwargs)


# ---------------------------------------------------------------------------
# 1. Mass assignment e corpo do PATCH / ações
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "version",
    [-1, 0, 2_147_483_648, 1.0, True, "1", None, [1], {"v": 1}],
    ids=["negativo", "zero", "acima_int32", "float", "bool", "string", "null", "lista", "objeto"],
)
def test_version_forjado_e_rejeitado_sem_alterar(scene, version):
    response = scene.api.client.patch(
        f"/api/v1/users/{scene.user_x}", json={"version": version, "role": "RH"}, headers=_h()
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "validation_error"
    assert scene.w.role_codes(scene.user_x) == {"USER"} and scene.w.get(scene.user_x).version == 1


@pytest.mark.parametrize(
    "body",
    [
        {"version": 1, "role": "adm"},
        {"version": 1, "role": "ADM "},
        {"version": 1, "role": ["ADM"]},
        {"version": 1, "unit_ids": [str(uuid.uuid4()) for _ in range(51)]},
        {"version": 1, "role": "RH", "confirm_privilege_change": 1},
    ],
    ids=["minusculo", "espaco", "lista", "51_unidades", "confirm_int"],
)
def test_patch_valores_fora_do_contrato(scene, body):
    response = scene.api.client.patch(f"/api/v1/users/{scene.user_x}", json=body, headers=_h())
    assert response.status_code == 400
    assert scene.w.role_codes(scene.user_x) == {"USER"}


@pytest.mark.parametrize("field", ["active", "deleted_at", "auth_user_id", "unit_id", "version"])
@pytest.mark.parametrize("suffix", ["/deactivate", "/activate"])
def test_acoes_de_conta_rejeitam_campos_privilegiados(scene, suffix, field):
    body = {"version": 1, field: "x"} if field != "version" else {"version": 1, "versao": 2}
    response = scene.api.client.post(f"/api/v1/users/{scene.user_x}{suffix}", json=body, headers=_h())
    assert response.status_code == 400
    assert scene.w.get(scene.user_x).active is True and scene.w.get(scene.user_x).version == 1
    flagged = [e for e in scene.api.events
               if e["event_type"] in {"PRIVILEGE_ESCALATION_ATTEMPT", "MASS_ASSIGNMENT_REJECTED"}]
    assert flagged and flagged[0]["actor_user_id"] == str(scene.actor)


@pytest.mark.parametrize("suffix", ["/revoke-sessions", "/password-reset", "/mfa-reset"])
def test_rotas_sem_corpo_rejeitam_version_ou_alvo_no_corpo(scene, suffix):
    response = scene.api.client.post(
        f"/api/v1/users/{scene.user_x}{suffix}",
        json={"version": 1, "user_id": str(scene.only_y)},
        headers=_h(),
    )
    assert response.status_code == 400
    scene.api.admin.delete_all_mfa_factors.assert_not_called()
    scene.api.admin.send_password_recovery.assert_not_called()
    assert scene.w.get(scene.user_x).sessions_revoked_at is None


def test_confirm_false_nao_confirma_promocao(scene):
    response = scene.api.client.patch(
        f"/api/v1/users/{scene.user_x}",
        json={"version": 1, "role": "ADM", "confirm_privilege_change": False},
        headers=_h(),
    )
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "confirmation_required"
    assert scene.w.role_codes(scene.user_x) == {"USER"}


# ---------------------------------------------------------------------------
# 2. Auto-alteração, último ADM e serialização
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("transform", [str.upper, str.lower], ids=["maiusculas", "minusculas"])
@pytest.mark.parametrize(
    "method,suffix,body",
    [
        ("PATCH", "", {"version": 1, "unit_ids": "X"}),
        ("PATCH", "", {"version": 1, "role": "USER", "confirm_privilege_change": True}),
        ("POST", "/deactivate", {"version": 1}),
        ("POST", "/mfa-reset", None),
    ],
    ids=["unidades", "perfil", "desativar", "mfa"],
)
def test_auto_alteracao_bloqueada_em_qualquer_grafia_do_uuid(scene, method, suffix, body, transform):
    if body and body.get("unit_ids") == "X":
        body = {"version": 1, "unit_ids": [str(scene.x)]}
    url = f"/api/v1/users/{transform(str(scene.actor))}{suffix}"
    response = scene.api.client.open(url, method=method, json=body, headers=_h())
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "self_change_forbidden"
    assert scene.w.role_codes(scene.actor) == {"ADM"} and scene.w.get(scene.actor).active is True
    scene.api.admin.delete_all_mfa_factors.assert_not_called()


def test_dois_adms_se_rebaixando_em_sequencia_sobra_um_adm(scene):
    """Serialização lógica do "último ADM": o 2º pedido roda com o estado
    já gravado pelo 1º (papéis relidos a cada requisição)."""
    api = scene.api
    first = api.client.patch(
        f"/api/v1/users/{scene.adm2}",
        json={"version": 1, "role": "USER", "confirm_privilege_change": True},
        headers=_h(),
    )
    assert first.status_code == 200
    # O ADM rebaixado tenta, com o JWT que já tinha, rebaixar o ator.
    second = api.client.patch(
        f"/api/v1/users/{scene.actor}",
        json={"version": 1, "role": "USER", "confirm_privilege_change": True},
        headers=_h(ADM2_SUB),
    )
    assert second.status_code == 403
    assert scene.w.role_codes(scene.actor) == {"ADM"}


def test_lock_global_vem_antes_de_qualquer_leitura_do_alvo(scene):
    """PATCH/desativação tomam o advisory lock do "último ADM" ANTES do
    `SELECT ... FOR UPDATE` (mesma ordem do revoke legado; sem deadlock)."""
    api = scene.api
    marks: list[str] = []
    from app.services import user_admin_service as svc

    original_load = svc.UserAdminService._load_scoped_target

    def spy_load(self, *a, **k):
        marks.append("load")
        return original_load(self, *a, **k)

    from unittest.mock import patch

    with patch.object(svc, "_acquire_advisory_xact_lock", lambda _db, key: marks.append(f"lock:{key}")), \
            patch.object(svc.UserAdminService, "_load_scoped_target", spy_load):
        api.client.patch(f"/api/v1/users/{scene.user_x}", json={"version": 1, "role": "RH"}, headers=_h())
        api.client.post(f"/api/v1/users/{scene.user_x}/deactivate", json={"version": 2}, headers=_h())
    lock_key = svc._REVOKE_ADVISORY_LOCK_KEY
    assert marks == [f"lock:{lock_key}", "load", f"lock:{lock_key}", "load"]


def test_desativar_o_outro_adm_quando_ha_dois_e_depois_o_unico_restante_e_protegido(scene):
    api = scene.api
    assert api.client.post(f"/api/v1/users/{scene.adm2}/deactivate", json={"version": 1},
                           headers=_h()).status_code == 200
    # adm2 inativo: o JWT dele morre na hora (active=false + sessions_revoked_at).
    assert api.client.get("/api/v1/me", headers=_h(ADM2_SUB)).status_code == 401
    # Rebaixar o ator (único ADM ativo) é impossível por qualquer caminho.
    assert api.client.patch(
        f"/api/v1/users/{scene.actor}",
        json={"version": 1, "role": "USER", "confirm_privilege_change": True},
        headers=_h(ADM2_SUB),
    ).status_code == 401


# ---------------------------------------------------------------------------
# 3. Semântica de unit_ids e escopo
# ---------------------------------------------------------------------------


def test_patch_de_unidades_preserva_e_nao_revela_vinculos_alheios(scene):
    api = scene.api
    z = scene.w.unit("Z")
    with scene.w.session() as db:  # Z entra no escopo do ator
        from app.models.units import UserUnitAccess

        db.add(UserUnitAccess(id=uuid.uuid4(), user_id=scene.actor, unit_id=z))
    response = api.client.patch(
        f"/api/v1/users/{scene.multi}", json={"version": 1, "unit_ids": [str(z)]}, headers=_h()
    )
    assert response.status_code == 200
    body = response.get_json()
    assert [u["id"] for u in body["units"]] == [str(z)]
    assert str(scene.y) not in response.get_data(as_text=True)
    # Vínculo alheio (Y) preservado; X (do escopo) removido; Z adicionado.
    assert scene.w.unit_ids(scene.multi) == {scene.y, z}
    (audit,) = scene.w.audits("USER_UNITS_CHANGED")
    assert str(scene.y) not in str(audit.previous_values) + str(audit.new_values)
    history = api.client.get(f"/api/v1/users/{scene.multi}/audit", headers=_h()).get_data(as_text=True)
    assert str(scene.y) not in history


def test_adm_nao_remove_vinculo_alheio_nem_enviando_a_unidade_alheia(scene):
    api = scene.api
    response = api.client.patch(
        f"/api/v1/users/{scene.multi}", json={"version": 1, "unit_ids": [str(scene.y)]}, headers=_h()
    )
    assert response.status_code == 403 and response.get_json()["error"]["code"] == "unit_out_of_scope"
    assert scene.w.unit_ids(scene.multi) == {scene.x, scene.y}


def test_filtro_por_unidade_alheia_nao_revela_quem_tem_vinculo_nela(scene):
    api = scene.api
    alheia = api.client.get(f"/api/v1/users?unit_id={scene.y}", headers=_h()).get_json()
    inexistente = api.client.get(f"/api/v1/users?unit_id={uuid.uuid4()}", headers=_h()).get_json()
    assert alheia == inexistente == {"total": 0, "page": 1, "page_size": 50, "pages": 0, "users": []}


@pytest.mark.parametrize("case", ["promover", "desativar_adm_multi", "promover_orfao"])
def test_mudanca_de_privilegio_exige_escopo_sobre_todas_as_unidades_do_alvo(scene, case):
    api = scene.api
    if case == "promover_orfao":
        # Conta revogada por OUTRO ADM (sem papéis nem unidades): visível a todo
        # ADM, e qualquer um a devolve como ADM sem unidade alguma no escopo dele.
        orphan = scene.w.user("Revogada Por Outro", units=[])
        response = api.client.patch(
            f"/api/v1/users/{orphan}",
            json={"version": 1, "role": "ADM", "confirm_privilege_change": True},
            headers=_h(),
        )
        assert response.status_code in (403, 409)
        assert scene.w.role_codes(orphan) == set()
    elif case == "promover":
        response = api.client.patch(
            f"/api/v1/users/{scene.multi}",
            json={"version": 1, "role": "ADM", "confirm_privilege_change": True},
            headers=_h(),
        )
        assert response.status_code in (403, 409)
        assert scene.w.role_codes(scene.multi) == {"USER"}
    else:
        multi_adm = scene.w.user("Adm XY", role="ADM", units=[scene.x, scene.y])
        response = api.client.post(f"/api/v1/users/{multi_adm}/deactivate", json={"version": 1}, headers=_h())
        assert response.status_code in (403, 409)
        assert scene.w.get(multi_adm).active is True


def test_historico_nao_mostra_acoes_do_alvo_sobre_usuarios_fora_do_escopo(scene):
    api = scene.api
    multi_adm = scene.w.user("Adm XY", role="ADM", units=[scene.x, scene.y])
    foreign_event = uuid.uuid4()
    with scene.w.session() as db:
        db.add(AuditLog(
            id=foreign_event, actor_user_id=multi_adm, entity_type="user", entity_id=str(scene.only_y),
            operation="USER_ROLE_CHANGED", previous_values={"role": "USER"}, new_values={"role": "ADM"},
            result="SUCESSO", occurred_at=datetime.now(timezone.utc),
        ))
    events = api.client.get(f"/api/v1/users/{multi_adm}/audit", headers=_h()).get_json()["events"]
    assert str(foreign_event) not in {event["id"] for event in events}


def test_historico_nunca_devolve_segredos_nem_chaves_fora_da_allowlist(scene):
    api = scene.api
    secret = "eyJhbGciOiJIUzI1NiJ9.segredo-sintetico.assinatura"
    with scene.w.session() as db:
        db.add(AuditLog(
            id=uuid.uuid4(), actor_user_id=scene.actor, entity_type="user", entity_id=str(scene.user_x),
            operation="USER_DEACTIVATED",
            previous_values={"active": True, "password": secret, "email": "pessoa.x@exemplo.invalid"},
            new_values={
                "active": False, "access_token": secret, "invite_link": f"https://x.invalid/#{secret}",
                "redirect_to": "https://x.invalid", "reason": "motivo com CPF 529.982.247-25",
                "role": {"nested": secret}, "units": [secret * 3],
            },
            result="SUCESSO", occurred_at=datetime.now(timezone.utc),
        ))
    response = api.client.get(f"/api/v1/users/{scene.user_x}/audit", headers=_h())
    text = response.get_data(as_text=True)
    assert response.status_code == 200
    for leak in (secret, "pessoa.x@exemplo.invalid", "529.982.247-25", "redirect_to", "invite_link"):
        assert leak not in text
    (event,) = response.get_json()["events"]
    assert set(event["changes"]) <= {"role", "units", "active", "avatar", "sessions_revoked_at"}
    assert event["changes"]["role"] == {"from": None, "to": None}


# ---------------------------------------------------------------------------
# 4. Sessões revogadas: iat / amr
# ---------------------------------------------------------------------------

REVOKED = datetime(2026, 10, 15, 12, 0, 0, 250_000, tzinfo=timezone.utc)
CUTOFF = int(datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc).timestamp())


@pytest.mark.parametrize(
    "claims",
    [
        {"iat": CUTOFF + 60, "amr": [{"method": "password", "timestamp": CUTOFF - 600}]},
        {"iat": CUTOFF + 60, "amr": [{"method": "password", "timestamp": CUTOFF}]},
        {"iat": CUTOFF + 60, "amr": [{"method": "password", "timestamp": CUTOFF - 1},
                                     {"method": "totp", "timestamp": CUTOFF - 1}]},
        {"iat": float("nan")},
        {"iat": float("inf")},
        {"iat": CUTOFF - 0.5},
    ],
    ids=["refresh", "login_no_mesmo_segundo", "refresh_aal2", "iat_nan", "iat_inf", "iat_fracao_antes"],
)
def test_sessao_anterior_a_revogacao_e_rejeitada(claims):
    assert session_predates_revocation(claims, REVOKED) is True


@pytest.mark.parametrize(
    "amr",
    [
        [{"method": "password", "timestamp": CUTOFF - 600}, {"method": "totp", "timestamp": CUTOFF + 30}],
        [{"method": "password", "timestamp": CUTOFF - 600}, {"method": "totp", "timestamp": CUTOFF - 590},
         {"method": "totp", "timestamp": CUTOFF + 30}],
    ],
    ids=["reverify_totp", "novo_fator_apos_reset"],
)
def test_reverificar_totp_numa_sessao_revogada_nao_a_ressuscita(amr):
    assert session_predates_revocation({"iat": CUTOFF + 31, "amr": amr}, REVOKED) is True


def test_sessao_revogada_com_totp_reverificado_e_negada_na_api(scene):
    """Cenário: sessão de um ADM roubada; outro ADM roda revoke-sessions (ou
    mfa-reset). O atacante, com o refresh token ainda válido no Supabase,
    re-verifica TOTP (ou cadastra um fator novo após o reset) e obtém um
    access token com `iat` novo e `amr` = [password antigo, totp novo]."""
    api = scene.api
    login_at = int(time.time()) - 900
    assert api.client.post(f"/api/v1/users/{scene.adm2}/revoke-sessions", headers=_h()).status_code == 200
    stolen = auth_headers(
        ADM2_SUB, iat=int(time.time()) + 2,
        amr=[{"method": "password", "timestamp": login_at}, {"method": "totp", "timestamp": int(time.time()) + 2}],
    )
    assert api.client.get("/api/v1/users", headers=stolen).status_code == 401


def test_novo_login_apos_revogacao_continua_aceito(scene):
    """Controle positivo da correção sugerida para UA-SESS-01 (usar o MENOR
    instante do `amr`): um login novo tem TODOS os instantes após o corte."""
    api = scene.api
    assert api.client.post(f"/api/v1/users/{scene.adm2}/revoke-sessions", headers=_h()).status_code == 200
    now = int(time.time()) + 2
    fresh = auth_headers(ADM2_SUB, iat=now, amr=[{"method": "password", "timestamp": now},
                                                 {"method": "totp", "timestamp": now}])
    assert api.client.get("/api/v1/users", headers=fresh).status_code == 200


def test_mfa_reset_exige_aal2_antes_da_reautenticacao(scene):
    api = scene.api
    response = api.client.post(
        f"/api/v1/users/{scene.user_x}/mfa-reset", headers=_h(aal="aal1", amr=recent_totp_amr())
    )
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "AAL2_REQUIRED"
    api.admin.delete_all_mfa_factors.assert_not_called()


def test_mfa_reset_alvo_alheio_com_reautenticacao_valida_e_404(scene):
    api = scene.api
    response = api.client.post(f"/api/v1/users/{scene.only_y}/mfa-reset", headers=_h())
    assert response.status_code == 404
    api.admin.delete_all_mfa_factors.assert_not_called()


# ---------------------------------------------------------------------------
# 5. Reset de senha: allowlist, sem vazamento, 5/h por alvo
# ---------------------------------------------------------------------------


def _set_redirect(monkeypatch, value):
    from app.config.settings import get_settings

    monkeypatch.setattr(
        type(get_settings()), "password_reset_redirect_effective_url", property(lambda _s: value)
    )


def test_limite_por_alvo_vale_entre_adms_e_grafias_do_uuid(scene, monkeypatch):
    api = scene.api
    _set_redirect(monkeypatch, "https://app.exemplo.invalid/redefinir-senha")
    api.admin.send_password_recovery.return_value = None
    target = str(scene.user_x)
    plan = [(ADM_SUB, target), (ADM2_SUB, target.upper()), (ADM_SUB, target), (ADM2_SUB, target.upper()),
            (ADM_SUB, target)]
    for sub, path_id in plan:
        response = api.client.post(f"/api/v1/users/{path_id}/password-reset", headers=_h(sub))
        assert response.status_code == 200 and response.get_json() == {"result": "sent"}
    sixth = api.client.post(f"/api/v1/users/{target.upper()}/password-reset", headers=_h(ADM2_SUB))
    assert sixth.status_code == 429
    assert api.admin.send_password_recovery.call_count == 5


def test_reset_de_senha_nao_devolve_nem_audita_link_email_ou_redirect(scene, monkeypatch):
    api = scene.api
    redirect = "https://app.exemplo.invalid/redefinir-senha"
    _set_redirect(monkeypatch, redirect)
    api.admin.send_password_recovery.return_value = {"action_link": "https://x.invalid/#token=SEGREDO"}
    response = api.client.post(f"/api/v1/users/{scene.user_x}/password-reset", headers=_h())
    assert response.get_json() == {"result": "sent"}
    api.admin.send_password_recovery.assert_called_once_with("pessoa.x@exemplo.invalid", redirect)
    (audit,) = scene.w.audits("USER_PASSWORD_RESET_SENT")
    dumped = str(audit.previous_values) + str(audit.new_values)
    for leak in ("SEGREDO", "pessoa.x@exemplo.invalid", redirect):
        assert leak not in dumped and leak not in response.get_data(as_text=True)


@pytest.mark.parametrize(
    "configured,allowed,expected",
    [
        ("https://evil.invalid/x", "https://app.exemplo.invalid/a", None),
        ("", "https://app.exemplo.invalid/a,https://app.exemplo.invalid/b", "https://app.exemplo.invalid/a"),
        ("https://app.exemplo.invalid/b", "https://app.exemplo.invalid/a,https://app.exemplo.invalid/b",
         "https://app.exemplo.invalid/b"),
        ("https://app.exemplo.invalid/a/../../evil", "https://app.exemplo.invalid/a", None),
        ("https://app.exemplo.invalid/a", "", None),
    ],
)
def test_redirect_do_reset_so_da_allowlist(configured, allowed, expected):
    from app.config.settings import Settings

    settings = Settings(
        database_url="postgresql://u:p@localhost/x", secret_key="s" * 40, _env_file=None,
        password_reset_redirect_url=configured, invite_allowed_redirect_urls=allowed,
    )
    assert settings.password_reset_redirect_effective_url == expected


def test_cliente_bloqueia_redirect_fora_da_allowlist_sem_rede():
    from unittest.mock import MagicMock

    from app.config.settings import Settings
    from app.integrations.supabase_admin_client import InviteRedirectNotAllowedError, SupabaseAdminClient

    session = MagicMock()
    client = SupabaseAdminClient(
        settings=Settings(
            database_url="postgresql://u:p@localhost/x", secret_key="s" * 40, _env_file=None,
            supabase_url="https://projeto-ficticio.supabase.co", supabase_service_role_key="k" * 40,
            invite_allowed_redirect_urls="https://app.exemplo.invalid/a",
        ),
        session=session,
    )
    with pytest.raises(InviteRedirectNotAllowedError):
        client.send_password_recovery("p@exemplo.invalid", "https://app.exemplo.invalid/a?next=//evil")
    session.request.assert_not_called()


# ---------------------------------------------------------------------------
# 6. Upload de foto: limite de corpo próprio, multipart e conteúdo
# ---------------------------------------------------------------------------


class _CountingStream(io.BytesIO):
    """`wsgi.input` que conta quantos bytes o backend realmente leu."""

    def __init__(self, data: bytes) -> None:
        super().__init__(data)
        self.consumed = 0

    def read(self, size=-1):
        chunk = super().read(size)
        self.consumed += len(chunk)
        return chunk

    def readline(self, size=-1):
        chunk = super().readline(size)
        self.consumed += len(chunk)
        return chunk


def _png(size=(48, 48)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (20, 90, 160)).save(out, "PNG")
    return out.getvalue()


def _multipart_environ(file_bytes: bytes, headers: dict[str, str]):
    builder = EnvironBuilder(
        path="/api/v1/me/avatar", method="PUT", headers=headers,
        data={"file": (io.BytesIO(file_bytes), "a.png", "image/png")}, content_type="multipart/form-data",
    )
    environ = builder.get_environ()
    body = environ["wsgi.input"].read()
    return environ, body


def _run(app, environ):
    iterator, status, _headers = run_wsgi_app(app.wsgi_app, environ, buffered=True)
    return int(status.split()[0]), b"".join(iterator)


@pytest.fixture()
def uploader(scene):
    return scene


def test_content_length_acima_do_limite_413_sem_ler_o_corpo(uploader):
    app = uploader.api.client.application
    environ, body = _multipart_environ(b"\x89PNG\r\n\x1a\n" + b"\0" * (3 * 1024 * 1024), _h(USER_SUB))
    stream = _CountingStream(body)
    environ["wsgi.input"] = stream
    status, out = _run(app, environ)
    assert status == 413 and b"file_too_large" in out
    assert stream.consumed == 0
    assert uploader.api.storage.objects == {}


def test_streaming_sem_content_length_com_servidor_que_termina_o_stream(uploader):
    """Gunicorn/Nginx (produção): `wsgi.input_terminated` => leitura limitada."""
    app = uploader.api.client.application
    environ, body = _multipart_environ(b"\x89PNG\r\n\x1a\n" + b"\0" * (8 * 1024 * 1024), _h(USER_SUB))
    stream = _CountingStream(body)
    environ.pop("CONTENT_LENGTH", None)
    environ["wsgi.input"] = stream
    environ["wsgi.input_terminated"] = True
    status, out = _run(app, environ)
    assert status == 413 and b"file_too_large" in out
    assert stream.consumed <= AVATAR_BODY_LIMIT + 64 * 1024
    assert uploader.api.storage.objects == {}


def test_streaming_sem_content_length_e_sem_terminacao_nao_le_alem_do_limite(uploader):
    app = uploader.api.client.application
    environ, body = _multipart_environ(b"\x89PNG\r\n\x1a\n" + b"\0" * (8 * 1024 * 1024), _h(USER_SUB))
    stream = _CountingStream(body)
    environ.pop("CONTENT_LENGTH", None)
    environ.pop("wsgi.input_terminated", None)
    environ["wsgi.input"] = stream
    status, _out = _run(app, environ)
    assert status in (400, 411, 413)
    assert stream.consumed <= AVATAR_BODY_LIMIT + 64 * 1024, stream.consumed


def test_content_length_falso_menor_que_o_corpo_nao_aceita_arquivo_truncado(uploader):
    app = uploader.api.client.application
    environ, body = _multipart_environ(_png((300, 300)), _h(USER_SUB))
    environ["CONTENT_LENGTH"] = str(len(body) // 2)
    environ["wsgi.input"] = _CountingStream(body)
    status, out = _run(app, environ)
    assert status == 400 and b"unsupported_image" in out
    assert uploader.api.storage.objects == {}


@pytest.mark.parametrize(
    "raw,ctype",
    [
        (b"sem boundary", "multipart/form-data"),
        (b"--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a\"\r\n\r\n\x89PNG", "multipart/form-data; boundary=B"),
        (b"--B\r\ncabecalho quebrado\r\n\r\nabc\r\n--B--\r\n", "multipart/form-data; boundary=B"),
        (b"--B--\r\n", "multipart/form-data; boundary=B"),
        (b"\x89PNG\r\n\x1a\n", "image/png"),
        (b"file=abc", "application/x-www-form-urlencoded"),
    ],
    ids=["sem_boundary", "sem_fechamento", "cabecalho_invalido", "vazio", "corpo_cru", "urlencoded"],
)
def test_multipart_malformado_400(uploader, raw, ctype):
    response = uploader.api.client.put("/api/v1/me/avatar", data=raw, content_type=ctype, headers=_h(USER_SUB))
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "unsupported_image"
    assert uploader.api.storage.objects == {}


def test_muitas_partes_ou_campo_texto_gigante_sao_barrados(uploader):
    client = uploader.api.client
    many = {f"p{i}": "x" for i in range(30)}
    many["file"] = (io.BytesIO(_png()), "a.png", "image/png")
    assert client.put("/api/v1/me/avatar", data=many, content_type="multipart/form-data",
                      headers=_h(USER_SUB)).status_code in (400, 413)
    huge_text = client.put("/api/v1/me/avatar", data={"file": "x" * (600 * 1024)},
                           content_type="multipart/form-data", headers=_h(USER_SUB))
    assert huge_text.status_code in (400, 413)
    assert uploader.api.storage.objects == {}


def _jpeg_with_metadata(marker: bytes) -> bytes:
    image = Image.new("RGB", (200, 120), (200, 30, 30))
    exif = Image.Exif()
    exif[0x010E] = marker.decode()  # ImageDescription
    exif[0x013B] = marker.decode()  # Artist
    gps = {1: "S", 2: (10.0, 11.0, 12.0), 3: "W", 4: (48.0, 20.0, 0.0)}
    exif[0x8825] = gps
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif.tobytes(), icc_profile=b"ICC-" + marker * 4, comment=marker)
    return out.getvalue()


def test_upload_http_remove_exif_gps_icc_e_comentario(uploader):
    marker = b"SEGREDO-METADADO-9c1"
    data = _jpeg_with_metadata(marker)
    assert marker in data
    response = uploader.api.client.put(
        "/api/v1/me/avatar", data={"file": (io.BytesIO(data), "../../x.svg", "image/svg+xml")},
        content_type="multipart/form-data", headers=_h(USER_SUB),
    )
    assert response.status_code == 200
    ((key, stored),) = uploader.api.storage.objects.items()
    assert key.endswith(".webp") and "x.svg" not in key and ".." not in key
    assert stored[:4] == b"RIFF" and stored[8:12] == b"WEBP"
    for forbidden in (marker, b"EXIF", b"ICCP", b"XMP ", b"Exif"):
        assert forbidden not in stored
    with Image.open(io.BytesIO(stored)) as out:
        assert out.size == (512, 512) and not out.info.get("exif") and not out.info.get("icc_profile")


@pytest.mark.parametrize(
    "tail",
    [b"<html><script>alert(1)</script></html>", b"PK\x03\x04" + b"\0" * 26 + b"evil.sh", b"<?php system($_GET[0]); ?>"],
    ids=["jpeg_html", "jpeg_zip", "jpeg_php"],
)
def test_polyglot_via_http_vira_webp_limpo(uploader, tail):
    out = io.BytesIO()
    Image.new("RGB", (64, 64), (1, 2, 3)).save(out, "JPEG")
    data = out.getvalue() + tail
    response = uploader.api.client.put(
        "/api/v1/me/avatar", data={"file": (io.BytesIO(data), "a.html", "text/html")},
        content_type="multipart/form-data", headers=_h(USER_SUB),
    )
    assert response.status_code == 200
    (stored,) = uploader.api.storage.objects.values()
    assert tail[:8] not in stored and stored[8:12] == b"WEBP"


@pytest.mark.parametrize(
    "data",
    [
        b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        b"GIF89a\x01\x00\x01\x00\x00\x00\x00;",
        b"\xff\xd8\xff<svg onload=alert(1)>",
        b"RIFF\x00\x00\x00\x00WEBPVP8 garbage",
        b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + (50000).to_bytes(4, "big") * 2 + b"\x08\x02\x00\x00\x00",
    ],
    ids=["svg", "gif", "jpeg_falso_svg", "webp_falso", "png_bomba_cabecalho"],
)
def test_formatos_proibidos_ou_falsos_via_http(uploader, data):
    response = uploader.api.client.put(
        "/api/v1/me/avatar", data={"file": (io.BytesIO(data), "foto.png", "image/png")},
        content_type="multipart/form-data", headers=_h(USER_SUB),
    )
    assert response.status_code == 400 and response.get_json()["error"]["code"] == "unsupported_image"
    assert uploader.api.storage.objects == {}


def test_upload_para_alvo_alheio_nao_grava_nada(uploader):
    response = uploader.api.client.put(
        f"/api/v1/users/{uploader.only_y}/avatar",
        data={"file": (io.BytesIO(_png()), "a.png", "image/png")},
        content_type="multipart/form-data", headers=_h(),
    )
    assert response.status_code == 404
    assert uploader.api.storage.objects == {}
    assert uploader.w.get(uploader.only_y).avatar_object_key is None


def test_url_assinada_alheia_e_404_e_propria_nao_aceita_id(uploader):
    api = uploader.api
    uploader.w.set(uploader.only_y, avatar_object_key=f"{uuid.uuid4()}.webp")
    assert api.client.get(f"/api/v1/users/{uploader.only_y}/avatar-url", headers=_h()).status_code == 404
    # /me/avatar-url ignora qualquer parâmetro de alvo: sempre o usuário do JWT.
    mine = api.client.get(f"/api/v1/me/avatar-url?user_id={uploader.only_y}", headers=_h(USER_SUB))
    assert mine.status_code in (400, 404)
