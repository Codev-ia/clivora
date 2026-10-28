"""Servidor de correo configurado en Configuración → Sistema.

EMAIL_BACKEND apunta a ConfiguredEmailBackend: si en Sistema está activado
el servidor de correo, manda por ese SMTP con su remitente; si no, usa el
backend de las variables EMAIL_* del .env (en desarrollo, la consola). Así
ningún código que manda correos (citas, restablecer contraseña) necesita
saber de dónde sale la configuración.

La contraseña SMTP se guarda cifrada (ver core/cifrado.py): si SECRET_KEY
cambia hay que volver a escribirla."""
from django.conf import settings
from django.core.mail.backends.base import BaseEmailBackend
from django.core.mail.backends.smtp import EmailBackend as SMTPBackend
from django.utils.module_loading import import_string

from . import cifrado

TIMEOUT = 15  # segundos para conectar con el servidor SMTP


def cifrar(texto):
    return cifrado.cifrar(texto, 'correo')


def descifrar(valor):
    return cifrado.descifrar(valor, 'correo')


def remitente(config):
    """'"Nombre" <correo>' sin codificar: Django codifica los acentos al enviar."""
    nombre = config.remitente_nombre.replace('"', '').replace('\\', '').strip()
    return f'"{nombre}" <{config.remitente_correo}>' if nombre else config.remitente_correo


def conexion_smtp(config, **kwargs):
    return SMTPBackend(
        host=config.smtp_host, port=config.smtp_puerto, username=config.smtp_usuario or None,
        password=descifrar(config.smtp_password_cifrada) or None,
        use_tls=config.smtp_seguridad == 'tls', use_ssl=config.smtp_seguridad == 'ssl', timeout=TIMEOUT, **kwargs)


class ConfiguredEmailBackend(BaseEmailBackend):
    def __init__(self, fail_silently=False, **kwargs):
        super().__init__(fail_silently=fail_silently)
        from .models import SystemSettings

        config = SystemSettings.get()
        self.from_email = None
        if config.correo_activo and config.smtp_host and config.remitente_correo:
            self.backend = conexion_smtp(config, fail_silently=fail_silently)
            self.from_email = remitente(config)
        else:
            self.backend = import_string(settings.EMAIL_FALLBACK_BACKEND)(fail_silently=fail_silently, **kwargs)

    def open(self):
        return self.backend.open()

    def close(self):
        return self.backend.close()

    def send_messages(self, email_messages):
        if self.from_email:
            # Quien manda con el remitente por defecto sale con el configurado.
            for msg in email_messages:
                if msg.from_email == settings.DEFAULT_FROM_EMAIL:
                    msg.from_email = self.from_email
        return self.backend.send_messages(email_messages)
