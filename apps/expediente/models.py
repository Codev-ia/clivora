"""Expediente clínico: Historia Clínica y diagnósticos (CIE-10 / CIE-11).

Solo lo que captura la pantalla de Historia Clínica de Clivora. Los textos
largos guardan el HTML del editor enriquecido (ya saneado, ver html.py).
"""
from django.conf import settings
from django.contrib.postgres.indexes import GinIndex
from django.db import models

from apps.core.models import TimeStampedModel

from .cie import normalizar


class Pronostico(models.Model):
    """Catálogo de pronóstico del Plan de Tratamiento (Favorable, Reservado…)."""

    name = models.CharField('nombre', max_length=80, unique=True)
    sequence = models.PositiveIntegerField('orden', default=10)
    active = models.BooleanField('activo', default=True)

    class Meta:
        verbose_name = 'pronóstico'
        verbose_name_plural = 'pronósticos'
        ordering = ['sequence', 'id']

    def __str__(self):
        return self.name


class DiagnosticoCIE(models.Model):
    """Catálogo de diagnósticos: CIE-10 (edición de la OPS, la que usa México)
    y CIE-11 (OMS). Comparten tabla para que el buscador y las líneas de
    diagnóstico funcionen igual con los dos."""

    CATALOGOS = [('cie10', 'CIE-10'), ('cie11', 'CIE-11')]

    catalogo = models.CharField('catálogo', max_length=5, choices=CATALOGOS, default='cie11', db_index=True)
    codigo = models.CharField('código', max_length=20, db_index=True)
    nombre = models.CharField('descripción', max_length=500)
    capitulo = models.CharField('capítulo', max_length=250, blank=True)
    sinonimos = models.TextField('sinónimos', blank=True, help_text='Otros nombres del diagnóstico, uno por renglón.')
    active = models.BooleanField('activo', default=True)
    # Texto normalizado (sin acentos ni signos, ver cie.normalizar) para el
    # buscador: búsqueda tolerante a faltas de ortografía con pg_trgm.
    search_name = models.CharField(max_length=600, editable=False)
    search_text = models.TextField(editable=False)

    class Meta:
        verbose_name = 'diagnóstico CIE'
        verbose_name_plural = 'catálogo CIE'
        ordering = ['catalogo', 'codigo']
        constraints = [models.UniqueConstraint(fields=['catalogo', 'codigo'], name='cie_codigo_unico')]
        indexes = [GinIndex(fields=['search_text'], name='cie_search_trgm', opclasses=['gin_trgm_ops'])]

    def __str__(self):
        return f'{self.codigo} - {self.nombre}'

    def save(self, *args, **kwargs):
        self.calcular_busqueda()
        super().save(*args, **kwargs)

    def calcular_busqueda(self):
        self.search_name = normalizar(f'{self.codigo} {self.nombre}')
        self.search_text = normalizar(f'{self.codigo} {self.nombre} {self.sinonimos}')


