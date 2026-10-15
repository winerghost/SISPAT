"""Foto de perfil: validação/recodificação da imagem e orquestração Storage + banco.

Contrato: `docs/architecture/modulo-configuracoes.md` (Etapa 2, "Foto de perfil").

Pipeline de segurança (`process_avatar`), nesta ordem:
    1. tamanho: vazio -> 400 `unsupported_image`; > 2 MiB -> 413 `file_too_large`
       (o limite do CORPO da rota é aplicado antes, em `app.api.v1`);
    2. magic bytes: só JPEG (`FF D8 FF`), PNG (assinatura de 8 bytes) e WebP
       (`RIFF....WEBP`). Extensão e Content-Type do upload são ignorados;
       SVG, GIF, HTML, ZIP e qualquer outro formato são recusados;
    3. Pillow restrito ao formato detectado (`formats=[...]`), com
       `Image.MAX_IMAGE_PIXELS` = 16 MP e `DecompressionBombWarning` tratado
       como erro; lado <= 4096 px e total <= 16 MP checados no cabeçalho,
       ANTES de decodificar os pixels; imagens animadas recusadas;
    4. `verify()` (integridade) e REABERTURA (o objeto verificado não serve
       para decodificar); arquivo truncado falha no `load()`;
    5. `ImageOps.exif_transpose` (opcional: EXIF corrompido não derruba);
    6. recorte central + redimensionamento para 512x512, cópia dos PIXELS
       para uma imagem nova (sem `info`) e WebP sem EXIF/ICC/XMP.
    O resultado é sempre um WebP novo: polyglots (JPEG+HTML, JPEG+ZIP) perdem
    tudo que não for pixel.

Orquestração (`AvatarService`): o chamador entrega o `User` já carregado com
`FOR UPDATE` (escopo checado em `user_admin_service`). Upload com nome
aleatório `<uuid4>.webp` -> grava a chave + `AuditLog` na MESMA transação ->
commit -> apaga a foto antiga (melhor esforço; falha só é logada). Falha no
Storage -> `StorageUnavailableError` (API 503), sem alterar o banco.
"""
from __future__ import annotations

import io
import logging
import uuid
import warnings
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy.orm import Session

from app.integrations.supabase_storage_client import (
    SIGNED_URL_TTL_SECONDS,
    StorageUnavailableError,
    SupabaseStorageClient,
    is_valid_object_key,
)
from app.models.audit import AuditLog
from app.models.rbac import User

logger = logging.getLogger(__name__)

MAX_AVATAR_BYTES = 2 * 1024 * 1024
MAX_SIDE_PX = 4096
MAX_PIXELS = 16_000_000
OUTPUT_SIZE = (512, 512)
_WEBP_QUALITY = 85

OPERATION_AVATAR_UPDATED = "USER_AVATAR_UPDATED"
OPERATION_AVATAR_REMOVED = "USER_AVATAR_REMOVED"

# Limite global do Pillow (o processo só usa Pillow para avatares). Acima de
# 2x este valor o Pillow levanta `DecompressionBombError` já no `open()`;
# entre 1x e 2x emite um warning, que `process_avatar` converte em erro.
Image.MAX_IMAGE_PIXELS = MAX_PIXELS

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class AvatarError(Exception):
    status_code = 400
    code = "unsupported_image"
    message = "Imagem inválida. Envie um arquivo JPEG, PNG ou WebP."


class UnsupportedImageError(AvatarError):
    pass


class FileTooLargeError(AvatarError):
    status_code = 413
    code = "file_too_large"
    message = "Arquivo acima do limite de 2 MiB."


def sniff_image_format(data: bytes) -> str | None:
    """Formato pelo conteúdo (magic bytes); `None` se não for JPEG/PNG/WebP."""
    if data.startswith(b"\xff\xd8\xff"):
        return "JPEG"
    if data.startswith(_PNG_SIGNATURE):
        return "PNG"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    return None


def _check_dimensions(size: tuple[int, int]) -> None:
    width, height = size
    if width < 1 or height < 1 or width > MAX_SIDE_PX or height > MAX_SIDE_PX:
        raise UnsupportedImageError()
    if width * height > MAX_PIXELS:
        raise UnsupportedImageError()


