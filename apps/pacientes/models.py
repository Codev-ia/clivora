"""Pacientes.

Un paciente es único para todas las clínicas (un solo expediente, aunque se
atienda en varias); `clinica_registro` solo dice dónde se dio de alta.
"""
from datetime import date

from django.conf import settings
from django.db import models, transaction

from apps.core.models import TimeStampedModel


class OrigenReferencia(models.Model):
    """Cómo llegó el paciente (Página Web, Facebook, Médico Externo…)."""

    name = models.CharField('nombre', max_length=120, unique=True)
    pide_medico = models.BooleanField('pide médico de referencia', default=False,
                                      help_text='Al elegirlo, el alta pide el médico que lo refirió.')
    active = models.BooleanField('activo', default=True)

    class Meta:
        verbose_name = 'origen de referencia'
        verbose_name_plural = 'orígenes de referencia'
        ordering = ['name']

    def __str__(self):
        return self.name


class Paciente(TimeStampedModel):
    GENERO_CHOICES = [
        ('masculino', 'Masculino'),
        ('femenino', 'Femenino'),
        ('otro', 'Otro'),
        ('no_decir', 'Prefiero no decirlo'),
    ]
    ESTADO_CIVIL_CHOICES = [
        ('soltero', 'Soltero'),
        ('casado', 'Casado'),
        ('union_libre', 'Unión Libre'),
        ('viudo', 'Viudo'),
        ('divorciado', 'Divorciado'),
    ]

    expediente = models.CharField('número de expediente', max_length=20, unique=True, editable=False)
    nombres = models.CharField('nombre(s)', max_length=150)
    primer_apellido = models.CharField('primer apellido', max_length=100, blank=True)
    segundo_apellido = models.CharField('segundo apellido', max_length=100, blank=True)
    nombre_completo = models.CharField('nombre completo', max_length=360, editable=False, db_index=True)
    fecha_nacimiento = models.DateField('fecha de nacimiento', null=True, blank=True)
    genero = models.CharField('género', max_length=10, choices=GENERO_CHOICES, blank=True)
    estado_civil = models.CharField('estado civil', max_length=12, choices=ESTADO_CIVIL_CHOICES, blank=True)
    ocupacion = models.CharField('ocupación', max_length=120, blank=True)
    religion = models.CharField('religión', max_length=80, blank=True)
    curp = models.CharField('CURP', max_length=18, blank=True)
    tutor_legal = models.CharField('tutor legal', max_length=200, blank=True)
    foto = models.ImageField('foto', upload_to='pacientes/fotos/', blank=True)

    email = models.EmailField('correo', blank=True)
    celular = models.CharField('celular', max_length=30, blank=True, db_index=True)
    telefono = models.CharField('teléfono', max_length=30, blank=True)

    origen_referencia = models.ForeignKey(OrigenReferencia, null=True, blank=True, on_delete=models.PROTECT,
                                          verbose_name='origen de referencia')
    medico_referencia = models.CharField('médico de referencia', max_length=200, blank=True)
    doctor_asignado = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                        related_name='pacientes_asignados', verbose_name='médico asignado')
    acepta_terminos = models.BooleanField('aceptó términos y aviso de privacidad', default=False)

    # Domicilio personal
    pais = models.CharField('país', max_length=80, blank=True)
    estado = models.CharField('estado', max_length=80, blank=True)
    ciudad = models.CharField('ciudad', max_length=120, blank=True)
    colonia = models.CharField('colonia', max_length=120, blank=True)
    codigo_postal = models.CharField('código postal', max_length=10, blank=True)
    calle = models.CharField('calle', max_length=200, blank=True)
    numero = models.CharField('número', max_length=30, blank=True)

    # Facturación
    rfc = models.CharField('RFC', max_length=13, blank=True, db_index=True)
    regimen_fiscal = models.CharField('régimen fiscal (SAT)', max_length=3, blank=True)
    lista_precios = models.ForeignKey('precios.Pricelist', null=True, blank=True, on_delete=models.SET_NULL,
                                      related_name='pacientes', verbose_name='lista de precios')
    fiscal_pais = models.CharField('país (fiscal)', max_length=80, blank=True)
    fiscal_estado = models.CharField('estado (fiscal)', max_length=80, blank=True)
    fiscal_ciudad = models.CharField('ciudad (fiscal)', max_length=120, blank=True)
    fiscal_colonia = models.CharField('colonia (fiscal)', max_length=120, blank=True)
    fiscal_codigo_postal = models.CharField('código postal (fiscal)', max_length=10, blank=True)
    fiscal_calle = models.CharField('calle (fiscal)', max_length=200, blank=True)
    fiscal_numero = models.CharField('número (fiscal)', max_length=30, blank=True)

    clinica_registro = models.ForeignKey('core.Clinica', null=True, blank=True, on_delete=models.SET_NULL,
                                         related_name='+', verbose_name='clínica donde se registró')
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='registrado por')
    active = models.BooleanField('activo', default=True)

    class Meta:
        verbose_name = 'paciente'
        verbose_name_plural = 'pacientes'
        ordering = ['nombre_completo']

    def __str__(self):
        return f'{self.nombre_completo} ({self.expediente})'

    @property
    def edad(self):
        if not self.fecha_nacimiento:
            return None
        today = date.today()
        born = self.fecha_nacimiento
        return today.year - born.year - ((today.month, today.day) < (born.month, born.day))

    @staticmethod
    def componer_nombre(*partes):
        return ' '.join(p.strip() for p in partes if p and p.strip()).upper()

    @classmethod
    def siguiente_expediente(cls):
        """Consecutivo "00N" (0017, 00123…)."""
        numeros = [int(e[2:]) for e in cls.objects.values_list('expediente', flat=True) if e[2:].isdigit()]
        return f'00{max(numeros, default=0) + 1}'

    def save(self, *args, **kwargs):
        self.nombre_completo = self.componer_nombre(self.nombres, self.primer_apellido, self.segundo_apellido)
        self.curp = self.curp.strip().upper()
        self.rfc = self.rfc.strip().upper()
        if not self.expediente:
            with transaction.atomic():
                # Bloquea la tabla para que dos altas simultáneas no tomen el mismo número.
                list(Paciente.objects.select_for_update().values_list('pk', flat=True)[:1])
                self.expediente = self.siguiente_expediente()
                return super().save(*args, **kwargs)
        return super().save(*args, **kwargs)


class ExpedienteCompartido(TimeStampedModel):
    """Expediente compartido con un médico. Al Médico Externo (que solo ve
    sus pacientes asignados) le da acceso a este expediente mientras exista
    el registro; los médicos internos ya lo ven, para ellos queda como aviso.
    No manda correo ni genera ningún link."""

    paciente = models.ForeignKey(Paciente, on_delete=models.CASCADE, related_name='compartidos')
    medico = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='expedientes_compartidos',
                               verbose_name='compartido con')
    compartido_por = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                       related_name='+', verbose_name='compartido por')
    nota = models.TextField('nota', blank=True)

    class Meta:
        verbose_name = 'expediente compartido'
        verbose_name_plural = 'expedientes compartidos'
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.paciente} → {self.medico}'