class HistoriaClinica(TimeStampedModel):
    """Historia Clínica del paciente (una por paciente)."""

    # Secciones de la pantalla con su propia "Última modificación": cuál
    # campo pertenece a cuál tarjeta (mismos números que el frontend).
    SECCIONES = {
        1: ('antecedentes_importantes', 'no_patologicos',
            'tabaquismo', 'tabaquismo_obs', 'vapeo', 'vapeo_obs', 'humo_pasivo', 'humo_pasivo_obs',
            'alcoholismo', 'alcoholismo_obs', 'drogas', 'drogas_obs', 'alergias', 'alergias_obs',
            'cirugias', 'cirugias_obs', 'transfusiones', 'transfusiones_obs',
            'reproductivos', 'reproductivos_obs', 'otras_enfermedades', 'gineco', 'gineco_obs'),
        8: ('motivo_consulta',),
        9: ('respiratorio', 'endocrino', 'piel_anexos', 'cardiovascular', 'musculoesqueletico',
            'digestivo', 'genitourinario', 'aparatos_comentarios'),
        10: ('exploracion_cabeza', 'exploracion_cuello', 'exploracion_torax', 'exploracion_abdomen',
             'exploracion_genitales', 'exploracion_extremidades', 'exploracion_fecha'),
        15: ('peea',),
        12: ('analisis',),
        13: ('plan_tratamiento', 'pronostico'),
    }

    paciente = models.OneToOneField('pacientes.Paciente', on_delete=models.CASCADE, related_name='historia_clinica')

    antecedentes_importantes = models.TextField('antecedentes importantes', blank=True)
    motivo_consulta = models.TextField('motivo de consulta', blank=True)

    # Antecedentes no patológicos y patológicos: cada uno con su switch
    # ("Interrogado y Negado" cuando está apagado) y sus observaciones.
    no_patologicos = models.TextField('antecedentes no patológicos', blank=True)
    tabaquismo = models.BooleanField('tabaquismo', default=False)
    tabaquismo_obs = models.TextField('observaciones de tabaquismo', blank=True)
    vapeo = models.BooleanField('vapeo', default=False)
    vapeo_obs = models.TextField('observaciones de vapeo', blank=True)
    humo_pasivo = models.BooleanField('exposición pasiva a humo', default=False)
    humo_pasivo_obs = models.TextField('observaciones de exposición a humo', blank=True)
    alcoholismo = models.BooleanField('alcoholismo', default=False)
    alcoholismo_obs = models.TextField('observaciones de alcoholismo', blank=True)
    drogas = models.BooleanField('consumo de drogas', default=False)
    drogas_obs = models.TextField('observaciones de drogas', blank=True)
    alergias = models.BooleanField('alergias', default=False)
    alergias_obs = models.TextField('observaciones de alergias', blank=True)
    cirugias = models.BooleanField('cirugías', default=False)
    cirugias_obs = models.TextField('observaciones de cirugías', blank=True)
    transfusiones = models.BooleanField('transfusiones', default=False)
    transfusiones_obs = models.TextField('observaciones de transfusiones', blank=True)
    reproductivos = models.BooleanField('antecedentes reproductivos', default=False)
    reproductivos_obs = models.TextField('observaciones reproductivas', blank=True)
    otras_enfermedades = models.TextField('otras enfermedades', blank=True)
    gineco = models.BooleanField('antecedentes gineco-obstétricos', default=False)
    gineco_obs = models.TextField('gineco-obstétricos', blank=True)

    # Interrogatorio por aparatos y sistemas
    respiratorio = models.TextField('respiratorio', blank=True)
    endocrino = models.TextField('endocrino', blank=True)
    piel_anexos = models.TextField('piel y anexos', blank=True)
    cardiovascular = models.TextField('cardiovascular', blank=True)
    musculoesqueletico = models.TextField('musculoesquelético', blank=True)
    digestivo = models.TextField('digestivo', blank=True)
    genitourinario = models.TextField('genitourinario', blank=True)
    aparatos_comentarios = models.TextField('comentarios generales', blank=True)

    # Exploración física
    exploracion_fecha = models.DateTimeField('fecha y hora de la exploración', null=True, blank=True)
    exploracion_cabeza = models.TextField('cabeza', blank=True)
    exploracion_cuello = models.TextField('cuello', blank=True)
    exploracion_torax = models.TextField('tórax', blank=True)
    exploracion_abdomen = models.TextField('abdomen', blank=True)
    exploracion_genitales = models.TextField('genitales', blank=True)
    exploracion_extremidades = models.TextField('extremidades', blank=True)

    peea = models.TextField('principio, evolución y estado actual (PEEA)', blank=True)
    analisis = models.TextField('análisis', blank=True)
    plan_tratamiento = models.TextField('plan de tratamiento', blank=True)
    pronostico = models.ForeignKey(Pronostico, null=True, blank=True, on_delete=models.PROTECT,
                                   verbose_name='pronóstico')

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='creado por')
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='modificado por')

    class Meta:
        verbose_name = 'historia clínica'
        verbose_name_plural = 'historias clínicas'

    def __str__(self):
        return f'Historia clínica de {self.paciente}'


