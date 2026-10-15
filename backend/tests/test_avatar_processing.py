"""Pipeline de validação/recodificação da foto (`app.services.avatar_service`).

Uploads maliciosos: polyglots JPEG+HTML e JPEG+ZIP, SVG, GIF, HTML, PNG com
dimensões gigantes (decompression bomb, só cabeçalho), lado > 4096, > 16 MP,
animação, arquivo vazio/truncado, > 2 MiB. Prova de remoção de EXIF/ICC/XMP.
Tudo em memória, sem rede.
"""
from __future__ import annotations

import io
import struct
import zipfile
import zlib

import pytest
from PIL import Image

from app.services.avatar_service import (
    MAX_AVATAR_BYTES,
    FileTooLargeError,
    UnsupportedImageError,
    process_avatar,
    sniff_image_format,
)

SECRET_MARKER = "CameraSecretaGPS-XYZ"


def _jpeg(size=(800, 600), *, exif=True, icc=True, color=(200, 30, 30)) -> bytes:
    image = Image.new("RGB", size, color)
    kwargs = {"quality": 90}
    if exif:
        data = Image.Exif()
        data[0x010F] = SECRET_MARKER  # Make
        data[0x0110] = "ModeloSecreto"  # Model
        data[0x0112] = 6  # Orientation
        kwargs["exif"] = data.tobytes()
    if icc:
        kwargs["icc_profile"] = b"ICC-" + SECRET_MARKER.encode() * 8
    out = io.BytesIO()
    image.save(out, "JPEG", **kwargs)
    return out.getvalue()


def _png(size=(300, 200), mode="RGB", **kwargs) -> bytes:
    out = io.BytesIO()
    Image.new(mode, size).save(out, "PNG", **kwargs)
    return out.getvalue()


def _webp(size=(300, 300)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (0, 128, 0)).save(out, "WEBP")
    return out.getvalue()


