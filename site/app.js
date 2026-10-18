/**
 * Frekans TV.
 *
 * Loads the compact search index once, filters in the browser, and fetches a
 * channel document only when it is opened. Playback stays in the browser:
 * this page never proxies video. No framework, no build step.
 */

const API = 'api/v1';

const state = {
  channels: [],
  filtered: [],
  countries: new Map(),
  categories: new Map(),
  languages: new Map(),
  manifest: null,
  favourites: loadFavourites(),
  rendered: 0,
  pageSize: 60,
  query: '',
  // `playable` defaults on: roughly three quarters of the catalogue is
  // metadata for channels with no stream at all, and showing those by
  // default promises far more than the site can actually play.
  filters: { country: '', category: '', language: '', playable: true, online: false, hd: false, favourites: false },
  sort: 'relevance',
  detailCache: new Map(),
  epgCache: new Map(),
  current: null,
  hls: null,
};

// Field positions in a search-index row — must match src/api/search-index.ts.
const F = {
  ID: 0,
  NAME: 1,
  SEARCH: 2,
  COUNTRY: 3,
  CATEGORIES: 4,
  LANGUAGES: 5,
  LOGO: 6,
  SCORE: 7,
  ONLINE: 8,
  STREAMS: 9,
  QUALITY: 10,
};

const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---------------------------------------------------------------- storage

function loadFavourites() {
  try {
    return new Set(JSON.parse(localStorage.getItem('frekans:favorites') ?? '[]'));
  } catch {
    return new Set();
  }
}

function saveFavourites() {
  try {
    localStorage.setItem('frekans:favorites', JSON.stringify([...state.favourites]));
  } catch {
    /* private mode — favourites stay in memory for this session */
  }
}

