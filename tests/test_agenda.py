import base64

from django.contrib.auth.models import Group
from django.core import mail
from django.core.management import call_command
from django.test import TestCase, override_settings

from apps.accounts.models import User
from apps.agenda.models import Cita, MotivoRechazo
from apps.core.models import Clinica, Lugar, Sala
from apps.pacientes.models import Paciente


def make_user(username, roles, clinica, **kw):
    user = User.objects.create_user(username, password='Clave-segura-1', **kw)
    user.groups.add(*Group.objects.filter(name__in=roles))
    user.clinicas.add(clinica)
    user.clinica_activa = clinica
    user.save()
    return user


@override_settings(MEDIA_ROOT='/tmp/app-test-media')
class AgendaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.clinica = Clinica.objects.create(name='Clínica Demo')
        cls.otra = Clinica.objects.create(name='Otra')
        cls.ph2 = Lugar.objects.create(clinica=cls.clinica, name='Penthouse 2')
        cls.sala2 = Sala.objects.create(lugar=cls.ph2, name='Sala 2', tipo='tratamiento')
        cls.cons_a = Sala.objects.create(lugar=cls.ph2, name='Consultorio A', tipo='consulta')
        cls.enfermera = make_user('enf', ['Acceso a Clivora', 'Enfermería'], cls.clinica, first_name='Eva')
        cls.recepcion = make_user('rec', ['Acceso a Clivora', 'Recepción'], cls.clinica)
        cls.medico = make_user('dr', ['Acceso a Clivora', 'Médicos'], cls.clinica, first_name='Ana', last_name='Ruiz')
        cls.paciente = Paciente.objects.create(nombres='Juan', primer_apellido='Pérez', email='juan@example.com')

    def setUp(self):
        self.client.force_login(self.enfermera)

    def post(self, url, data):
        return self.client.post(url, data, content_type='application/json')

    def nueva(self, **extra):
        data = {'tipo': 'Tratamiento', 'motivo': 'Infusión', 'pacienteId': self.paciente.pk, 'doctorId': self.medico.pk,
                'ubicacion': self.ph2.pk, 'sala': self.sala2.pk, 'fecha': '2026-11-03', 'hora': '09:00',
                'fechaFin': '2026-11-03', 'horaFin': '11:00', 'frecuencia': 'Primera vez', 'ciclo': 'Ciclo 1',
                'estado': 'aprobado', **extra}
        r = self.post('/clivora/api/citas', data)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def test_alta_nace_pendiente_y_serializa_como_el_frontend(self):
        c = self.nueva()
        self.assertEqual(c['estado'], 'pendiente')
        self.assertEqual((c['ubicacion'], c['sala'], c['lugarId'], c['salaId']), ('Penthouse 2', 'Sala 2', self.ph2.pk, self.sala2.pk))
        self.assertEqual((c['hora'], c['horaFin'], c['doctor'], c['paciente']), ('09:00', '11:00', 'Ana Ruiz', 'JUAN PÉREZ'))
        self.assertEqual(c['aplicacion'], {'modo': 'manual', 'estado': '', 'traslados': []})
        self.assertEqual(Cita.objects.get().clinica, self.clinica)

    def test_sala_no_se_reserva_dos_veces_al_aprobar(self):
        a, b = self.nueva(), self.nueva(hora='10:00', horaFin='12:00')
        self.assertEqual(self.post(f"/clivora/api/citas/{a['id']}", {**a, 'ubicacion': a['lugarId'], 'sala': a['salaId'], 'estado': 'aprobado'}).status_code, 200)
        r = self.post(f"/clivora/api/citas/{b['id']}", {**b, 'ubicacion': b['lugarId'], 'sala': b['salaId'], 'estado': 'aprobado'})
        self.assertEqual(r.json()['error'], 'sala_ocupada')
        self.assertIn('ya está reservada', r.json()['message'])

    def test_consulta_requiere_consultorio(self):
        r = self.post('/clivora/api/citas', {'tipo': 'Consulta', 'motivo': 'Consulta médica', 'ubicacion': self.ph2.pk,
                                                  'sala': self.sala2.pk, 'fecha': '2026-11-03', 'hora': '09:00'})
        # La sala de tratamiento no se acepta para Consulta: queda sin sala, no truena.
        self.assertEqual(r.status_code, 400)
        self.assertIn('consultorio', r.json()['message'])

    def test_transiciones_rechazo_y_correos(self):
        c = self.nueva()
        payload = {**c, 'ubicacion': c['lugarId'], 'sala': c['salaId']}
        rechazo = MotivoRechazo.objects.get(name='Conflicto de horario')
        with self.captureOnCommitCallbacks(execute=True):  # el correo sale al confirmar la transacción
            r = self.post(f"/clivora/api/citas/{c['id']}", {**payload, 'estado': 'rechazado', 'rejectionReasonId': rechazo.pk})
        self.assertEqual(r.json()['rejectedBy'], 'Eva')
        self.assertEqual(len(mail.outbox), 1)
        self.assertEqual(mail.outbox[0].subject, 'Tu cita no pudo confirmarse')
        self.assertIn('Conflicto de horario', mail.outbox[0].alternatives[0][0])
        r = self.post(f"/clivora/api/citas/{c['id']}", {**payload, 'estado': 'aprobado'})
        self.assertEqual(r.json()['error'], 'cita_rechazada')

    def test_check_in_y_out(self):
        c = self.nueva()
        self.assertEqual(self.post(f"/clivora/api/citas/{c['id']}/check", {'tipo': 'check_in'}).json()['error'], 'not_aprobado')
        with self.captureOnCommitCallbacks(execute=True):
            self.post(f"/clivora/api/citas/{c['id']}", {**c, 'ubicacion': c['lugarId'], 'sala': c['salaId'], 'estado': 'aprobado'})
        self.assertEqual(len(mail.outbox), 1)  # confirmación
        self.assertEqual(mail.outbox[0].subject, 'Confirmación de tu cita')
        r = self.post(f"/clivora/api/citas/{c['id']}/check", {'tipo': 'check_in'})
        self.assertEqual((r.json()['estado'], r.json()['checkIn'], r.json()['checkInBy']), ('en_progreso', True, 'Eva'))
        r = self.post(f"/clivora/api/citas/{c['id']}/check", {'tipo': 'check_out'})
        self.assertEqual(r.json()['estado'], 'finalizado')

    def test_permisos_por_rol(self):
        self.client.force_login(self.medico)  # médico: solo lectura
        r = self.post('/clivora/api/citas', {'tipo': 'Consulta', 'fecha': '2026-11-03', 'hora': '09:00'})
        self.assertEqual(r.status_code, 403)
        self.client.force_login(self.recepcion)  # recepción: solo Consulta
        self.assertEqual(self.post('/clivora/api/citas', {'tipo': 'Tratamiento', 'fecha': '2026-11-03', 'hora': '09:00'}).status_code, 403)
        self.assertEqual(self.post('/clivora/api/citas', {'tipo': 'Consulta', 'motivo': 'Consulta médica', 'ubicacion': self.ph2.pk,
                                                               'sala': self.cons_a.pk, 'fecha': '2026-11-03', 'hora': '09:00'}).status_code, 200)

    def test_cada_clinica_ve_sus_citas(self):
        self.nueva()
        otra_user = make_user('otra', ['Acceso a Clivora', 'Enfermería'], self.otra)
        self.client.force_login(otra_user)
        self.assertEqual(self.client.get('/clivora/api/citas').json(), [])

    def test_archivos(self):
        c = self.nueva()
        data_url = 'data:text/plain;base64,' + base64.b64encode(b'hola').decode()
        r = self.post(f"/clivora/api/citas/{c['id']}/files", {'files': [{'name': 'nota.txt', 'dataUrl': data_url}]})
        archivo = r.json()['created'][0]
        self.assertEqual((archivo['name'], archivo['fileSize']), ('nota.txt', 4))
        self.assertEqual(b''.join(self.client.get(archivo['fileUrl']).streaming_content), b'hola')
        self.client.logout()
        self.assertEqual(self.client.get(archivo['fileUrl']).status_code, 302)  # sin sesión no se descarga

    def test_tratamientos_y_catalogos(self):
        self.nueva()
        t = self.client.get('/clivora/api/tratamientos').json()[0]
        self.assertEqual((t['sala'], t['ubicacion'], t['motivo']), ('Sala 2', 'Penthouse 2', 'Infusión'))
        cat = self.client.get('/clivora/api/citas/catalogs').json()
        self.assertEqual(cat['lugares'][0]['name'], 'Penthouse 2')
        self.assertEqual(len(cat['lugares'][0]['salas']), 2)
        self.assertIn('Ana Ruiz', [d['name'] for d in cat['doctors']])

    def test_auto_agendado_publico_y_seguimiento(self):
        self.client.logout()
        self.client.get(f'/clivora/agendar?clinica={self.clinica.pk}')
        r = self.post('/clivora/api/public/citas', {'nombre': 'Visitante', 'telefono': '8100000000',
                                                         'tipo': 'Consulta', 'motivo': 'Consulta médica',
                                                         'fecha': '2026-11-05', 'hora': '10:00'})
        self.assertTrue(r.json()['ok'])
        cita = Cita.objects.get(solicitante_nombre='Visitante')
        self.assertEqual((cita.estado, cita.clinica), ('pendiente', self.clinica))
        page = self.client.get(f"/clivora/estado/{r.json()['trackingToken']}")
        self.assertContains(page, 'Pendiente de revisión')
        self.assertEqual(self.client.get('/clivora/estado/no-existe').status_code, 404)
