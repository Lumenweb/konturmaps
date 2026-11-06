"""Точка входа на хостинге Beget: Passenger запускает сайт через этот файл."""
import os
import sys

# ВРЕМЕННО: на хостинге пока нет SSL-сертификата, поэтому сайт работает по http://
# Когда сертификат будет подключён, поменяйте False на True и перезапустите сайт
# (touch tmp/restart.txt) — сайт перейдёт на https:// и снова защитит пароли.
HTTPS = True

os.environ.setdefault('KM_HOSTING', '1')
os.environ.setdefault('KM_HTTPS', '1' if HTTPS else '0')
os.environ.setdefault('KM_PUBLIC_URL', ('https' if HTTPS else 'http') + '://konturmaps.ru')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app as application  # noqa: E402