function loadTheme() {
  try {
    const stored = localStorage.getItem('frekans:theme');
    if (stored) document.documentElement.dataset.theme = stored;
    else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.dataset.theme = 'light';
    }
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- helpers

/** Same normalisation the index build uses, so queries match the blob. */
function normalise(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[ıİ]/g, 'i')
    .replace(/[ğ]/g, 'g')
    .replace(/[şç]/g, (c) => (c === 'ş' ? 's' : 'c'))
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function scoreClass(score, online) {
  if (online) return 'good';
  if (score >= 60) return 'good';
  if (score >= 25) return 'warn';
  if (score > 0) return 'bad';
  return 'unknown';
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

function formatNumber(value) {
  return new Intl.NumberFormat('tr-TR').format(value);
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '--:--'
    : date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

function categoryLabel(id) {
  if (!id) return '';
  return state.categories.get(id)?.name ?? id;
}

async function getJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
}

// ---------------------------------------------------------------- boot

function startClock() {
  const node = $('#clock');
  if (!node) return;
  const tick = () => {
    node.textContent = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  };
  tick();
  window.setInterval(tick, 15000);
}

async function boot() {
  loadTheme();
  startClock();
  wireEvents();

  try {
    const [index, manifest] = await Promise.all([
      getJson(`${API}/search.json`),
      getJson(`${API}/index.json`).catch(() => null),
    ]);

    state.channels = index.channels ?? [];
    state.manifest = manifest;
    renderBrandMeta();

    // Facets are small; failing to load them just leaves the selects empty.
    const [countries, categories, languages] = await Promise.all([
      getJson(`${API}/countries.json`).catch(() => []),
      getJson(`${API}/categories.json`).catch(() => []),
      getJson(`${API}/languages.json`).catch(() => []),
    ]);

    const facetLabel = (item) =>
      `${item.name} (${formatNumber(item.playable ?? item.channels ?? 0)})`;
    fillSelect($('#filter-country'), countries, 'code', (item) =>
      `${item.flag ? `${item.flag} ` : ''}${facetLabel(item)}`,
    );
    fillSelect($('#filter-category'), categories, 'id', facetLabel);
    fillSelect($('#filter-language'), languages, 'code', facetLabel);

    for (const country of countries) state.countries.set(country.code.toLowerCase(), country);
    for (const category of categories) state.categories.set(category.id, category);
    for (const language of languages) state.languages.set(language.code, language);

    readUrlState();
    applyFilters();
    renderStats();
  } catch (error) {
    $('#result-count').textContent =
      'Kanal dizini açılmadı. Sayfayı dosyadan değil, HTTP üzerinden açın.';
    console.error(error);
  }
}

function fillSelect(select, items, valueKey, labelOf) {
  if (!Array.isArray(items) || items.length === 0) return;
  const fragment = document.createDocumentFragment();
  // Counts shown to the user are playable counts — an option reading "(417)"
  // that yields 232 results once the default filter applies is just wrong.
  for (const item of [...items].sort((a, b) => (b.playable ?? 0) - (a.playable ?? 0))) {
    if ((item.playable ?? item.channels ?? 0) === 0) continue;
    const option = el('option', null, labelOf(item));
    option.value = String(item[valueKey]).toLowerCase();
    fragment.append(option);
  }
  select.append(fragment);
}

function renderBrandMeta() {
  if (!state.manifest) {
    $('#brand-meta').textContent = `${formatNumber(state.channels.length)} kanal`;
    return;
  }
  const { counts, generated_at: generatedAt } = state.manifest;
  const playable = counts.playable_channels ?? counts.channels;
  $('#brand-meta').textContent = `${formatNumber(playable)} yayın · ${formatNumber(counts.online_streams)} canlı`;
  $('#footer-meta').textContent =
    `Son üretim ${new Date(generatedAt).toLocaleString('tr-TR')} · ` +
    `${formatNumber(counts.streams)} adres · ${formatNumber(counts.epg_programmes)} rehber kaydı`;
}

function renderStats() {
  const withStream = state.channels.filter((row) => row[F.STREAMS] > 0);
  const online = state.channels.filter((row) => row[F.ONLINE] === 1).length;
  const hd = withStream.filter((row) => parseInt(row[F.QUALITY], 10) >= 720).length;
  $('#stats').innerHTML = '';
  const rows = [
    ['Yayını olan', formatNumber(withStream.length)],
    ['Şu an çalışan', formatNumber(online)],
    ['HD ve üzeri', formatNumber(hd)],
    ['Kayıtlı kanal', formatNumber(state.channels.length)],
    ['Favori', formatNumber(state.favourites.size)],
  ];
  for (const [label, value] of rows) {
    const line = el('div');
    line.append(`${label}: `, el('b', null, value));
    $('#stats').append(line);
  }
}

// ---------------------------------------------------------------- filtering

function applyFilters(resetScroll = true) {
  const query = normalise(state.query);
  const { country, category, language, playable, online, hd, favourites } = state.filters;

  let rows = state.channels;

  if (playable) rows = rows.filter((row) => row[F.STREAMS] > 0);
  if (favourites) rows = rows.filter((row) => state.favourites.has(row[F.ID]));
  if (online) rows = rows.filter((row) => row[F.ONLINE] === 1);
  if (hd) rows = rows.filter((row) => parseInt(row[F.QUALITY], 10) >= 720);
  if (country) rows = rows.filter((row) => row[F.COUNTRY].toLowerCase() === country);
  if (category) {
    rows = rows.filter((row) => row[F.CATEGORIES].toLowerCase().split(';').includes(category));
  }
  if (language) {
    rows = rows.filter((row) => row[F.LANGUAGES].toLowerCase().split(';').includes(language));
  }

  if (query) {
    // Prefix hits rank above substring hits; both beat non-matches.
    const scored = [];
    for (const row of rows) {
      const haystack = row[F.SEARCH];
      const at = haystack.indexOf(query);
      if (at === -1) continue;
      scored.push([row, at === 0 ? 2 : 1]);
    }
    scored.sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1];
      if (state.sort === 'relevance') return b[0][F.SCORE] - a[0][F.SCORE];
      return 0;
    });
    rows = scored.map((entry) => entry[0]);
  }

  if (state.sort === 'name') {
    rows = [...rows].sort((a, b) => a[F.NAME].localeCompare(b[F.NAME]));
  } else if (state.sort === 'score') {
    rows = [...rows].sort((a, b) => b[F.SCORE] - a[F.SCORE] || a[F.NAME].localeCompare(b[F.NAME]));
  } else if (state.sort === 'quality') {
    rows = [...rows].sort(
      (a, b) =>
        (parseInt(b[F.QUALITY], 10) || 0) - (parseInt(a[F.QUALITY], 10) || 0) ||
        b[F.SCORE] - a[F.SCORE],
    );
  }

  state.filtered = rows;
  state.rendered = 0;
  $('#results').innerHTML = '';
  if (resetScroll) window.scrollTo({ top: 0, behavior: 'auto' });

  const label = `${formatNumber(rows.length)} kanal`;
  $('#result-count').textContent = state.filters.playable ? `${label}, yayını olan` : label;
  const title = $('#list-title');
  if (title) {
    title.textContent = state.filters.favourites
      ? 'Favoriler'
      : state.filters.country
        ? (state.countries.get(state.filters.country)?.name ?? 'Kanallar')
        : state.query
          ? 'Arama'
          : 'Kanallar';
  }
  $('#empty').hidden = rows.length > 0;

  renderChips();
  renderMore();
  writeUrlState();
}