class SeccionModificada(models.Model):
    """Quién y cuándo cambió por última vez algo de una sección de la
    Historia Clínica (la pantalla manda el formulario completo en cada
    guardado; solo se marcan las secciones donde de verdad cambió algo)."""

    historia = models.ForeignKey(HistoriaClinica, on_delete=models.CASCADE, related_name='secciones')
    seccion = models.PositiveSmallIntegerField('sección')
    updated_at = models.DateTimeField('modificado')
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='modificado por')

    class Meta:
        verbose_name = 'modificación de sección'
        verbose_name_plural = 'modificaciones de sección'
        constraints = [models.UniqueConstraint(fields=['historia', 'seccion'], name='hc_seccion_unica')]


class AntecedenteFamiliar(TimeStampedModel):
    """Antecedentes heredofamiliares: un renglón por familiar."""

    paciente = models.ForeignKey('pacientes.Paciente', on_delete=models.CASCADE, related_name='antecedentes_familiares')
    fallecido = models.BooleanField('fallecido', default=False)
    descripcion = models.TextField('descripción del familiar', blank=True)

    class Meta:
        verbose_name = 'antecedente heredofamiliar'
        verbose_name_plural = 'antecedentes heredofamiliares'
        ordering = ['id']


class MedicamentoActual(TimeStampedModel):
    """Medicamentos que el paciente toma actualmente (texto libre)."""

    paciente = models.ForeignKey('pacientes.Paciente', on_delete=models.CASCADE, related_name='medicamentos_actuales')
    descripcion = models.TextField('medicamento')

    class Meta:
        verbose_name = 'medicamento actual'
        verbose_name_plural = 'medicamentos actuales'
        ordering = ['id']


class Diagnostico(TimeStampedModel):
    """Diagnósticos del paciente (Análisis y Diagnóstico), elegidos del
    catálogo CIE."""

    paciente = models.ForeignKey('pacientes.Paciente', on_delete=models.CASCADE, related_name='diagnosticos')
    cie = models.ForeignKey(DiagnosticoCIE, null=True, blank=True, on_delete=models.PROTECT,
                            related_name='+', verbose_name='diagnóstico CIE')
    diagnostico = models.CharField('diagnóstico', max_length=520)
    comentario = models.CharField('comentario', max_length=500, blank=True)
    sequence = models.PositiveIntegerField('orden', default=0)

    class Meta:
        verbose_name = 'diagnóstico'
        verbose_name_plural = 'diagnósticos'
        ordering = ['sequence', 'id']

    def __str__(self):
        return self.diagnostico


# ── Notas: signos vitales y enfermería ────────────────────────────────────

class NotaBase(TimeStampedModel):
    """Lo común a las notas del expediente (pestaña Notas)."""

    paciente = models.ForeignKey('pacientes.Paciente', on_delete=models.CASCADE, related_name='+')
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='creado por')
    updated_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='modificado por')

    class Meta:
        abstract = True
        ordering = ['-created_at']


