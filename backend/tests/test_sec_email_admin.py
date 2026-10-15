"""E-mail administrativo: `POST /settings/email/test` e notificação a ADMs.

Zero rede: SMTP (`smtplib`) mockado, Redis em memória, banco mockado. Valores
FICTÍCIOS. Cobre: matriz authz, corpo vazio/mass assignment, destinatário só
o próprio ADM, resposta genérica, rate limit fail-closed, auditoria e o gancho
de notificação de eventos críticos (best effort, sem dados sensíveis).
"""
from __future__ import annotations

import smtplib
from concurrent.futures import Future
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import redis as redis_lib

from _email_helpers import FAKE_PASSWORD, make_settings
from app import create_app
from app.authorization import security_events
from app.services import security_notifications as notif
from app.services.email import dispatch
from test_ai_support import FakeRedis
from test_sec_authz import as_user, call, make_token

_REAL_DISPATCH = security_events._dispatch  # o conftest troca por no-op (autouse)
URL = "/api/v1/settings/email/test"
PERM = "settings.email.manage"
SMTP = "app.services.email.sender.smtplib.SMTP"


class _SyncExecutor:
    def submit(self, fn, *a, **k):
        f = Future()
        try:
            f.set_result(fn(*a, **k))
        except BaseException as exc:  # noqa: BLE001
            f.set_exception(exc)
        return f


@pytest.fixture()
def client():
    return create_app().test_client()


@pytest.fixture()
def events():
    captured: list[dict] = []
    with patch("app.authorization.security_events._dispatch", side_effect=captured.append):
        yield captured


@pytest.fixture()
def env(monkeypatch):
    state = SimpleNamespace(redis=FakeRedis(), settings=make_settings())
    monkeypatch.setattr(dispatch, "_get_executor", lambda: _SyncExecutor())
    with ExitStack() as stack:
        stack.enter_context(patch("redis.Redis.from_url", return_value=state.redis))
        stack.enter_context(
            patch("app.api.v1.email_settings.get_settings", lambda: state.settings)
        )
        yield state


def _adm(**kw):
    return as_user({"ADM"}, {PERM}, **kw)


def _post(client, body=None, token=None):
    return call(client, "POST", URL, body, token=token or make_token())


# --- authz -------------------------------------------------------------------
@pytest.mark.parametrize("role", ["USER", "RH"])
def test_user_e_rh_negados_e_auditados(client, env, events, role):
    with patch(SMTP) as smtp, as_user({role}, {PERM}):
        r = _post(client)
    assert r.status_code == 403
    assert any(e["event_type"] == "ACCESS_DENIED" for e in events)
    smtp.assert_not_called()


def test_adm_aal1_negado(client, env, events):
    with patch(SMTP) as smtp, _adm():
        r = _post(client, token=make_token(aal="aal1"))
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "AAL2_REQUIRED"
    assert any(e["event_type"] == "AAL2_REQUIRED" for e in events)
    smtp.assert_not_called()


def test_adm_sem_permissao_negado(client, env, events):
    with patch(SMTP) as smtp, as_user({"ADM"}, {"settings.ai.manage"}):
        r = _post(client)
    assert r.status_code == 403
    smtp.assert_not_called()


def test_sem_token_401(client, env):
    with patch(SMTP) as smtp:
        r = call(client, "POST", URL, None, token=None)
    assert r.status_code == 401
    smtp.assert_not_called()


# --- corpo / destinatário ------------------------------------------------------
@pytest.mark.parametrize(
    "body", [{"to": "atacante@evil.example"}, {"recipient": "x@y.com"}, {"subject": "s"}, {"role": "ADM"}]
)
def test_corpo_com_campos_e_rejeitado_e_auditado(client, env, events, body):
    with patch(SMTP) as smtp, _adm():
        r = _post(client, body)
    assert r.status_code == 400
    assert any(
        e["event_type"] in {"MASS_ASSIGNMENT_REJECTED", "PRIVILEGE_ESCALATION_ATTEMPT"} for e in events
    )
    smtp.assert_not_called()


