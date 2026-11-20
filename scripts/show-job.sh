#!/usr/bin/env bash
# Весь путь одного задания: запись в БД, файлы на диске, записи журналов.
# Запуск на сервере: sudo bash scripts/show-job.sh <номер задания>
set -u
ID=${1:?Укажите номер задания}
[[ "$ID" =~ ^[A-Za-z0-9_-]{1,128}$ ]] || { echo 'Неверный номер'; exit 1; }
DB=/var/lib/filelab/filelab.db
# sqlite3 запускаем от filelab: иначе root может создать служебные файлы БД, недоступные службам.
echo "== Запись в БД"
runuser -u filelab -- sqlite3 -line "$DB" "SELECT seq,id,state,created_at,started_at,finished_at,error_code,error_message,child_pid,results FROM jobs WHERE id='$ID';"
echo "== Входные файлы"
runuser -u filelab -- sqlite3 -column -header "$DB" "SELECT position,original_name,stored_name,size FROM job_inputs WHERE job_id='$ID' ORDER BY position;"
echo "== Каталог задания"
ls -la "/var/lib/filelab/jobs/$ID" "/var/lib/filelab/jobs/$ID"/* 2>&1
echo "== Журнал API"
journalctl -u filelab-api --no-pager -o cat | grep -F "$ID"
echo "== Журнал обработчика"
journalctl -u filelab-worker --no-pager -o cat | grep -F "$ID"
