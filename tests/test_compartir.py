from django.core.management import call_command
from django.test import TestCase

from apps.core.models import Clinica
from apps.pacientes.models import ExpedienteCompartido, Paciente

from .test_pacientes import make_user


class CompartirTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        clinica = Clinica.objects.create(name='Clínica Demo')
        cls.dra = make_user('dra', ['Acceso a Clivora', 'Médicos', 'Compartir Expediente'], clinica, first_name='Ana')
        cls.enfermera = make_user('enf', ['Acceso a Clivora', 'Enfermería'], clinica)
        cls.externo = make_user('ext', ['Acceso a Clivora', 'Médico Externo'], clinica, first_name='Luis')
        cls.paciente = Paciente.objects.create(nombres='Paciente', doctor_asignado=cls.dra)
        cls.url = f'/clivora/api/patients/{cls.paciente.pk}/shares'

    def post(self, url, data=None):
        return self.client.post(url, data or {}, content_type='application/json')

    def test_compartir_da_acceso_al_medico_externo(self):
        self.client.force_login(self.externo)
        self.assertEqual(self.client.get(f'/clivora/api/patients/{self.paciente.pk}').status_code, 404)
        self.client.force_login(self.dra)
        data = self.post(self.url, {'doctor_id': str(self.externo.pk), 'note': '<p>Segunda opinión</p><script>x</script>',
                                    'file_ids': []}).json()
        self.assertEqual((data['doctor_name'], data['shared_by_name'], data['note'], data['file_titles']),
                         ('Luis', 'Ana', '<p>Segunda opinión</p>', []))
        self.assertEqual(len(self.client.get(self.url).json()), 1)
        # El externo ya ve el expediente y su lista de pacientes lo incluye.
        self.client.force_login(self.externo)
        self.assertEqual(self.client.get(f'/clivora/api/patients/{self.paciente.pk}').status_code, 200)
        self.assertEqual([p['id'] for p in self.client.get('/clivora/api/patients').json()], [self.paciente.pk])
        # Quitar el registro le quita el acceso.
        self.client.force_login(self.dra)
        self.assertEqual(self.post(f"/clivora/api/shares/{data['id']}/delete").json(), {'ok': True})
        self.client.force_login(self.externo)
        self.assertEqual(self.client.get(f'/clivora/api/patients/{self.paciente.pk}').status_code, 404)

    def test_solo_el_rol_compartir(self):
        self.client.force_login(self.dra)
        rec = self.post(self.url, {'doctor_id': self.externo.pk}).json()
        self.assertEqual(self.post(self.url, {}).json(), {'error': 'missing_doctor'})
        # Solo médicos: una enfermera no es destino válido.
        self.assertEqual(self.post(self.url, {'doctor_id': self.enfermera.pk}).status_code, 400)
        self.client.force_login(self.enfermera)
        self.assertEqual(len(self.client.get(self.url).json()), 1)
        self.assertEqual(self.post(self.url, {'doctor_id': self.externo.pk}).status_code, 403)
        self.assertEqual(self.post(f"/clivora/api/shares/{rec['id']}/delete").status_code, 403)
        self.assertEqual(ExpedienteCompartido.objects.count(), 1)
