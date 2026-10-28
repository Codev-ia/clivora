"""Clínicas (multiempresa), lugares de atención y salas."""
from django.core.validators import RegexValidator
from django.db import models

from .sat import REGIMENES_FISCALES, RFC_REGEX


class TimeStampedModel(models.Model):
    """Base de los modelos: fechas de creación y de última actualización."""

    created_at = models.DateTimeField('creado', auto_now_add=True)
    updated_at = models.DateTimeField('actualizado', auto_now=True)

    class Meta:
        abstract = True


class Clinica(TimeStampedModel):
    """Unidad de multiempresa: cada usuario trabaja en una clínica activa y
    solo ve los datos (lugares, inventario, listas de precios…) de las
    clínicas que tiene permitidas."""

    name = models.CharField('nombre', max_length=200)
    logo = models.ImageField('logo', upload_to='clinicas/logos/', blank=True)
    phone = models.CharField('teléfono', max_length=40, blank=True)
    email = models.EmailField('correo', blank=True)
    city = models.CharField('ciudad', max_length=120, blank=True, help_text='Se muestra en el encabezado de Clivora.')
    active = models.BooleanField('activa', default=True)

    # Datos fiscales del emisor (CFDI 4.0). El código postal fiscal es el
    # "lugar de expedición" de las facturas.
    legal_name = models.CharField('razón social', max_length=250, blank=True,
                                  help_text='Tal como aparece en la Constancia de Situación Fiscal, sin régimen societario.')
    rfc = models.CharField('RFC', max_length=13, blank=True, validators=[RegexValidator(
        RFC_REGEX, 'RFC inválido: 12 caracteres (persona moral) o 13 (persona física).')])
    regimen_fiscal = models.CharField('régimen fiscal', max_length=3, blank=True, choices=REGIMENES_FISCALES)
    codigo_postal = models.CharField('código postal fiscal', max_length=5, blank=True,
                                     validators=[RegexValidator(r'^\d{5}$', 'El código postal debe tener 5 dígitos.')])
    calle = models.CharField('calle', max_length=200, blank=True)
    numero_exterior = models.CharField('número exterior', max_length=30, blank=True)
    numero_interior = models.CharField('número interior', max_length=30, blank=True)
    colonia = models.CharField('colonia', max_length=120, blank=True)
    municipio = models.CharField('municipio / alcaldía', max_length=120, blank=True)
    estado = models.CharField('estado', max_length=80, blank=True)
    pais = models.CharField('país', max_length=80, blank=True, default='México')

    class Meta:
        verbose_name = 'clínica'
        verbose_name_plural = 'clínicas'
        ordering = ['name']

    def __str__(self):
        return self.name

    @property
    def tipo_persona(self):
        if len(self.rfc) == 12:
            return 'moral'
        if len(self.rfc) == 13:
            return 'fisica'
        return ''

    def save(self, *args, **kwargs):
        self.rfc = (self.rfc or '').strip().upper()
        super().save(*args, **kwargs)


class Lugar(TimeStampedModel):
    """Lugar de atención dentro de una clínica (p. ej. Penthouse 2, Piso 15)."""

    clinica = models.ForeignKey(Clinica, on_delete=models.PROTECT, related_name='lugares', verbose_name='clínica')
    name = models.CharField('nombre', max_length=120)
    address = models.CharField('dirección / referencia', max_length=250, blank=True)
    sequence = models.PositiveIntegerField('orden', default=10)
    active = models.BooleanField('activo', default=True)

    class Meta:
        verbose_name = 'lugar de atención'
        verbose_name_plural = 'lugares de atención'
        ordering = ['clinica', 'sequence', 'name']
        constraints = [models.UniqueConstraint(fields=['clinica', 'name'], name='uniq_lugar_por_clinica')]

    def __str__(self):
        return self.name


class Sala(TimeStampedModel):
    """Sala de tratamiento o consultorio de un lugar (p. ej. Penthouse 2 —
    Sala 2). Las citas reservan una sala; dos citas no pueden ocupar la
    misma sala a la misma hora."""

    TIPO_TRATAMIENTO = 'tratamiento'
    TIPO_CONSULTA = 'consulta'
    TIPO_CHOICES = [
        (TIPO_TRATAMIENTO, 'Sala de tratamiento / infusión'),
        (TIPO_CONSULTA, 'Consultorio'),
    ]

    lugar = models.ForeignKey(Lugar, on_delete=models.CASCADE, related_name='salas', verbose_name='lugar')
    name = models.CharField('nombre', max_length=80)
    tipo = models.CharField('tipo', max_length=12, choices=TIPO_CHOICES, default=TIPO_TRATAMIENTO)
    sequence = models.PositiveIntegerField('orden', default=10)
    active = models.BooleanField('activa', default=True)

    class Meta:
        verbose_name = 'sala'
        verbose_name_plural = 'salas'
        ordering = ['lugar', 'tipo', 'sequence', 'name']
        constraints = [models.UniqueConstraint(fields=['lugar', 'name'], name='uniq_sala_por_lugar')]

    def __str__(self):
        return f'{self.lugar} — {self.name}'


class SystemSettings(models.Model):
    """Configuración del sistema (un solo registro). Solo la cambia el
    superusuario: límites de la instalación (licencia)."""

    max_usuarios = models.PositiveIntegerField(
        'máximo de usuarios activos', null=True, blank=True,
        help_text='Vacío = sin límite. No cuenta a los superusuarios.')
    max_clinicas = models.PositiveIntegerField(
        'máximo de clínicas activas', null=True, blank=True, help_text='Vacío = sin límite.')

    # Servidor de correo (citas, restablecer contraseña). Sin activar, se usa
    # el de las variables EMAIL_* del .env (en desarrollo, la consola).
    SEGURIDAD = [('tls', 'STARTTLS (puerto 587)'), ('ssl', 'SSL/TLS (puerto 465)'), ('ninguna', 'Sin cifrado')]
    correo_activo = models.BooleanField('usar este servidor de correo', default=False)
    smtp_host = models.CharField('servidor SMTP', max_length=255, blank=True)
    smtp_puerto = models.PositiveIntegerField('puerto', default=587)
    smtp_seguridad = models.CharField('seguridad', max_length=7, choices=SEGURIDAD, default='tls')
    smtp_usuario = models.CharField('usuario', max_length=255, blank=True)
    smtp_password_cifrada = models.TextField('contraseña (cifrada)', blank=True, editable=False)
    remitente_nombre = models.CharField('nombre del remitente', max_length=120, blank=True, default='Clivora')
    remitente_correo = models.EmailField('correo del remitente', blank=True)
    updated_at = models.DateTimeField('actualizado', auto_now=True)
    updated_by = models.ForeignKey('accounts.User', null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='actualizado por')

    class Meta:
        verbose_name = 'configuración del sistema'
        verbose_name_plural = 'configuración del sistema'

    def __str__(self):
        return 'Configuración del sistema'

    @classmethod
    def get(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj
