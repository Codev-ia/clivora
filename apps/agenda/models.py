"""Agenda: citas de Consulta y Tratamiento.

Cada cita es de una clínica y reserva una sala de un lugar de atención
(Configuración → Lugares y salas). Dos citas aprobadas no pueden ocupar la
misma sala a la misma hora; un médico sí puede tener varias citas a la vez.
"""
import secrets

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.utils import timezone

from apps.core.models import TimeStampedModel


class MotivoCita(models.Model):
    TIPO_CONSULTA = 'consulta'
    TIPO_TRATAMIENTO = 'tratamiento'
    TIPO_CHOICES = [(TIPO_CONSULTA, 'Consulta'), (TIPO_TRATAMIENTO, 'Tratamiento')]

    name = models.CharField('nombre', max_length=120)
    tipo = models.CharField('tipo de cita', max_length=12, choices=TIPO_CHOICES)
    active = models.BooleanField('activo', default=True)

    class Meta:
        verbose_name = 'motivo de cita'
        verbose_name_plural = 'motivos de cita'
        ordering = ['tipo', 'name']
        constraints = [models.UniqueConstraint(fields=['tipo', 'name'], name='uniq_motivo_por_tipo')]

    def __str__(self):
        return self.name


class MotivoRechazo(models.Model):
    name = models.CharField('nombre', max_length=120, unique=True)
    active = models.BooleanField('activo', default=True)

    class Meta:
        verbose_name = 'motivo de rechazo'
        verbose_name_plural = 'motivos de rechazo'
        ordering = ['name']

    def __str__(self):
        return self.name


def _token():
    return secrets.token_urlsafe(24)


