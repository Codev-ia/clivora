import base64
import io
import tempfile

from django.contrib.auth.models import Group
from django.core.management import call_command
from django.test import TestCase, override_settings
from PIL import Image

from apps.accounts.models import User
from apps.core.models import Clinica
from apps.pacientes.models import Paciente


def make_user(username, roles, clinica, **kw):
    user = User.objects.create_user(username, password='Clave-segura-1', **kw)
    user.groups.add(*Group.objects.filter(name__in=roles))
    user.clinicas.add(clinica)
    user.clinica_activa = clinica
    user.save()
    return user


ALTA = {
    'nombres': 'María José', 'primerApellido': 'López', 'segundoApellido': 'García',
    'fechaNacimiento': '1985-03-14', 'genero': 'Femenino', 'estadoCivil': 'Casado', 'celular': '8112345678',
    'email': 'maria@example.com', 'origenReferencia': 'Facebook', 'calle': 'Av. Siempre Viva', 'numeroCasa': '742',
    'ciudad': 'Monterrey', 'rfc': 'logm850314ab1', 'regimenFiscal': '605', 'terminosCondiciones': True,
    'religion': 'Católica',
}


class PacientesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.clinica = Clinica.objects.create(name='Clínica Demo')
        cls.recepcion = make_user('recepcion', ['Acceso a Clivora', 'Recepción'], cls.clinica)
        cls.dr = make_user('dra', ['Acceso a Clivora', 'Médicos'], cls.clinica, first_name='Ana', last_name='Ruiz')
        cls.externo = make_user('externo', ['Acceso a Clivora', 'Médico Externo'], cls.clinica, first_name='Luis')

    def setUp(self):
        self.client.force_login(self.recepcion)

    def crear(self, **extra):
        r = self.client.post('/clivora/api/patients', {**ALTA, **extra}, content_type='application/json')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_alta_con_expediente_consecutivo(self):
        a = self.crear()
        b = self.crear(nombres='Pedro', celular='8100000000', rfc='')
        self.assertEqual(a['name'], 'MARÍA JOSÉ LÓPEZ GARCÍA')
        self.assertEqual((a['exp'], b['exp']), ('001', '002'))
        p = Paciente.objects.get(pk=a['id'])
        self.assertEqual((p.rfc, p.genero, p.clinica_registro, p.origen_referencia.name),
                         ('LOGM850314AB1', 'femenino', self.clinica, 'Facebook'))

    def test_nombre_y_apellido_obligatorios(self):
        r = self.client.post('/clivora/api/patients', {'nombres': 'Solo nombre'}, content_type='application/json')
        self.assertEqual(r.json()['error'], 'missing_required_fields')

    def test_duplicados(self):
        self.crear()
        r = self.client.get('/clivora/api/patients/check_similar', {'nombres': 'Maria Jose', 'primerApellido': 'Lopez'})
        self.assertIn('Nombre similar', r.json()[0]['reasons'][0])
        r = self.client.get('/clivora/api/patients/check_similar', {'celular': '8112345678'})
        self.assertEqual(r.json()[0]['reasons'], ['Mismo celular'])

    def test_ficha_y_edicion(self):
        pid = self.crear()['id']
        data = self.client.get(f'/clivora/api/patients/{pid}').json()
        self.assertEqual(data['info_general']['genero'], 'Femenino')
        self.assertEqual(data['domicilio_personal']['numeroCasa'], '742')
        self.assertEqual(data['historia_clinica']['religion'], 'Católica')
        self.client.post(f'/clivora/api/patients/{pid}/info_general',
                         {'celular': '8199999999', 'doctor': 'Ana Ruiz'}, content_type='application/json')
        p = Paciente.objects.get(pk=pid)
        self.assertEqual((p.celular, p.doctor_asignado, p.nombres), ('8199999999', self.dr, 'María José'))

    def test_domicilio_fiscal(self):
        pid = self.crear()['id']
        url = f'/clivora/api/patients/{pid}/domicilio'
        personal = {'pais': 'México', 'ciudad': 'Monterrey', 'calle': 'Av. Siempre Viva', 'numeroCasa': '742'}
        fiscal = {'pais': 'México', 'estado': 'Nuevo León', 'ciudad': 'San Pedro', 'colonia': 'Del Valle',
                  'codigoPostal': '66220', 'calle': 'Calzada del Valle', 'numeroCasa': '400'}
        r = self.client.post(url, {**personal, 'fiscal': fiscal}, content_type='application/json')
        self.assertEqual(r.json(), {'ok': True})
        data = self.client.get(f'/clivora/api/patients/{pid}').json()
        self.assertEqual(data['domicilio_fiscal']['codigoPostal'], '66220')
        self.assertEqual(data['domicilio_fiscal']['ciudad'], 'San Pedro')
        self.assertEqual(data['domicilio_personal']['ciudad'], 'Monterrey')  # cada uno por su lado
        # Sin "fiscal" (alta o edición del personal solo) no se toca el fiscal.
        self.client.post(url, personal, content_type='application/json')
        self.assertEqual(Paciente.objects.get(pk=pid).fiscal_calle, 'Calzada del Valle')
        r = self.client.post(url, {**personal, 'fiscal': {**fiscal, 'codigoPostal': '662'}},
                             content_type='application/json')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(Paciente.objects.get(pk=pid).fiscal_codigo_postal, '66220')

    def test_medico_externo_solo_ve_sus_pacientes(self):
        mio = self.crear(nombres='Del externo')
        self.crear(nombres='Ajeno', celular='8111111111', rfc='')
        Paciente.objects.filter(pk=mio['id']).update(doctor_asignado=self.externo)
        self.client.force_login(self.externo)
        self.assertEqual([p['id'] for p in self.client.get('/clivora/api/patients').json()], [mio['id']])

    def test_catalogos(self):
        self.assertEqual(len(self.client.get('/clivora/api/fiscal_regimes').json()), 23)
        self.assertIn('Médico Externo', [o['name'] for o in self.client.get('/clivora/api/patient_referrals').json()])
        doctors = {d['name']: d for d in self.client.get('/clivora/api/doctors').json()}
        self.assertTrue(doctors['Ana Ruiz']['isInternalReferral'])
        self.assertTrue(doctors['Luis']['isExternalReferral'])


