from django.db.models import Count, Q
from django.contrib.auth import update_session_auth_hash
from rest_framework import serializers, viewsets
from rest_framework.exceptions import MethodNotAllowed, PermissionDenied
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.inventario.models import Location

from .clinica import active_clinica, allowed_clinicas
from .logos import procesar_logo
from .models import Clinica, Lugar, Sala, SystemSettings
from .permissions import ModelPermissions
from .serializers import (ClinicaSerializer, CorreoPruebaSerializer, CorreoSerializer, LugarSerializer, PasswordChangeSerializer, ProfileSerializer,
                          SalaSerializer, SystemSettingsSerializer)


class ClinicaViewSet(viewsets.ModelViewSet):
    """Clínicas. Se listan las permitidas al usuario (todas para superusuarios);
    ?active=all incluye las archivadas. No se borran: se archivan."""

    permission_classes = [ModelPermissions]
    serializer_class = ClinicaSerializer
    pagination_class = None
    # DELETE solo para quitar el logo (…/logo/); las clínicas no se borran.
    http_method_names = ['get', 'post', 'patch', 'delete', 'head', 'options']

    def destroy(self, request, *args, **kwargs):
        raise MethodNotAllowed('DELETE', detail='Las clínicas no se borran: archívala desmarcando "Activa".')

    def get_queryset(self):
        user = self.request.user
        qs = Clinica.objects.all() if user.is_superuser else Clinica.objects.filter(usuarios=user)
        if self.request.query_params.get('active') != 'all':
            qs = qs.filter(active=True)
        return qs.annotate(lugares_count=Count('lugares', distinct=True),
                           usuarios_count=Count('usuarios', distinct=True))

    @action(detail=True, methods=['post', 'delete'], url_path='logo')
    def logo(self, request, pk=None):
        """POST {"logo": "data:image/png;base64,..."} sube/reemplaza el logo;
        DELETE lo quita."""
        clinica = self.get_object()
        if request.method == 'DELETE':
            if clinica.logo:
                clinica.logo.delete(save=False)
            clinica.logo = ''
            clinica.save(update_fields=['logo', 'updated_at'])
            return Response(ClinicaSerializer(clinica).data)
        content = procesar_logo(request.data.get('logo'))
        if clinica.logo:
            clinica.logo.delete(save=False)
        clinica.logo.save(f'clinica-{clinica.pk}.png', content, save=False)
        clinica.save(update_fields=['logo', 'updated_at'])
        return Response(ClinicaSerializer(clinica).data)

    def perform_create(self, serializer):
        clinica = serializer.save()
        # Su almacén de farmacia: el inventario necesita una ubicación interna
        # por clínica para registrar entradas y salidas.
        Location.objects.create(name='Farmacia', usage=Location.USAGE_INTERNAL, clinica=clinica)
        # Quien la crea queda con acceso a ella (si no es superusuario).
        if not self.request.user.is_superuser:
            self.request.user.clinicas.add(clinica)


class LugarViewSet(viewsets.ModelViewSet):
    """Lugares de atención (con sus salas) de las clínicas permitidas.
    ?clinica=<id>; por defecto los de la clínica activa."""

    permission_classes = [ModelPermissions]
    serializer_class = LugarSerializer
    pagination_class = None

    def get_queryset(self):
        allowed = allowed_clinicas(self.request.user)
        qs = Lugar.objects.filter(clinica__in=allowed).select_related('clinica').prefetch_related('salas')
        clinica = self.request.query_params.get('clinica')
        if self.action == 'list':
            if clinica != 'all':
                qs = qs.filter(clinica_id=clinica or getattr(active_clinica(self.request), 'pk', None))
            if self.request.query_params.get('active') != 'all':
                qs = qs.filter(active=True)
        return qs

    def perform_create(self, serializer):
        if not allowed_clinicas(self.request.user).filter(pk=serializer.validated_data['clinica'].pk).exists():
            raise ValidationError({'clinica': 'No tienes acceso a esa clínica.'})
        serializer.save()

    def perform_destroy(self, instance):
        instance.active = False
        instance.save(update_fields=['active', 'updated_at'])


class SalaViewSet(viewsets.ModelViewSet):
    permission_classes = [ModelPermissions]
    serializer_class = SalaSerializer
    pagination_class = None

    def get_queryset(self):
        qs = Sala.objects.filter(lugar__clinica__in=allowed_clinicas(self.request.user))
        if self.request.query_params.get('lugar'):
            qs = qs.filter(lugar_id=self.request.query_params['lugar'])
        return qs

    def _check_lugar(self, lugar):
        if not allowed_clinicas(self.request.user).filter(pk=lugar.clinica_id).exists():
            raise ValidationError({'lugar': 'No tienes acceso a ese lugar.'})

    def perform_create(self, serializer):
        self._check_lugar(serializer.validated_data['lugar'])
        serializer.save()

    def perform_update(self, serializer):
        self._check_lugar(serializer.validated_data.get('lugar', serializer.instance.lugar))
        serializer.save()

    def perform_destroy(self, instance):
        instance.active = False
        instance.save(update_fields=['active', 'updated_at'])


