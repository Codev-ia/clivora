from django.urls import path, re_path

from . import reset, verificar, views

urlpatterns = [
    path('', views.home),
    path('clivora', views.index),
    path('clivora/login', views.login_page),
    path('clivora/login/verificar', verificar.verificar),
    path('clivora/logout', views.logout_view),
    path('clivora/reset_password', reset.reset_password),
    path('clivora/reset_password/confirm', reset.confirmar),
    path('clivora/api/me', views.api_me),
]

# Debe ir al final de config/urls.py (después de las rutas ya implementadas).
fallback_urlpatterns = [
    re_path(r'^clivora/api/(?P<path>.+)$', views.api_not_implemented),
]
