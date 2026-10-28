from django.contrib.auth.models import Group
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.core.models import Clinica, SystemSettings


class SistemaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.root = User.objects.create_superuser('root', password='Clave-segura-1')
        cls.clinica = Clinica.objects.create(name='Clínica Demo')
        cls.admin = User.objects.create_user('admin-rol', password='Clave-segura-1')
        cls.admin.groups.add(*Group.objects.filter(name__in=['Acceso a Clivora', 'Administrador']))
        cls.admin.clinicas.add(cls.clinica)

    def client_for(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def nuevo_usuario(self, c, username):
        return c.post('/api/v1/usuarios/', {'username': username, 'first_name': username,
                                            'password': 'Clave-segura-1', 'clinicas': [self.clinica.pk]})

    def test_solo_el_superusuario_cambia_limites(self):
        self.assertEqual(self.client_for(self.admin).patch('/api/v1/sistema/', {'max_usuarios': 99}).status_code, 403)
        r = self.client_for(self.root).patch('/api/v1/sistema/', {'max_usuarios': 5, 'max_clinicas': 3})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['usuarios'], r.json()['clinicas']), (1, 1))  # el superusuario no cuenta

    def test_limite_de_usuarios_al_crear_y_reactivar(self):
        SystemSettings.objects.update_or_create(pk=1, defaults={'max_usuarios': 2})
        c = self.client_for(self.admin)
        self.assertEqual(self.nuevo_usuario(c, 'uno').status_code, 201)   # admin-rol + uno = 2
        r = self.nuevo_usuario(c, 'dos')
        self.assertEqual(r.status_code, 400)
        self.assertIn('máximo de 2 usuarios', str(r.json()))
        uno = User.objects.get(username='uno')
        c.patch(f'/api/v1/usuarios/{uno.pk}/', {'is_active': False})
        self.assertEqual(self.nuevo_usuario(c, 'dos').status_code, 201)   # se liberó un lugar
        r = c.patch(f'/api/v1/usuarios/{uno.pk}/', {'is_active': True})   # reactivar excede
        self.assertEqual(r.status_code, 400)

    def test_limite_de_clinicas(self):
        SystemSettings.objects.update_or_create(pk=1, defaults={'max_clinicas': 1})
        r = self.client_for(self.root).post('/api/v1/core/clinicas/', {'name': 'Otra', 'active': True})
        self.assertEqual(r.status_code, 400)
        self.assertIn('máximo de 1 clínicas', str(r.json()))

    def test_limite_no_puede_ser_menor_que_el_uso(self):
        r = self.client_for(self.root).patch('/api/v1/sistema/', {'max_usuarios': 0})
        self.assertEqual(r.status_code, 400)

    def test_perfil_y_contrasena_propios(self):
        c = self.client_for(self.root)
        r = c.patch('/api/v1/me/', {'first_name': 'Super', 'last_name': 'Admin', 'email': 'root@clivora.mx'})
        self.assertEqual(r.json()['first_name'], 'Super')
        self.assertEqual(c.patch('/api/v1/me/', {'username': 'admin-rol'}).status_code, 400)  # ya existe
        r = c.post('/api/v1/me/password/', {'current_password': 'mala', 'new_password': 'Nueva-clave-2026'})
        self.assertEqual(r.status_code, 400)
        r = c.post('/api/v1/me/password/', {'current_password': 'Clave-segura-1', 'new_password': 'Nueva-clave-2026'})
        self.assertEqual(r.status_code, 200)
        self.root.refresh_from_db()
        self.assertTrue(self.root.check_password('Nueva-clave-2026'))
