"""Rotas de foto (`/me/avatar*` e `/users/<id>/avatar*`) no test client.

Storage falso (`FakeStorage`): nenhum bucket real é tocado. Cobre limite de
2 MiB próprio da rota (sem alterar o limite global de 1 MiB), extensão e
Content-Type falsos, campos extras, Storage fora (503 sem afetar as demais
rotas), troca com remoção da foto antiga e URL assinada de 300 s.
"""
from __future__ import annotations

import io
import os
import re
import uuid

import pytest
from PIL import Image
from test_user_admin_db import api, auth_headers, recent_totp_amr, world  # noqa: F401

USER_SUB = "auth-pessoa-foto"
ADM_SUB = "auth-adm-foto"
KEY_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$")


@pytest.fixture()
def people(api):
    unit = api.world.unit("A")
    user = api.world.user("Pessoa Foto", role="USER", units=[unit], auth_user_id=USER_SUB)
    adm = api.world.user("Adm Foto", role="ADM", units=[unit], auth_user_id=ADM_SUB)
    return api, user, adm


def _image(fmt="PNG", size=(120, 90)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (90, 10, 200)).save(out, fmt)
    return out.getvalue()


def _put(client, url, data: bytes, *, name="foto.png", ctype="image/png", sub=USER_SUB, extra=None):
    form = {"file": (io.BytesIO(data), name, ctype)}
    form.update(extra or {})
    return client.put(
        url, data=form, content_type="multipart/form-data",
        headers=auth_headers(sub, amr=recent_totp_amr()),
    )


def test_upload_proprio_grava_webp_aleatorio_audita_e_gera_url(people):
    api, user, _adm = people
    response = _put(api.client, "/api/v1/me/avatar", _image())
    assert response.status_code == 200 and response.get_json() == {"has_avatar": True}
    (key,) = api.storage.objects
    assert KEY_RE.fullmatch(key) and api.world.get(user).avatar_object_key == key
    assert api.storage.objects[key][:4] == b"RIFF" and api.storage.objects[key][8:12] == b"WEBP"
    (audit,) = api.world.audits("USER_AVATAR_UPDATED")
    assert audit.previous_values == {"avatar": False} and audit.new_values == {"avatar": True}
    assert audit.entity_id == str(user)
    url = api.client.get("/api/v1/me/avatar-url", headers=auth_headers(USER_SUB))
    assert url.status_code == 200
    assert url.get_json()["expires_in"] == 300 and key in url.get_json()["url"]


def test_troca_apaga_a_foto_antiga(people):
    api, user, _adm = people
    _put(api.client, "/api/v1/me/avatar", _image())
    (old,) = api.storage.objects
    assert _put(api.client, "/api/v1/me/avatar", _image("JPEG")).status_code == 200
    (new,) = api.storage.objects
    assert new != old and api.storage.deleted == [old]
    assert api.world.get(user).avatar_object_key == new


def test_remocao_e_url_sem_foto(people):
    api, user, _adm = people
    headers = auth_headers(USER_SUB)
    assert api.client.get("/api/v1/me/avatar-url", headers=headers).status_code == 404
    assert api.client.delete("/api/v1/me/avatar", headers=headers).get_json() == {"has_avatar": False}
    _put(api.client, "/api/v1/me/avatar", _image())
    response = api.client.delete("/api/v1/me/avatar", headers=headers)
    assert response.status_code == 200 and response.get_json() == {"has_avatar": False}
    assert api.storage.objects == {} and api.world.get(user).avatar_object_key is None
    missing = api.client.get("/api/v1/me/avatar-url", headers=headers)
    assert missing.status_code == 404
    assert missing.get_json() == {"error": {"code": "not_found", "message": "Recurso não encontrado."}}
    assert len(api.world.audits("USER_AVATAR_REMOVED")) == 1


def test_extensao_e_content_type_nao_sao_confiaveis(people):
    api, _user, _adm = people
    ok = _put(api.client, "/api/v1/me/avatar", _image(), name="foto.gif", ctype="image/gif")
    assert ok.status_code == 200
    html = b"<html><script>alert(1)</script></html>"
    bad = _put(api.client, "/api/v1/me/avatar", html, name="foto.jpg", ctype="image/jpeg")
    assert bad.status_code == 400 and bad.get_json()["error"]["code"] == "unsupported_image"
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'
    bad_svg = _put(api.client, "/api/v1/me/avatar", svg, name="foto.png", ctype="image/png")
    assert bad_svg.status_code == 400


