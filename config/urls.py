from django.contrib import admin
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from apps.accounts import seguridad
from apps.accounts import views as acc
from apps.web import urls as web_urls
from apps.core import compat
from apps.core import views as core_views
from apps.inventario import views as inv
from apps.agenda import compat as agenda
from apps.expediente import compat as hc
from apps.expediente import archivos, documentos, notas, reportes
from apps.pacientes import compartir
from apps.pacientes import compat as pac
from apps.precios import views as pre

admin.site.site_header = 'Clivora — Administración'
admin.site.site_title = 'Clivora'
admin.site.index_title = 'Panel'


def _admin_login(request, extra_context=None):
    """El panel de administración entra con el login de Clivora (que pide la
    verificación en dos pasos); su formulario propio se la saltaría."""
    from django.shortcuts import redirect
    from django.utils.http import urlencode
    return redirect(f"/clivora/login?{urlencode({'redirect': request.GET.get('next') or '/admin/'})}")


admin.site.login = _admin_login

router = DefaultRouter()
router.register('core/clinicas', core_views.ClinicaViewSet, basename='clinica')
router.register('core/lugares', core_views.LugarViewSet, basename='lugar')
router.register('core/salas', core_views.SalaViewSet, basename='sala')
router.register('usuarios', acc.UserViewSet, basename='usuario')
router.register('roles', acc.RoleViewSet, basename='rol')
router.register('inventario/unidades', inv.UnitOfMeasureViewSet)
router.register('inventario/categorias', inv.ProductCategoryViewSet)
router.register('inventario/productos', inv.ProductViewSet, basename='producto')
router.register('inventario/ubicaciones', inv.LocationViewSet, basename='ubicacion')
router.register('inventario/lotes', inv.LotViewSet, basename='lote')
router.register('inventario/existencias', inv.StockQuantViewSet, basename='existencia')
router.register('inventario/movimientos', inv.StockMoveViewSet, basename='movimiento')
router.register('precios/aseguradoras', pre.AseguradoraViewSet)
router.register('precios/listas', pre.PricelistViewSet, basename='lista')
router.register('precios/productos', pre.PricelistItemViewSet, basename='precio-producto')