def test_corpo_nao_objeto_400(client, env, events):
    with patch(SMTP) as smtp, _adm():
        r = call(client, "POST", URL, ["a@b.com"], token=make_token())
    assert r.status_code == 400
    smtp.assert_not_called()


def test_envia_somente_ao_proprio_adm_com_corpo_vazio_ou_ausente(client, env, events):
    for body in (None, {}):
        with patch(SMTP) as smtp, _adm():
            r = _post(client, body)
        assert r.status_code == 200 and r.get_json() == {"result": "sent"}
        send = smtp.return_value.send_message
        assert send.call_args.kwargs["to_addrs"] == ["sintetico@exemplo.com"]
        msg = send.call_args.args[0]
        assert msg["To"] == "sintetico@exemplo.com"
    types = [e["event_type"] for e in events]
    assert "EMAIL_TEST_REQUESTED" in types and "EMAIL_SENT" in types


def test_resposta_e_auditoria_nao_vazam_endereco_nem_segredo(client, env, events):
    with patch(SMTP), _adm():
        r = _post(client)
    blob = r.get_data(as_text=True) + repr(events)
    assert "sintetico@exemplo.com" not in blob
    assert FAKE_PASSWORD not in blob and "smtp.example.test" not in blob


# --- resultados genéricos ------------------------------------------------------
def test_desabilitado_nao_abre_rede_e_audita(client, env, events):
    env.settings = make_settings(email_enabled=False)
    with patch(SMTP) as smtp, _adm():
        r = _post(client)
    assert r.status_code == 200 and r.get_json() == {"result": "disabled"}
    smtp.assert_not_called()
    assert [e["details"]["outcome"] for e in events if e["event_type"] == "EMAIL_TEST_REQUESTED"] == [
        "disabled"
    ]


def test_falha_smtp_resposta_generica_sem_detalhes(client, env, events):
    with patch(SMTP) as smtp, patch("app.services.email.sender.time.sleep"), _adm():
        smtp.return_value.login.side_effect = smtplib.SMTPAuthenticationError(535, b"senha ruim " + FAKE_PASSWORD.encode())
        r = _post(client)
    assert r.status_code == 200 and r.get_json() == {"result": "failed"}
    blob = r.get_data(as_text=True) + repr(events)
    assert "535" not in r.get_data(as_text=True) and FAKE_PASSWORD not in blob
    assert any(e["event_type"] == "EMAIL_FAILED" for e in events)
    assert any(
        e["event_type"] == "EMAIL_TEST_REQUESTED" and e["details"]["outcome"] == "failed" for e in events
    )


def test_email_invalido_do_adm_vira_failed(client, env, events):
    with patch(SMTP) as smtp, patch(
        "app.auth.supabase_auth._load_user_with_roles_and_permissions",
        return_value=(
            SimpleNamespace(id="00000000-0000-0000-0000-000000000001", active=True,
                            auth_user_id="a", name="x", email="a@b.com\r\nBcc: v@evil.example"),
            {"ADM"}, {PERM},
        ),
    ):
        r = _post(client)
    assert r.get_json() == {"result": "failed"}
    smtp.assert_not_called()


# --- rate limit ------------------------------------------------------------------
def test_rate_limit_rigido_429(client, env):
    with patch(SMTP), _adm(user_id=__import__("uuid").uuid4()) as u:
        codes = []
        for _ in range(5):
            codes.append(_post(client).status_code)
    assert codes == [200, 200, 200, 429, 429]


def test_redis_fora_bloqueia_503_sem_enviar(client, env):
    broken = MagicMock()
    broken.incr.side_effect = redis_lib.exceptions.ConnectionError("x")
    with patch("redis.Redis.from_url", return_value=broken), patch(SMTP) as smtp, _adm():
        r = _post(client)
    assert r.status_code == 503
    smtp.assert_not_called()


# --- constantes de eventos -------------------------------------------------------
def test_eventos_de_email_vivem_em_security_events():
    assert security_events.EVENT_EMAIL_SENT == "EMAIL_SENT"
    assert security_events.EVENT_EMAIL_FAILED == "EMAIL_FAILED"
    assert dispatch.EVENT_EMAIL_SENT is security_events.EVENT_EMAIL_SENT