class SignosVitales(NotaBase):
    sistolica = models.PositiveSmallIntegerField('presión sistólica', default=0)
    diastolica = models.PositiveSmallIntegerField('presión diastólica', default=0)
    fc = models.PositiveSmallIntegerField('frecuencia cardiaca', default=0)
    fr = models.PositiveSmallIntegerField('frecuencia respiratoria', default=0)
    temperatura = models.FloatField('temperatura (°C)', default=0)
    saturacion = models.PositiveSmallIntegerField('saturación de oxígeno (%)', default=0)
    peso = models.FloatField('peso (kg)', default=0)
    talla = models.FloatField('talla (cm)', default=0)
    superficie_corporal = models.FloatField('superficie corporal (m²)', default=0, editable=False)
    imc = models.FloatField('IMC (kg/m²)', default=0, editable=False)
    comentarios = models.TextField('comentarios', blank=True)

    class Meta(NotaBase.Meta):
        verbose_name = 'signos vitales'
        verbose_name_plural = 'signos vitales'

    def save(self, *args, **kwargs):
        # Superficie corporal (DuBois) e índice de masa corporal.
        if self.peso and self.talla:
            self.superficie_corporal = 0.007184 * (self.peso ** 0.425) * (self.talla ** 0.725)
            self.imc = self.peso / ((self.talla / 100) ** 2)
        else:
            self.superficie_corporal = self.imc = 0
        super().save(*args, **kwargs)


