from django.core.management import call_command
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.accounts.models import Especialidad, PerfilMedico, User
from apps.expediente.reportes import _firma_medico
from apps.pacientes.models import Paciente

from . import factories as f
from .test_api import make_user
from .test_clinicas import png_data_url


@override_settings(MEDIA_ROOT='/tmp/app-test-media')
class MedicosTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.demo = f.clinica('Clínica Demo')
        cls.otra = f.clinica('Otra clínica')
        cls.admin = make_user('admin', ['Acceso a Clivora', 'Administrador'], [cls.demo])
        cls.dra = make_user('dra', ['Acceso a Clivora', 'Médicos'], [cls.demo], first_name='Ana', last_name='Ruiz')
        cls.dr = make_user('dr', ['Acceso a Clivora', 'Médicos'], [cls.demo], first_name='Beto', last_name='Paz')
        cls.externo = make_user('ext', ['Acceso a Clivora', 'Médico Externo'], [cls.demo])
        cls.lejano = make_user('lejano', ['Acceso a Clivora', 'Médicos'], [cls.otra])
        cls.enfermera = make_user('enf', ['Acceso a Clivora', 'Enfermería'], [cls.demo], first_name='Eva')
        cls.recepcion = make_user('rec', ['Acceso a Clivora', 'Recepción'], [cls.demo])
        cls.onco = Especialidad.objects.create(name='Oncología médica')

    def client_for(self, user):
        c = APIClient()
        c.force_authenticate(user)
        return c

    def test_admin_lista_medicos_y_enfermeria_de_sus_clinicas(self):
        c = self.client_for(self.admin)
        data = c.get('/api/v1/medicos/').json()
        self.assertEqual([(m['username'], m['tipo']) for m in data],  # orden por nombre
                         [('ext', 'medico'), ('dra', 'medico'), ('dr', 'medico'), ('enf', 'enfermeria')])
        self.assertTrue(data[0]['es_externo'])
        self.assertEqual((data[1]['especialidad'], data[1]['cedula_profesional']), (None, ''))
        self.assertEqual([m['username'] for m in c.get('/api/v1/medicos/?tipo=medico').json()], ['ext', 'dra', 'dr'])
        self.assertEqual([m['username'] for m in c.get('/api/v1/medicos/?tipo=enfermeria').json()], ['enf'])
        self.assertNotIn('enf', [m['username'] for m in c.get('/api/v1/medicos/?especialidad=none').json()])

    def test_admin_edita_perfil_y_filtra_por_especialidad(self):
        c = self.client_for(self.admin)
        r = c.patch(f'/api/v1/medicos/{self.dra.pk}/', {
            'especialidad': self.onco.pk, 'cedula_profesional': '12345678', 'cedula_especialidad': '87654321',
            'universidad': 'UANL', 'enfermera': self.enfermera.pk}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d['especialidad_name'], d['enfermera_name'], d['cedula_profesional']),
                         ('Oncología médica', 'Eva', '12345678'))
        self.assertEqual([m['id'] for m in c.get(f'/api/v1/medicos/?especialidad={self.onco.pk}').json()], [self.dra.pk])
        self.assertNotIn(self.dra.pk, [m['id'] for m in c.get('/api/v1/medicos/?especialidad=none').json()])
        self.assertEqual([m['id'] for m in c.get('/api/v1/medicos/?q=1234').json()], [self.dra.pk])

    def test_validaciones(self):
        c = self.client_for(self.admin)
        r = c.patch(f'/api/v1/medicos/{self.dra.pk}/', {'cedula_profesional': '12A'}, format='json')
        self.assertIn('cedula_profesional', r.json())
        r = c.patch(f'/api/v1/medicos/{self.dra.pk}/', {'enfermera': self.recepcion.pk}, format='json')
        self.assertIn('enfermera', r.json())  # solo Enfermería / Jefa de Enfermería
        baja = Especialidad.objects.create(name='Pediatría', active=False)
        r = c.patch(f'/api/v1/medicos/{self.dra.pk}/', {'especialidad': baja.pk}, format='json')
        self.assertIn('especialidad', r.json())
        self.assertEqual(c.get(f'/api/v1/medicos/{self.lejano.pk}/').status_code, 404)  # otra clínica
        self.assertEqual(c.get(f'/api/v1/medicos/{self.recepcion.pk}/').status_code, 404)  # no es personal clínico

    def test_medico_solo_ve_y_edita_su_ficha(self):
        c = self.client_for(self.dra)
        self.assertEqual([m['id'] for m in c.get('/api/v1/medicos/').json()], [self.dra.pk])
        self.assertEqual(c.get(f'/api/v1/medicos/{self.dr.pk}/').status_code, 404)
        r = c.patch(f'/api/v1/medicos/{self.dra.pk}/', {'universidad': 'UNAM'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(PerfilMedico.objects.get(user=self.dra).universidad, 'UNAM')
        self.assertEqual(self.client_for(self.recepcion).get('/api/v1/medicos/').status_code, 403)

    def test_ficha_de_enfermeria(self):
        admin = self.client_for(self.admin)
        admin.patch(f'/api/v1/medicos/{self.dra.pk}/', {'enfermera': self.enfermera.pk}, format='json')
        r = admin.patch(f'/api/v1/medicos/{self.enfermera.pk}/', {'cedula_profesional': '555', 'universidad': 'UANL'},
                        format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['cedula_profesional'], r.json()['medicos_asignados']), ('555', ['Ana Ruiz']))
        for campo, valor in (('especialidad', self.onco.pk), ('cedula_especialidad', '1'), ('enfermera', self.enfermera.pk)):
            r = admin.patch(f'/api/v1/medicos/{self.enfermera.pk}/', {campo: valor}, format='json')
            self.assertIn(campo, r.json())  # solo de médicos
        # La enfermera ve y edita su propia ficha, y nada más.
        enf = self.client_for(self.enfermera)
        self.assertEqual([m['id'] for m in enf.get('/api/v1/medicos/').json()], [self.enfermera.pk])
        r = enf.post(f'/api/v1/medicos/{self.enfermera.pk}/firma/', {'firma': png_data_url()}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        firma = _firma_medico(User.objects.get(pk=self.enfermera.pk), 'Firma del personal de enfermería')
        self.assertTrue(firma['imagen'].startswith('file://'))
        self.assertEqual(firma['cedulas'], 'Céd. Prof. 555')

    def test_firma(self):
        c = self.client_for(self.admin)
        r = c.post(f'/api/v1/medicos/{self.dra.pk}/firma/', {'firma': png_data_url((1600, 500))}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        url = r.json()['firma_url']
        self.assertTrue(url.startswith(f'/clivora/medico_firma/{self.dra.pk}?v='))
        self.client.force_login(self.admin)
        self.assertEqual(self.client.get(url).status_code, 200)
        self.client.force_login(self.dra)
        self.assertEqual(self.client.get(url).status_code, 200)  # su propia firma
        self.client.force_login(self.dr)
        self.assertEqual(self.client.get(url).status_code, 404)  # la de otro médico, no
        r = c.post(f'/api/v1/medicos/{self.dra.pk}/firma/', {'firma': 'data:image/svg+xml;base64,PHN2Zz4='},
                   format='json')
        self.assertIn('firma', r.json())
        self.assertTrue(PerfilMedico.objects.get(user=self.dra).firma)  # la anterior sigue
        r = c.delete(f'/api/v1/medicos/{self.dra.pk}/firma/')
        self.assertEqual(r.json()['firma_url'], '')

    def test_especialidades(self):
        admin = self.client_for(self.admin)
        r = admin.post('/api/v1/especialidades/', {'name': '  Hematología   clínica '}, format='json')
        self.assertEqual((r.status_code, r.json()['name']), (201, 'Hematología clínica'))
        self.assertIn('name', admin.post('/api/v1/especialidades/', {'name': 'oncología MÉDICA'}, format='json').json())
        admin.patch(f"/api/v1/especialidades/{r.json()['id']}/", {'active': False}, format='json')
        nombres = [e['name'] for e in self.client_for(self.dra).get('/api/v1/especialidades/').json()]
        self.assertEqual(nombres, ['Oncología médica'])
        self.assertEqual(self.client_for(self.dra).post('/api/v1/especialidades/', {'name': 'X'}).status_code, 403)

    def test_catalogos_y_me(self):
        PerfilMedico.objects.create(user=self.dra, especialidad=self.onco)
        self.client.force_login(self.dra)
        self.assertEqual(self.client.get('/clivora/api/doctor_specialties').json(),
                         [{'id': self.onco.pk, 'name': 'Oncología médica'}])
        dra = next(d for d in self.client.get('/clivora/api/doctors').json() if d['id'] == self.dra.pk)
        self.assertEqual((dra['specialtyId'], dra['specialtyName']), (self.onco.pk, 'Oncología médica'))
        cat = self.client.get('/clivora/api/citas/catalogs').json()
        self.assertEqual(next(d for d in cat['doctors'] if d['id'] == self.dra.pk)['specialtyId'], self.onco.pk)
        me = self.client.get('/clivora/api/me').json()
        self.assertEqual((me['canSeeMedicos'], me['canManageMedicos'], me['canManageEspecialidades']),
                         (True, False, False))
        self.client.force_login(self.enfermera)
        self.assertTrue(self.client.get('/clivora/api/me').json()['canSeeMedicos'])
        self.client.force_login(self.recepcion)
        self.assertFalse(self.client.get('/clivora/api/me').json()['canSeeMedicos'])
        self.client.force_login(self.admin)
        me = self.client.get('/clivora/api/me').json()
        self.assertEqual((me['canSeeMedicos'], me['canManageMedicos'], me['canManageEspecialidades']),
                         (True, True, True))

    def test_firma_y_cedulas_en_los_reportes(self):
        self.assertEqual(_firma_medico(self.dra), {'caption': 'Firma del médico', 'name': 'Ana Ruiz', 'imagen': '',
                                                   'especialidad': '', 'cedulas': ''})
        c = self.client_for(self.admin)
        c.patch(f'/api/v1/medicos/{self.dra.pk}/', {'especialidad': self.onco.pk, 'cedula_profesional': '123',
                                                   'cedula_especialidad': '456'}, format='json')
        c.post(f'/api/v1/medicos/{self.dra.pk}/firma/', {'firma': png_data_url()}, format='json')
        firma = _firma_medico(User.objects.get(pk=self.dra.pk))
        self.assertTrue(firma['imagen'].startswith('file://'))
        self.assertEqual((firma['especialidad'], firma['cedulas']), ('Oncología médica', 'Céd. Prof. 123 · Céd. Esp. 456'))
        paciente = Paciente.objects.create(nombres='Paciente', primer_apellido='Prueba', doctor_asignado=self.dra)
        self.client.force_login(self.dra)
        r = self.client.get(f'/clivora/api/patients/{paciente.pk}/historia_clinica/print')
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b'%PDF'))
