from django.contrib.auth.models import Group
from django.core.management import call_command
from django.test import TestCase

from apps.accounts.models import User
from apps.core.models import Clinica


class ClivoraPagesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.enfermera = User.objects.create_user('ana', email='Ana@Clinica.com', password='clave-1', first_name='Ana')
        cls.enfermera.groups.add(Group.objects.get(name='Acceso a Clivora'), Group.objects.get(name='Enfermería'))
        cls.clinica = Clinica.objects.create(name='Clínica Demo', city='Monterrey')
        cls.enfermera.clinicas.add(cls.clinica)
        cls.sin_acceso = User.objects.create_user('externo', password='clave-1')
        cls.sin_clinica = User.objects.create_user('sinclinica', password='clave-1')
        cls.sin_clinica.groups.add(Group.objects.get(name='Acceso a Clivora'))

    def test_pagina_de_login_con_diseno_de_clivora(self):
        r = self.client.get('/clivora/login')
        self.assertEqual(r.status_code, 200)
        self.assertContains(r, '/clivora/static/assets/js/login.js?v=')
        self.assertContains(r, 'Clivora')

    def test_login_por_correo_sin_importar_mayusculas(self):
        r = self.client.post('/clivora/login', {'login': 'ana@clinica.com', 'password': 'clave-1'})
        self.assertEqual(r.json(), {'ok': True, 'name': 'Ana', 'specialty': '', 'redirect': '/clivora'})
        self.assertEqual(self.client.get('/clivora').status_code, 200)

    def test_login_invalido_y_sin_acceso(self):
        self.assertEqual(self.client.post('/clivora/login', {'login': 'ana', 'password': 'x'}).json(),
                         {'ok': False, 'error': 'invalid'})
        self.assertEqual(self.client.post('/clivora/login', {'login': '', 'password': ''}).json()['error'], 'missing')
        r = self.client.post('/clivora/login', {'login': 'externo', 'password': 'clave-1'})
        self.assertEqual(r.json(), {'ok': False, 'error': 'forbidden'})
        r = self.client.post('/clivora/login', {'login': 'sinclinica', 'password': 'clave-1'})
        self.assertEqual(r.json(), {'ok': False, 'error': 'forbidden'})
        self.assertNotIn('_auth_user_id', self.client.session)

    def test_redirect_externo_no_se_respeta(self):
        r = self.client.post('/clivora/login', {'login': 'ana', 'password': 'clave-1',
                                                     'redirect': 'https://otro-sitio.com/'})
        self.assertEqual(r.json()['redirect'], '/clivora')

    def test_principal_exige_sesion(self):
        r = self.client.get('/clivora')
        self.assertEqual(r.status_code, 302)
        self.assertTrue(r['Location'].startswith('/clivora/login'))

    def test_principal_incluye_pantallas_de_farmacia(self):
        self.client.force_login(self.enfermera)
        r = self.client.get('/clivora')
        self.assertContains(r, 'id="productosView"')
        self.assertContains(r, '/clivora/static/assets/js/inventario.js?v=')
        self.assertIn('csrftoken', r.cookies)

    def test_api_me(self):
        self.client.force_login(self.enfermera)
        me = self.client.get('/clivora/api/me').json()
        self.assertTrue(me['canEditAnotacionesEnfermeria'])
        self.assertTrue(me['isEnfermeriaLimited'])
        self.assertFalse(me['canSeeInventory'])
        self.assertFalse(me['canManageInventory'])
        self.assertFalse(me['canManageUsers'])
        self.assertEqual(me['clinicaActiva'], {'id': self.clinica.pk, 'name': 'Clínica Demo', 'city': 'Monterrey', 'logoUrl': ''})

    def test_recepcion_no_ve_farmacia_ni_configuracion(self):
        for rol in ('Recepción', 'Jefe de Admisiones/Recepción'):
            user = User.objects.create_user(f'rec-{len(rol)}', password='clave-1')
            user.groups.add(Group.objects.get(name='Acceso a Clivora'), Group.objects.get(name=rol))
            user.clinicas.add(self.clinica)
            self.client.force_login(user)
            me = self.client.get('/clivora/api/me').json()
            menus = ('canSeeInventory', 'canManageInventory', 'canManagePricelists', 'canManageProducts',
                     'canManageClinicas', 'canManageLugares', 'canManageUsers', 'canSeeClinicMenu')
            self.assertEqual({k: me[k] for k in menus}, dict.fromkeys(menus, False), rol)
            for url in ('/api/v1/inventario/productos/', '/api/v1/precios/listas/', '/api/v1/usuarios/',
                        '/api/v1/core/clinicas/'):
                self.assertEqual(self.client.get(url).status_code, 403, (rol, url))
            # Lo que sí usa en sus pantallas: listas de precios del paciente y catálogo de médicos.
            self.assertEqual(self.client.get('/clivora/api/pricelists').status_code, 200)
            self.assertEqual(self.client.get('/clivora/api/doctors').status_code, 200)

    def test_rutas_aun_no_migradas_responden_json(self):
        self.client.force_login(self.enfermera)
        r = self.client.get('/clivora/api/patients/1/questionnaire')
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.json()['error'], 'not_implemented')

    def test_logout(self):
        self.client.force_login(self.enfermera)
        self.assertEqual(self.client.get('/clivora/logout').status_code, 302)
        self.assertEqual(self.client.get('/clivora').status_code, 302)