function renderChips() {
  const container = $('#active-chips');
  container.innerHTML = '';
  const active = [];

  if (state.filters.country) {
    active.push(['country', state.countries.get(state.filters.country)?.name ?? state.filters.country]);
  }
  if (state.filters.category) {
    active.push(['category', state.categories.get(state.filters.category)?.name ?? state.filters.category]);
  }
  if (state.filters.language) {
    active.push(['language', state.languages.get(state.filters.language)?.name ?? state.filters.language]);
  }
  if (state.filters.playable) active.push(['playable', 'Yayını olan']);
  if (state.filters.online) active.push(['online', 'Çalışan']);
  if (state.filters.hd) active.push(['hd', 'HD']);
  if (state.filters.favourites) active.push(['favourites', 'Favoriler']);

  for (const [key, label] of active) {
    const chip = el('button', 'chip', label);
    chip.type = 'button';
    chip.addEventListener('click', () => clearFilter(key));
    container.append(chip);
  }

  const count = $('#filter-count');
  count.textContent = String(active.length);
  count.hidden = active.length === 0;
}

function clearFilter(key) {
  if (key === 'playable' || key === 'online' || key === 'hd' || key === 'favourites') {
    state.filters[key] = false;
    $(`#filter-${key === 'favourites' ? 'favorites' : key}`).checked = false;
  } else {
    state.filters[key] = '';
    $(`#filter-${key}`).value = '';
  }
  applyFilters();
}

function resetFilters() {
  state.filters = { country: '', category: '', language: '', playable: true, online: false, hd: false, favourites: false };
  state.query = '';
  $('#search').value = '';
  for (const id of ['country', 'category', 'language']) $(`#filter-${id}`).value = '';
  for (const id of ['online', 'hd', 'favorites']) $(`#filter-${id}`).checked = false;
  $('#filter-playable').checked = true;
  applyFilters();
}

// ---------------------------------------------------------------- rendering

function renderMore() {
  const slice = state.filtered.slice(state.rendered, state.rendered + state.pageSize);
  if (slice.length === 0) return;

  const fragment = document.createDocumentFragment();
  for (const row of slice) fragment.append(renderCard(row));
  $('#results').append(fragment);
  state.rendered += slice.length;
}

