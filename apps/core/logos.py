"""Validación y normalización de imágenes subidas (logo de la clínica, foto del
paciente)."""
import base64
import binascii
import io
import re

from django.core.files.base import ContentFile
from PIL import Image, UnidentifiedImageError
from rest_framework.exceptions import ValidationError

TIPOS = {'image/png', 'image/jpeg', 'image/webp'}  # sin SVG: puede llevar código
MAX_BYTES = 2 * 1024 * 1024
MAX_LADO = 600


def procesar_imagen(data_url, campo='logo', nombre='El logo', max_bytes=MAX_BYTES, max_lado=MAX_LADO):
    """data URL -> PNG (máximo max_lado px por lado, conserva transparencia).
    Los errores van como {campo: mensaje} (ValidationError de DRF)."""
    match = re.match(r'^data:([\w/+.-]+);base64,(.+)$', data_url or '', re.S)
    if not match:
        raise ValidationError({campo: 'Envía la imagen.'})
    if match.group(1) not in TIPOS:
        raise ValidationError({campo: f'{nombre} debe ser PNG, JPG o WebP.'})
    try:
        raw = base64.b64decode(match.group(2), validate=True)
    except (binascii.Error, ValueError):
        raise ValidationError({campo: 'La imagen está dañada.'})
    if len(raw) > max_bytes:
        raise ValidationError({campo: f'{nombre} no puede pesar más de {max_bytes // (1024 * 1024)} MB.'})
    try:
        Image.open(io.BytesIO(raw)).verify()
        image = Image.open(io.BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError):
        raise ValidationError({campo: 'El archivo no es una imagen válida.'})
    image = image.convert('RGBA') if image.mode not in ('RGB', 'RGBA') else image
    image.thumbnail((max_lado, max_lado))
    out = io.BytesIO()
    image.save(out, format='PNG', optimize=True)
    return ContentFile(out.getvalue())


def procesar_logo(data_url):
    return procesar_imagen(data_url)
