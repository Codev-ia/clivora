from django.core.management import call_command
from django.test import TestCase

from apps.core.models import Clinica
from apps.expediente.models import NotaEnfermeria, SignosVitales, SignoVitalEnfermeria
from apps.pacientes.models import Paciente

from .test_pacientes import make_user

REGISTRO = {
    'nursingNoteKind': 'clinical_record',
    'admissionWeightKg': 70, 'admissionHeightCm': 170, 'admissionTreatmentCycle': 'Ciclo 2',
    'admissionAllergiesNote': '', 'admissionIsolation': 'contacto',
    'painScale': '3', 'downtonScore': 2, 'ecogNumber': '1', 'karnofskyNumber': '80',
    'glasgowMotor': 6, 'glasgowVerbal': 5, 'glasgowOcular': 4, 'glasgowResult': 15,
    'previous_falls_downton': True, 'sedatives_downton': False,
    'comentarios': '<p>Paciente estable<script>x()</script></p>',
    'nauseaScale': '2', 'mucositisScale': '9', 'functionalFatigueScale': '8', 'neutropeniaScale': '0',
    'labHemoglobin': 12.5, 'labLeukocytes': 5400, 'labPlatelets': 250000, 'labNeutrophils': 3000,
    'systemsConsciousness': 'alerta', 'systemsMood': 'ansioso', 'systemsSkin': 'integra',
    'systemsObservations': 'Sin cambios', 'evaPainLevel': 3, 'evaCharacteristics': 'punzante',
    'evaLocation': 'Brazo "izq" <b>', 'evaIntervention': 'Paracetamol',
    'fallPreventionBell': False,
    'dischargeMedicationsNote': 'Filgrastim 300 mcg\nOndansetrón 8 mg',
    'nurseResponsible1': 'Enf. Ana', 'dischargeTime': '14:30',
    'newsVitals': {'time': '09:00', 'fc': 80, 'pas': 120, 'pad': 80, 'fr': 16, 'temp': 36.6, 'sat': 97,
                   'consciousness': 'A', 'newsScore': 1},
    'vitalSignsCaptureTime': '09:00',
    'manualVitalSigns': [{'hora': '10:00', 'pas': 118, 'pad': 76, 'fc': 78, 'fr': 16, 'temp': 36.5, 'sat': 98}],
    'appliedMedications': [{'medicationName': 'Ondansetrón', 'doseText': '8 mg', 'route': 'IV', 'time': '09:10',
                            'doubleCheckVerification1': 'Ana', 'doubleCheckVerification2': 'Luis'},
                           {'medicationName': ''}],
}


class NotasTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.clinica = Clinica.objects.create(name='Clínica Demo')
        cls.enfermera = make_user('enf', ['Acceso a Clivora', 'Enfermería'], cls.clinica, first_name='Ana')
        cls.recepcion = make_user('rec', ['Acceso a Clivora', 'Recepción'], cls.clinica)
        cls.externo = make_user('ext', ['Acceso a Clivora', 'Médico Externo'], cls.clinica)
        cls.paciente = Paciente.objects.create(nombres='Paciente', primer_apellido='Prueba')
        cls.base = f'/clivora/api/patients/{cls.paciente.pk}/consultations'

    def setUp(self):
        self.client.force_login(self.enfermera)

    def post(self, url, data):
        return self.client.post(url, data, content_type='application/json')

    def test_signos_vitales(self):
        r = self.post(f'{self.base}/vitals', {'sistolica': '120', 'diastolica': '80', 'fc': '72', 'fr': '',
                                              'temperatura': '36.5', 'saturacion': '98', 'peso': '70',
                                              'altura': '170', 'comentarios': '<b>Bien</b>'})
        data = r.json()
        self.assertEqual(data['source'], 'vitals')
        self.assertEqual((data['sistolica'], data['fr'], data['createdBy']), (120, '', 'Ana'))
        self.assertEqual((data['bsa'], data['imc']), ('1.81 m²', '24.22 kg/m²'))
        pk = int(data['id'][2:])
        data = self.post(f'/clivora/api/consultations/vitals/{pk}', {'sistolica': 130, 'peso': '', 'altura': 170}).json()
        self.assertEqual((data['sistolica'], data['bsa'], data['imc']), (130, '', ''))

    def test_evaluacion_inicial(self):
        r = self.post(f'{self.base}/nursing', {
            'nursingNoteKind': 'initial_assessment', 'comentarios': 'Ingreso', 'admissionAllergiesNote': '',
            'assessmentAnswers': [
                {'pattern': 'Eliminación', 'question': '¿Alteraciones urinarias?', 'answer': 'si', 'detail': 'Disuria'},
                {'pattern': 'Sueño', 'question': '¿Insomnio?', 'answer': 'quizá'},
                {'pattern': '', 'question': 'sin patrón'},
            ]})
        data = r.json()
        self.assertEqual(data['titulo'], 'Evaluación Inicial de Enfermería')
        self.assertEqual(data['admissionAllergiesNote'], 'Sin alergias conocidas')
        self.assertEqual([(a['answer'], a['detail']) for a in data['assessmentAnswers']], [('si', 'Disuria'), ('no', '')])
        self.assertNotIn('newsVitals', data)
        preguntas = self.client.get('/clivora/api/nursing/assessment_questions').json()
        self.assertEqual(len(preguntas), 20)

    def test_registro_clinico(self):
        data = self.post(f'{self.base}/nursing', REGISTRO).json()
        self.assertEqual(data['titulo'], 'Registro Clínico de Enfermería')
        self.assertEqual(data['comentarios'], '<p>Paciente estable</p>')
        self.assertEqual(data['mucositisScale'], '0')  # opción inválida → valor por omisión
        self.assertEqual(data['evaLocation'], 'Brazo izq b')
        self.assertEqual((data['previous_falls_downton'], data['fallPreventionBell'], data['fallPreventionBrake']),
                         (True, False, True))
        self.assertEqual(data['newsVitals']['newsScore'], 1)
        self.assertEqual(len(data['manualVitalSigns']), 1)
        self.assertEqual([m['medicationName'] for m in data['appliedMedications']], ['Ondansetrón'])
        self.assertEqual(data['dischargeMedicationsNote'], 'Filgrastim 300 mcg\nOndansetrón 8 mg')

        # Edición parcial: solo cambia lo que viene; las tablas se sincronizan.
        pk = int(data['id'][2:])
        med = data['appliedMedications'][0]
        data = self.post(f'/clivora/api/consultations/nursing/{pk}', {
            'comentarios': 'Egreso sin incidencias', 'painScale': 0,
            'appliedMedications': [{**med, 'doseText': '4 mg'}, {'medicationName': 'Paracetamol'}],
            'manualVitalSigns': [],
        }).json()
        self.assertEqual((data['comentarios'], data['painScale'], data['ecogNumber']), ('Egreso sin incidencias', '', 1))
        self.assertEqual([(m['medicationName'], m['doseText']) for m in data['appliedMedications']],
                         [('Ondansetrón', '4 mg'), ('Paracetamol', '')])
        self.assertEqual(data['appliedMedications'][0]['id'], med['id'])
        self.assertEqual(data['manualVitalSigns'], [])
        self.assertEqual(SignoVitalEnfermeria.objects.filter(tipo='news').count(), 1)

    def test_lista_y_borrado(self):
        self.post(f'{self.base}/vitals', {'sistolica': 110})
        self.post(f'{self.base}/nursing', REGISTRO)
        lista = self.client.get(self.base).json()
        self.assertEqual([c['source'] for c in lista], ['nursing', 'vitals'])  # la más reciente primero
        nota_id = int(lista[0]['id'][2:])
        self.assertEqual(self.client.post(f'/clivora/api/consultations/nursing/{nota_id}/delete').json(), {'ok': True})
        self.assertFalse(NotaEnfermeria.objects.exists())
        self.assertEqual(self.client.post('/clivora/api/consultations/oncology/1/delete').status_code, 400)

    def test_recepcion_solo_lectura(self):
        self.post(f'{self.base}/vitals', {'sistolica': 110})
        signos = SignosVitales.objects.get()
        self.client.force_login(self.recepcion)
        self.assertEqual(len(self.client.get(self.base).json()), 1)
        self.assertEqual(self.post(f'{self.base}/vitals', {'sistolica': 1}).status_code, 403)
        self.assertEqual(self.post(f'{self.base}/nursing', REGISTRO).status_code, 403)
        self.assertEqual(self.post(f'/clivora/api/consultations/vitals/{signos.pk}', {}).status_code, 403)
        self.assertEqual(self.client.post(f'/clivora/api/consultations/vitals/{signos.pk}/delete').status_code, 403)
        self.assertFalse(self.client.get('/clivora/api/me').json()['canEditNursingVitals'])

    def test_medico_externo_solo_sus_pacientes(self):
        self.post(f'{self.base}/vitals', {'sistolica': 110})
        self.client.force_login(self.externo)
        self.assertEqual(self.client.get(self.base).status_code, 404)
        signos = SignosVitales.objects.get()
        self.assertEqual(self.post(f'/clivora/api/consultations/vitals/{signos.pk}', {}).status_code, 404)

    def test_actividad_del_mes_y_fecha_de_creacion(self):
        self.post(f'{self.base}/vitals', {'sistolica': 110})
        actividad = self.client.get('/clivora/api/dashboard/patient_activity').json()
        self.assertEqual((actividad['vitalsPatientIds'], actividad['nursingPatientIds']), ([self.paciente.pk], []))
        admin = make_user('admin2', ['Acceso a Clivora', 'Administrador'], self.clinica)
        self.client.force_login(admin)
        signos = SignosVitales.objects.get()
        r = self.post(f'/clivora/api/historial/signos_vitales/{signos.pk}/create_date', {'create_date': '2026-01-05T08:00'})
        self.assertEqual(r.status_code, 200)
        signos.refresh_from_db()
        self.assertEqual(signos.created_at.month, 1)


class NotaOncologiaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        from apps.expediente.models import DiagnosticoCIE
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.clinica = Clinica.objects.create(name='Clínica Demo')
        cls.dra = make_user('dra', ['Acceso a Clivora', 'Médicos'], cls.clinica, first_name='Ana', last_name='Ruiz')
        cls.recepcion = make_user('rec', ['Acceso a Clivora', 'Recepción'], cls.clinica)
        cls.jefe = make_user('jefe', ['Acceso a Clivora', 'Jefe de Admisiones/Recepción'], cls.clinica)
        cls.paciente = Paciente.objects.create(nombres='Paciente', primer_apellido='Prueba', doctor_asignado=cls.dra)
        cls.base = f'/clivora/api/patients/{cls.paciente.pk}/consultations'
        cls.c50 = DiagnosticoCIE.objects.get(catalogo='cie10', codigo='C50')

    def setUp(self):
        self.client.force_login(self.dra)

    def post(self, url, data):
        return self.client.post(url, data, content_type='application/json')

    def nota(self, **extra):
        return {
            'admissionDatetime': '2026-10-26T09:30', 'treatmentCycle': 'Ciclo 3 de 6', 'allergiesNote': '',
            'analisis': '<p>Paciente <b>estable</b><img src=x onerror=alert(1)></p>',
            'indicaciones': 'Control en 21 días\n<Hidratación oral>',
            'diagnosticos': [{'codigo': f'C50 - {self.c50.nombre}', 'tipo': 'Principal', 'comment': 'Mama izq',
                              'cie11_diagnosis_id': self.c50.pk},
                             {'codigo': '', 'tipo': 'Secundario'}],
            'recetas': [{'nombre': 'Ondansetrón 8 mg', 'indicaciones': 'Cada 8 h', 'notas': ''}, {'nombre': ''}],
            **extra,
        }

    def test_crear_editar_y_listar(self):
        data = self.post(f'{self.base}/oncology', self.nota()).json()
        self.assertEqual((data['source'], data['medico'], data['allergiesNote']),
                         ('consultation', 'Ana Ruiz', 'Sin alergias conocidas'))
        self.assertEqual(data['admissionDatetime'], '2026-10-26T09:30')
        self.assertEqual(data['analisis'], '<p>Paciente <b>estable</b></p>')
        self.assertEqual(data['indicaciones'], 'Control en 21 días<br>&lt;Hidratación oral&gt;')
        self.assertEqual([(d['tipo'], d['cie11_diagnosis_id']) for d in data['diagnosticos']], [('Principal', self.c50.pk)])
        self.assertEqual([r['nombre'] for r in data['recetas']], ['Ondansetrón 8 mg'])

        # Edición parcial: lo que no viene (recetas) se conserva.
        data = self.post(f"/clivora/api/consultations/oncology/{data['consultation_id']}",
                         {'treatmentCycle': 'Ciclo 4 de 6', 'diagnosticos': []}).json()
        self.assertEqual((data['treatmentCycle'], data['diagnosticos'], len(data['recetas'])), ('Ciclo 4 de 6', [], 1))
        self.assertEqual(data['indicaciones'], 'Control en 21 días<br>&lt;Hidratación oral&gt;')
        lista = self.client.get(self.base).json()
        self.assertEqual([c['id'] for c in lista], [data['id']])
        actividad = self.client.get('/clivora/api/dashboard/patient_activity').json()
        self.assertEqual(actividad['oncologyPatientIds'], [self.paciente.pk])

    def test_permisos_de_recepcion(self):
        data = self.post(f'{self.base}/oncology', self.nota()).json()
        self.client.force_login(self.recepcion)
        self.assertEqual(self.post(f'{self.base}/oncology', self.nota()).status_code, 403)
        url = f"/clivora/api/consultations/oncology/{data['consultation_id']}"
        self.assertEqual(self.post(url, {}).status_code, 403)
        self.assertEqual(self.client.post(f"/clivora/api/consultations/consultation/{data['consultation_id']}/delete").status_code, 403)
        # El Jefe de Recepción sí puede (como en el sistema anterior).
        self.client.force_login(self.jefe)
        self.assertEqual(self.post(url, {'treatmentCycle': 'Ciclo 5'}).status_code, 200)
        self.assertEqual(self.client.post(f"/clivora/api/consultations/consultation/{data['consultation_id']}/delete").json(), {'ok': True})
