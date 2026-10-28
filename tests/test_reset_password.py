import re

from django.core import mail
from django.core.cache import cache
from django.core.management import call_command
from django.test import TestCase

from apps.accounts.models import User
from apps.core.models import Clinica

from .test_pacientes import make_user


class RestablecerContrasenaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        clinica = Clinica.objects.create(name='Clínica Demo')
        cls.user = make_user('ana', ['Acceso a Clivora', 'Médicos'], clinica, email='ana@example.com', first_name='Ana')

    def setUp(self):
        cache.clear()

    def pedir(self, login):
        return self.client.post('/clivora/reset_password', {'login': login}).json()

    def token(self):
        return re.search(r'token=([\w.-]+)', mail.outbox[-1].body).group(1)

    def confirmar(self, token, password, confirmacion=None):
        return self.client.post('/clivora/reset_password/confirm', {
            'token': token, 'password': password, 'confirm_password': confirmacion or password}).json()

    def test_flujo_completo(self):
        self.assertEqual(self.pedir('ANA@example.com'), {'ok': True})
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].to, ['ana@example.com'])
        token = self.token()
        # El enlace abre la pantalla para elegir la contraseña, con el nombre.
        html = self.client.get(f'/clivora/reset_password?token={token}').content.decode()
        self.assertIn('&quot;mode&quot;: &quot;confirm&quot;', html)
        self.assertIn('Ana', html)
        self.assertEqual(self.confirmar(token, 'otra', 'distinta'), {'ok': False, 'error': 'mismatch'})
        self.assertIn('message', self.confirmar(token, '123'))  # validadores de Django
        self.assertEqual(self.confirmar(token, 'Nueva-clave-2026'), {'ok': True, 'login': 'ana@example.com'})
        self.user.refresh_from_db()
        self.assertTrue(self.user.check_password('Nueva-clave-2026'))
        # El enlace ya no sirve una vez usado.
        self.assertEqual(self.confirmar(token, 'Otra-clave-2026'), {'ok': False, 'error': 'invalid_token'})
        self.assertIn('&quot;invalid&quot;', self.client.get(f'/clivora/reset_password?token={token}').content.decode())

    def test_no_revela_cuentas_y_limita_solicitudes(self):
        self.assertEqual(self.pedir('nadie@example.com'), {'ok': True})
        self.assertEqual(mail.outbox, [])
        self.assertEqual(self.pedir(''), {'ok': False, 'error': 'missing'})
        for _ in range(4):  # 5 por IP en 15 minutos (la de "nadie" cuenta)
            self.assertEqual(self.pedir('ana'), {'ok': True})
        self.assertIn('Demasiadas', self.pedir('ana')['message'])
        self.assertEqual(len(mail.outbox), 4)

    def test_token_invalido(self):
        self.assertEqual(self.confirmar('basura.token', 'Nueva-clave-2026'), {'ok': False, 'error': 'invalid_token'})
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        self.pedir('ana')
        self.assertEqual(mail.outbox, [])
