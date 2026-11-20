// Браузерная часть. Весь текст из ответов сервера выводится через textContent,
// поэтому имена файлов и сообщения не могут вставить HTML или скрипт в страницу.
const $ = (sel) => document.querySelector(sel);
const STATE_RU = { queued: 'в очереди', running: 'выполняется', succeeded: 'готово', failed: 'ошибка' };

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// Время хранится в UTC; показываем в местном поясе и подписываем пояс.
function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', { timeZoneName: 'short' });
}

async function api(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Ошибка HTTP ${response.status}`);
  return data;
}

function resultLinks(job) {
  const box = el('div');
  if (job.state === 'failed' && job.error) {
    box.append(el('span', `${job.error.code}: ${job.error.message}`, 'failed'));
  }
  for (const r of job.results) {
    const a = el('a', `${r.name} (${r.size} байт)`);
    a.href = r.url;
    a.download = r.name;
    box.append(a, el('br'));
  }
  return box;
}

function showDetails(job) {
  const box = $('#details');
  box.replaceChildren();
  const list = el('ul');
  list.append(
    el('li', `Номер: ${job.id}`),
    el('li', `Состояние: ${STATE_RU[job.state] ?? job.state}`),
    el('li', `Создано: ${formatTime(job.createdAt)}`),
    el('li', `Начато: ${formatTime(job.startedAt)}`),
    el('li', `Завершено: ${formatTime(job.finishedAt)}`),
    el('li', `Параметры: ${JSON.stringify(job.params)}`),
    el('li', `Файлы: ${job.inputs.map((i) => `${i.position}. ${i.name}`).join(', ')}`),
  );
  box.append(list, resultLinks(job));
  const sheet = job.results.find((r) => r.name === 'sheet.png');
  if (sheet) {
    const img = el('img', undefined, 'preview');
    img.src = sheet.url;
    img.alt = 'Готовый контактный лист';
    box.append(el('p', 'Предпросмотр:'), img);
  }
}

async function loadJobs() {
  try {
    const { jobs } = await api('/api/jobs');
    const body = $('#jobs');
    body.replaceChildren();
    for (const job of jobs) {
      const row = el('tr');
      const idCell = el('td', undefined, 'mono');
      const link = el('a', job.id);
      link.href = '#';
      link.onclick = (e) => { e.preventDefault(); openJob(job.id); };
      idCell.append(link);
      row.append(
        idCell,
        el('td', STATE_RU[job.state] ?? job.state, job.state),
        el('td', formatTime(job.createdAt)),
        el('td', String(job.inputs.length)),
      );
      const res = el('td');
      res.append(resultLinks(job));
      row.append(res);
      body.append(row);
    }
  } catch (error) {
    $('#message').textContent = `Не удалось получить список: ${error.message}`;
  }
}

async function openJob(id) {
  try {
    showDetails(await api(`/api/jobs/${encodeURIComponent(id)}`));
  } catch (error) {
    $('#details').textContent = error.message;
  }
}

$('#job-form').onsubmit = async (event) => {
  event.preventDefault();
  const files = $('#files').files;
  const params = {
    columns: Number($('#columns').value),
    cellWidth: Number($('#cellWidth').value),
    cellHeight: Number($('#cellHeight').value),
    gap: Number($('#gap').value),
  };
  const data = new FormData();
  for (const file of files) data.append('files', file);
  data.append('params', JSON.stringify(params));
  $('#send').disabled = true;
  $('#message').textContent = 'Отправка…';
  try {
    const job = await api('/api/jobs', { method: 'POST', body: data });
    $('#message').textContent = `Задание принято, номер: ${job.id}`;
    $('#find-id').value = job.id;
    await openJob(job.id);
    await loadJobs();
  } catch (error) {
    $('#message').textContent = `Ошибка: ${error.message}`;
  } finally {
    $('#send').disabled = false;
  }
};

$('#find-form').onsubmit = (event) => {
  event.preventDefault();
  openJob($('#find-id').value.trim());
};

$('#refresh').onclick = async () => {
  await loadJobs();
  const id = $('#find-id').value.trim();
  if (id) await openJob(id);
};

loadJobs();