# --- notificação a ADMs ----------------------------------------------------------
@pytest.fixture()
def notify_env(monkeypatch):
    notif.reset_throttle()
    monkeypatch.setattr(notif, "_get_executor", lambda: _SyncExecutor())
    monkeypatch.setattr(dispatch, "_get_executor", lambda: _SyncExecutor())
    state = SimpleNamespace(settings=make_settings(), recipients=["adm1@agu.gov.br", "adm2@agu.gov.br"])
    monkeypatch.setattr(notif, "get_settings", lambda: state.settings)
    monkeypatch.setattr(dispatch, "get_settings", lambda: state.settings)
    monkeypatch.setattr(notif, "resolve_admin_recipients", lambda: list(state.recipients))
    monkeypatch.setattr(dispatch, "_build_redis_client", lambda url: FakeRedis())
    audit: list = []
    monkeypatch.setattr(dispatch, "record_security_event", lambda t, **kw: audit.append((t, kw)))
    state.audit = audit
    yield state
    notif.reset_throttle()


def _event(event_type="PRIVILEGE_ESCALATION_ATTEMPT", severity="high", **extra):
    base = security_events.build_security_event(event_type, severity=severity)
    base.update(extra)
    return base


def test_evento_critico_envia_para_cada_adm_com_corpo_sem_dados_sensiveis(notify_env):
    event = _event(
        actor_user_id="11111111-1111-1111-1111-111111111111",
        details={"fields": ["role"], "token": "eyJ.SEGREDO.x"},
    )
    event["request"] = {"request_id": "req-1", "ip": "203.0.113.9", "path": "/api/v1/users/abc"}
    with patch(SMTP) as smtp:
        assert notif.notify_admins_of_event(event) is True
    sends = smtp.return_value.send_message.call_args_list
    assert [c.kwargs["to_addrs"] for c in sends] == [["adm1@agu.gov.br"], ["adm2@agu.gov.br"]]
    body = sends[0].args[0].as_string()
    for secret in ("203.0.113.9", "/api/v1/users", "SEGREDO", "11111111-1111", FAKE_PASSWORD):
        assert secret not in body
    assert "PRIVILEGE_ESCALATION_ATTEMPT" in body and "req-1" in body


def test_desligado_e_noop_sem_banco_nem_rede(notify_env, monkeypatch):
    notify_env.settings = make_settings(email_enabled=False)
    monkeypatch.setattr(notif, "resolve_admin_recipients", MagicMock(side_effect=AssertionError))
    with patch(SMTP) as smtp:
        assert notif.notify_admins_of_event(_event()) is False
    smtp.assert_not_called()


@pytest.mark.parametrize("event_type,severity", [("ACCESS_DENIED", "medium"), ("EMAIL_FAILED", "high")])
def test_eventos_nao_criticos_ou_de_email_nao_notificam(notify_env, event_type, severity):
    with patch(SMTP) as smtp:
        assert notif.notify_admins_of_event(_event(event_type, severity)) is False
    smtp.assert_not_called()


def test_throttle_um_aviso_por_tipo(notify_env):
    with patch(SMTP) as smtp:
        assert notif.notify_admins_of_event(_event()) is True
        assert notif.notify_admins_of_event(_event()) is False
        assert notif.notify_admins_of_event(_event("MFA_FACTOR_DELETED", "high")) is True
    assert smtp.return_value.send_message.call_count == 4


def test_falha_de_smtp_ou_do_banco_nunca_propaga(notify_env, monkeypatch):
    with patch(SMTP) as smtp, patch("app.services.email.sender.time.sleep"):
        smtp.return_value.login.side_effect = smtplib.SMTPAuthenticationError(535, b"x")
        assert notif.notify_admins_of_event(_event()) is True
    monkeypatch.setattr(notif, "resolve_admin_recipients", MagicMock(side_effect=RuntimeError("db")))
    notif.reset_throttle()
    assert notif.notify_admins_of_event(_event()) is True  # agendou; falha engolida


