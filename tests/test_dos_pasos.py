import re
import time

import pyotp
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from apps.accounts import dos_pasos
from apps.accounts.models import DosPasos
from apps.core.models import Clinica

from .test_pacientes import make_user

CLAVE = 'Clave-segura-1'


class DosPasosTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        clinica = Clinica.objects.create(name='Clínica Demo')
        cls.ana = make_user('ana', ['Acceso a Clivora', 'Médicos'], clinica, email='ana@example.com', first_name='Ana')
        cls.admin = make_user('jefe', ['Acceso a Clivora', 'Administrador'], clinica)

    def api(self, user=None):
        c = APIClient()
        c.force_login(user or self.ana)  # sesión real: el secreto nuevo vive en ella
        return c

    def activar(self):
        c = self.api()
        self.assertEqual(c.post('/api/v1/me/dos_pasos/iniciar/', {'password': 'mala'}).status_code, 400)
        data = c.post('/api/v1/me/dos_pasos/iniciar/', {'password': CLAVE}).json()
        self.assertTrue(data['qr'].startswith('data:image/svg+xml'))
        self.assertIn('issuer=Clivora', data['uri'])
        self.assertEqual(c.post('/api/v1/me/dos_pasos/activar/', {'codigo': '000000'}).status_code, 400)
        totp = pyotp.TOTP(data['secreto'])
        r = c.post('/api/v1/me/dos_pasos/activar/', {'codigo': totp.now()}).json()
        self.assertTrue(r['dos_pasos'])
        self.assertEqual((len(r['codigos']), r['codigos_restantes']), (10, 10))
        return totp, r['codigos']

    def login(self, client=None, **extra):
        client = client or self.client
        return client.post('/clivora/login', {'login': 'ana', 'password': CLAVE, **extra}).json()

    def verificar(self, code, remember=''):
        return self.client.post('/clivora/login/verificar', {'code': code, 'remember': remember})

    def test_activar_y_entrar_con_el_codigo(self):
        totp, _ = self.activar()
        r = self.login()
        self.assertEqual(r, {'ok': True, 'mfa': True, 'redirect': '/clivora/login/verificar'})
        # Sin el código todavía no hay sesión.
        self.assertEqual(self.client.get('/clivora/api/me').status_code, 302)
        self.assertContains(self.client.get('/clivora/login/verificar'), 'Verificación en dos pasos')
        # El código con que se activó ya se usó; el siguiente de la app sí sirve
        # (se acepta un paso de desfase del reloj del teléfono).
        paso = int(time.time()) // 30
        data = self.verificar(totp.generate_otp(paso + 1)).json()
        self.assertEqual((data['ok'], data['redirect']), (True, '/clivora'))
        self.assertEqual(self.client.get('/clivora/api/me').status_code, 200)

    def test_codigo_repetido_e_intentos(self):
        totp, _ = self.activar()
        # El mismo código con el que se activó no se acepta (ya se usó).
        self.login()
        self.assertEqual(self.verificar(totp.now()).json()['error'], 'invalid')
        for restantes in (3, 2, 1):
            self.assertEqual(self.verificar('111111').json()['remaining'], restantes)
        self.assertEqual(self.verificar('111111').json()['error'], 'expired')
        # Hay que empezar de nuevo desde la contraseña.
        self.assertRedirects(self.client.get('/clivora/login/verificar'), '/clivora/login', fetch_redirect_response=False)

    def test_codigo_de_recuperacion_y_equipo_de_confianza(self):
        _, codigos = self.activar()
        self.login()
        r = self.verificar(codigos[0].upper(), remember='1')
        self.assertTrue(r.json()['ok'])
        self.assertIn(dos_pasos.COOKIE_EQUIPO, r.cookies)
        self.assertEqual(len(DosPasos.objects.get(user=self.ana).codigos_recuperacion), 9)
        # En este equipo ya no lo pide.
        self.client.get('/clivora/logout')
        self.assertNotIn('mfa', self.login())
        # El código de recuperación ya usado no vuelve a servir.
        otro = self.client_class()
        self.login(otro)
        self.assertFalse(otro.post('/clivora/login/verificar', {'code': codigos[0]}).json()['ok'])

    def test_desactivar_y_codigos_nuevos(self):
        _, viejos = self.activar()
        c = self.api()
        self.assertEqual(c.post('/api/v1/me/dos_pasos/codigos/', {'password': 'mala'}).status_code, 400)
        nuevos = c.post('/api/v1/me/dos_pasos/codigos/', {'password': CLAVE}).json()['codigos']
        self.assertFalse(set(viejos) & set(nuevos))
        self.assertTrue(re.fullmatch(r'[0-9a-f]{4}-[0-9a-f]{4}', nuevos[0]))
        self.assertFalse(c.post('/api/v1/me/dos_pasos/desactivar/', {'password': CLAVE}).json()['dos_pasos'])
        self.assertNotIn('mfa', self.login())

    def test_administrador_la_quita(self):
        self.activar()
        self.assertTrue(self.api(self.admin).get(f'/api/v1/usuarios/{self.ana.pk}/').json()['dos_pasos'])
        r = self.api(self.admin).post(f'/api/v1/usuarios/{self.ana.pk}/quitar_dos_pasos/')
        self.assertFalse(r.json()['dos_pasos'])
        # Un usuario sin permiso de editar usuarios no puede.
        self.activar()
        otro = make_user('enf', ['Acceso a Clivora', 'Enfermería'], Clinica.objects.first())
        self.assertEqual(self.api(otro).post(f'/api/v1/usuarios/{self.ana.pk}/quitar_dos_pasos/').status_code, 403)

    def test_admin_de_django_usa_el_login_de_clivora(self):
        r = self.client.get('/admin/login/?next=/admin/')
        self.assertRedirects(r, '/clivora/login?redirect=%2Fadmin%2F', fetch_redirect_response=False)
        self.assertEqual(self.client.get('/api-auth/login/').status_code, 404)
