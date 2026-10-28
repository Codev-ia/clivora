from decimal import Decimal

from django.contrib.auth.models import Group
from django.core.management import call_command
from django.test import TestCase
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.inventario.models import Location
from apps.precios.models import Aseguradora, Pricelist

from . import factories as f


def make_user(username, roles, clinicas, **kw):
    user = User.objects.create_user(username, password='Clave-segura-1', **kw)
    user.groups.add(*Group.objects.filter(name__in=roles))
    user.clinicas.add(*clinicas)
    user.clinica_activa = clinicas[0] if clinicas else None
    user.save()
    return user


class ApiTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.demo = f.clinica('Clínica Demo')
        cls.otra = f.clinica('Otra clínica')
        cls.farmacia_user = make_user('farmacia', ['Acceso a Clivora', 'Farmacia'], [cls.demo])
        cls.medico = make_user('medico', ['Acceso a Clivora', 'Médicos'], [cls.demo])
        cls.sin_rol = make_user('nadie', [], [cls.demo])
        cls.farmacia = f.location('Farmacia Demo', clinica=cls.demo)
        cls.farmacia_otra = f.location('Farmacia otra', clinica=cls.otra)
        cls.proveedor = Location.objects.get(usage=Location.USAGE_SUPPLIER)
        cls.prod = f.product(code='PARA-500')
        cls.prod_otra = f.product('Solo de la otra', clinica=cls.otra)

    def client_for(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_sin_sesion_y_sin_rol(self):
        self.assertEqual(APIClient().get('/api/v1/inventario/productos/').status_code, 403)
        self.assertEqual(self.client_for(self.sin_rol).get('/api/v1/inventario/productos/').status_code, 403)

    def test_productos_de_la_clinica_activa_y_compartidos(self):
        r = self.client_for(self.farmacia_user).get('/api/v1/inventario/productos/')
        names = [p['name'] for p in r.json()['results']]
        self.assertIn('Paracetamol', names)
        self.assertNotIn('Solo de la otra', names)

    def test_inventario_solo_para_farmacia_comercial_y_administrador(self):
        # Médicos (como Enfermería y Recepción) no entran a Farmacia; el
        # catálogo de medicamentos de sus pantallas sale de /clivora/api/products.
        self.assertEqual(self.client_for(self.medico).get('/api/v1/inventario/productos/').status_code, 403)
        self.assertEqual(self.client_for(self.medico).get('/api/v1/precios/listas/').status_code, 403)
        c = APIClient()
        c.force_login(self.medico)
        self.assertIn('Paracetamol', [p['name'] for p in c.get('/clivora/api/products').json()])

    def test_medico_consulta_pero_no_mueve_inventario(self):
        r = self.client_for(self.medico).post('/api/v1/inventario/movimientos/', {
            'product': self.prod.pk, 'quantity': '1', 'location_from': self.proveedor.pk,
            'location_to': self.farmacia.pk})
        self.assertEqual(r.status_code, 403)

    def test_farmacia_registra_confirma_y_ajusta(self):
        c = self.client_for(self.farmacia_user)
        r = c.post('/api/v1/inventario/movimientos/', {'product': self.prod.pk, 'quantity': '12',
                                                       'location_from': self.proveedor.pk,
                                                       'location_to': self.farmacia.pk, 'reference': 'FAC-1'})
        self.assertEqual(r.status_code, 201, r.content)
        r = c.post(f'/api/v1/inventario/movimientos/{r.json()["id"]}/confirmar/')
        self.assertEqual(r.json()['state'], 'done')
        r = c.post('/api/v1/inventario/movimientos/ajuste/', {'product': self.prod.pk, 'location': self.farmacia.pk,
                                                              'counted_quantity': '10'})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.prod.qty_available, Decimal('10'))

    def test_no_mueve_inventario_de_otra_clinica(self):
        r = self.client_for(self.farmacia_user).post('/api/v1/inventario/movimientos/', {
            'product': self.prod.pk, 'quantity': '1', 'location_from': self.proveedor.pk,
            'location_to': self.farmacia_otra.pk})
        self.assertEqual(r.status_code, 400)
        self.assertIn('clínica activa', str(r.json()))

    def test_salida_sin_existencia_da_error_claro(self):
        c = self.client_for(self.farmacia_user)
        r = c.post('/api/v1/inventario/movimientos/', {'product': self.prod.pk, 'quantity': '5',
                                                       'location_from': self.farmacia.pk,
                                                       'location_to': self.proveedor.pk})
        r = c.post(f'/api/v1/inventario/movimientos/{r.json()["id"]}/confirmar/')
        self.assertEqual(r.status_code, 400)
        self.assertIn('Existencia insuficiente', str(r.json()))

    def test_rutas_compatibles_con_el_frontend(self):
        self.client.force_login(self.medico)
        Pricelist.objects.create(name='GNP', clinica=self.demo)
        Pricelist.objects.create(name='De la otra', clinica=self.otra)
        Aseguradora.objects.create(name='AXA')
        self.assertEqual(self.client.get('/clivora/api/products?q=para').json(),
                         [{'id': self.prod.pk, 'name': 'Paracetamol'}])
        row = self.client.get('/clivora/api/products/stock?q=PARA').json()[0]
        self.assertEqual(set(row), {'id', 'name', 'code', 'qtyAvailable', 'price'})
        self.assertEqual([p['name'] for p in self.client.get('/clivora/api/pricelists').json()], ['GNP'])
        self.assertEqual(self.client.get('/clivora/api/aseguradoras').json()[0]['name'], 'AXA')
        summary = self.client.get('/clivora/api/farmacia/summary').json()
        self.assertEqual(set(summary), {'entradasMes', 'salidasMes', 'entradasPendientes', 'salidasPendientes',
                                        'existenciasConStock', 'movimientos'})

    def test_calcular_precio(self):
        r = self.client_for(self.medico).get(f'/api/v1/precios/calcular/?product={self.prod.pk}')
        self.assertEqual(r.json()['price'], '100.00')


class MultiClinicaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.a = f.clinica('Clínica A')
        cls.b = f.clinica('Clínica B')
        cls.c = f.clinica('Clínica C')
        cls.admin = make_user('admin-ab', ['Acceso a Clivora', 'Administrador'], [cls.a, cls.b])
        cls.enfermera = make_user('enfermera', ['Acceso a Clivora', 'Enfermería'], [cls.a])

    def client_for(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_solo_ve_sus_clinicas_y_cambia_de_activa(self):
        c = self.client_for(self.admin)
        self.assertEqual([x['name'] for x in c.get('/api/v1/core/clinicas/').json()], ['Clínica A', 'Clínica B'])
        self.assertEqual(c.post('/api/v1/me/clinica/', {'clinica': self.b.pk}).status_code, 200)
        self.admin.refresh_from_db()
        self.assertEqual(self.admin.clinica_activa, self.b)
        self.assertEqual(c.post('/api/v1/me/clinica/', {'clinica': self.c.pk}).status_code, 400)

    def test_lugares_y_salas_de_la_clinica_activa(self):
        c = self.client_for(self.admin)
        r = c.post('/api/v1/core/lugares/', {'clinica': self.a.pk, 'name': 'Penthouse 2'})
        self.assertEqual(r.status_code, 201, r.content)
        r = c.post('/api/v1/core/salas/', {'lugar': r.json()['id'], 'name': 'Sala 2', 'tipo': 'tratamiento'})
        self.assertEqual(r.status_code, 201, r.content)
        lugares = c.get('/api/v1/core/lugares/').json()
        self.assertEqual(lugares[0]['salas'][0]['name'], 'Sala 2')
        self.assertEqual(c.post('/api/v1/core/lugares/', {'clinica': self.c.pk, 'name': 'X'}).status_code, 400)

    def test_enfermeria_no_configura(self):
        c = self.client_for(self.enfermera)
        self.assertEqual(c.post('/api/v1/core/lugares/', {'clinica': self.a.pk, 'name': 'X'}).status_code, 403)
        self.assertEqual(c.get('/api/v1/usuarios/').status_code, 403)

    def test_admin_da_de_alta_usuario_con_roles_y_clinicas(self):
        c = self.client_for(self.admin)
        recepcion = Group.objects.get(name='Recepción').pk
        acceso = Group.objects.get(name='Acceso a Clivora').pk
        r = c.post('/api/v1/usuarios/', {'username': 'nueva', 'first_name': 'Nueva', 'password': 'Clave-segura-1',
                                         'roles': [acceso, recepcion], 'clinicas': [self.b.pk]}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        user = User.objects.get(username='nueva')
        self.assertTrue(user.check_password('Clave-segura-1'))
        self.assertEqual(user.clinica_activa, self.b)
        self.assertEqual(set(user.groups.values_list('name', flat=True)), {'Acceso a Clivora', 'Recepción'})
        # No puede dar una clínica que no tiene.
        r = c.patch(f'/api/v1/usuarios/{user.pk}/', {'clinicas': [self.c.pk]}, format='json')
        self.assertEqual(r.status_code, 400)

    def test_admin_no_ve_usuarios_de_otras_clinicas(self):
        externo = make_user('externo', ['Acceso a Clivora'], [self.c])
        r = self.client_for(self.admin).get('/api/v1/usuarios/?clinica=all')
        self.assertNotIn(externo.username, [u['username'] for u in r.json()['results']])


class InstalacionNuevaTests(TestCase):
    def test_superusuario_entra_sin_clinicas_y_da_de_alta_la_primera(self):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        User.objects.create_superuser('root', password='Clave-segura-1')
        r = self.client.post('/clivora/login', {'login': 'root', 'password': 'Clave-segura-1'})
        self.assertTrue(r.json()['ok'])
        self.assertIsNone(self.client.get('/clivora/api/me').json()['clinicaActiva'])
        r = self.client.post('/api/v1/core/clinicas/', {'name': 'Clínica Demo', 'active': True}, content_type='application/json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertTrue(Location.objects.filter(clinica_id=r.json()['id'], usage=Location.USAGE_INTERNAL).exists())
        self.assertEqual(self.client.get('/clivora/api/me').json()['clinicaActiva']['name'], 'Clínica Demo')