def test_executor_quebrado_nao_propaga(notify_env, monkeypatch):
    monkeypatch.setattr(notif, "_get_executor", MagicMock(side_effect=RuntimeError("x")))
    assert notif.notify_admins_of_event(_event()) is False


def test_dispatch_aciona_notificacao_so_para_notify_true(monkeypatch):
    calls = []
    monkeypatch.setattr(notif, "notify_admins_of_event", lambda e: calls.append(e))
    monkeypatch.setattr(security_events._writer, "submit", lambda e: True)
    _REAL_DISPATCH(_event(severity="high"))
    _REAL_DISPATCH(_event("ACCESS_DENIED", "medium"))
    assert len(calls) == 1 and calls[0]["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT"


def test_dispatch_sobrevive_a_falha_da_notificacao(monkeypatch):
    monkeypatch.setattr(notif, "notify_admins_of_event", MagicMock(side_effect=RuntimeError("x")))
    monkeypatch.setattr(security_events._writer, "submit", lambda e: True)
    _REAL_DISPATCH(_event(severity="critical"))  # não levanta


def test_resolve_admin_recipients_consulta_apenas_adm_ativos():
    session = MagicMock()
    session.execute.return_value.scalars.return_value = iter(["b@agu.gov.br", "a@agu.gov.br", "b@agu.gov.br", ""])

    class _CM:
        def __enter__(self):
            return session

        def __exit__(self, *a):
            return False

    with patch.object(notif, "get_db_session", lambda: _CM()):
        assert notif.resolve_admin_recipients() == ["b@agu.gov.br", "a@agu.gov.br"]
    sql = str(session.execute.call_args.args[0].compile(compile_kwargs={"literal_binds": True}))
    assert "roles.code = 'ADM'" in sql and "users.active IS true" in sql
    assert "deactivated_at IS NULL" in sql and "LIMIT 20" in sql


# --- aviso de fator TOTP cadastrado por ADM em AAL1 (apoio ao B-3) -------------
NOTICE = "/api/v1/security/mfa/factor-added-notice"


def _notice(client, aal, roles, factors=None, body=None):
    admin = MagicMock()
    admin.list_mfa_factors.return_value = [{"id": "f"}] if factors is None else factors
    with patch("app.api.v1.security.SupabaseAdminClient", return_value=admin), as_user(roles, set()):
        return call(client, "POST", NOTICE, body, token=make_token(aal=aal))


def test_adm_aal1_com_fator_gera_evento_high(client, env, events):
    assert _notice(client, "aal1", {"ADM"}).status_code == 204
    ev = [e for e in events if e["event_type"] == "ADM_TOTP_ENROLL_AAL1"]
    assert len(ev) == 1 and ev[0]["severity"] == "high" and ev[0]["notify"] is True


@pytest.mark.parametrize("aal,roles,factors", [("aal2", {"ADM"}, None), ("aal1", {"USER"}, None), ("aal1", {"ADM"}, [])])
def test_aviso_sem_evento_nos_demais_casos(client, env, events, aal, roles, factors):
    assert _notice(client, aal, roles, factors).status_code == 204
    assert not [e for e in events if e["event_type"] == "ADM_TOTP_ENROLL_AAL1"]


def test_aviso_rejeita_corpo_e_exige_token(client, env, events):
    assert _notice(client, "aal1", {"ADM"}, body={"role": "ADM"}).status_code == 400
    assert call(client, "POST", NOTICE, None, token=None).status_code == 401


# --- B-7: cliente Redis reutilizado, fail-closed preservado ----------------------
def test_cliente_redis_do_rate_limit_e_reutilizado():
    import importlib

    rl = importlib.import_module("app.security.rate_limit")

    fake = FakeRedis()
    with patch("redis.Redis.from_url", return_value=fake) as factory:
        a = rl._build_redis_client("redis://x:6379/0")
        b = rl._build_redis_client("redis://x:6379/0")
        c = rl._build_redis_client("redis://y:6379/0")
    assert a is b is fake and c is fake and factory.call_count == 2