class NotaEnfermeria(NotaBase):
    """Evaluación Inicial de Enfermería (valoración por patrones funcionales)
    o Registro Clínico de Enfermería (seguimiento/egreso). Los campos de
    escalas, laboratorio, sistemas, EVA y firmas solo los usa el registro
    clínico."""

    VALORACION_INICIAL = 'initial_assessment'
    REGISTRO_CLINICO = 'clinical_record'
    TIPOS = [(VALORACION_INICIAL, 'Evaluación Inicial de Enfermería'), (REGISTRO_CLINICO, 'Registro Clínico de Enfermería')]
    AISLAMIENTO = [('ninguno', 'Ninguno'), ('contacto', 'Contacto'), ('gotas', 'Gotas'), ('aereo', 'Aéreo'),
                   ('protector', 'Protector')]
    NAUSEA = [(str(i), str(i)) for i in range(6)]
    GRADO_0_4 = [(str(i), str(i)) for i in range(5)]
    FATIGA = [(v, v) for v in ('10', '8', '6', '4', '2')]
    CONCIENCIA = [(v, v) for v in ('alerta', 'orientado_3_esferas', 'lenguaje_claro', 'sigue_instrucciones',
                                   'moviliza_extremidades', 'somnoliento', 'confuso', 'otro')]
    ANIMO = [(v, v) for v in ('tranquilo', 'triste', 'euforico', 'ansioso', 'agresivo', 'deprimido', 'otro')]
    URINARIO = [(v, v) for v in ('espontaneo', 'incontinencia_urinaria', 'disuria', 'retencion', 'hematuria',
                                 'sonda', 'otro')]
    GASTRO = [(v, v) for v in ('normal', 'estrenimiento', 'incontinencia_gi', 'diarrea', 'nausea', 'vomitos',
                               'anorexia', 'distension', 'otro')]
    CARDIO = [(v, v) for v in ('normal', 'palpitaciones', 'disnea', 'parestesias', 'neuropatias', 'edema', 'tos',
                               'otro')]
    PIEL = [(v, v) for v in ('integra', 'deshidratada', 'ictericia', 'palidez', 'hiperpigmentacion', 'dermatitis',
                             'alopecia', 'mucositis', 'heridas', 'rash', 'otro')]
    EVA = [(v, v) for v in ('sin_dolor', 'colico', 'quemante', 'opresivo', 'punzante', 'sordo')]

    tipo = models.CharField('tipo', max_length=20, choices=TIPOS, default=REGISTRO_CLINICO)
    reporte = models.TextField('reporte de enfermería', blank=True)

    # Datos de ingreso
    peso_kg = models.FloatField('peso (kg)', default=0)
    talla_cm = models.FloatField('talla (cm)', default=0)
    ciclo = models.CharField('ciclo de tratamiento', max_length=120, blank=True)
    alergias = models.CharField('alergias', max_length=500, blank=True, default='Sin alergias conocidas')
    piso_suite = models.CharField('piso / suite', max_length=120, blank=True)
    aislamiento = models.CharField('aislamiento', max_length=10, choices=AISLAMIENTO, default='ninguno')
    modalidad_atencion = models.CharField('modalidad de atención', max_length=120, blank=True)

    # Escalas
    dolor = models.PositiveSmallIntegerField('escala de dolor', default=0)
    downton = models.PositiveSmallIntegerField('escala de Downton', default=0)
    ecog = models.PositiveSmallIntegerField('ECOG', default=0)
    karnofsky = models.PositiveSmallIntegerField('Karnofsky', default=0)
    glasgow_motor = models.PositiveSmallIntegerField('Glasgow: respuesta motora', default=0)
    glasgow_verbal = models.PositiveSmallIntegerField('Glasgow: respuesta verbal', default=0)
    glasgow_ocular = models.PositiveSmallIntegerField('Glasgow: apertura ocular', default=0)
    glasgow_total = models.PositiveSmallIntegerField('Glasgow: total', default=0)
    # Factores de riesgo de caídas (Downton)
    caidas_previas = models.BooleanField('caídas previas', default=False)
    sedantes = models.BooleanField('sedantes', default=False)
    diureticos = models.BooleanField('diuréticos', default=False)
    antihipertensivos = models.BooleanField('antihipertensivos', default=False)
    antiparkinsonianos = models.BooleanField('antiparkinsonianos', default=False)
    antidepresivos = models.BooleanField('antidepresivos', default=False)
    desorientado = models.BooleanField('desorientado', default=False)
    deficit_visual = models.BooleanField('déficit visual', default=False)
    deficit_auditivo = models.BooleanField('déficit auditivo', default=False)
    deficit_extremidades = models.BooleanField('déficit en extremidades', default=False)
    marcha_segura_con_ayuda = models.BooleanField('marcha segura con ayuda', default=False)
    marcha_insegura = models.BooleanField('marcha insegura con o sin ayuda', default=False)
    marcha_imposible = models.BooleanField('marcha imposible', default=False)
    # Escalas especializadas
    nausea = models.CharField('náusea', max_length=2, choices=NAUSEA, default='0')
    mucositis = models.CharField('mucositis', max_length=2, choices=GRADO_0_4, default='0')
    fatiga = models.CharField('fatiga funcional', max_length=2, choices=FATIGA, default='10')
    neutropenia = models.CharField('neutropenia', max_length=2, choices=GRADO_0_4, default='0')
    # Laboratorio
    hemoglobina = models.FloatField('hemoglobina', default=0)
    leucocitos = models.PositiveIntegerField('leucocitos', default=0)
    plaquetas = models.PositiveIntegerField('plaquetas', default=0)
    neutrofilos = models.PositiveIntegerField('neutrófilos', default=0)
    # Aparatos y sistemas
    conciencia = models.CharField('estado de conciencia', max_length=25, choices=CONCIENCIA, default='alerta')
    animo = models.CharField('estado de ánimo', max_length=15, choices=ANIMO, default='tranquilo')
    urinario = models.CharField('urinario', max_length=25, choices=URINARIO, default='espontaneo')
    gastrointestinal = models.CharField('gastrointestinal', max_length=20, choices=GASTRO, default='normal')
    cardiorrespiratorio = models.CharField('cardiorrespiratorio', max_length=15, choices=CARDIO, default='normal')
    piel = models.CharField('piel', max_length=20, choices=PIEL, default='integra')
    sistemas_observaciones = models.TextField('observaciones de aparatos y sistemas', blank=True)
    # Dolor (EVA)
    eva_nivel = models.PositiveSmallIntegerField('EVA: nivel', default=0)
    eva_caracteristicas = models.CharField('EVA: características', max_length=10, choices=EVA, default='sin_dolor')
    eva_localizacion = models.TextField('EVA: localización', blank=True)
    eva_intervencion = models.TextField('EVA: intervención', blank=True)
    # Prevención de caídas
    barandales = models.BooleanField('barandales arriba', default=True)
    freno = models.BooleanField('freno puesto', default=True)
    brazalete_azul = models.BooleanField('brazalete azul', default=True)
    timbre = models.BooleanField('timbre al alcance', default=True)
    # Egreso y firmas
    medicamentos_egreso = models.TextField('medicamentos entregados al egreso', blank=True)
    enfermera_1 = models.CharField('enfermera responsable 1', max_length=150, blank=True)
    enfermera_2 = models.CharField('enfermera responsable 2', max_length=150, blank=True)
    hora_egreso = models.CharField('hora de egreso', max_length=10, blank=True)
    hora_signos = models.CharField('hora de captura de signos vitales', max_length=10, blank=True)

    class Meta(NotaBase.Meta):
        verbose_name = 'nota de enfermería'
        verbose_name_plural = 'notas de enfermería'

    @property
    def titulo(self):
        return dict(self.TIPOS)[self.tipo]


