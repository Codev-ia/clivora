"""Reglas de la Agenda: guardar citas, cambios de estado, check-in/out y correos."""
import logging

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.mail import send_mail
from django.db import transaction
from django.template.loader import render_to_string
from django.utils import timezone
from django.utils.html import strip_tags

from .models import Cita

log = logging.getLogger(__name__)


class SalaOcupada(ValidationError):
    pass


def _nombre(user):
    return (user.get_full_name() or user.username) if user else ''


def validar_transicion(cita, estado_anterior):
    if estado_anterior and cita.estado not in Cita.TRANSICIONES.get(estado_anterior, {estado_anterior}):
        raise ValidationError(
            f'No se puede cambiar la cita de "{dict(Cita.ESTADO_CHOICES).get(estado_anterior)}" a '
            f'"{cita.get_estado_display()}".')


def validar_sala(cita):
    otra = cita.sala_ocupada_por()
    if otra:
        ini, fin = timezone.localtime(otra.inicio), timezone.localtime(otra.fin)
        raise SalaOcupada(
            f'La sala "{cita.sala.name}" ({cita.lugar.name if cita.lugar_id else ""}) ya está reservada el '
            f'{ini:%d/%m/%Y} de {ini:%H:%M} a {fin:%H:%M} por otra cita aprobada ({otra.nombre}). '
            'Elige otra sala u horario.')


@transaction.atomic
def guardar(cita, user=None, estado_anterior=None):
    """Valida y guarda la cita; dispara lo que corresponde al cambiar de estado."""
    if cita.pk and estado_anterior is None:
        estado_anterior = Cita.objects.filter(pk=cita.pk).values_list('estado', flat=True).first()
    if estado_anterior == Cita.RECHAZADO and cita.estado == Cita.RECHAZADO and cita.pk:
        raise ValidationError('Una cita rechazada ya no se puede modificar.')
    validar_transicion(cita, estado_anterior)
    cita.full_clean(exclude=['clinica', 'token_seguimiento'])
    # Bloquea la sala mientras se valida, para que dos aprobaciones simultáneas
    # no reserven el mismo horario.
    if cita.sala_id:
        list(Cita.objects.select_for_update().filter(sala_id=cita.sala_id).values_list('pk', flat=True))
    validar_sala(cita)
    cambio = cita.estado != estado_anterior
    if cambio and cita.estado == Cita.RECHAZADO:
        cita.rechazada_el = cita.rechazada_el or timezone.localdate()
        cita.rechazada_por = cita.rechazada_por or user
    cita.save()
    if cambio and cita.estado in (Cita.APROBADO, Cita.RECHAZADO):
        transaction.on_commit(lambda: enviar_correo(cita))
    return cita


def enviar_correo(cita):
    """Correo al paciente al confirmar o rechazar su cita (si tiene correo)."""
    if not cita.paciente_id or not cita.paciente.email:
        return
    plantilla, asunto = (('confirmada', 'Confirmación de tu cita') if cita.estado == Cita.APROBADO
                         else ('rechazada', 'Tu cita no pudo confirmarse'))
    html = render_to_string(f'agenda/correos/{plantilla}.html', {
        'cita': cita, 'paciente': cita.paciente.nombre_completo, 'doctor': _nombre(cita.doctor),
        'inicio': timezone.localtime(cita.inicio),
    })
    try:
        send_mail(asunto, strip_tags(html), settings.DEFAULT_FROM_EMAIL, [cita.paciente.email], html_message=html)
    except Exception:  # un correo fallido no debe tumbar el guardado de la cita
        log.exception('No se pudo enviar el correo de la cita %s', cita.pk)


@transaction.atomic
def check(cita, tipo, user):
    cita = Cita.objects.select_for_update().get(pk=cita.pk)
    if tipo == 'check_in':
        if cita.estado != Cita.APROBADO:
            raise ValidationError('not_aprobado')
        cita.check_in_at, cita.check_in_by = timezone.now(), user
        cita.estado = Cita.EN_PROGRESO
    elif tipo == 'check_out':
        if cita.estado != Cita.EN_PROGRESO:
            raise ValidationError('not_checked_in')
        cita.check_out_at, cita.check_out_by = timezone.now(), user
        cita.estado = Cita.FINALIZADO
    else:
        raise ValidationError('invalid_tipo')
    cita.save()
    return cita
