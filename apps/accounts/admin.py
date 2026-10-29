from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import Especialidad, PerfilMedico, User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    fieldsets = BaseUserAdmin.fieldsets + (('Clínicas', {'fields': ('clinicas', 'clinica_activa')}),)
    filter_horizontal = BaseUserAdmin.filter_horizontal + ('clinicas',)


@admin.register(Especialidad)
class EspecialidadAdmin(admin.ModelAdmin):
    list_display = ('name', 'active')
    list_filter = ('active',)
    search_fields = ('name',)


@admin.register(PerfilMedico)
class PerfilMedicoAdmin(admin.ModelAdmin):
    list_display = ('user', 'especialidad', 'cedula_profesional', 'enfermera')
    list_filter = ('especialidad',)
    search_fields = ('user__first_name', 'user__last_name', 'user__username', 'cedula_profesional')
    raw_id_fields = ('user', 'enfermera')