def process_avatar(data: bytes) -> bytes:
    """Valida e recodifica a imagem para WebP 512x512 sem metadados.

    Levanta `UnsupportedImageError` (400) ou `FileTooLargeError` (413). Nunca
    devolve nada derivado dos bytes originais além dos pixels.
    """
    if not isinstance(data, (bytes, bytearray)) or len(data) == 0:
        raise UnsupportedImageError()
    if len(data) > MAX_AVATAR_BYTES:
        raise FileTooLargeError()
    data = bytes(data)
    fmt = sniff_image_format(data)
    if fmt is None:
        raise UnsupportedImageError()

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data), formats=[fmt]) as probe:
                _check_dimensions(probe.size)
                if getattr(probe, "n_frames", 1) != 1:
                    raise UnsupportedImageError()
                probe.verify()
            with Image.open(io.BytesIO(data), formats=[fmt]) as image:
                _check_dimensions(image.size)
                if fmt == "JPEG":
                    # Decodifica já reduzido (menos memória) quando possível.
                    image.draft("RGB", (OUTPUT_SIZE[0] * 2, OUTPUT_SIZE[1] * 2))
                image.load()
                try:
                    oriented = ImageOps.exif_transpose(image)
                except Exception:  # noqa: BLE001 - EXIF inválido: segue sem orientar
                    oriented = image
                has_alpha = oriented.mode in ("RGBA", "LA", "PA") or (
                    oriented.mode == "P" and "transparency" in oriented.info
                )
                mode = "RGBA" if has_alpha else "RGB"
                converted = oriented.convert(mode)
                fitted = ImageOps.fit(
                    converted, OUTPUT_SIZE, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5)
                )
                # Imagem NOVA só com os pixels: nenhum `info` (EXIF/ICC/XMP,
                # comentários, chunks de texto) sobrevive.
                clean = Image.frombytes(mode, fitted.size, fitted.tobytes())
                out = io.BytesIO()
                clean.save(out, format="WEBP", quality=_WEBP_QUALITY, method=4, exif=b"", xmp="")
    except AvatarError:
        raise
    except (
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
        UnidentifiedImageError,
        OSError,
        ValueError,
        SyntaxError,
        EOFError,
        MemoryError,
        IndexError,
        TypeError,
    ) as exc:
        logger.info("avatar_service: imagem recusada (%s).", exc.__class__.__name__)
        raise UnsupportedImageError() from exc
    return out.getvalue()


def new_object_key() -> str:
    return f"{uuid.uuid4()}.webp"


class AvatarService:
    """Troca/remoção/URL assinada da foto de um `User` já autorizado e travado."""

    def __init__(self, db: Session, storage: SupabaseStorageClient) -> None:
        self._db = db
        self._storage = storage

    def _audit(
        self, operation: str, user: User, actor_id: Any, had: bool, has: bool, request_id: str | None
    ) -> None:
        self._db.add(
            AuditLog(
                id=uuid.uuid4(),
                actor_user_id=actor_id,
                entity_type="user",
                entity_id=str(user.id),
                operation=operation,
                previous_values={"avatar": had},
                new_values={"avatar": has},
                request_id=request_id,
                result="SUCESSO",
            )
        )

    def _delete_quietly(self, object_key: str | None) -> None:
        if not object_key or not is_valid_object_key(object_key):
            return
        try:
            self._storage.delete(object_key)
        except StorageUnavailableError:
            logger.warning("avatar_service: objeto antigo não removido do Storage (órfão).")

    def replace(
        self, user: User, webp_bytes: bytes, *, actor_id: Any, request_id: str | None
    ) -> None:
        """Envia a nova foto e só então troca a chave no banco (commit)."""
        old_key = user.avatar_object_key
        new_key = new_object_key()
        self._storage.upload(new_key, webp_bytes)  # StorageUnavailableError -> 503
        try:
            user.avatar_object_key = new_key
            self._db.add(user)
            self._audit(OPERATION_AVATAR_UPDATED, user, actor_id, old_key is not None, True, request_id)
            self._db.commit()
        except Exception:
            self._db.rollback()
            self._delete_quietly(new_key)
            raise
        if old_key and old_key != new_key:
            self._delete_quietly(old_key)

    def remove(self, user: User, *, actor_id: Any, request_id: str | None) -> bool:
        """Apaga o objeto no Storage e limpa a chave. Retorna False se não havia foto."""
        old_key = user.avatar_object_key
        if not old_key:
            return False
        if is_valid_object_key(old_key):
            # Storage primeiro: se estiver fora, 503 e nada muda (o usuário
            # pode repetir); a foto nunca some só do banco ficando no bucket.
            self._storage.delete(old_key)
        user.avatar_object_key = None
        self._db.add(user)
        self._audit(OPERATION_AVATAR_REMOVED, user, actor_id, True, False, request_id)
        self._db.commit()
        return True

    def signed_url(self, user: User) -> dict[str, Any] | None:
        """`{"url", "expires_in"}` ou `None` quando não há foto (API 404)."""
        key = user.avatar_object_key
        if not key or not is_valid_object_key(key):
            return None
        url = self._storage.create_signed_url(key, SIGNED_URL_TTL_SECONDS)
        return {"url": url, "expires_in": SIGNED_URL_TTL_SECONDS}
