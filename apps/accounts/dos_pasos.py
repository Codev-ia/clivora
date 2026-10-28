"""Verificación en dos pasos (TOTP): el usuario la activa desde Mi Perfil →
Seguridad con una app de autenticación (Google Authenticator, Microsoft
Authenticator, 1Password…). Al iniciar sesión, después de la contraseña,
pide el código de 6 dígitos de la app o uno de los códigos de recuperación.

"Equipo de confianza": una cookie firmada que evita pedir el código en ese
navegador durante DIAS_EQUIPO_CONFIABLE días. Deja de servir si el usuario
desactiva y vuelve a activar la verificación."""
import hashlib
import secrets
import time

import pyotp
import segno
from django.core import signing

from apps.core.cifrado import cifrar, descifrar

from .models import DosPasos

EMISOR = 'Clivora'
CODIGOS_RECUPERACION = 10
DIAS_EQUIPO_CONFIABLE = 30
COOKIE_EQUIPO = 'clivora_equipo'
_SAL_EQUIPO = 'clivora.dos-pasos.equipo'


def registro(user):
    return DosPasos.objects.filter(user=user).first() if user and user.pk else None


def activa(user):
    return DosPasos.objects.filter(user=user).exists() if user and user.pk else False


def nuevo_secreto():
    return pyotp.random_base32()


def uri(user, secreto):
    return pyotp.TOTP(secreto).provisioning_uri(name=user.email or user.username, issuer_name=EMISOR)


def qr_svg(texto):
    """QR como data URI SVG (se ve nítido a cualquier tamaño)."""
    return segno.make(texto, error='m').svg_data_uri(scale=5, border=2, dark='#1C2F57')


def codigo_valido(secreto, codigo, ultimo_paso=0):
    """Paso de tiempo del código si es válido (acepta el anterior y el
    siguiente por si el reloj del teléfono va desfasado) y no se usó antes;
    si no, None."""
    codigo = ''.join(c for c in str(codigo or '') if c.isdigit())
    if len(codigo) != 6 or not secreto:
        return None
    totp = pyotp.TOTP(secreto)
    actual = int(time.time()) // totp.interval
    for paso in (actual - 1, actual, actual + 1):
        if paso > ultimo_paso and secrets.compare_digest(totp.generate_otp(paso), codigo):
            return paso
    return None


def _hash(codigo):
    return hashlib.sha256(codigo.replace('-', '').strip().lower().encode()).hexdigest()


def generar_codigos(reg):
    """Reemplaza los códigos de recuperación y devuelve los nuevos (en claro,
    solo esta vez)."""
    codigos = [f'{secrets.token_hex(2)}-{secrets.token_hex(2)}' for _ in range(CODIGOS_RECUPERACION)]
    reg.codigos_recuperacion = [_hash(c) for c in codigos]
    reg.save(update_fields=['codigos_recuperacion'])
    return codigos


def activar(user, secreto):
    DosPasos.objects.filter(user=user).delete()
    reg = DosPasos.objects.create(user=user, secreto_cifrado=cifrar(secreto, 'dos-pasos'))
    return reg, generar_codigos(reg)


def verificar(user, codigo):
    """Código de la app o de recuperación (el de recuperación se gasta)."""
    reg = registro(user)
    if not reg:
        return False
    paso = codigo_valido(descifrar(reg.secreto_cifrado, 'dos-pasos'), codigo, reg.ultimo_paso)
    if paso is not None:
        reg.ultimo_paso = paso
        reg.save(update_fields=['ultimo_paso'])
        return True
    h = _hash(str(codigo or ''))
    if h in reg.codigos_recuperacion:
        reg.codigos_recuperacion = [c for c in reg.codigos_recuperacion if c != h]
        reg.save(update_fields=['codigos_recuperacion'])
        return True
    return False


# ── Equipo de confianza ───────────────────────────────────────────────────

def _huella(reg):
    return int(reg.activado_en.timestamp())


def cookie_equipo(reg):
    return signing.dumps({'u': reg.user_id, 'a': _huella(reg)}, salt=_SAL_EQUIPO)


def equipo_confiable(request, user):
    reg = registro(user)
    valor = request.COOKIES.get(COOKIE_EQUIPO)
    if not reg or not valor:
        return False
    try:
        data = signing.loads(valor, salt=_SAL_EQUIPO, max_age=DIAS_EQUIPO_CONFIABLE * 86400)
    except signing.BadSignature:
        return False
    return data.get('u') == user.pk and data.get('a') == _huella(reg)
