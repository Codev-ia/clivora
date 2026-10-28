"""Archivos que el frontend sube como data-URL ("data:<tipo>;base64,…")."""
import base64
import binascii
import re

_DATA_URL = re.compile(r'^data:([\w.+/-]+)?(;[^,]*)?;base64,(.+)$', re.S)


def decodificar_data_url(data_url):
    """(mimetype, bytes) o (None, None) si no es un data-URL válido."""
    match = _DATA_URL.match(data_url or '')
    if not match:
        return None, None
    try:
        return match.group(1) or 'application/octet-stream', base64.b64decode(match.group(3))
    except (binascii.Error, ValueError):
        return None, None