class RespuestaValoracion(models.Model):
    """Respuesta de la Evaluación Inicial de Enfermería (patrones funcionales
    de salud de Marjory Gordon)."""

    RESPUESTAS = [('si', 'Sí'), ('no', 'No'), ('na', 'No aplica')]

    nota = models.ForeignKey(NotaEnfermeria, on_delete=models.CASCADE, related_name='respuestas')
    patron = models.CharField('patrón', max_length=120)
    pregunta = models.CharField('pregunta', max_length=250)
    respuesta = models.CharField('respuesta', max_length=2, choices=RESPUESTAS, default='no')
    detalle = models.CharField('detalle', max_length=500, blank=True)

    class Meta:
        verbose_name = 'respuesta de valoración'
        verbose_name_plural = 'respuestas de valoración'
        ordering = ['id']


class SignoVitalEnfermeria(models.Model):
    """Signos vitales dentro del Registro Clínico de Enfermería: la lectura de
    la escala NEWS (una por nota) y las tomas adicionales (varias)."""

    NEWS = 'news'
    MANUAL = 'manual'
    TIPOS = [(NEWS, 'Escala NEWS'), (MANUAL, 'Toma adicional')]
    CONCIENCIA = [('A', 'Alerta'), ('V', 'Responde a la voz'), ('P', 'Responde al dolor'), ('U', 'No responde')]

    nota = models.ForeignKey(NotaEnfermeria, on_delete=models.CASCADE, related_name='signos')
    tipo = models.CharField('tipo', max_length=6, choices=TIPOS)
    hora = models.CharField('hora', max_length=10, blank=True)
    pas = models.PositiveSmallIntegerField('presión sistólica', default=0)
    pad = models.PositiveSmallIntegerField('presión diastólica', default=0)
    fc = models.PositiveSmallIntegerField('frecuencia cardiaca', default=0)
    fr = models.PositiveSmallIntegerField('frecuencia respiratoria', default=0)
    temperatura = models.FloatField('temperatura', default=0)
    saturacion = models.PositiveSmallIntegerField('saturación', default=0)
    peso = models.FloatField('peso', default=0)
    talla = models.FloatField('talla', default=0)
    conciencia = models.CharField('conciencia (NEWS)', max_length=1, choices=CONCIENCIA, default='A')
    news = models.PositiveSmallIntegerField('puntaje NEWS', default=0)

    class Meta:
        verbose_name = 'signo vital de enfermería'
        verbose_name_plural = 'signos vitales de enfermería'
        ordering = ['id']


class MedicamentoAplicado(models.Model):
    """Administración de medicamentos registrada en la nota de enfermería."""

    nota = models.ForeignKey(NotaEnfermeria, on_delete=models.CASCADE, related_name='medicamentos')
    medicamento = models.CharField('medicamento', max_length=250)
    dosis = models.CharField('dosis', max_length=120, blank=True)
    via = models.CharField('vía', max_length=80, blank=True)
    hora = models.CharField('hora', max_length=10, blank=True)
    doble_verificacion_1 = models.CharField('doble verificación 1', max_length=150, blank=True)
    doble_verificacion_2 = models.CharField('doble verificación 2', max_length=150, blank=True)

    class Meta:
        verbose_name = 'medicamento aplicado'
        verbose_name_plural = 'medicamentos aplicados'
        ordering = ['id']