@override_settings(MEDIA_ROOT=tempfile.mkdtemp(prefix='clivora-test-media-'))
class FotoPacienteTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        clinica = Clinica.objects.create(name='Clínica Demo')
        cls.enfermera = make_user('enf', ['Acceso a Clivora', 'Enfermería'], clinica)
        cls.externo = make_user('ext', ['Acceso a Clivora', 'Médico Externo'], clinica)
        cls.paciente = Paciente.objects.create(nombres='Paciente')

    def test_subir_y_ver_foto(self):
        self.client.force_login(self.enfermera)
        url = f'/clivora/api/patients/{self.paciente.pk}/photo'
        buf = io.BytesIO()
        Image.new('RGB', (1600, 1200), 'navy').save(buf, format='JPEG')
        foto = 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()
        data = self.client.post(url, {'photo': foto}, content_type='application/json').json()
        self.assertTrue(data['photoUrl'].startswith(f'/clivora/patient_photo/{self.paciente.pk}?v='))
        detalle = self.client.get(f'/clivora/api/patients/{self.paciente.pk}').json()
        self.assertEqual(detalle['photoUrl'], data['photoUrl'])
        r = self.client.get(data['photoUrl'])
        self.assertEqual(Image.open(io.BytesIO(b''.join(r.streaming_content))).size, (512, 384))
        # Ni SVG ni archivos que no son imagen.
        svg = 'data:image/svg+xml;base64,' + base64.b64encode(b'<svg onload="x()"/>').decode()
        self.assertEqual(self.client.post(url, {'photo': svg}, content_type='application/json').status_code, 400)
        # Solo la ve quien puede ver al paciente.
        self.client.force_login(self.externo)
        self.assertEqual(self.client.get(data['photoUrl']).status_code, 404)
