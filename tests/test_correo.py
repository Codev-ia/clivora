from unittest import mock

from django.core import mail
from django.core.mail import get_connection, send_mail
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.core.correo import ConfiguredEmailBackend, descifrar
from apps.core.models import SystemSettings

DATOS = {'correo_activo': True, 'smtp_host': 'smtp.ejemplo.com', 'smtp_puerto': 465, 'smtp_seguridad': 'ssl',
         'smtp_usuario': 'no-responder@ejemplo.com', 'smtp_password': 'secreta-123',
         'remitente_nombre': 'Clínica Demo', 'remitente_correo': 'no-responder@ejemplo.com'}


class CorreoTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.root = User.objects.create_superuser('root', password='Clave-segura-1')
        cls.usuario = User.objects.create_user('ana', password='Clave-segura-1')

    def client_for(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_guardar_sin_devolver_la_contrasena(self):
        c = self.client_for(self.root)
        data = c.patch('/api/v1/sistema/correo/', DATOS, format='json').json()
        self.assertNotIn('smtp_password', data)
        self.assertTrue(data['smtp_password_guardada'])
        config = SystemSettings.get()
        self.assertNotIn('secreta', config.smtp_password_cifrada)  # cifrada en la base
        self.assertEqual(descifrar(config.smtp_password_cifrada), 'secreta-123')
        # Sin contraseña (o vacía) se conserva la guardada.
        c.patch('/api/v1/sistema/correo/', {'smtp_host': 'smtp.otro.com', 'smtp_password': ''}, format='json')
        config.refresh_from_db()
        self.assertEqual((config.smtp_host, descifrar(config.smtp_password_cifrada)), ('smtp.otro.com', 'secreta-123'))
        # Activar pide servidor y remitente.
        r = c.patch('/api/v1/sistema/correo/', {'remitente_correo': ''}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertIn('remitente', str(r.json()))

    def test_solo_superusuario(self):
        c = self.client_for(self.usuario)
        self.assertEqual(c.get('/api/v1/sistema/correo/').status_code, 403)
        self.assertEqual(c.patch('/api/v1/sistema/correo/', DATOS, format='json').status_code, 403)
        self.assertEqual(c.post('/api/v1/sistema/correo/prueba/', {'destinatario': 'a@b.com'}).status_code, 403)

    @override_settings(EMAIL_FALLBACK_BACKEND='django.core.mail.backends.locmem.EmailBackend')
    def test_backend_usa_el_servidor_configurado(self):
        # Sin activar: el del .env (aquí, locmem).
        backend = ConfiguredEmailBackend()
        self.assertEqual(type(backend.backend).__module__, 'django.core.mail.backends.locmem')
        self.client_for(self.root).patch('/api/v1/sistema/correo/', DATOS, format='json')
        backend = ConfiguredEmailBackend()
        smtp = backend.backend
        self.assertEqual((smtp.host, smtp.port, smtp.use_ssl, smtp.use_tls, smtp.username, smtp.password),
                         ('smtp.ejemplo.com', 465, True, False, 'no-responder@ejemplo.com', 'secreta-123'))
        # El remitente por defecto se cambia por el configurado.
        with mock.patch.object(type(smtp), 'send_messages', return_value=1) as enviar:
            send_mail('Hola', 'Texto', None, ['p@ejemplo.com'],
                      connection=get_connection('apps.core.correo.ConfiguredEmailBackend'))
        self.assertEqual(enviar.call_args[0][0][0].from_email, '"Clínica Demo" <no-responder@ejemplo.com>')

    def test_correo_de_prueba(self):
        c = self.client_for(self.root)
        r = c.post('/api/v1/sistema/correo/prueba/', {'destinatario': 'yo@ejemplo.com'})
        self.assertIn('Guarda primero', str(r.json()))
        c.patch('/api/v1/sistema/correo/', {**DATOS, 'correo_activo': False}, format='json')
        with mock.patch('django.core.mail.backends.smtp.EmailBackend.send_messages', return_value=1) as enviar:
            self.assertEqual(c.post('/api/v1/sistema/correo/prueba/', {'destinatario': 'yo@ejemplo.com'}).json(),
                             {'ok': True})
        self.assertEqual(enviar.call_args[0][0][0].to, ['yo@ejemplo.com'])
        with mock.patch('django.core.mail.backends.smtp.EmailBackend.send_messages',
                        side_effect=OSError('Connection refused')):
            r = c.post('/api/v1/sistema/correo/prueba/', {'destinatario': 'yo@ejemplo.com'})
        self.assertEqual(r.status_code, 400)
        self.assertIn('Connection refused', str(r.json()))
        self.assertEqual(mail.outbox, [])
