#!/usr/bin/env bash
# Установка или обновление сервиса filelab (тема 01) на учебной Ubuntu.
# Запуск из корня проекта ПОСЛЕ "npm ci --omit=dev":   sudo bash deploy/install.sh [версия]
# Данные в /var/lib/filelab при обновлении сохраняются.
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Запустите так: sudo bash deploy/install.sh' >&2
  exit 1
fi
SRC=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$SRC"

# 1. Проверки до любых изменений.
[[ -x /usr/local/bin/node ]] || { echo 'Нет /usr/local/bin/node: сначала установите Node 24.' >&2; exit 1; }
CODE_FILES=(server.mjs worker.mjs process-job.mjs package.json package-lock.json
            src/config.mjs src/db.mjs src/params.mjs src/sheet.mjs)
WEB_FILES=(public/index.html public/app.js)
DEPLOY_FILES=(deploy/filelab-api.service deploy/filelab-worker.service deploy/filelab.nginx deploy/filelab.env)
for f in "${CODE_FILES[@]}" "${WEB_FILES[@]}" "${DEPLOY_FILES[@]}"; do
  [[ -f "$f" ]] || { echo "Нет файла $f" >&2; exit 1; }
done
[[ -d node_modules/express && -d node_modules/sharp ]] || { echo 'Нет node_modules: выполните npm ci --omit=dev' >&2; exit 1; }

# Версия: аргумент или короткий хэш Git-коммита.
VERSION=${1:-$(git -c safe.directory="$SRC" -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo manual)}
if [[ -n "$(git -c safe.directory="$SRC" -C "$SRC" status --porcelain 2>/dev/null)" ]]; then
  VERSION="$VERSION-dirty"   # есть незакоммиченные изменения
fi

# 2. Пользователь службы без входа в систему.
if ! id filelab >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/filelab --shell /usr/sbin/nologin filelab
fi

# 3. Останавливаем службы на время замены кода.
systemctl stop filelab-api filelab-worker 2>/dev/null || true

# 4. Собираем новый выпуск в отдельном каталоге, затем подменяем целиком,
#    чтобы старые файлы не остались в программе.
rm -rf /opt/filelab.new /opt/filelab.old
install -d -m 755 -o root -g root /opt/filelab.new /opt/filelab.new/src
for f in "${CODE_FILES[@]}"; do
  install -m 644 -o root -g root "$f" "/opt/filelab.new/$f"
done
cp -a node_modules /opt/filelab.new/
printf '%s\n' "$VERSION" > /opt/filelab.new/VERSION
(cd /opt/filelab.new && sha256sum "${CODE_FILES[@]}" > SHA256SUMS)
chown -R root:root /opt/filelab.new
chmod -R u+rwX,go+rX,go-w /opt/filelab.new
if [[ -d /opt/filelab ]]; then mv /opt/filelab /opt/filelab.old; fi
mv /opt/filelab.new /opt/filelab
rm -rf /opt/filelab.old

# 5. Статическая страница для Nginx.
rm -rf /var/www/filelab.new
install -d -m 755 -o root -g root /var/www/filelab.new
for f in "${WEB_FILES[@]}"; do
  install -m 644 -o root -g root "$f" "/var/www/filelab.new/$(basename "$f")"
done
rm -rf /var/www/filelab.old
if [[ -d /var/www/filelab ]]; then mv /var/www/filelab /var/www/filelab.old; fi
mv /var/www/filelab.new /var/www/filelab
rm -rf /var/www/filelab.old

# 6. Каталог данных принадлежит пользователю службы.
install -d -m 750 -o filelab -g filelab /var/lib/filelab

# 7. Конфигурация. Существующий /etc/filelab.env не перезаписываем, чтобы не
#    потерять ручные настройки (например, MAX_CONCURRENT_JOBS=2).
if [[ ! -f /etc/filelab.env ]] || grep -q '^APP_VERSION=infrastructure-demo' /etc/filelab.env; then
  install -m 640 -o root -g filelab deploy/filelab.env /etc/filelab.env
else
  echo 'Оставлен существующий /etc/filelab.env. Сравните: diff /etc/filelab.env deploy/filelab.env'
fi
install -m 644 -o root -g root deploy/filelab-api.service /etc/systemd/system/filelab-api.service
install -m 644 -o root -g root deploy/filelab-worker.service /etc/systemd/system/filelab-worker.service
install -m 644 -o root -g root deploy/filelab.nginx /etc/nginx/sites-available/filelab
if [[ -L /etc/nginx/sites-enabled/default ]]; then unlink /etc/nginx/sites-enabled/default; fi
ln -sfn /etc/nginx/sites-available/filelab /etc/nginx/sites-enabled/filelab
nginx -t

# 8. Запуск и автозапуск.
systemctl daemon-reload
systemctl enable --now filelab-api filelab-worker nginx
systemctl restart filelab-api filelab-worker
systemctl reload nginx

# 9. Ждём, пока API ответит через Nginx, и сверяем версию.
for attempt in {1..30}; do
  if health=$(curl --max-time 1 --fail --silent http://127.0.0.1/api/health); then
    echo "Готово: $health"
    [[ "$health" == *"\"version\":\"$VERSION\""* ]] || echo 'ВНИМАНИЕ: версия в ответе не совпала с установленной' >&2
    exit 0
  fi
  sleep 1
done
echo 'Службы установлены, но API не отвечает. Смотрите: journalctl -u filelab-api -n 50' >&2
exit 1