function renderCard(row) {
  const card = el('button', 'card');
  card.type = 'button';
  card.dataset.id = row[F.ID];
  card.setAttribute('aria-label', `${row[F.NAME]} kanalını aç`);

  const top = el('div', 'card__top');

  if (row[F.LOGO]) {
    const logo = el('img', 'card__logo');
    logo.src = row[F.LOGO];
    logo.alt = '';
    logo.loading = 'lazy';
    logo.decoding = 'async';
    logo.addEventListener('error', () => logo.replaceWith(fallbackLogo(row[F.NAME])), { once: true });
    top.append(logo);
  } else {
    top.append(fallbackLogo(row[F.NAME]));
  }

  const titles = el('div');
  titles.append(el('div', 'card__name', row[F.NAME]));

  const country = state.countries.get(row[F.COUNTRY].toLowerCase());
  const category = row[F.CATEGORIES].split(';').filter(Boolean)[0];
  const subtitle = [country ? `${country.flag ?? ''} ${country.name}` : row[F.COUNTRY], categoryLabel(category)]
    .filter(Boolean)
    .join(' · ');
  titles.append(el('div', 'card__sub', subtitle));
  top.append(titles);
  card.append(top);

  const tags = el('div', 'card__tags');

  if (row[F.STREAMS] === 0) {
    // No stream at all: the channel exists in the database but there is
    // nothing to play, which is a different thing from "not yet checked".
    tags.append(el('span', 'dot dot--unknown'));
    tags.append(el('span', 'tag', 'Yayın yok'));
    card.append(tags);
    card.addEventListener('click', () => openChannel(row[F.ID]));
    return card;
  }

  const status = scoreClass(row[F.SCORE], row[F.ONLINE] === 1);
  tags.append(el('span', `dot dot--${status}`));
  tags.append(
    el(
      'span',
      `tag tag--${status === 'unknown' ? '' : status}`.trim(),
      row[F.ONLINE] === 1 ? 'Canlı' : row[F.SCORE] > 0 ? `${Math.round(row[F.SCORE])}%` : 'Bakılmadı',
    ),
  );
  if (row[F.QUALITY]) {
    tags.append(el('span', `tag${parseInt(row[F.QUALITY], 10) >= 720 ? ' tag--hd' : ''}`, row[F.QUALITY]));
  }
  if (row[F.STREAMS] > 1) tags.append(el('span', 'tag', `${row[F.STREAMS]} adres`));
  if (state.favourites.has(row[F.ID])) tags.append(el('span', 'tag', '★'));
  card.append(tags);

  card.addEventListener('click', () => openChannel(row[F.ID]));
  return card;
}

function fallbackLogo(name) {
  return el('div', 'card__logo card__logo--fallback', initials(name));
}

// ---------------------------------------------------------------- player

async function openChannel(id) {
  const panel = $('#player');
  panel.hidden = false;
  document.body.style.overflow = 'hidden';

  $('#player-title').textContent = 'Açılıyor…';
  document.title = 'Frekans TV';
  $('#player-sub').textContent = '';
  $('#player-streams').innerHTML = '';
  $('#player-epg').innerHTML = '';
  $('#player-meta').innerHTML = '';

  let channel = state.detailCache.get(id);
  if (!channel) {
    try {
      channel = await getJson(`${API}/channels/${encodeURIComponent(id)}.json`);
      state.detailCache.set(id, channel);
    } catch {
      $('#player-title').textContent = 'Kanal açılamadı';
      $('#player-sub').textContent = 'Kanal kaydı yüklenemedi.';
      return;
    }
  }

  state.current = channel;
  renderPlayerHeader(channel);
  renderStreamList(channel);
  renderEpg(channel);
  renderMeta(channel);

  const best = channel.streams?.[0];
  if (best) playStream(best, 0);
  else setStatus('Bu kanalın listelenmiş yayını yok.');
}

function zap(delta) {
  if (!state.current) return;
  const index = state.filtered.findIndex((row) => row[F.ID] === state.current.id);
  const next = state.filtered[index + delta];
  if (next) openChannel(next[F.ID]);
}

