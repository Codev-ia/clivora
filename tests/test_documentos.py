from django.core.management import call_command
from django.test import TestCase

from apps.core.models import Clinica
from apps.expediente.models import LineaReceta, OrdenMedica, Receta
from apps.pacientes.models import Paciente

from .test_pacientes import make_user


class DocumentosTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.clinica = Clinica.objects.create(name='Clínica Demo')
        cls.dra = make_user('dra', ['Acceso a Clivora', 'Médicos'], cls.clinica, first_name='Ana', last_name='Ruiz')
        cls.dr2 = make_user('dr2', ['Acceso a Clivora', 'Médicos'], cls.clinica, first_name='Luis')
        cls.enfermera = make_user('enf', ['Acceso a Clivora', 'Enfermería'], cls.clinica)
        cls.recepcion = make_user('rec', ['Acceso a Clivora', 'Recepción'], cls.clinica)
        cls.paciente = Paciente.objects.create(nombres='Paciente', primer_apellido='Prueba', doctor_asignado=cls.dra)
        cls.otro = Paciente.objects.create(nombres='Otro')
        cls.base = f'/clivora/api/patients/{cls.paciente.pk}'

    def setUp(self):
        self.client.force_login(self.dra)

    def post(self, url, data=None):
        return self.client.post(url, data or {}, content_type='application/json')

    def test_receta_medica(self):
        data = self.post(f'{self.base}/recipe_headers', {
            'doctor_id': self.dr2.pk, 'notes': '<p>Tomar con alimentos</p><script>x</script>',
            'lines': [{'product': 'Paracetamol 500 mg', 'indications': 'Cada 8 h', 'notes': ''}, {'product': ''}],
        }).json()
        self.assertEqual((data['recipe_type'], data['doctor_name'], data['notes']),
                         ('standard', 'Luis', '<p>Tomar con alimentos</p>'))
        self.assertEqual([ln['product'] for ln in data['lines']], ['Paracetamol 500 mg'])
        self.assertFalse(data['clinic_consultations_id'])
        # Editar: cambia un medicamento, agrega otro y conserva el médico.
        linea = data['lines'][0]
        data = self.post(f"/clivora/api/recipe_headers/{data['id']}", {
            'notes': 'Sin cambios', 'lines': [{**linea, 'indications': 'Cada 6 h'}, {'product': 'Omeprazol'}],
        }).json()
        self.assertEqual(data['doctor_name'], 'Luis')
        self.assertEqual([(ln['id'] == linea['id'], ln['indications']) for ln in data['lines']],
                         [(True, 'Cada 6 h'), (False, '')])
        lista = self.client.get(f'{self.base}/recipe_headers').json()
        self.assertEqual(len(lista), 1)
        self.assertEqual(self.post(f"/clivora/api/recipe_headers/{data['id']}/delete").json(), {'ok': True})
        self.assertFalse(LineaReceta.objects.exists())

    def test_receta_oncologica_desde_la_nota(self):
        nota = self.post(f'{self.base}/consultations/oncology', {'treatmentCycle': 'Ciclo 2'}).json()
        data = self.post(f'{self.base}/recipe_headers', {
            'recipe_type': 'oncological', 'notes': '', 'cycle_number': 'Ciclo 2', 'application_day': 'Día 1',
            'next_treatment_date': '2026-11-16', 'weight': 70, 'height': 170, 'blood_pressure': '120/80',
            'heart_rate': '72', 'body_surface_area': 1.81, 'general_diagnosis': 'C50 - Tumor maligno de la mama',
            'premedication_description': '<p>Ondansetrón 8 mg IV</p>', 'postmedication_description': '',
            'lines': [{'product': 'Paclitaxel 175 mg/m²', 'indications': 'IV en 3 h'}],
            'clinic_consultations_id': nota['consultation_id'],
        }).json()
        self.assertEqual((data['doctor_name'], data['next_treatment_date'], data['heart_rate'], data['weight']),
                         ('Ana Ruiz', '2026-11-16', 72, 70.0))
        self.assertEqual(data['clinic_consultations_id'], nota['consultation_id'])
        orden = self.post(f'{self.base}/lab_orders', {
            'hr_employee_id': '', 'observations': '<p>Biometría hemática</p>',
            'clinic_consultations_id': nota['consultation_id'],
        }).json()
        self.assertEqual(orden['hr_employee_name'], 'Ana Ruiz')  # sin médico: el asignado al paciente
        nota = self.client.get(f'{self.base}/consultations').json()[0]
        self.assertEqual([d['label'] for d in nota['linkedDocuments']], ['Receta Oncológica', 'Orden Médica'])
        # Una nota de otro paciente no se puede usar como origen.
        otra = self.post(f'/clivora/api/patients/{self.otro.pk}/lab_orders',
                         {'clinic_consultations_id': nota['consultation_id']}).json()
        self.assertFalse(otra['clinic_consultations_id'])

    def test_orden_medica(self):
        data = self.post(f'{self.base}/lab_orders', {'hr_employee_id': self.dr2.pk,
                                                    'observations': 'Perfil tiroideo'}).json()
        self.assertEqual((data['hr_employee_name'], data['observations']), ('Luis', 'Perfil tiroideo'))
        data = self.post(f"/clivora/api/lab_orders/{data['id']}", {'hr_employee_id': self.dra.pk,
                                                                   'observations': 'Perfil hepático'}).json()
        self.assertEqual((data['hr_employee_name'], data['observations']), ('Ana Ruiz', 'Perfil hepático'))
        catalogos = self.client.get('/clivora/api/lab_catalogs').json()
        self.assertEqual([d['name'] for d in catalogos['employees']], ['Ana Ruiz', 'Luis'])
        self.assertEqual(self.post(f"/clivora/api/lab_orders/{data['id']}/delete").json(), {'ok': True})
        self.assertFalse(OrdenMedica.objects.exists())

    def test_permisos(self):
        receta = self.post(f'{self.base}/recipe_headers', {'lines': [{'product': 'Paracetamol'}]}).json()
        orden = self.post(f'{self.base}/lab_orders', {'observations': 'BH'}).json()
        # Enfermería: órdenes sí, recetas solo lectura.
        self.client.force_login(self.enfermera)
        self.assertEqual(len(self.client.get(f'{self.base}/recipe_headers').json()), 1)
        self.assertEqual(self.post(f'{self.base}/recipe_headers', {'lines': []}).status_code, 403)
        self.assertEqual(self.post(f"/clivora/api/recipe_headers/{receta['id']}").status_code, 403)
        self.assertEqual(self.post(f"/clivora/api/lab_orders/{orden['id']}", {'observations': 'BH y QS'}).status_code, 200)
        # Recepción: las dos en solo lectura.
        self.client.force_login(self.recepcion)
        self.assertEqual(len(self.client.get(f'{self.base}/lab_orders').json()), 1)
        self.assertEqual(self.post(f'{self.base}/lab_orders', {}).status_code, 403)
        self.assertEqual(self.post(f"/clivora/api/lab_orders/{orden['id']}/delete").status_code, 403)
        self.assertEqual(self.post(f"/clivora/api/recipe_headers/{receta['id']}/delete").status_code, 403)
        self.assertTrue(Receta.objects.exists() and OrdenMedica.objects.exists())
