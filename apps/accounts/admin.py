from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin

from .models import User


@admin.register(User)
class UserAdmin(BaseUserAdmin):
    fieldsets = BaseUserAdmin.fieldsets + (('Clínicas', {'fields': ('clinicas', 'clinica_activa')}),)
    filter_horizontal = BaseUserAdmin.filter_horizontal + ('clinicas',)
