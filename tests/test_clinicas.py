import base64
import io

from django.test import TestCase, override_settings
from PIL import Image
from rest_framework.test import APIClient

from apps.accounts.models import User
from apps.core.models import Clinica


def png_data_url(size=(1200, 400)):
    buf = io.BytesIO()
    Image.new('RGBA', size, (124, 58, 237, 255)).save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


@override_settings(MEDIA_ROOT='/tmp/app-test-media')
class ClinicaFiscalTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.root = User.objects.create_superuser('root', password='Clave-segura-1')

    def setUp(self):
        self.c = APIClient()
        self.c.force_authenticate(self.root)

    def crear(self, **extra):
        data = {'name': 'Clínica Demo', 'active': True, 'legal_name': 'DIAGNOSTICO ONCOLOGICO AVANZADO',
                'rfc': 'doa160913k50', 'regimen_fiscal': '601', 'codigo_postal': '64000', 'calle': 'Av. Constitución',
                'numero_exterior': '123', 'colonia': 'Centro', 'municipio': 'Monterrey', 'estado': 'Nuevo León', **extra}
        return self.c.post('/api/v1/core/clinicas/', data)

    def test_datos_fiscales(self):
        r = self.crear()
        self.assertEqual(r.status_code, 201, r.content)
        d = r.json()
        self.assertEqual((d['rfc'], d['tipo_persona'], d['regimen_fiscal_label'], d['pais']),
                         ('DOA160913K50', 'moral', 'General de Ley Personas Morales', 'México'))

    def test_validaciones(self):
        self.assertIn('rfc', self.crear(rfc='ABC123').json())
        self.assertIn('codigo_postal', self.crear(codigo_postal='640').json())
        self.assertIn('regimen_fiscal', self.crear(regimen_fiscal='999').json())

    def test_logo(self):
        cid = self.crear().json()['id']
        r = self.c.post(f'/api/v1/core/clinicas/{cid}/logo/', {'logo': png_data_url()})
        self.assertEqual(r.status_code, 200, r.content)
        url = r.json()['logo_url']
        self.assertTrue(url.startswith(f'/clivora/clinica_logo/{cid}?v='))
        img = Image.open(io.BytesIO(b''.join(self.client.get(url).streaming_content)))
        self.assertEqual(img.size, (600, 200))  # reducido a 600 px conservando proporción
        r = self.c.delete(f'/api/v1/core/clinicas/{cid}/logo/')
        self.assertEqual(r.json()['logo_url'], '')
        self.assertFalse(Clinica.objects.get(pk=cid).logo)

    def test_logo_invalido(self):
        cid = self.crear().json()['id']
        falso = 'data:image/png;base64,' + base64.b64encode(b'no soy una imagen').decode()
        self.assertIn('no es una imagen', str(self.c.post(f'/api/v1/core/clinicas/{cid}/logo/', {'logo': falso}).json()))
        svg = 'data:image/svg+xml;base64,' + base64.b64encode(b'<svg onload="alert(1)"/>').decode()
        self.assertIn('PNG, JPG o WebP', str(self.c.post(f'/api/v1/core/clinicas/{cid}/logo/', {'logo': svg}).json()))

    def test_la_clinica_no_se_borra(self):
        cid = self.crear().json()['id']
        self.assertEqual(self.c.delete(f'/api/v1/core/clinicas/{cid}/').status_code, 405)
        self.assertTrue(Clinica.objects.filter(pk=cid).exists())

    def test_regimen_vacio_permitido(self):
        self.assertEqual(self.crear(regimen_fiscal='', rfc='', codigo_postal='').status_code, 201)