function renderPlayerHeader(channel) {
  const logo = $('#player-logo');
  const fallback = $('#player-fallback');
  const showFallback = () => {
    logo.hidden = true;
    if (!fallback) return;
    fallback.hidden = false;
    fallback.textContent = initials(channel.name);
  };
  if (channel.logo) {
    logo.hidden = false;
    if (fallback) fallback.hidden = true;
    logo.onerror = showFallback;
    logo.src = channel.logo;
  } else {
    showFallback();
  }

  $('#player-title').textContent = channel.name;
  document.title = `${channel.name} — Frekans TV`;
  const country = state.countries.get((channel.country ?? '').toLowerCase());
  $('#player-sub').textContent = [
    country ? `${country.flag ?? ''} ${country.name}` : channel.country,
    channel.categories?.map((id) => categoryLabel(id)).join(', '),
    channel.stream_count ? `${channel.stream_count} adres` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const favourite = state.favourites.has(channel.id);
  const button = $('#player-fav');
  button.setAttribute('aria-pressed', String(favourite));
  button.title = favourite ? 'Favorilerden çıkar' : 'Favorilere ekle';
  button.setAttribute('aria-label', button.title);
  button.onclick = () => {
    if (state.favourites.has(channel.id)) state.favourites.delete(channel.id);
    else state.favourites.add(channel.id);
    saveFavourites();
    const on = state.favourites.has(channel.id);
    button.setAttribute('aria-pressed', String(on));
    button.title = on ? 'Favorilerden çıkar' : 'Favorilere ekle';
    button.setAttribute('aria-label', button.title);
    renderStats();
  };
}

function renderStreamList(channel) {
  const container = $('#player-streams');
  container.innerHTML = '';
  if (!channel.streams?.length) return;

  container.append(el('p', 'section-title', 'Yayın adresleri'));

  channel.streams.forEach((stream, index) => {
    const button = el('button', 'stream-btn');
    button.type = 'button';
    const status = scoreClass(stream.health?.score ?? 0, stream.health?.status === 'online');
    button.append(el('span', `dot dot--${status}`));

    const quality = stream.quality ?? '—';
    const label = el('span', 'stream-btn__label', `${quality}${stream.title ? ` · ${stream.title}` : ''}`);
    button.append(label);

    if (stream.health?.latency_ms) {
      button.append(el('span', 'tag', `${stream.health.latency_ms}ms`));
    }
    if (stream.health?.uptime) {
      button.append(el('span', 'tag', `${stream.health.uptime}%`));
    }

    button.addEventListener('click', () => playStream(stream, index, { fallback: false }));
    container.append(button);
  });
}

async function renderEpg(channel) {
  const container = $('#player-epg');
  container.innerHTML = '';
  if (!channel.guides?.length) return;

  const country = (channel.country ?? 'int').toLowerCase();
  let programmes = state.epgCache.get(country);

  if (programmes === undefined) {
    try {
      const response = await fetch(`epg/${country}.xml`, { cache: 'no-cache' });
      if (!response.ok) throw new Error('no guide');
      programmes = parseGuide(await response.text());
    } catch {
      programmes = null;
    }
    state.epgCache.set(country, programmes);
  }

  if (!programmes) return;
  const list = (programmes.get(channel.id) ?? []).slice(0, 12);
  if (list.length === 0) return;

  container.append(el('p', 'section-title', 'Şimdi ve sonra'));
  const now = Date.now();

  for (const programme of list) {
    const start = new Date(programme.start).getTime();
    const stop = new Date(programme.stop).getTime();
    const isNow = now >= start && now < stop;

    const item = el('div', `epg-item${isNow ? ' epg-item--now' : ''}`);
    item.append(el('span', 'epg-item__time', formatTime(programme.start)));
    const body = el('div');
    body.append(el('div', 'epg-item__title', programme.title));
    if (programme.desc) body.append(el('div', 'epg-item__desc', programme.desc));
    item.append(body);
    container.append(item);
  }
}

/** Minimal XMLTV reader — the browser already has a parser, so use it. */
function parseGuide(xml) {
  const document_ = new DOMParser().parseFromString(xml, 'text/xml');
  if (document_.querySelector('parsererror')) return null;

  const byChannel = new Map();
  for (const node of document_.querySelectorAll('programme')) {
    const channel = node.getAttribute('channel');
    if (!channel) continue;
    const list = byChannel.get(channel) ?? [];
    list.push({
      start: xmltvDate(node.getAttribute('start')),
      stop: xmltvDate(node.getAttribute('stop')),
      title: node.querySelector('title')?.textContent ?? '',
      desc: node.querySelector('desc')?.textContent ?? '',
    });
    byChannel.set(channel, list);
  }

  const now = Date.now();
  for (const [channel, list] of byChannel) {
    byChannel.set(
      channel,
      list
        .filter((programme) => new Date(programme.stop).getTime() >= now)
        .sort((a, b) => a.start.localeCompare(b.start)),
    );
  }
  return byChannel;
}

function xmltvDate(value) {
  if (!value) return '';
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(value);
  if (!match) return '';
  const [, y, mo, d, h, mi, s = '00', offset = '+0000'] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset.slice(0, 3)}:${offset.slice(3)}`;
}

function renderMeta(channel) {
  const list = $('#player-meta');
  list.innerHTML = '';
  const stream = channel.streams?.[0];
  const rows = [
    ['Kanal', channel.id],
    ['Ülke', channel.country],
    ['Diller', channel.languages?.join(', ') || '—'],
    ['Türler', channel.categories?.join(', ') || '—'],
    ['Site', channel.website || '—'],
    ['Sağlık', `${channel.score}/100`],
    ['Codec', stream?.health?.media?.video_codec ?? '—'],
    ['Bit hızı', stream?.health?.media?.bitrate ? `${Math.round(stream.health.media.bitrate / 1000)} kbps` : '—'],
    ['Son kontrol', stream?.health?.checked_at ? new Date(stream.health.checked_at).toLocaleString('tr-TR') : '—'],
    ['API', `${API}/channels/${channel.id}.json`],
  ];
  for (const [term, description] of rows) {
    list.append(el('dt', null, term), el('dd', null, String(description)));
  }
}

function setStatus(message) {
  const overlay = $('#player-status');
  overlay.textContent = message ?? '';
  overlay.hidden = !message;
}

function playStream(stream, index, options = {}) {
  const video = $('#video');
  const fallback = options.fallback !== false;
  destroyPlayer();

  document.querySelectorAll('.stream-btn').forEach((button, i) => {
    button.setAttribute('aria-current', String(i === index));
  });

  setStatus('Bağlanıyor…');

  const onReady = () => setStatus(null);
  const onFail = (detail) => {
    const next = fallback ? state.current?.streams?.[index + 1] : null;
    if (next) {
      window.setTimeout(() => {
        if (state.current) playStream(next, index + 1, { fallback: true });
      }, 0);
      return;
    }
    console.warn('[frekans]', detail);
    window.setTimeout(() => {
      if ($('#player').hidden) return;
      destroyPlayer();
      setStatus(
        'Bu yayın tarayıcıda açılmadı. Adres kapalı, bölgeye kilitli ya da özel başlık istiyor olabilir. Başka bir adresi deneyin.',
      );
    }, 0);
  };

  const isHls = /\.m3u8(\?|$)/i.test(stream.url) || stream.url.includes('m3u8');

  if (isHls && window.Hls?.isSupported()) {
    const hls = new window.Hls({
      lowLatencyMode: true,
      backBufferLength: 30,
      manifestLoadingTimeOut: 15000,
      manifestLoadingMaxRetry: 2,
    });
    state.hls = hls;
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      onReady();
      video.play().catch(() => setStatus('Başlatmak için oynatın.'));
    });
    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      // Mixed content is the single most common failure on an HTTPS page.
      const mixed = location.protocol === 'https:' && stream.url.startsWith('http:');
      onFail(mixed ? 'https sayfada http yayın' : data.details);
    });
    hls.loadSource(stream.url);
    hls.attachMedia(video);
    return;
  }

  video.src = stream.url;
  video.addEventListener('loadedmetadata', onReady, { once: true });
  video.addEventListener('error', () => onFail('oynatma hatası'), { once: true });
  video.play().catch(() => setStatus('Başlatmak için oynatın.'));
}

function destroyPlayer() {
  const video = $('#video');
  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function closePlayer() {
  destroyPlayer();
  $('#player').hidden = true;
  document.body.style.overflow = '';
  state.current = null;
  document.title = 'Frekans TV';
  setStatus(null);
}

// ---------------------------------------------------------------- url state

function writeUrlState() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  for (const [key, value] of Object.entries(state.filters)) {
    if (key === 'playable') continue;
    if (value === true) params.set(key, '1');
    else if (value) params.set(key, value);
  }
  // On by default, so only the disabled state is worth putting in the URL.
  if (!state.filters.playable) params.set('all', '1');
  if (state.sort !== 'relevance') params.set('sort', state.sort);
  const next = params.toString();
  history.replaceState(null, '', next ? `?${next}` : location.pathname);
}

function readUrlState() {
  const params = new URLSearchParams(location.search);
  state.query = params.get('q') ?? '';
  $('#search').value = state.query;

  for (const key of ['country', 'category', 'language']) {
    const value = params.get(key);
    if (value) {
      state.filters[key] = value.toLowerCase();
      $(`#filter-${key}`).value = value.toLowerCase();
    }
  }
  for (const [key, id] of [['online', 'online'], ['hd', 'hd'], ['favourites', 'favorites']]) {
    if (params.get(key) === '1') {
      state.filters[key] = true;
      $(`#filter-${id}`).checked = true;
    }
  }
  if (params.get('all') === '1') {
    state.filters.playable = false;
    $('#filter-playable').checked = false;
  }
  const sort = params.get('sort');
  if (sort) {
    state.sort = sort;
    $('#sort').value = sort;
  }

  if (!params.has('country')) {
    let seen = true;
    try {
      seen = localStorage.getItem('frekans:welcomed') === '1';
      localStorage.setItem('frekans:welcomed', '1');
    } catch {
      seen = true;
    }
    if (!seen && $('#filter-country').querySelector('option[value="tr"]')) {
      state.filters.country = 'tr';
      $('#filter-country').value = 'tr';
    }
  }
}