def _png_header_only(width: int, height: int) -> bytes:
    """PNG minúsculo que DECLARA dimensões gigantes (bomba de descompressão)."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"\x00" * 64))
        + chunk(b"IEND", b"")
    )


def _decoded(webp: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(webp))
    image.load()
    return image


@pytest.mark.parametrize("factory", [_jpeg, _png, _webp], ids=["jpeg", "png", "webp"])
def test_formatos_aceitos_viram_webp_512_sem_metadados(factory):
    out = process_avatar(factory())
    image = _decoded(out)
    assert image.format == "WEBP" and image.size == (512, 512)
    assert not {"exif", "icc_profile", "xmp"} & set(image.info)
    assert len(image.getexif()) == 0


def test_exif_icc_e_xmp_sao_removidos():
    data = _jpeg()
    assert SECRET_MARKER.encode() in data  # o original carrega os metadados
    out = process_avatar(data)
    assert SECRET_MARKER.encode() not in out and b"ModeloSecreto" not in out
    assert b"EXIF" not in out and b"ICCP" not in out and b"XMP " not in out


def test_png_com_transparencia_mantem_alfa_sem_chunks_de_texto():
    from PIL import PngImagePlugin

    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", SECRET_MARKER)
    out = process_avatar(_png(mode="RGBA", pnginfo=info))
    assert _decoded(out).mode == "RGBA" and SECRET_MARKER.encode() not in out


@pytest.mark.parametrize(
    "payload",
    [
        b"<html><body><script>alert(1)</script></body></html>",
        b"<html><img src=x onerror=alert(1)></html>",
    ],
)
def test_polyglot_jpeg_html_e_neutralizado(payload):
    out = process_avatar(_jpeg() + payload)
    assert b"<script" not in out and b"<html" not in out and b"onerror" not in out
    assert _decoded(out).size == (512, 512)


def test_polyglot_jpeg_zip_e_neutralizado():
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("payload.sh", "rm -rf /")
    out = process_avatar(_jpeg() + archive.getvalue())
    assert b"PK\x03\x04" not in out and b"payload.sh" not in out


@pytest.mark.parametrize(
    "data",
    [
        b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        b"<svg onload=alert(1)>",
        b"GIF89a" + b"\x00" * 100,
        b"<html><script>alert(1)</script></html>",
        b"PK\x03\x04" + b"\x00" * 100,
        b"%PDF-1.7\n",
        b"\x00\x00\x01\x00",  # ICO
        b"BM" + b"\x00" * 60,  # BMP
        b"RIFF\x00\x00\x00\x00WAVEfmt ",
        b"II*\x00",  # TIFF
    ],
    ids=["svg", "svg-onload", "gif", "html", "zip", "pdf", "ico", "bmp", "riff-wave", "tiff"],
)
def test_formatos_fora_da_allowlist_recusados(data):
    with pytest.raises(UnsupportedImageError) as exc:
        process_avatar(data)
    assert exc.value.status_code == 400 and exc.value.code == "unsupported_image"


def test_gif_real_recusado_mesmo_valido():
    out = io.BytesIO()
    Image.new("RGB", (32, 32)).save(out, "GIF")
    with pytest.raises(UnsupportedImageError):
        process_avatar(out.getvalue())


@pytest.mark.parametrize(
    "width,height",
    [(50_000, 50_000), (4097, 10), (10, 4097), (4096, 4000), (100_000, 1)],
    ids=["bomba-2.5Gpx", "lado-largura", "lado-altura", "16.4MP", "faixa"],
)
def test_dimensoes_gigantes_recusadas_sem_decodificar(width, height):
    data = _png_header_only(width, height)
    assert len(data) < 200  # arquivo minúsculo, dimensões declaradas enormes
    with pytest.raises(UnsupportedImageError):
        process_avatar(data)


def test_png_real_com_lado_acima_do_limite_recusado():
    with pytest.raises(UnsupportedImageError):
        process_avatar(_png(size=(5000, 8), mode="1"))


def test_animacao_recusada():
    frames = [Image.new("RGB", (40, 40), (i * 40, 0, 0)) for i in range(3)]
    out = io.BytesIO()
    frames[0].save(out, "PNG", save_all=True, append_images=frames[1:])
    with pytest.raises(UnsupportedImageError):
        process_avatar(out.getvalue())
    webp = io.BytesIO()
    frames[0].save(webp, "WEBP", save_all=True, append_images=frames[1:])
    with pytest.raises(UnsupportedImageError):
        process_avatar(webp.getvalue())


@pytest.mark.parametrize("cut", [0.3, 0.6, 0.9])
def test_arquivo_truncado_recusado(cut):
    data = _jpeg(size=(400, 400), exif=False, icc=False)
    with pytest.raises(UnsupportedImageError):
        process_avatar(data[: int(len(data) * cut)])


def test_png_com_crc_corrompido_recusado():
    data = bytearray(_png())
    data[-20] ^= 0xFF  # corrompe o último IDAT/CRC
    with pytest.raises(UnsupportedImageError):
        process_avatar(bytes(data))


def test_vazio_e_limite_de_tamanho():
    with pytest.raises(UnsupportedImageError):
        process_avatar(b"")
    with pytest.raises(FileTooLargeError) as exc:
        process_avatar(b"\xff\xd8\xff" + b"\x00" * MAX_AVATAR_BYTES)
    assert exc.value.status_code == 413 and exc.value.code == "file_too_large"


def test_magic_bytes():
    assert sniff_image_format(_jpeg(exif=False, icc=False)) == "JPEG"
    assert sniff_image_format(_png()) == "PNG"
    assert sniff_image_format(_webp()) == "WEBP"
    assert sniff_image_format(b"RIFF\x00\x00\x00\x00AVI ") is None
    assert sniff_image_format(b"\xff\xd8") is None


def test_orientacao_exif_corrompida_nao_derruba():
    image = Image.new("RGB", (100, 50), (1, 2, 3))
    exif = Image.Exif()
    exif[0x0112] = 99  # orientação inválida
    out = io.BytesIO()
    image.save(out, "JPEG", exif=exif.tobytes())
    assert _decoded(process_avatar(out.getvalue())).size == (512, 512)