compat_urls = [
    path('products', compat.products),
    path('products/stock', compat.products_stock),
    path('pricelists', compat.pricelists),
    path('aseguradoras', compat.aseguradoras),
    path('farmacia/summary', compat.farmacia_summary),
    # Pacientes
    path('patients', pac.patients),
    path('patients/check_similar', pac.check_similar),
    path('patients/<int:patient_id>', pac.patient_detail),
    path('patients/<int:patient_id>/info_general', pac.info_general_save),
    path('patients/<int:patient_id>/domicilio', pac.domicilio_save),
    path('patients/<int:patient_id>/facturacion', pac.facturacion_save),
    path('patients/<int:patient_id>/photo', pac.foto_guardar),
    path('patients/<int:patient_id>/shares', compartir.compartidos),
    path('shares/<int:share_id>/delete', compartir.compartido_borrar),
    path('doctors', pac.doctors),
    path('doctor_specialties', pac.doctor_specialties),
    path('fiscal_regimes', pac.fiscal_regimes),
    path('patient_referrals', pac.patient_referrals),
    # Historia Clínica
    path('patients/<int:patient_id>/historia_clinica', hc.historia_clinica_save),
    path('patients/<int:patient_id>/family_history', hc.family_history),
    path('patients/<int:patient_id>/medications', hc.medications),
    path('patients/<int:patient_id>/diagnosis_lines', hc.diagnosis_lines),
    path('hc/catalogs', hc.hc_catalogs),
    path('cie11/search', hc.cie11_search),
    path('historial/<str:model>/<int:record_id>/create_date', hc.historial_create_date),
    # Notas del expediente: signos vitales y enfermería
    path('patients/<int:patient_id>/consultations', notas.consultas),
    path('patients/<int:patient_id>/consultations/vitals', notas.signos_crear),
    path('patients/<int:patient_id>/consultations/nursing', notas.enfermeria_crear),
    path('consultations/vitals/<int:rec_id>', notas.signos_editar),
    path('consultations/nursing/<int:rec_id>', notas.enfermeria_editar),
    path('patients/<int:patient_id>/consultations/oncology', notas.oncologia_crear),
    path('consultations/oncology/<int:rec_id>', notas.oncologia_editar),
    path('consultations/<str:source>/<int:rec_id>/delete', notas.consulta_borrar),
    path('nursing/assessment_questions', notas.preguntas_valoracion),
    # Recetas y órdenes médicas
    # Reportes PDF
    path('patients/<int:patient_id>/historia_clinica/print', reportes.historia_clinica),
    path('patients/<int:patient_id>/consultations/vitals/<int:rec_id>/print', reportes.signos_vitales),
    path('patients/<int:patient_id>/nursing_notes/<int:rec_id>/print', reportes.nota_enfermeria),
    path('patients/<int:patient_id>/nursing_notes/<int:rec_id>/clinical_print', reportes.nota_enfermeria),
    path('patients/<int:patient_id>/consultations/oncology/<int:rec_id>/print', reportes.nota_oncologia),
    path('patients/<int:patient_id>/lab_orders/<int:rec_id>/print', reportes.orden_medica),
    path('patients/<int:patient_id>/recipe_headers/<int:rec_id>/print', reportes.receta),
    path('patients/<int:patient_id>/recipe_headers/<int:rec_id>/onco_print', reportes.receta),
    path('patients/<int:patient_id>/recipe_headers', documentos.recetas),
    path('recipe_headers/<int:rec_id>', documentos.receta_editar),
    path('recipe_headers/<int:rec_id>/delete', documentos.receta_borrar),
    path('patients/<int:patient_id>/lab_orders', documentos.ordenes),
    path('lab_orders/<int:rec_id>', documentos.orden_editar),
    path('lab_orders/<int:rec_id>/delete', documentos.orden_borrar),
    path('lab_catalogs', documentos.catalogos_ordenes),
    # Archivos del expediente
    path('patients/<int:patient_id>/files', archivos.archivos),
    path('files/<int:rec_id>/delete', archivos.archivo_borrar),
    # Agenda y Tratamientos
    path('citas', agenda.citas),
    path('citas/catalogs', agenda.catalogos),
    path('citas/<int:cita_id>', agenda.cita_detalle),
    path('citas/<int:cita_id>/delete', agenda.cita_borrar),
    path('citas/<int:cita_id>/check', agenda.cita_check),
    path('citas/<int:cita_id>/files', agenda.cita_archivos),
    path('cita_files/<int:archivo_id>/delete', agenda.cita_archivo_borrar),
    path('tratamientos', agenda.tratamientos),
    path('dashboard/patient_activity', agenda.actividad_pacientes),
    path('public/citas', agenda.crear_cita_publica),
    path('public/citas/catalogs', agenda.catalogos_publicos),
]

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/v1/precios/calcular/', pre.compute_price),
    path('api/v1/me/clinica/', core_views.switch_clinica),
    path('api/v1/me/', core_views.me_profile),
    path('api/v1/me/password/', core_views.me_password),
    path('api/v1/me/seguridad/', seguridad.seguridad),
    path('api/v1/me/dos_pasos/iniciar/', seguridad.iniciar),
    path('api/v1/me/dos_pasos/activar/', seguridad.activar),
    path('api/v1/me/dos_pasos/desactivar/', seguridad.desactivar),
    path('api/v1/me/dos_pasos/codigos/', seguridad.codigos),
    path('api/v1/sistema/', core_views.sistema),
    path('api/v1/sistema/correo/', core_views.sistema_correo),
    path('api/v1/sistema/correo/prueba/', core_views.sistema_correo_prueba),
    path('api/v1/', include(router.urls)),
    path('clivora/api/', include(compat_urls)),
    path('clivora/agendar', agenda.agendar_publico),
    path('clivora/clinica_logo/<int:clinica_id>', core_views.clinica_logo),
    path('clivora/estado/<str:token>', agenda.estado_publico),
    path('clivora/cita_files/<int:archivo_id>', agenda.cita_archivo_descargar),
    path('clivora/patient_files/<int:rec_id>', archivos.archivo_descargar),
    path('clivora/patient_photo/<int:patient_id>', pac.foto),
    path('', include(web_urls.urlpatterns)),
    *web_urls.fallback_urlpatterns,
]