// ---------------------------------------------------------------- events

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function wireEvents() {
  const onSearch = debounce(() => {
    state.query = $('#search').value.trim();
    applyFilters();
  }, 140);
  $('#search').addEventListener('input', onSearch);

  for (const key of ['country', 'category', 'language']) {
    $(`#filter-${key}`).addEventListener('change', (event) => {
      state.filters[key] = event.target.value;
      applyFilters();
    });
  }

  $('#filter-playable').addEventListener('change', (event) => {
    state.filters.playable = event.target.checked;
    applyFilters();
  });
  $('#filter-online').addEventListener('change', (event) => {
    state.filters.online = event.target.checked;
    applyFilters();
  });
  $('#filter-hd').addEventListener('change', (event) => {
    state.filters.hd = event.target.checked;
    applyFilters();
  });
  $('#filter-favorites').addEventListener('change', (event) => {
    state.filters.favourites = event.target.checked;
    applyFilters();
  });
  $('#sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    applyFilters();
  });

  $('#filters-reset').addEventListener('click', resetFilters);
  $('#empty-reset').addEventListener('click', resetFilters);

  $('#filters-toggle').addEventListener('click', (event) => {
    const panel = $('#filters');
    const open = panel.classList.toggle('is-open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
  });

  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('frekans:theme', next);
    } catch {
      /* ignore */
    }
  });

  for (const node of document.querySelectorAll('[data-close]')) {
    node.addEventListener('click', closePlayer);
  }

  document.addEventListener('keydown', (event) => {
    const typing = event.target instanceof HTMLElement && event.target.closest('input, textarea, select');
    if (event.key === 'Escape' && !$('#player').hidden) closePlayer();
    if (!typing && event.key === '/' && document.activeElement !== $('#search')) {
      event.preventDefault();
      $('#search').focus();
      $('#search').select();
    }
    if (
      !$('#player').hidden &&
      !typing &&
      !event.target.closest?.('.player__body') &&
      (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    ) {
      event.preventDefault();
      zap(event.key === 'ArrowDown' ? 1 : -1);
    }
  });

  // Infinite scroll.
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) renderMore();
    },
    { rootMargin: '600px' },
  );
  observer.observe($('#sentinel'));
}

boot();