def test_corpo_acima_de_2mib_retorna_413_proprio(people):
    api, user, _adm = people
    big = b"\xff\xd8\xff" + os.urandom(2 * 1024 * 1024)
    response = _put(api.client, "/api/v1/me/avatar", big, name="foto.jpg", ctype="image/jpeg")
    assert response.status_code == 413
    assert response.get_json()["error"]["code"] == "file_too_large"
    assert api.storage.objects == {} and api.world.get(user).avatar_object_key is None


def test_arquivo_entre_1_e_2_mib_aceito_sem_alterar_limite_global(people):
    api, _user, _adm = people
    noise = Image.frombytes("RGB", (700, 700), os.urandom(700 * 700 * 3))
    out = io.BytesIO()
    noise.save(out, "PNG", compress_level=0)
    data = out.getvalue()
    assert 1024 * 1024 < len(data) < 2 * 1024 * 1024
    assert _put(api.client, "/api/v1/me/avatar", data).status_code == 200
    # Limite global (1 MiB) continua valendo para as demais rotas.
    assert api.client.application.config["MAX_CONTENT_LENGTH"] == 1_048_576
    big_json = api.client.patch(
        f"/api/v1/users/{uuid.uuid4()}",
        data=b'{"version": 1, "role": "' + b"x" * (1024 * 1024 + 10) + b'"}',
        content_type="application/json",
        headers=auth_headers(ADM_SUB),
    )
    assert big_json.status_code in (400, 413)


@pytest.mark.parametrize(
    "case",
    ["campo_extra", "dois_arquivos", "sem_arquivo", "json", "vazio"],
)
def test_formulario_invalido(people, case):
    api, _user, _adm = people
    headers = auth_headers(USER_SUB)
    if case == "campo_extra":
        response = _put(api.client, "/api/v1/me/avatar", _image(), extra={"user_id": str(uuid.uuid4())})
        assert response.get_json()["error"]["code"] == "validation_error"
        assert any(e["event_type"] == "PRIVILEGE_ESCALATION_ATTEMPT" for e in api.events)
    elif case == "dois_arquivos":
        response = api.client.put(
            "/api/v1/me/avatar",
            data={"file": [(io.BytesIO(_image()), "a.png"), (io.BytesIO(_image()), "b.png")]},
            content_type="multipart/form-data", headers=headers,
        )
    elif case == "sem_arquivo":
        response = api.client.put(
            "/api/v1/me/avatar", data={}, content_type="multipart/form-data", headers=headers
        )
    elif case == "json":
        response = api.client.put("/api/v1/me/avatar", json={"file": "x"}, headers=headers)
    else:
        response = _put(api.client, "/api/v1/me/avatar", b"")
    assert response.status_code == 400
    assert api.storage.objects == {}


def test_storage_fora_responde_503_e_o_resto_funciona(people):
    api, user, _adm = people
    _put(api.client, "/api/v1/me/avatar", _image())
    key = api.world.get(user).avatar_object_key
    api.storage.down = True
    headers = auth_headers(USER_SUB)
    put = _put(api.client, "/api/v1/me/avatar", _image())
    assert put.status_code == 503 and put.get_json()["error"]["code"] == "storage_unavailable"
    assert api.client.get("/api/v1/me/avatar-url", headers=headers).status_code == 503
    assert api.client.delete("/api/v1/me/avatar", headers=headers).status_code == 503
    assert api.world.get(user).avatar_object_key == key  # nada mudou no banco
    # Demais rotas seguem normais.
    assert api.client.get("/api/v1/me", headers=headers).status_code == 200
    adm_headers = auth_headers(ADM_SUB)
    assert api.client.get("/api/v1/users", headers=adm_headers).status_code == 200
    assert api.client.get(f"/api/v1/users/{user}", headers=adm_headers).get_json()["has_avatar"] is True


def test_adm_gerencia_foto_de_usuario_do_escopo(people):
    api, user, _adm = people
    url = f"/api/v1/users/{user}/avatar"
    assert _put(api.client, url, _image(), sub=ADM_SUB).status_code == 200
    (audit,) = api.world.audits("USER_AVATAR_UPDATED")
    assert audit.actor_user_id != user and audit.entity_id == str(user)
    link = api.client.get(f"/api/v1/users/{user}/avatar-url", headers=auth_headers(ADM_SUB))
    assert link.status_code == 200 and link.get_json()["expires_in"] == 300
    removed = api.client.delete(url, headers=auth_headers(ADM_SUB))
    assert removed.get_json() == {"has_avatar": False}


def test_usuario_comum_nao_altera_foto_de_outro(people):
    api, _user, adm = people
    response = _put(api.client, f"/api/v1/users/{adm}/avatar", _image(), sub=USER_SUB)
    assert response.status_code == 403
    assert api.storage.objects == {}
