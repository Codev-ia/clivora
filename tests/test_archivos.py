import base64
import shutil
import tempfile

from django.core.management import call_command
from django.test import TestCase, override_settings

from apps.core.models import Clinica
from apps.expediente.models import ArchivoPaciente
from apps.pacientes.models import Paciente

from .test_pacientes import make_user

MEDIA = tempfile.mkdtemp(prefix='clivora-test-media-')
PDF = b'%PDF-1.4 prueba'
DATA_URL = 'data:application/pdf;base64,' + base64.b64encode(PDF).decode()


@override_settings(MEDIA_ROOT=MEDIA)
class ArchivosTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.clinica = Clinica.objects.create(name='Clínica Demo')
        cls.recepcion = make_user('rec', ['Acceso a Clivora', 'Recepción'], cls.clinica, first_name='Rosa')
        cls.externo = make_user('ext', ['Acceso a Clivora', 'Médico Externo'], cls.clinica)
        cls.paciente = Paciente.objects.create(nombres='Paciente', primer_apellido='Prueba')
        cls.url = f'/clivora/api/patients/{cls.paciente.pk}/files'

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA, ignore_errors=True)

    def setUp(self):
        self.client.force_login(self.recepcion)

    def subir(self, **extra):
        data = {'type': 'Estudios de laboratorio', 'type_document': 'Estudios de laboratorio',
                'title': 'Biometría "oct"', 'comment': '<p>Resultados</p><script>x</script>', 'cycle': '3',
                'date_cycle': '2026-10-20', 'fee': True, 'fee_cycle': '1500', 'file': DATA_URL, **extra}
        return self.client.post(self.url, data, content_type='application/json')

    def test_subir_listar_descargar_y_borrar(self):
        data = self.subir().json()
        self.assertEqual((data['title'], data['type_document'], data['comment'], data['uploaded_by']),
                         ('Biometría oct', 'Estudios de laboratorio', '<p>Resultados</p>', 'Rosa'))
        self.assertEqual((data['date_cycle'], data['fee_cycle'], data['mimetype']), ('2026-10-20', 1500.0, 'application/pdf'))
        url = data['fileUrl']
        self.assertTrue(url.startswith('/clivora/patient_files/'))
        r = self.client.get(url)
        self.assertEqual(b''.join(r.streaming_content), PDF)
        self.assertNotIn('attachment', r['Content-Disposition'])
        self.assertEqual(r['X-Frame-Options'], 'SAMEORIGIN')  # vista previa en iframe
        r = self.client.get(url.replace('download=false', 'download=true'))
        self.assertIn('attachment', r['Content-Disposition'])
        self.assertEqual(len(self.client.get(self.url).json()), 1)
        # Borrar lo oculta, sin perder el documento.
        self.assertEqual(self.client.post(f"/clivora/api/files/{data['id']}/delete").json(), {'ok': True})
        self.assertEqual(self.client.get(self.url).json(), [])
        self.assertEqual(self.client.get(url).status_code, 404)
        self.assertTrue(ArchivoPaciente.objects.filter(pk=data['id'], eliminado=True).exists())

    def test_validaciones(self):
        self.assertEqual(self.subir(title='').status_code, 400)
        self.assertEqual(self.subir(file='no-es-un-archivo').status_code, 400)
        data = self.subir(type='Inventado', type_document='Inventado', file='').json()
        self.assertEqual((data['type_document'], data['fileUrl']), ('Otros', ''))

    def test_medico_externo_solo_sus_pacientes(self):
        data = self.subir().json()
        self.client.force_login(self.externo)
        self.assertEqual(self.client.get(self.url).status_code, 404)
        self.assertEqual(self.client.get(data['fileUrl']).status_code, 404)
        self.client.post(f"/clivora/api/files/{data['id']}/delete")
        self.assertFalse(ArchivoPaciente.objects.get().eliminado)
