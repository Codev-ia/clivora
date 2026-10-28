from django.core.management import call_command
from django.test import TestCase

from apps.core.models import Clinica
from apps.expediente.models import (AntecedenteFamiliar, Diagnostico, DiagnosticoCIE, HistoriaClinica,
                                    MedicamentoActual, Pronostico, SeccionModificada)
from apps.pacientes.models import Paciente

from .test_pacientes import make_user


class HistoriaClinicaTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        cls.clinica = Clinica.objects.create(name='Clínica Demo')
        cls.dr = make_user('dra', ['Acceso a Clivora', 'Médicos'], cls.clinica, first_name='Ana', last_name='Ruiz')
        cls.enfermera = make_user('enf', ['Acceso a Clivora', 'Enfermería'], cls.clinica)
        cls.recepcion = make_user('rec', ['Acceso a Clivora', 'Recepción'], cls.clinica)
        cls.externo = make_user('ext', ['Acceso a Clivora', 'Médico Externo'], cls.clinica)
        cls.paciente = Paciente.objects.create(nombres='Paciente', primer_apellido='Prueba', religion='Católica')
        cls.url = f'/clivora/api/patients/{cls.paciente.pk}'

    def setUp(self):
        self.client.force_login(self.dr)

    def post(self, ruta, data):
        return self.client.post(f'{self.url}/{ruta}', data, content_type='application/json')

    def historia(self):
        return self.client.get(self.url).json()['historia_clinica']

    def test_sin_historia_devuelve_solo_religion(self):
        self.assertEqual(self.historia(), {'religion': 'Católica'})

    def test_guardar_y_leer(self):
        reservado = Pronostico.objects.get(name='Reservado')
        r = self.post('historia_clinica', {
            'motivo_consulta': '<p>Dolor <b>abdominal</b></p>', 'smoking': True,
            'smoking_observations': '10 cigarrillos', 'physical_exploration_datetime': '2026-10-25T09:30',
            'forecast_option_id': str(reservado.pk), 'campo_que_no_existe': 'x',
        })
        self.assertEqual(r.json(), {'ok': True})
        hc = self.historia()
        self.assertEqual(hc['motivo_consulta'], '<p>Dolor <b>abdominal</b></p>')
        self.assertIs(hc['smoking'], True)
        self.assertEqual(hc['physical_exploration_datetime'], '2026-10-25T09:30')
        self.assertEqual(hc['forecast_option_id'], reservado.pk)
        self.assertEqual(hc['createdBy'], 'Ana Ruiz')
        self.assertEqual(set(hc['sectionsAudit']), {'1', '8', '9', '10', '12', '13', '15'})

    def test_html_saneado(self):
        self.post('historia_clinica', {'peea_description':
                                       '<p onclick="x()">Hola<script>alert(1)</script><img src=x onerror=y()></p>'
                                       '<span style="color: red; position: fixed">rojo</span>'})
        self.assertEqual(HistoriaClinica.objects.get().peea,
                         '<p>Hola</p><span style="color:red">rojo</span>')

    def test_auditoria_solo_de_secciones_cambiadas(self):
        self.post('historia_clinica', {'motivo_consulta': 'Uno', 'peea_description': 'PEEA'})
        hc = HistoriaClinica.objects.get()
        self.assertEqual(set(hc.secciones.values_list('seccion', flat=True)), {8, 15})
        antes = hc.secciones.get(seccion=15).updated_at
        # Se manda todo el formulario otra vez, solo cambia el motivo.
        self.post('historia_clinica', {'motivo_consulta': 'Dos', 'peea_description': 'PEEA'})
        self.assertEqual(hc.secciones.get(seccion=15).updated_at, antes)
        self.assertGreater(hc.secciones.get(seccion=8).updated_at, antes)
        self.assertEqual(SeccionModificada.objects.count(), 2)

    def test_enfermeria_y_recepcion_solo_lectura(self):
        for user in (self.enfermera, self.recepcion):
            self.client.force_login(user)
            self.assertEqual(self.client.get(self.url).status_code, 200)
            for ruta in ('historia_clinica', 'family_history', 'medications', 'diagnosis_lines'):
                self.assertEqual(self.post(ruta, {'rows': []}).status_code, 403, (user, ruta))
        self.assertFalse(HistoriaClinica.objects.exists())

    def test_medico_externo_solo_sus_pacientes(self):
        self.client.force_login(self.externo)
        self.assertEqual(self.client.get(f'{self.url}/diagnosis_lines').status_code, 404)
        self.assertEqual(self.post('historia_clinica', {'motivo_consulta': 'x'}).status_code, 404)
        self.paciente.doctor_asignado = self.externo
        self.paciente.save()
        self.assertEqual(self.post('historia_clinica', {'motivo_consulta': 'x'}).status_code, 200)

    def test_familiares(self):
        self.post('family_history', {'rows': [{'has_died': True, 'other_diseases': 'Padre: diabetes'},
                                              {'other_diseases': 'Madre'}]})
        filas = self.client.get(f'{self.url}/family_history').json()
        self.assertEqual([(f['has_died'], f['other_diseases']) for f in filas],
                         [(True, 'Padre: diabetes'), (False, 'Madre')])
        # Edita el primero y quita el segundo.
        self.post('family_history', {'rows': [{'id': filas[0]['id'], 'other_diseases': 'Padre: DM2'}]})
        self.assertEqual(list(AntecedenteFamiliar.objects.values_list('pk', 'fallecido', 'descripcion')),
                         [(filas[0]['id'], True, 'Padre: DM2')])
        # Sin familiares queda explícito "Interrogado y Negado".
        self.post('family_history', {'rows': []})
        self.assertEqual(list(AntecedenteFamiliar.objects.values_list('descripcion', flat=True)),
                         ['Interrogado y Negado'])

    def test_medicamentos(self):
        self.post('medications', {'rows': [{'product': 'Metformina 850 mg'}, {'product': '  '}]})
        self.assertEqual([m['product'] for m in self.client.get(f'{self.url}/medications').json()],
                         ['Metformina 850 mg'])
        self.post('medications', {'rows': []})
        self.assertEqual(list(MedicamentoActual.objects.values_list('descripcion', flat=True)),
                         ['Interrogado y no refiere tomar alguno'])

    def test_diagnosticos(self):
        c50 = DiagnosticoCIE.objects.get(catalogo='cie10', codigo='C50')
        self.post('diagnosis_lines', {'rows': [
            {'diagnosis': f'C50 - {c50.nombre}', 'cie11_diagnosis_id': c50.pk, 'comment': 'Mama izquierda'},
            {'diagnosis': '', 'cie11_diagnosis_id': False},  # sin elegir del catálogo: se ignora
            {'diagnosis': 'Otro', 'cie11_diagnosis_id': 999999},
        ]})
        filas = self.client.get(f'{self.url}/diagnosis_lines').json()
        self.assertEqual([(f['cie11_diagnosis_id'], f['comment']) for f in filas],
                         [(c50.pk, 'Mama izquierda'), (False, '')])
        self.assertEqual(list(Diagnostico.objects.values_list('sequence', flat=True)), [0, 10])


class CatalogosTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        clinica = Clinica.objects.create(name='Clínica Demo')
        cls.user = make_user('dra', ['Acceso a Clivora', 'Médicos'], clinica)

    def setUp(self):
        self.client.force_login(self.user)

    def buscar(self, q):
        return [(d['catalog'], d['code']) for d in self.client.get('/clivora/api/cie11/search', {'q': q}).json()]

    def test_catalogo_cargado(self):
        self.assertGreater(DiagnosticoCIE.objects.filter(catalogo='cie10').count(), 14000)
        self.assertTrue(DiagnosticoCIE.objects.filter(catalogo='cie11', codigo='5A11').exists())
        # Volver a cargar no duplica ni cambia nada.
        call_command('cargar_cie', stdout=open('/dev/null', 'w'))
        self.assertEqual(DiagnosticoCIE.objects.filter(catalogo='cie10', codigo='C50').count(), 1)

    def test_cie11_completo_de_la_oms(self):
        cie11 = DiagnosticoCIE.objects.filter(catalogo='cie11', active=True)
        self.assertGreater(cie11.count(), 17000)
        self.assertEqual(cie11.get(codigo='2C60').nombre, 'Carcinoma de la mama, tipo especializado')
        self.assertEqual(cie11.get(codigo='RA01').capitulo, '25 Códigos para propósitos especiales')
        self.assertFalse(cie11.filter(codigo__startswith='X').exists())  # códigos de extensión fuera
        # Un código que ya no viene en el archivo se desactiva, no se borra.
        viejo = DiagnosticoCIE.objects.create(catalogo='cie11', codigo='ZZ99', nombre='Ya no existe')
        call_command('cargar_cie', stdout=open('/dev/null', 'w'))
        viejo.refresh_from_db()
        self.assertFalse(viejo.active)
        self.assertIn('Cáncer del páncreas', cie11.get(codigo='2C10').sinonimos)

    def test_lee_la_tabulacion_de_la_oms(self):
        from apps.expediente.cie import filas_cie11
        encabezado = 'Foundation URI\tLinearization URI\tCode\tBlockId\tTitleEN\tTitle\tClassKind\tChapterNo\n'
        tabulacion = '\ufeff' + encabezado + ''.join('\t'.join(c) + '\n' for c in [
            ('', '', '', '', '"Neoplasms"', '"Neoplasias"', 'chapter', '02'),
            ('', '', '2C10', '', '"- - Malignant neoplasm of pancreas"', '"- - Neoplasia maligna del páncreas"', 'category', '02'),
            ('', '', '', 'BlockL1-2A0', '"- Block"', '"- Bloque"', 'block', '02'),
            ('', '', 'QA47.6', '', '"- Multiple born in hospital"', '', 'category', '24'),
            ('', '', 'XA0060', '', '"- Sterile matrix"', '"- Matriz estéril"', 'category', 'X'),
        ])
        self.assertEqual(filas_cie11(tabulacion), [
            {'code': '2C10', 'name': 'Neoplasia maligna del páncreas', 'chapter': '02 Neoplasias'},
            {'code': 'QA47.6', 'name': 'Multiple born in hospital', 'chapter': '24'},  # sin traducción: en inglés
        ])

    def test_buscador(self):
        self.assertEqual(self.buscar('diabetis tipo 2')[0], ('cie11', '5A11'))  # con falta de ortografía
        self.assertEqual(self.buscar('C50')[0], ('cie10', 'C50'))
        self.assertIn(('cie10', 'C34'), self.buscar('cáncer pulmón'))  # sinónimo de "Tumor maligno"
        self.assertIn(('cie11', '2C82'), self.buscar('cancer de prostata'))  # sinónimo de "Neoplasia maligna"
        self.assertEqual(self.buscar('zzzzqqq'), [])
        self.assertTrue(all(c == 'cie11' for c, _ in self.buscar('')))

    def test_catalogos_hc(self):
        data = self.client.get('/clivora/api/hc/catalogs').json()
        self.assertEqual([p['name'] for p in data['forecast_options']],
                         ['Favorable', 'Reservado', 'Desfavorable', 'Ligado a evolución'])


class FechaCreacionTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        call_command('seed_roles', stdout=open('/dev/null', 'w'))
        clinica = Clinica.objects.create(name='Clínica Demo')
        cls.con_permiso = make_user('jefa', ['Acceso a Clivora', 'Médicos', 'Historial Médico: Editar Fecha de Creación'], clinica)
        cls.sin_permiso = make_user('dra', ['Acceso a Clivora', 'Médicos'], clinica)
        cls.hc = HistoriaClinica.objects.create(paciente=Paciente.objects.create(nombres='P'))
        cls.url = f'/clivora/api/historial/historia_clinica/{cls.hc.pk}/create_date'

    def test_corregir_fecha(self):
        self.client.force_login(self.sin_permiso)
        self.assertEqual(self.client.post(self.url, {'create_date': '2026-01-05T08:00'}, content_type='application/json').status_code, 403)
        self.client.force_login(self.con_permiso)
        r = self.client.post(self.url, {'create_date': '2026-01-05T08:00'}, content_type='application/json')
        self.assertEqual(r.json(), {'create_date': '2026-01-05T08:00:00'})
        self.hc.refresh_from_db()
        self.assertEqual(self.hc.created_at.year, 2026)
        r = self.client.post('/clivora/api/historial/res.partner/1/create_date', {'create_date': '2026-01-05T08:00'}, content_type='application/json')
        self.assertEqual(r.status_code, 400)