class SwitchClinicaSerializer(serializers.Serializer):
    clinica = serializers.IntegerField()


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def switch_clinica(request):
    """POST /api/v1/me/clinica/ {"clinica": id} — cambia la clínica activa."""
    data = SwitchClinicaSerializer(data=request.data)
    data.is_valid(raise_exception=True)
    clinica = allowed_clinicas(request.user).filter(pk=data.validated_data['clinica']).first()
    if clinica is None:
        raise ValidationError({'clinica': 'No tienes acceso a esa clínica.'})
    request.user.clinica_activa = clinica
    request.user.save(update_fields=['clinica_activa'])
    return Response({'id': clinica.pk, 'name': clinica.name})


@api_view(['GET', 'PATCH'])
@permission_classes([IsAuthenticated])
def sistema(request):
    """GET /api/v1/sistema/ — límites y uso (lo ve cualquiera para mostrar
    "12 de 20 usuarios"). PATCH — solo el superusuario."""
    settings_obj = SystemSettings.get()
    if request.method == 'PATCH':
        if not request.user.is_superuser:
            raise PermissionDenied('Solo el superusuario puede cambiar la configuración del sistema.')
        serializer = SystemSettingsSerializer(settings_obj, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(updated_by=request.user)
        return Response(serializer.data)
    return Response(SystemSettingsSerializer(settings_obj).data)


def _solo_superusuario(request):
    if not request.user.is_superuser:
        raise PermissionDenied('Solo el superusuario puede ver y cambiar el servidor de correo.')


@api_view(['GET', 'PATCH'])
@permission_classes([IsAuthenticated])
def sistema_correo(request):
    """GET/PATCH /api/v1/sistema/correo/ — servidor de correo (solo superusuario)."""
    _solo_superusuario(request)
    settings_obj = SystemSettings.get()
    if request.method == 'PATCH':
        serializer = CorreoSerializer(settings_obj, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save(updated_by=request.user)
    return Response(CorreoSerializer(settings_obj).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def sistema_correo_prueba(request):
    """POST /api/v1/sistema/correo/prueba/ {destinatario} — manda un correo de
    prueba con el servidor guardado (aunque todavía no esté activado), para
    revisar los datos antes de activarlo."""
    from django.core.mail import EmailMessage

    from .correo import conexion_smtp, remitente

    _solo_superusuario(request)
    data = CorreoPruebaSerializer(data=request.data)
    data.is_valid(raise_exception=True)
    config = SystemSettings.get()
    if not config.smtp_host or not config.remitente_correo:
        raise ValidationError({'detail': 'Guarda primero el servidor SMTP y el correo del remitente.'})
    mensaje = EmailMessage(
        'Correo de prueba de Clivora',
        'Si recibiste este correo, el servidor de correo de Clivora está bien configurado.',
        remitente(config), [data.validated_data['destinatario']], connection=conexion_smtp(config))
    try:
        mensaje.send()
    except Exception as e:  # el mensaje del servidor SMTP le dice al usuario qué corregir
        raise ValidationError({'detail': f'No se pudo enviar: {e}'})
    return Response({'ok': True})


@api_view(['GET', 'PATCH'])
@permission_classes([IsAuthenticated])
def me_profile(request):
    """GET/PATCH /api/v1/me/ — datos de la cuenta propia."""
    if request.method == 'PATCH':
        serializer = ProfileSerializer(request.user, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)
    return Response(ProfileSerializer(request.user).data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def me_password(request):
    """POST /api/v1/me/password/ {current_password, new_password}. Mantiene la
    sesión abierta tras el cambio."""
    serializer = PasswordChangeSerializer(data=request.data, context={'request': request})
    serializer.is_valid(raise_exception=True)
    request.user.set_password(serializer.validated_data['new_password'])
    request.user.save(update_fields=['password'])
    update_session_auth_hash(request._request, request.user)
    return Response({'ok': True})


def clinica_logo(request, clinica_id):
    """Logo de una clínica. Público: se usa también en documentos impresos."""
    from django.http import FileResponse, Http404
    clinica = Clinica.objects.filter(pk=clinica_id).first()
    if not clinica or not clinica.logo:
        raise Http404
    response = FileResponse(clinica.logo.open('rb'), content_type='image/png')
    response['Cache-Control'] = 'public, max-age=31536000, immutable'  # la URL lleva ?v=
    return response