class NotaOncologia(NotaBase):
    """Nota de Oncología Médica."""

    medico = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                               related_name='+', verbose_name='médico',
                               help_text='Médico asignado al paciente al guardar la nota.')
    fecha_ingreso = models.DateTimeField('fecha y hora de ingreso', null=True, blank=True)
    ciclo = models.CharField('ciclo de tratamiento', max_length=120, blank=True)
    alergias = models.CharField('alergias', max_length=500, blank=True, default='Sin alergias conocidas')
    analisis = models.TextField('análisis clínico (SOAP)', blank=True)
    indicaciones = models.TextField('notas / indicaciones', blank=True)

    class Meta(NotaBase.Meta):
        verbose_name = 'nota de oncología médica'
        verbose_name_plural = 'notas de oncología médica'


class DiagnosticoNotaOncologia(models.Model):
    TIPOS = [('Principal', 'Principal'), ('Secundario', 'Secundario'), ('Complicación', 'Complicación')]

    nota = models.ForeignKey(NotaOncologia, on_delete=models.CASCADE, related_name='diagnosticos')
    diagnostico = models.CharField('diagnóstico', max_length=520)
    tipo = models.CharField('tipo', max_length=15, choices=TIPOS, default='Principal')
    cie = models.ForeignKey(DiagnosticoCIE, null=True, blank=True, on_delete=models.PROTECT, related_name='+',
                            verbose_name='diagnóstico CIE')
    comentario = models.CharField('comentario', max_length=500, blank=True)

    class Meta:
        verbose_name = 'diagnóstico de la nota de oncología'
        verbose_name_plural = 'diagnósticos de la nota de oncología'
        ordering = ['id']


class RecetaNotaOncologia(models.Model):
    """Medicamentos de la receta redactada dentro de la nota (se precargan en
    la siguiente nota del paciente)."""

    nota = models.ForeignKey(NotaOncologia, on_delete=models.CASCADE, related_name='recetas')
    nombre = models.CharField('medicamento', max_length=250)
    indicaciones = models.CharField('indicaciones', max_length=500, blank=True)
    notas = models.CharField('notas', max_length=500, blank=True)

    class Meta:
        verbose_name = 'medicamento de la nota de oncología'
        verbose_name_plural = 'medicamentos de la nota de oncología'
        ordering = ['id']


# ── Recetas y órdenes médicas ─────────────────────────────────────────────

class DocumentoMedico(NotaBase):
    """Lo común a recetas y órdenes médicas: médico y la nota de oncología
    desde la que se generaron (vacía si se crearon directo en su pestaña)."""

    medico = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                               related_name='+', verbose_name='médico')
    nota_oncologia = models.ForeignKey(NotaOncologia, null=True, blank=True, on_delete=models.SET_NULL,
                                       related_name='+', verbose_name='nota de oncología de origen')

    class Meta(NotaBase.Meta):
        abstract = True


class OrdenMedica(DocumentoMedico):
    observaciones = models.TextField('estudios / indicaciones', blank=True)

    class Meta(DocumentoMedico.Meta):
        verbose_name = 'orden médica'
        verbose_name_plural = 'órdenes médicas'


