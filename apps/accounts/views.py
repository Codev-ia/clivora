from django.db.models import Q
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from apps.core.clinica import active_clinica, allowed_clinicas
from apps.core.permissions import ModelPermissions

from .models import DosPasos, User
from .serializers import RoleSerializer, UserSerializer, app_roles


class UserViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.CreateModelMixin,
                  mixins.UpdateModelMixin, viewsets.GenericViewSet):
    """Usuarios de las clínicas permitidas. No se borran: se desactivan
    (is_active=false) para conservar el historial de quién hizo qué.
    Filtros: ?q=, ?clinica=<id>|all (por defecto la activa), ?role=<id>, ?active=0|all."""

    permission_classes = [ModelPermissions]
    serializer_class = UserSerializer
    http_method_names = ['get', 'post', 'patch', 'head', 'options']

    def get_queryset(self):
        user = self.request.user
        qs = User.objects.prefetch_related('groups', 'clinicas').select_related('dos_pasos')
        if not user.is_superuser:
            qs = qs.filter(clinicas__in=allowed_clinicas(user)).distinct()
        p = self.request.query_params
        if self.action == 'list':
            clinica = p.get('clinica')
            if clinica != 'all':
                qs = qs.filter(clinicas=clinica or getattr(active_clinica(self.request), 'pk', None))
            active = p.get('active', '1')
            if active != 'all':
                qs = qs.filter(is_active=active not in ('0', 'false'))
            if p.get('role'):
                qs = qs.filter(groups=p['role'])
            if p.get('q'):
                q = p['q'].strip()
                qs = qs.filter(Q(username__icontains=q) | Q(first_name__icontains=q) | Q(last_name__icontains=q)
                               | Q(email__icontains=q))
        return qs.order_by('first_name', 'last_name', 'username').distinct()

    @action(detail=True, methods=['post'])
    def quitar_dos_pasos(self, request, pk=None):
        """POST /api/v1/usuarios/<id>/quitar_dos_pasos/ — para quien perdió el
        teléfono y sus códigos de recuperación: la vuelve a activar al entrar."""
        if not request.user.has_perm('accounts.change_user'):
            raise PermissionDenied
        usuario = self.get_object()
        DosPasos.objects.filter(user=usuario).delete()
        usuario = self.get_queryset().get(pk=usuario.pk)  # sin el registro ya borrado en memoria
        return Response(UserSerializer(usuario, context={'request': request}).data)


class RoleViewSet(mixins.ListModelMixin, viewsets.GenericViewSet):
    permission_classes = [IsAuthenticated]
    serializer_class = RoleSerializer
    pagination_class = None

    def get_queryset(self):
        return app_roles()
