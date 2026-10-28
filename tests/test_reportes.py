from django.core.management import call_command
from django.test import TestCase

from apps.core.models import Clinica
from apps.expediente.models import HistoriaClinica, NotaEnfermeria
from apps.pacientes.models import Paciente

from .test_pacientes import make_user


class ReportesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        clinica = Clinica.objects.create(name='Clínica Demo', calle='Av. Uno', numero_exterior='10', phone='8112345678')
        cls.dra = make_user('dra', ['Acceso a Clivora', 'Médicos'], clinica, first_name='Ana', last_name='Ruiz')
        cls.externo = make_user('ext', ['Acceso a Clivora', 'Médico Externo'], clinica)
        cls.paciente = Paciente.objects.create(nombres='Paciente', primer_apellido='Prueba', doctor_asignado=cls.dra)
        cls.base = f'/clivora/api/patients/{cls.paciente.pk}'
        HistoriaClinica.objects.create(paciente=cls.paciente, motivo_consulta='<p>Dolor</p>')

    def setUp(self):
        self.client.force_login(self.dra)

    def post(self, url, data):
        return self.client.post(url, data, content_type='application/json').json()

    def assertPdf(self, url, nombre):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, url)
        self.assertEqual(r['Content-Type'], 'application/pdf')
        self.assertTrue(r.content.startswith(b'%PDF'))
        self.assertTrue(r['Content-Disposition'].startswith(f'inline; filename="{nombre}-'), r['Content-Disposition'])
        return r

    def test_todos_los_reportes(self):
        sv = self.post(f'{self.base}/consultations/vitals', {'systolic': 120, 'diastolic': 80, 'weight': 70,
                                                             'height': 170})
        onco = self.post(f'{self.base}/consultations/oncology', {'treatmentCycle': 'Ciclo 1'})
        receta = self.post(f'{self.base}/recipe_headers', {'lines': [{'product': 'Paracetamol', 'indications': 'c/8 h'}]})
        onco_receta = self.post(f'{self.base}/recipe_headers', {'recipe_type': 'oncological', 'cycle_number': '2',
                                                                'lines': [{'product': 'Paclitaxel'}]})
        orden = self.post(f'{self.base}/lab_orders', {'observations': 'Biometría hemática'})
        inicial = NotaEnfermeria.objects.create(paciente=self.paciente, tipo=NotaEnfermeria.VALORACION_INICIAL)
        inicial.respuestas.create(patron='Nutricional', pregunta='¿Come bien?', respuesta='si')
        registro = NotaEnfermeria.objects.create(paciente=self.paciente, reporte='Paciente estable')
        self.assertPdf(f'{self.base}/historia_clinica/print', 'Historia-clinica')
        self.assertPdf(f"{self.base}/consultations/vitals/{sv['id'].split('-')[1]}/print", 'Signos-vitales')
        self.assertPdf(f"{self.base}/consultations/oncology/{onco['consultation_id']}/print", 'Nota-oncologia')
        self.assertPdf(f"{self.base}/recipe_headers/{receta['id']}/print", 'Receta-medica')
        self.assertPdf(f"{self.base}/recipe_headers/{onco_receta['id']}/onco_print", 'Receta-oncologica')
        self.assertPdf(f"{self.base}/lab_orders/{orden['id']}/print", 'Orden-medica')
        self.assertPdf(f'{self.base}/nursing_notes/{inicial.pk}/print', 'Evaluacion-inicial')
        self.assertPdf(f'{self.base}/nursing_notes/{registro.pk}/clinical_print', 'Registro-clinico-enfermeria')
        r = self.client.get(f"{self.base}/lab_orders/{orden['id']}/print?download=1")
        self.assertTrue(r['Content-Disposition'].startswith('attachment;'))

    def test_solo_quien_ve_al_paciente(self):
        orden = self.post(f'{self.base}/lab_orders', {'observations': 'BH'})
        otro = Paciente.objects.create(nombres='Otro')
        # El documento tiene que ser del paciente de la URL.
        self.assertEqual(self.client.get(f"/clivora/api/patients/{otro.pk}/lab_orders/{orden['id']}/print").status_code, 404)
        self.client.force_login(self.externo)
        self.assertEqual(self.client.get(f'{self.base}/historia_clinica/print').status_code, 404)