class Cita(TimeStampedModel):
    TIPO_CHOICES = MotivoCita.TIPO_CHOICES

    NUEVO, PENDIENTE, APROBADO, RECHAZADO = 'nuevo', 'pendiente', 'aprobado', 'rechazado'
    DESFASADO, EN_PROGRESO, FINALIZADO = 'desfasado', 'en_progreso', 'finalizado'
    ESTADO_CHOICES = [
        (NUEVO, 'Nuevo'), (APROBADO, 'Aprobado'), (RECHAZADO, 'Rechazado'), (PENDIENTE, 'Pendiente'),
        (DESFASADO, 'Desfasado'), (EN_PROGRESO, 'En progreso'), (FINALIZADO, 'Finalizado'),
    ]
    # A qué estados se puede pasar desde cada uno (mismas reglas que Clivora):
    # en_progreso/finalizado solo vía check-in/check-out; rechazado y
    # finalizado son finales.
    TRANSICIONES = {
        NUEVO: {NUEVO, PENDIENTE, APROBADO, RECHAZADO, DESFASADO},
        PENDIENTE: {PENDIENTE, APROBADO, RECHAZADO, DESFASADO},
        APROBADO: {APROBADO, PENDIENTE, DESFASADO, EN_PROGRESO},
        DESFASADO: {DESFASADO, PENDIENTE, APROBADO, RECHAZADO},
        RECHAZADO: {RECHAZADO},
        EN_PROGRESO: {EN_PROGRESO, FINALIZADO},
        FINALIZADO: {FINALIZADO},
    }
    FRECUENCIA_CHOICES = [('primera_vez', 'Primera vez'), ('subsecuente', 'Subsecuente'), ('urgente', 'Urgente')]
    APLICACION_CHOICES = [('solicitado', 'Solicitado'), ('preparacion', 'Preparación'), ('listo', 'Listo')]

    clinica = models.ForeignKey('core.Clinica', on_delete=models.PROTECT, related_name='citas',
                                verbose_name='clínica')
    tipo = models.CharField('tipo de cita', max_length=12, choices=TIPO_CHOICES)
    motivo = models.ForeignKey(MotivoCita, null=True, blank=True, on_delete=models.PROTECT, verbose_name='motivo')
    paciente = models.ForeignKey('pacientes.Paciente', null=True, blank=True, on_delete=models.PROTECT,
                                 related_name='citas', verbose_name='paciente')
    doctor = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                               related_name='citas_como_doctor', verbose_name='médico')
    enfermera = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                  related_name='citas_como_enfermera', verbose_name='enfermera')
    lugar = models.ForeignKey('core.Lugar', null=True, blank=True, on_delete=models.PROTECT, verbose_name='lugar')
    sala = models.ForeignKey('core.Sala', null=True, blank=True, on_delete=models.PROTECT, verbose_name='sala')
    inicio = models.DateTimeField('inicio', db_index=True)
    fin = models.DateTimeField('fin')
    ciclo = models.CharField('ciclo', max_length=60, blank=True)
    frecuencia = models.CharField('frecuencia', max_length=12, choices=FRECUENCIA_CHOICES, blank=True)
    nota = models.TextField('nota (updates)', blank=True)
    estado = models.CharField('estado', max_length=12, choices=ESTADO_CHOICES, default=PENDIENTE, db_index=True)

    motivo_rechazo = models.ForeignKey(MotivoRechazo, null=True, blank=True, on_delete=models.PROTECT,
                                       verbose_name='motivo de rechazo')
    rechazada_el = models.DateField('fecha de rechazo', null=True, blank=True)
    rechazada_por = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                      related_name='+', verbose_name='rechazada por')

    anotaciones_enfermeria = models.TextField('anotaciones de enfermería', blank=True)
    esquema_tratamiento = models.TextField('esquema de tratamiento', blank=True)
    estado_aplicacion = models.CharField('aplicación de medicamento', max_length=12, choices=APLICACION_CHOICES,
                                         blank=True)
    stock_aplicacion = models.BooleanField('stock listo', default=False)

    check_in_at = models.DateTimeField('check-in', null=True, blank=True)
    check_in_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                    related_name='+', verbose_name='check-in por')
    check_out_at = models.DateTimeField('check-out', null=True, blank=True)
    check_out_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                     related_name='+', verbose_name='check-out por')

    # Solicitud desde la página pública (sin paciente ligado todavía).
    solicitante_nombre = models.CharField('solicitante', max_length=120, blank=True)
    solicitante_telefono = models.CharField('teléfono del solicitante', max_length=60, blank=True)
    solicitante_expediente = models.CharField('expediente indicado', max_length=60, blank=True)
    solicitante_rfc = models.CharField('RFC indicado', max_length=60, blank=True)
    solicitante_ip = models.GenericIPAddressField('IP del solicitante', null=True, blank=True)
    token_seguimiento = models.CharField('token de seguimiento', max_length=64, unique=True, default=_token,
                                         editable=False)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='creada por')

    class Meta:
        verbose_name = 'cita'
        verbose_name_plural = 'citas'
        ordering = ['-inicio']
        indexes = [models.Index(fields=['clinica', 'inicio']), models.Index(fields=['sala', 'inicio'])]

    def __str__(self):
        quien = self.paciente.nombre_completo if self.paciente_id else (self.solicitante_nombre or 'Sin paciente')
        return f'{self.get_tipo_display()} · {quien} · {timezone.localtime(self.inicio):%d/%m/%Y %H:%M}'

    @property
    def nombre(self):
        return self.motivo.name if self.motivo_id else self.get_tipo_display()

    def clean(self):
        if self.fin and self.inicio and self.fin <= self.inicio:
            raise ValidationError({'fin': 'La hora de fin debe ser posterior al inicio.'})
        if self.sala_id and self.lugar_id and self.sala.lugar_id != self.lugar_id:
            raise ValidationError({'sala': 'La sala no pertenece al lugar elegido.'})
        if self.lugar_id and self.lugar.clinica_id != self.clinica_id:
            raise ValidationError({'lugar': 'El lugar no pertenece a la clínica de la cita.'})
        if self.sala_id:
            esperado = 'consulta' if self.tipo == 'consulta' else 'tratamiento'
            if self.sala.tipo != esperado:
                tipo_sala = 'un consultorio' if esperado == 'consulta' else 'una sala de tratamiento'
                raise ValidationError({'sala': f'Para {self.get_tipo_display().lower()} elige {tipo_sala}.'})

    def sala_ocupada_por(self):
        """Otra cita aprobada que ocupa la misma sala en ese horario."""
        if self.estado != self.APROBADO or not self.sala_id:
            return None
        return (Cita.objects.filter(sala_id=self.sala_id, estado=self.APROBADO, inicio__lt=self.fin, fin__gt=self.inicio)
                .exclude(pk=self.pk).select_related('motivo').first())


class CitaArchivo(models.Model):
    MAX_POR_CITA = 8

    cita = models.ForeignKey(Cita, on_delete=models.CASCADE, related_name='archivos', verbose_name='cita')
    archivo = models.FileField('archivo', upload_to='citas/%Y/%m/')
    nombre = models.CharField('nombre', max_length=255)
    mimetype = models.CharField('tipo', max_length=120, blank=True)
    tamano = models.PositiveIntegerField('tamaño (bytes)', default=0)
    created_at = models.DateTimeField('subido', auto_now_add=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                   related_name='+', verbose_name='subido por')

    class Meta:
        verbose_name = 'archivo de cita'
        verbose_name_plural = 'archivos de cita'
        ordering = ['-created_at']

    def __str__(self):
        return self.nombre
