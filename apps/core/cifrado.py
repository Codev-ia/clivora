"""Cifrado de secretos guardados en la base (contraseña SMTP, secreto de la
verificación en dos pasos) con Fernet. La llave se deriva de SECRET_KEY y
del propósito: si SECRET_KEY cambia, lo cifrado ya no se puede leer (hay que
volver a capturarlo)."""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings


def _fernet(proposito):
    llave = hashlib.sha256(f'clivora-{proposito}:{settings.SECRET_KEY}'.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(llave))


def cifrar(texto, proposito):
    return _fernet(proposito).encrypt(texto.encode()).decode() if texto else ''


def descifrar(cifrado, proposito):
    if not cifrado:
        return ''
    try:
        return _fernet(proposito).decrypt(cifrado.encode()).decode()
    except InvalidToken:  # SECRET_KEY cambió
        return ''