class Receta(DocumentoMedico):
    MEDICA = 'standard'
    ONCOLOGICA = 'oncological'
    TIPOS = [(MEDICA, 'Receta Médica'), (ONCOLOGICA, 'Receta Oncológica')]

    tipo = models.CharField('tipo', max_length=12, choices=TIPOS, default=MEDICA)
    notas = models.TextField('notas generales', blank=True)
    # Solo Receta Oncológica
    ciclo = models.CharField('ciclo', max_length=60, blank=True)
    dia_aplicacion = models.CharField('día de aplicación', max_length=60, blank=True)
    proxima_aplicacion = models.DateField('próxima aplicación', null=True, blank=True)
    peso = models.FloatField('peso (kg)', default=0)
    talla = models.FloatField('talla (cm)', default=0)
    presion = models.CharField('presión arterial', max_length=20, blank=True)
    fc = models.PositiveSmallIntegerField('frecuencia cardiaca', default=0)
    fr = models.PositiveSmallIntegerField('frecuencia respiratoria', default=0)
    temperatura = models.FloatField('temperatura', default=0)
    saturacion = models.PositiveSmallIntegerField('saturación', default=0)
    superficie_corporal = models.FloatField('superficie corporal (m²)', default=0)
    imc = models.FloatField('IMC (kg/m²)', default=0)
    diagnostico_general = models.TextField('diagnóstico general', blank=True)
    premedicacion = models.TextField('premedicación', blank=True)
    postmedicacion = models.TextField('postmedicación', blank=True)

    class Meta(DocumentoMedico.Meta):
        verbose_name = 'receta'
        verbose_name_plural = 'recetas'


class LineaReceta(models.Model):
    receta = models.ForeignKey(Receta, on_delete=models.CASCADE, related_name='lineas')
    medicamento = models.CharField('medicamento / tratamiento', max_length=500)
    indicaciones = models.TextField('dosis / indicaciones', blank=True)
    notas = models.TextField('notas', blank=True)

    class Meta:
        verbose_name = 'medicamento de la receta'
        verbose_name_plural = 'medicamentos de la receta'
        ordering = ['id']


# ── Archivos del expediente ───────────────────────────────────────────────

class ArchivoPaciente(NotaBase):
    """Documento del expediente (pestaña Archivos y "Archivos de HC"). El
    archivo vive en MEDIA_ROOT y solo se sirve por una vista con permisos.
    Borrar lo oculta (no se pierde el documento clínico)."""

    TIPOS = [(t, t) for t in (
        'Estudios de laboratorio', 'Estudios de imagen', 'Imágenes médicas (Archivos DICOM y Nifti)',
        'Consentimientos informados', 'Indicaciones', 'Recetas', 'Informes médicos / seguros', 'Fotos clinicas',
        'Estudios de patología', 'Estudios moleculares', 'Biocomposiciones / Nutrición', 'INE', 'Bitácora',
        'Carta de autorización', 'Carátula de seguro', 'Póliza de seguro', 'CSF', 'Documento Clínico', 'Otros')]
    MAX_BYTES = 20 * 1024 * 1024

    tipo = models.CharField('tipo de documento', max_length=60, choices=TIPOS, default='Otros')
    titulo = models.CharField('título', max_length=255)
    comentario = models.TextField('comentarios', blank=True)
    ciclo = models.CharField('ciclo', max_length=60, blank=True)
    fecha_ciclo = models.DateField('fecha del ciclo', null=True, blank=True)
    tratamiento_primario = models.BooleanField('tratamiento primario', default=False)
    compartir_paciente = models.BooleanField('compartir con el paciente', default=False)
    honorarios = models.BooleanField('honorarios', default=False)
    honorarios_ciclo = models.FloatField('honorarios del ciclo', default=0)
    archivo = models.FileField('archivo', upload_to='pacientes/archivos/%Y/%m/', blank=True)
    nombre_archivo = models.CharField('nombre del archivo', max_length=255, blank=True)
    mimetype = models.CharField('tipo de contenido', max_length=120, blank=True)
    tamano = models.PositiveIntegerField('tamaño (bytes)', default=0)
    eliminado = models.BooleanField('eliminado', default=False, db_index=True)

    class Meta(NotaBase.Meta):
        verbose_name = 'archivo del paciente'
        verbose_name_plural = 'archivos del paciente'

    def __str__(self):
        return self.titulo
