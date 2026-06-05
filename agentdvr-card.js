/**
 * AgentDVR Gallery Card
 * ----------------------------------------------------------------------------
 * A Lovelace custom card for Home Assistant and ioBroker (Lovelace adapter)
 * that displays AgentDVR recordings as a thumbnail gallery.
 *
 * Features:
 *   - Thumbnail gallery with configurable size
 *   - Grouping by date (Today / Yesterday / weekday / date)
 *   - Relative time display (just now / X min ago / X h ago)
 *   - Lightbox player with prev/next navigation & keyboard control
 *   - Live camera view with status badge and optional live stream
 *   - Search & tag filter (subtle, collapsible)
 *   - Auto-refresh with diff detection (no unnecessary DOM rebuilds)
 *   - Modal stays open during refresh, rebuild deferred until closed
 *   - Graphical editor in Lovelace
 *   - Multi-language (German / English, auto-detected)
 *   - All colors taken from the Lovelace theme
 *
 * Installation:
 *   1. Copy the file to /config/www/agentdvr-card.js (HA)
 *      or /cards/agentdvr-card.js (ioBroker Lovelace adapter)
 *   2. Register the resource:
 *        url: /local/agentdvr-card.js   (HA)
 *        url: /cards/agentdvr-card.js   (ioBroker)
 *        type: module
 *   3. Add the card:
 *        type: custom:agentdvr-card
 *        ip_agentdvr: "192.168.99.5"    # AgentDVR IP address
 *        oid: "8"                        # camera OID in AgentDVR
 *        anzahl: 50                      # max. number of recordings
 *        groesse: "gross"                # klein (75px) | mittel (100px) | gross (150px)
 *        show_tags: true                 # show tags on thumbnails
 *        show_live: true                 # show live camera tile
 *        live_stream_url: ""             # optional alternative stream (e.g. go2rtc)
 *        tag_position: "bottom-left"    # top-left | top-right | bottom-left | bottom-right
 *        refresh_interval: 30           # auto-refresh in seconds, 0 = off
 *        title: "Driveway Camera"        # card title
 *
 * Requirements:
 *   - AgentDVR (https://www.ispyconnect.com/) reachable on the local network
 *
 * License: MIT
 * ----------------------------------------------------------------------------
 */

class AgentDvrCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._events = [];
    this._loading = false;
    this._error = null;
    this._showSettings = false;
    this._modal = null;
    this._refreshTimer = null;
    this._lastRefresh = null;
    this._search = '';
    this._tagFilter = '';
    this._showFilter = false;
    this._currentIdx = 0;
    this._visibleCache = [];
    this._lastSignature = null;
    this._pendingRebuild = false;
    this._cameraStatus = null; // { online, recording, name }
    this._cameraSize = null;   // { width, height, sizeParam }
  }

  // Kamera-Dimensionen einmalig aus getObject laden
  async _fetchCameraSize() {
    if (this._cameraSize) return;
    const ip = this._config.ip_agentdvr;
    const oid = this._config.oid;
    try {
      const resp = await fetch(`http://${ip}:8090/command/getObject?oid=${oid}&ot=2`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return;
      const obj = await resp.json();
      const w = obj?.data?.width || obj?.width;
      const h = obj?.data?.height || obj?.height;
      if (w && h) {
        this._cameraSize = {
          width: w,
          height: h,
          name: obj?.name || obj?.data?.name || '',
        };
      }
    } catch { /* silent fail, kein size-Parameter */ }
  }

  // --- Lovelace API ---
  setConfig(config) {
    this._config = {
      ip_agentdvr: config.ip_agentdvr || '192.168.99.5',
      oid: config.oid || '1',
      anzahl: config.anzahl || 50,
      groesse: config.groesse || 'mittel',
      show_tags: config.show_tags !== false,
      show_live: config.show_live !== false,
      live_stream_url: config.live_stream_url || '',
      tag_position: config.tag_position || 'bottom-left',
      refresh_interval: config.refresh_interval ?? 30,
      title: config.title || 'AgentDVR Aufnahmen',
    };
    this._lastSignature = null;
    this._arDetected = false;
    this._cameraSize = null;
    this._render();
    this._startRefresh();
    this._fetchCameraSize().then(() => {
      // Seitenverhältnis als CSS-Variable setzen sobald Kameragröße bekannt
      if (this._cameraSize) {
        const { width, height } = this._cameraSize;
        const ar = (height / width * 100).toFixed(4);
        const card = this.shadowRoot.querySelector('ha-card');
        if (card) card.style.setProperty('--thumb-ar', `${ar}%`);
      }
      this._fetchEvents();
    });
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    if (firstHass && this._config?.ip_agentdvr && this.shadowRoot.querySelector('ha-card')) {
      if (this._lang() !== this._renderedLang) {
        this._render();
        this._renderGallery();
      }
    }
  }

  // Sprache aus HA-Locale, sonst Browser, sonst Englisch
  _lang() {
    const l = this._hass?.locale?.language || this._hass?.language || navigator.language || 'en';
    const code = l.slice(0, 2).toLowerCase();
    return AgentDvrCard.TRANSLATIONS[code] ? code : 'en';
  }

  // Übersetzten Text holen
  _t(key) {
    const lang = this._lang();
    return AgentDvrCard.TRANSLATIONS[lang]?.[key] ?? AgentDvrCard.TRANSLATIONS.en[key] ?? key;
  }

  static getConfigElement() {
    return document.createElement('agentdvr-card-editor');
  }

  static getStubConfig() {
    return { ip_agentdvr: '192.168.99.5', oid: '1' };
  }

  // --- Lifecycle ---
  connectedCallback() {
    this._startRefresh();
  }

  disconnectedCallback() {
    this._stopRefresh();
  }

  // --- Refresh ---
  _startRefresh() {
    this._stopRefresh();
    const interval = parseInt(this._config.refresh_interval, 10);
    if (interval > 0) {
      this._refreshTimer = setInterval(() => this._fetchEvents(), interval * 1000);
    }
  }

  _stopRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  // --- Data ---
  // Kompakte Signatur der Eventliste: Anzahl + neueste/älteste Datei.
  // Ändert sie sich nicht, hat sich an der Liste nichts geändert.
  _signature(events) {
    if (!events.length) return 'empty';
    const first = events[0].fn || '';
    const last = events[events.length - 1].fn || '';
    return `${events.length}|${first}|${last}`;
  }

  async _fetchEvents() {
    if (this._loading) return;
    this._loading = true;
    this._error = null;
    // Spinner nur beim allerersten Laden zeigen, sonst kein Flackern
    if (this._events.length === 0) this._renderGallery();

    const url = `http://${this._config.ip_agentdvr}:8090/q/getEvents?oid=${this._config.oid}&ot=2`;
    try {
      const [evResp, stResp] = await Promise.all([
        fetch(url, { signal: AbortSignal.timeout(5000) }),
        this._config.show_live
          ? fetch(`http://${this._config.ip_agentdvr}:8090/command/getStatus?oid=${this._config.oid}&ot=2`, { signal: AbortSignal.timeout(5000) })
          : Promise.resolve(null),
      ]);
      if (!evResp.ok) throw new Error(`HTTP ${evResp.status}`);
      const data = await evResp.json();
      const events = (data.events || []).slice(0, this._config.anzahl);
      this._lastRefresh = new Date();

      // Kamera-Status parsen
      if (stResp && stResp.ok) {
        try {
          const st = await stResp.json();
          // AgentDVR liefert Array oder einzelnes Objekt
          const s = Array.isArray(st) ? st[0] : st;
          this._cameraStatus = {
            online:    s?.online ?? s?.Online ?? true,
            recording: s?.recording ?? s?.Recording ?? false,
            name:      s?.name ?? s?.Name ?? '',
          };
        } catch { this._cameraStatus = null; }
      }
      this._lastRefresh = new Date();

      const newSig = this._signature(events);
      const changed = newSig !== this._lastSignature;
      this._events = events;
      this._lastSignature = newSig;

      this._loading = false;
      if (changed || this._error) {
        // Modal offen? Neuaufbau aufschieben, sonst fliegt man aus dem Video.
        if (this._isModalOpen()) {
          this._pendingRebuild = true;
          this._updateStatusBar();
        } else {
          this._renderGallery();         // Daten geändert → komplett neu
        }
      } else {
        this._updateStatusBar();         // unverändert → nur Zeitstempel
      }
    } catch (e) {
      this._error = e.message || this._t('connectionFailed');
      this._loading = false;
      this._renderGallery();
    }
  }

  // Aktualisiert nur die Statuszeile, ohne das Grid neu zu bauen
  _updateStatusBar() {
    const statusBar = this.shadowRoot.querySelector('.status-bar');
    if (!statusBar || !this._lastRefresh) return;
    const t = this._lastRefresh.toTimeString().slice(0, 8);
    const visible = this._visibleCache || [];
    const filtered = visible.length !== this._events.length;
    const count = filtered ? `${visible.length} ${this._t('of')} ${this._events.length}` : `${this._events.length}`;
    statusBar.textContent = `${count} ${this._t('recordings')} · ${this._t('updated')}: ${t}`;
  }

  _parseEvent(ev) {
    const fn_vid = ev.fn || '';
    const fn_jpg = fn_vid.slice(0, fn_vid.lastIndexOf('.')) + '_large.jpg';
    const size = Math.round((ev.sb / 1048576) * 100) / 100;
    const duration = ev.d;
    const tag = ev.tg || '';
    const ts = (parseFloat(ev.c) - 621355968000000000) / 10000;
    const dt = new Date(ts);
    const time = dt.toTimeString().slice(0, 5);
    const date = `${String(dt.getDate()).padStart(2,'0')}.${String(dt.getMonth()+1).padStart(2,'0')}.`;
    const ip = this._config.ip_agentdvr;
    const oid = this._config.oid;
    const url_thumb = `http://${ip}:8090/fileThumb.jpg?oid=${oid}&fn=${fn_jpg}`;
    const url_vid   = `http://${ip}:8090/streamFile.cgi?oid=${oid}&ot=2&fn=${fn_vid}`;
    return { fn_vid, fn_jpg, size, duration, tag, time, date, url_thumb, url_vid, dt, ts };
  }

  // Relative Zeit nur für heute, sonst Uhrzeit (Datum steht im Gruppen-Header)
  _relativeTime(dt) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    // Nicht von heute → Uhrzeit, Datum steht im Gruppen-Header
    if (dt.getTime() < startOfToday) return dt.toTimeString().slice(0, 5);
    // Heute → relative Angabe
    const diff = (Date.now() - dt.getTime()) / 1000;
    if (diff < 60)    return this._t('justNow');
    if (diff < 3600)  return this._t('minAgo').replace('{n}', Math.floor(diff / 60));
    return this._t('hAgo').replace('{n}', Math.floor(diff / 3600));
  }

  // Gruppen-Label: Heute / Gestern / Wochentag / Datum
  _dayLabel(dt) {
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(dt)) / 86400000);
    if (days === 0) return this._t('today');
    if (days === 1) return this._t('yesterday');
    const locale = this._lang() === 'de' ? 'de-DE' : 'en-US';
    if (days < 7) return dt.toLocaleDateString(locale, { weekday: 'long' });
    return dt.toLocaleDateString(locale, { day: '2-digit', month: 'long', year: 'numeric' });
  }

  // Sammelt alle vorkommenden Tags für den Filter
  _collectTags() {
    const set = new Set();
    this._events.forEach(ev => { const t = (ev.tg || '').trim(); if (t) set.add(t); });
    return Array.from(set).sort();
  }

  // Liefert die nach Filter/Suche sichtbaren Event-Indizes
  _visibleIndices() {
    const q = (this._search || '').toLowerCase().trim();
    const tagFilter = this._tagFilter || '';
    return this._events.map((ev, idx) => idx).filter(idx => {
      const ev = this._events[idx];
      const tag = (ev.tg || '').toLowerCase();
      if (tagFilter && (ev.tg || '') !== tagFilter) return false;
      if (q) {
        const p = this._parseEvent(ev);
        const hay = `${tag} ${p.date} ${p.time}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // --- Render ---
  _render() {
    this._renderedLang = this._lang();
    const shadow = this.shadowRoot;
    shadow.innerHTML = `
      <style>${this._styles()}</style>
      <ha-card>
        <div class="card-header">
          <span class="title">${this._config.title}</span>
          <div class="header-actions">
            <button class="icon-btn filter-btn" title="Suchen & Filtern">
              <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
            </button>
            <button class="icon-btn refresh-btn" title="Aktualisieren">
              <svg viewBox="0 0 24 24"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 8 8h-2a6 6 0 1 1-1.76-4.24l-2.24 2.24H20V4l-2.35 2.35z"/></svg>
            </button>
          </div>
        </div>
        <div class="filter-bar hidden">
          <div class="search-wrap">
            <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>
            <input class="search-input" type="text" placeholder="${this._t('searchPlaceholder')}">
            <button class="search-clear hidden" title="✕">
              <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
          <div class="tag-chips"></div>
        </div>
        <div class="gallery-wrap">
          <div class="gallery"></div>
          <div class="status-bar"></div>
        </div>
      </ha-card>
      <div class="modal hidden">
        <div class="modal-backdrop"></div>
        <button class="modal-nav modal-prev" title="Vorherige">
          <svg viewBox="0 0 24 24"><path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>
        </button>
        <button class="modal-nav modal-next" title="Nächste">
          <svg viewBox="0 0 24 24"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>
        </button>
        <div class="modal-content">
          <button class="modal-close">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
          <div class="modal-video-wrap">
            <video class="modal-video" controls autoplay playsinline></video>
          </div>
          <div class="modal-meta"></div>
        </div>
      </div>
    `;

    this._bindHeaderEvents();
    this._renderGallery();
  }

  _bindHeaderEvents() {
    const shadow = this.shadowRoot;
    shadow.querySelector('.refresh-btn').addEventListener('click', () => this._fetchEvents());

    // Filter-Leiste ein/aus
    shadow.querySelector('.filter-btn').addEventListener('click', () => {
      this._showFilter = !this._showFilter;
      shadow.querySelector('.filter-bar').classList.toggle('hidden', !this._showFilter);
      shadow.querySelector('.filter-btn').classList.toggle('active', this._showFilter);
      if (this._showFilter) shadow.querySelector('.search-input').focus();
    });

    // Suche
    const searchInput = shadow.querySelector('.search-input');
    const searchClear = shadow.querySelector('.search-clear');
    searchInput.value = this._search || '';
    searchInput.addEventListener('input', () => {
      this._search = searchInput.value;
      searchClear.classList.toggle('hidden', !searchInput.value);
      this._renderGallery();
    });
    searchClear.addEventListener('click', () => {
      this._search = '';
      searchInput.value = '';
      searchClear.classList.add('hidden');
      searchInput.focus();
      this._renderGallery();
    });

    // Modal
    shadow.querySelector('.modal-backdrop').addEventListener('click', () => this._closeModal());
    shadow.querySelector('.modal-close').addEventListener('click', () => this._closeModal());
    shadow.querySelector('.modal-prev').addEventListener('click', () => this._navModal(-1));
    shadow.querySelector('.modal-next').addEventListener('click', () => this._navModal(1));

    // Keyboard (einmalig global)
    if (!this._keyHandler) {
      this._keyHandler = (e) => {
        if (this.shadowRoot.querySelector('.modal').classList.contains('hidden')) return;
        if (e.key === 'Escape') this._closeModal();
        else if (e.key === 'ArrowLeft') this._navModal(-1);
        else if (e.key === 'ArrowRight') this._navModal(1);
      };
      document.addEventListener('keydown', this._keyHandler);
    }
  }

  _renderGallery() {
    const shadow = this.shadowRoot;
    if (!shadow.querySelector('.gallery')) return;

    const gallery = shadow.querySelector('.gallery');
    const statusBar = shadow.querySelector('.status-bar');

    // Grid-Größe als Variable für die Items
    const minSizes = { klein: '75', mittel: '100', gross: '150' };
    const minPx = minSizes[this._config.groesse] || '100';
    gallery.style.setProperty('--min-col', `${minPx}px`);

    // Loading
    if (this._loading && this._events.length === 0) {
      gallery.innerHTML = `<div class="loading-wrap"><div class="spinner"></div><span>${this._t('loading')}</span></div>`;
      return;
    }

    // Error
    if (this._error) {
      gallery.innerHTML = `<div class="error-wrap"><svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg><span>${this._error}</span></div>`;
      return;
    }

    // Tag-Chips aktualisieren
    this._renderTagChips();

    // Sichtbare Indizes nach Filter/Suche
    const visible = this._visibleIndices();
    this._visibleCache = visible; // für Modal-Navigation (Live-Element NICHT drin)

    if (visible.length === 0 && !this._config.show_live) {
      gallery.innerHTML = `<div class="empty-wrap"><svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg><span>${this._t('noResults')}</span></div>`;
      if (this._lastRefresh) statusBar.textContent = `0 ${this._t('of')} ${this._events.length} ${this._t('recordings')}`;
      return;
    }

    // Nach Datum gruppieren
    const groups = [];
    const groupMap = new Map();
    visible.forEach(idx => {
      const p = this._parseEvent(this._events[idx]);
      const label = this._dayLabel(p.dt);
      if (!groupMap.has(label)) {
        const g = { label, items: [] };
        groupMap.set(label, g);
        groups.push(g);
      }
      groupMap.get(label).items.push({ idx, p });
    });

    // Live-Thumbnail HTML bauen
    const liveHtml = this._buildLiveThumb();

    // Gruppen rendern, Live-Element vor die erste Heute-Gruppe setzen
    let liveInserted = false;
    gallery.innerHTML = groups.map(g => {
      const isToday = g.label === this._t('today');
      const items = g.items.map(({ idx, p }) => {
        const [tv, tl] = this._config.tag_position.split('-');
        const tagHtml = (this._config.show_tags && p.tag)
          ? `<span class="tag" style="${tv}:5px;${tl}:5px">${p.tag}</span>`
          : '';
        return `
          <div class="thumb-item" data-idx="${idx}">
            <div class="thumb-img-wrap">
              <img src="${p.url_thumb}" loading="lazy" alt="${p.date} ${p.time}"
                   onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 75%22><rect fill=%22%23333%22 width=%22100%22 height=%2275%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%23666%22 font-size=%2210%22 text-anchor=%22middle%22 dy=%22.3em%22>No image</text></svg>'">
              ${tagHtml}
              <div class="thumb-overlay">
                <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </div>
            </div>
            <div class="thumb-info">
              <span class="thumb-datetime">${this._relativeTime(p.dt)}</span>
              <span class="thumb-meta">${p.duration}s · ${p.size} MB</span>
            </div>
          </div>`;
      }).join('');

      // Live vor erste Heute-Gruppe; wenn kein Heute, vor erster Gruppe
      const prefix = (liveHtml && (isToday || (!liveInserted && g === groups[0])))
        ? (() => { liveInserted = true; return liveHtml; })()
        : '';

      return `
        <div class="day-group">
          <div class="day-header"><span>${g.label}</span><span class="day-count">${g.items.length}</span></div>
          <div class="day-grid">${prefix}${items}</div>
        </div>`;
    }).join('');

    // Falls keine Gruppen aber Live vorhanden (alle gefiltert weg)
    if (!liveInserted && liveHtml) {
      gallery.innerHTML = `<div class="day-group"><div class="day-grid">${liveHtml}</div></div>`;
    }

    // Klick → Modal (Aufnahmen)
    gallery.querySelectorAll('.thumb-item').forEach(item => {
      item.addEventListener('click', () => {
        this._openModal(parseInt(item.dataset.idx, 10));
      });
    });

    // Klick → Livestream Modal
    const liveEl = gallery.querySelector('.thumb-item-live');
    if (liveEl) {
      liveEl.addEventListener('click', () => this._openLiveModal());
    }

    // Status bar
    if (this._lastRefresh) {
      const t = this._lastRefresh.toTimeString().slice(0, 8);
      const filtered = visible.length !== this._events.length;
      const count = filtered ? `${visible.length} ${this._t('of')} ${this._events.length}` : `${this._events.length}`;
      statusBar.textContent = `${count} ${this._t('recordings')} · ${this._t('updated')}: ${t}`;
      if (this._loading) statusBar.textContent += ` · ${this._t('loadingShort')}`;
    }
  }

  // Ermittelt das echte Kamera-Seitenverhältnis aus grab.jpg und setzt --ar.
  // Läuft nur einmal, danach gecacht.
  _detectAspectRatio() {
    if (this._arDetected) return;
    this._arDetected = true;
    const ip = this._config.ip_agentdvr;
    const oid = this._config.oid;
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth && probe.naturalHeight) {
        const ratio = (probe.naturalHeight / probe.naturalWidth * 100).toFixed(4);
        const card = this.shadowRoot.querySelector('ha-card');
        if (card) card.style.setProperty('--ar', `${ratio}%`);
        const modal = this.shadowRoot.querySelector('.modal-content');
        if (modal) modal.style.setProperty('--ar', `${ratio}%`);
      }
    };
    probe.onerror = () => { this._arDetected = false; }; // bei Fehler erneut versuchen
    probe.src = `http://${ip}:8090/grab.jpg?oid=${oid}&ot=2&ts=${Date.now()}`;
  }

  // Live-Thumbnail HTML
  _buildLiveThumb() {
    if (!this._config.show_live) return '';
    const ip = this._config.ip_agentdvr;
    const oid = this._config.oid;
    const grabUrl = `http://${ip}:8090/grab.jpg?oid=${oid}&ot=2&maintainAR=1&ts=${Date.now()}`;
    const sz = this._cameraSize ? `&size=${this._cameraSize.width}x${this._cameraSize.height}` : '';
    const streamUrl = `http://${ip}:8090/video.webm?oid=${oid}&ot=2${sz}`;
    const st = this._cameraStatus;
    let statusLabel = this._t('live');
    let statusClass = 'live-badge-online';
    if (st) {
      if (!st.online)       { statusLabel = this._t('offline'); statusClass = 'live-badge-offline'; }
      else if (st.recording){ statusLabel = this._t('rec');     statusClass = 'live-badge-rec'; }
    }
    return `
      <div class="thumb-item thumb-item-live">
        <div class="thumb-img-wrap">
          <img src="${grabUrl}" alt="Live"
               onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 75%22><rect fill=%22%23222%22 width=%22100%22 height=%2275%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%23666%22 font-size=%2210%22 text-anchor=%22middle%22 dy=%22.3em%22>Offline</text></svg>'">
          <span class="live-badge ${statusClass}">
            <span class="live-dot"></span>${statusLabel}
          </span>
          <div class="thumb-overlay">
            <svg viewBox="0 0 24 24"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>
          </div>
        </div>
        <div class="thumb-info">
          <span class="thumb-datetime">${this._t('now')}</span>
          <span class="thumb-meta">${this._cameraSize?.name || st?.name || this._t('camera')}</span>
        </div>
      </div>`;
  }

  // Livestream im Modal öffnen
  _openLiveModal() {
    const ip = this._config.ip_agentdvr;
    const oid = this._config.oid;
    const modal = this.shadowRoot.querySelector('.modal');
    const video = modal.querySelector('.modal-video');
    const meta  = modal.querySelector('.modal-meta');
    const st = this._cameraStatus;
    const videoWrap = modal.querySelector('.modal-video-wrap');

    // Alternativen Stream nutzen, falls konfiguriert
    const altUrl = (this._config.live_stream_url || '').trim();
    const isDirectVideo = /\.(webm|mp4|m3u8|mov|ogg|ogv)(\?|$)/i.test(altUrl);

    // Aufräumen: altes iframe/img entfernen
    const oldImg = modal.querySelector('.mjpeg-stream');
    if (oldImg) { oldImg.src = ''; oldImg.style.display = 'none'; }
    let iframe = modal.querySelector('.stream-iframe');
    let audioAvailable = true;

    if (altUrl && !isDirectVideo) {
      // --- Externe Player-Seite via iframe (z.B. go2rtc) ---
      video.style.display = 'none';
      video.src = '';
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.className = 'stream-iframe';
        iframe.allow = 'autoplay; fullscreen';
        iframe.frameBorder = '0';
        video.parentNode.insertBefore(iframe, video);
      }
      iframe.style.display = 'block';
      iframe.src = altUrl;
      videoWrap.classList.add('has-stream-iframe');
      videoWrap.classList.remove('has-stream-video');
      audioAvailable = false; // Ton steuert die externe Seite selbst
    } else {
      // --- Natives video-Element (AgentDVR-WebM oder direkte Video-URL) ---
      if (iframe) { iframe.src = ''; iframe.style.display = 'none'; }
      const sz = this._cameraSize ? `&size=${this._cameraSize.width}x${this._cameraSize.height}` : '';
      const streamUrl = altUrl && isDirectVideo
        ? altUrl
        : `http://${ip}:8090/video.webm?oid=${oid}&ot=2${sz}`;
      video.style.display = 'block';
      video.removeAttribute('controls');
      video.muted = true;
      video.src = streamUrl;
      video.play().catch(() => {});
      videoWrap.classList.add('has-stream-video');
      videoWrap.classList.remove('has-stream-iframe');
    }

    meta.innerHTML = `
      <div class="meta-row">
        <span class="live-badge live-badge-${st?.recording ? 'rec' : 'online'}" style="font-size:.8rem;padding:4px 10px">
          <span class="live-dot"></span>${st?.recording ? this._t('rec') : this._t('live')}
        </span>
      </div>
      <div class="meta-row"><span class="meta-label">${this._t('camera')}</span><span>${this._cameraSize?.name || st?.name || oid}</span></div>
      ${audioAvailable ? `
      <button class="audio-btn" title="${this._t('soundOn')}/${this._t('soundOff')}">
        <svg class="icon-muted" viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
        <svg class="icon-sound" viewBox="0 0 24 24" style="display:none"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
        <span class="audio-label">${this._t('soundOff')}</span>
      </button>` : ''}
    `;

    // Audio-Toggle (nur bei nativem Video)
    const audioBtn = meta.querySelector('.audio-btn');
    if (audioBtn) {
      audioBtn.addEventListener('click', () => {
        video.muted = !video.muted;
        audioBtn.querySelector('.icon-muted').style.display = video.muted ? '' : 'none';
        audioBtn.querySelector('.icon-sound').style.display = video.muted ? 'none' : '';
        audioBtn.querySelector('.audio-label').textContent = video.muted ? this._t('soundOff') : this._t('soundOn');
        audioBtn.classList.toggle('active', !video.muted);
      });
    }

    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Nav-Pfeile ausblenden beim Livestream
    this.shadowRoot.querySelector('.modal-prev').style.display = 'none';
    this.shadowRoot.querySelector('.modal-next').style.display = 'none';
  }

  _renderTagChips() {
    const wrap = this.shadowRoot.querySelector('.tag-chips');
    if (!wrap) return;
    const tags = this._collectTags();
    if (tags.length === 0) { wrap.innerHTML = ''; return; }

    const chip = (val, label) =>
      `<button class="chip ${this._tagFilter === val ? 'active' : ''}" data-tag="${val}">${label}</button>`;
    wrap.innerHTML = chip('', this._t('all')) + tags.map(t => chip(t, t)).join('');

    wrap.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        this._tagFilter = btn.dataset.tag;
        this._renderGallery();
      });
    });
  }

  // --- Modal ---
  _openModal(idx) {
    this._currentIdx = idx;
    this._showModalContent(idx);
    const modal = this.shadowRoot.querySelector('.modal');
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    this._updateNavButtons();
  }

  _showModalContent(idx) {
    const p = this._parseEvent(this._events[idx]);
    const modal = this.shadowRoot.querySelector('.modal');
    const video = modal.querySelector('.modal-video');
    const meta  = modal.querySelector('.modal-meta');

    video.src = p.url_vid;
    meta.innerHTML = `
      <div class="meta-row"><span class="meta-label">${this._t('date')}</span><span>${p.date} ${p.time}</span></div>
      <div class="meta-row"><span class="meta-label">${this._t('duration')}</span><span>${p.duration} s</span></div>
      <div class="meta-row"><span class="meta-label">${this._t('size')}</span><span>${p.size} MB</span></div>
      ${p.tag ? `<div class="meta-row"><span class="meta-label">${this._t('tag')}</span><span>${p.tag}</span></div>` : ''}
      <a class="download-btn" href="${p.url_vid}" download target="_blank">
        <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
        ${this._t('download')}
      </a>
    `;
  }

  // Navigation innerhalb der aktuell sichtbaren (gefilterten) Liste
  _navModal(dir) {
    const visible = this._visibleCache || this._visibleIndices();
    const pos = visible.indexOf(this._currentIdx);
    if (pos === -1) return;
    const newPos = pos + dir;
    if (newPos < 0 || newPos >= visible.length) return;
    this._currentIdx = visible[newPos];
    this._showModalContent(this._currentIdx);
    this._updateNavButtons();
  }

  _updateNavButtons() {
    const visible = this._visibleCache || this._visibleIndices();
    const pos = visible.indexOf(this._currentIdx);
    const prev = this.shadowRoot.querySelector('.modal-prev');
    const next = this.shadowRoot.querySelector('.modal-next');
    prev.classList.toggle('nav-disabled', pos <= 0);
    next.classList.toggle('nav-disabled', pos >= visible.length - 1);
  }

  _isModalOpen() {
    const modal = this.shadowRoot.querySelector('.modal');
    return modal && !modal.classList.contains('hidden');
  }

  _closeModal() {
    const modal = this.shadowRoot.querySelector('.modal');
    const video = modal.querySelector('.modal-video');
    video.pause();
    video.src = '';
    video.style.display = '';
    video.setAttribute('controls', ''); // für Aufnahmen wieder aktivieren
    video.muted = false;
    // evtl. altes MJPEG-img aufräumen
    const mjpeg = modal.querySelector('.mjpeg-stream');
    if (mjpeg) { mjpeg.src = ''; mjpeg.style.display = 'none'; }
    const iframe = modal.querySelector('.stream-iframe');
    if (iframe) { iframe.src = ''; iframe.style.display = 'none'; }
    const videoWrap = modal.querySelector('.modal-video-wrap');
    videoWrap.classList.remove('has-stream', 'has-stream-video', 'has-stream-iframe');
    videoWrap.style.paddingTop = '';
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    // Nav-Pfeile wiederherstellen
    this.shadowRoot.querySelector('.modal-prev').style.display = '';
    this.shadowRoot.querySelector('.modal-next').style.display = '';
    // Aufgeschobenen Neuaufbau nachholen
    if (this._pendingRebuild) {
      this._pendingRebuild = false;
      this._renderGallery();
    }
  }

  // --- Styles ---
  _styles() {
    return `
      :host {
        display: block;
      }

      ha-card {
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        border-radius: var(--ha-card-border-radius, 12px);
        box-shadow: var(--ha-card-box-shadow, 0 2px 8px rgba(0,0,0,.15));
        overflow: hidden;
        font-family: var(--paper-font-body1_-_font-family, sans-serif);
      }

      /* Header */
      .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px 10px;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.12));
      }
      .title {
        font-size: 1rem;
        font-weight: 500;
        color: var(--primary-text-color);
        letter-spacing: .01em;
      }
      .header-actions {
        display: flex;
        gap: 4px;
      }
      .icon-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 6px;
        border-radius: 50%;
        color: var(--secondary-text-color, #727272);
        display: flex;
        align-items: center;
        transition: background .15s, color .15s;
      }
      .icon-btn:hover {
        background: var(--secondary-background-color, rgba(0,0,0,.06));
        color: var(--primary-text-color);
      }
      .icon-btn.active {
        color: var(--accent-color, #6200ee);
        background: var(--secondary-background-color, rgba(0,0,0,.06));
      }
      .icon-btn svg {
        width: 20px;
        height: 20px;
        fill: currentColor;
      }

      /* Filter-Leiste */
      .filter-bar {
        padding: 10px 16px 12px;
        border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.12));
        background: var(--secondary-background-color, rgba(0,0,0,.02));
        animation: slideDown .18s ease;
      }
      .filter-bar.hidden { display: none; }
      @keyframes slideDown {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .search-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        background: var(--card-background-color, #fff);
        border: 1px solid var(--divider-color, rgba(0,0,0,.18));
        border-radius: 8px;
        padding: 0 10px;
        transition: border-color .15s;
      }
      .search-wrap:focus-within {
        border-color: var(--primary-color, var(--accent-color, #03a9f4));
      }
      .search-wrap > svg {
        width: 18px; height: 18px;
        fill: var(--secondary-text-color, #888);
        flex-shrink: 0;
      }
      .search-input {
        flex: 1;
        border: none;
        outline: none;
        background: transparent;
        color: var(--primary-text-color);
        font-size: .9rem;
        padding: 9px 0;
      }
      .search-clear {
        background: none; border: none; cursor: pointer;
        padding: 2px; display: flex; border-radius: 50%;
        color: var(--secondary-text-color, #888);
      }
      .search-clear.hidden { display: none; }
      .search-clear svg { width: 16px; height: 16px; fill: currentColor; }
      .search-clear:hover { color: var(--primary-text-color); }

      .tag-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }
      .tag-chips:empty { margin-top: 0; }
      .chip {
        background: var(--card-background-color, #fff);
        color: var(--secondary-text-color, #666);
        border: 1px solid var(--divider-color, rgba(0,0,0,.18));
        border-radius: 14px;
        padding: 4px 12px;
        font-size: .78rem;
        cursor: pointer;
        transition: all .15s;
        white-space: nowrap;
      }
      .chip:hover {
        border-color: var(--primary-color, var(--accent-color, #03a9f4));
        color: var(--primary-text-color);
      }
      .chip.active {
        background: var(--primary-color, var(--accent-color, #03a9f4));
        color: var(--text-primary-color, #fff);
        border-color: transparent;
      }

      /* Gallery / Gruppen */
      .gallery-wrap { padding: 12px; }
      .gallery {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .day-group { display: flex; flex-direction: column; gap: 8px; }
      .day-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: .82rem;
        font-weight: 600;
        color: var(--secondary-text-color, #727272);
        text-transform: uppercase;
        letter-spacing: .03em;
        padding: 0 2px;
      }
      .day-count {
        font-weight: 500;
        font-size: .72rem;
        background: var(--secondary-background-color, rgba(0,0,0,.06));
        border-radius: 10px;
        padding: 1px 8px;
        text-transform: none;
        letter-spacing: 0;
      }
      .day-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(var(--min-col, 100px), 1fr));
        gap: 8px;
      }

      .empty-wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 32px 16px;
        color: var(--secondary-text-color);
        font-size: .875rem;
      }
      .empty-wrap svg { width: 30px; height: 30px; fill: var(--disabled-text-color, #bbb); }

      /* Live-Badge */
      .live-badge {
        position: absolute;
        top: 5px;
        left: 5px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 7px 2px 5px;
        border-radius: 4px;
        font-size: .65rem;
        font-weight: 600;
        letter-spacing: .04em;
        background: rgba(0,0,0,.5);
        color: #fff;
        pointer-events: none;
        backdrop-filter: blur(2px);
      }
      .live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        flex-shrink: 0;
        animation: livepulse 1.6s ease-in-out infinite;
      }
      .live-badge-online .live-dot  { background: #4caf50; box-shadow: 0 0 0 0 rgba(76,175,80,.6); }
      .live-badge-rec .live-dot     { background: #f44336; box-shadow: 0 0 0 0 rgba(244,67,54,.6); }
      .live-badge-offline .live-dot { background: #9e9e9e; animation: none; }
      @keyframes livepulse {
        0%   { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
        60%  { box-shadow: 0 0 0 5px transparent; opacity: .8; }
        100% { box-shadow: 0 0 0 0 transparent; opacity: 1; }
      }
      .live-badge-online .live-dot  { color: rgba(76,175,80,.5); }
      .live-badge-rec    .live-dot  { color: rgba(244,67,54,.5); }

      /* Thumb */
      .thumb-item {
        cursor: pointer;
        border-radius: 8px;
        overflow: hidden;
        background: var(--secondary-background-color, rgba(0,0,0,.04));
        transition: transform .15s, box-shadow .15s;
      }
      .thumb-item:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 18px rgba(0,0,0,.18);
      }
      .thumb-img-wrap {
        position: relative;
        width: 100%;
        padding-top: var(--thumb-ar, 56.25%);
        background: var(--secondary-background-color);
        overflow: hidden;
        border-radius: 8px 8px 0 0;
      }
      .thumb-img-wrap img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center center;
        display: block;
      }
      .tag {
        position: absolute;
        background: rgba(0,0,0,.55);
        color: #fff;
        font-size: .65rem;
        padding: 2px 5px;
        border-radius: 4px;
        line-height: 1.3;
        pointer-events: none;
        max-width: 80%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .thumb-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,.35);
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity .15s;
      }
      .thumb-item:hover .thumb-overlay { opacity: 1; }
      .thumb-overlay svg {
        width: 36px;
        height: 36px;
        fill: rgba(255,255,255,.9);
        filter: drop-shadow(0 2px 4px rgba(0,0,0,.5));
      }
      .thumb-info {
        padding: 5px 6px 6px;
        display: flex;
        flex-direction: row;
        justify-content: space-between;
        align-items: baseline;
        gap: 4px;
        background: color-mix(in srgb, var(--primary-text-color, #000) 8%, transparent);
        border-radius: 0 0 8px 8px;
      }
      .thumb-datetime {
        font-size: .75rem;
        color: var(--primary-text-color);
        font-weight: 500;
        white-space: nowrap;
      }
      .thumb-meta {
        font-size: .68rem;
        color: var(--secondary-text-color, #727272);
        white-space: nowrap;
      }

      /* Status bar */
      .status-bar {
        text-align: right;
        font-size: .7rem;
        color: var(--disabled-text-color, #bdbdbd);
        padding-top: 6px;
      }

      /* Loading / Error */
      .loading-wrap, .error-wrap {
        grid-column: 1 / -1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 32px 16px;
        color: var(--secondary-text-color);
        font-size: .875rem;
      }
      .error-wrap svg {
        width: 32px;
        height: 32px;
        fill: var(--error-color, #b00020);
      }
      .spinner {
        width: 28px;
        height: 28px;
        border: 3px solid var(--divider-color, rgba(0,0,0,.12));
        border-top-color: var(--accent-color, #6200ee);
        border-radius: 50%;
        animation: spin .7s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* Modal */
      .modal {
        position: fixed;
        inset: 0;
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fadeIn .18s ease;
      }
      .modal.hidden { display: none; }
      @keyframes fadeIn {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      .modal-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,.75);
        backdrop-filter: blur(3px);
      }
      .modal-nav {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        z-index: 2;
        background: rgba(0,0,0,.4);
        border: none;
        border-radius: 50%;
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: #fff;
        transition: background .15s, opacity .15s;
      }
      .modal-nav:hover { background: rgba(0,0,0,.65); }
      .modal-nav svg { width: 26px; height: 26px; fill: currentColor; }
      .modal-prev { left: max(12px, calc(50vw - 480px)); }
      .modal-next { right: max(12px, calc(50vw - 480px)); }
      .modal-nav.nav-disabled {
        opacity: .25;
        pointer-events: none;
      }
      .modal-content {
        position: relative;
        z-index: 1;
        background: var(--card-background-color, #fff);
        border-radius: 12px;
        box-shadow: 0 24px 48px rgba(0,0,0,.4);
        width: min(92vw, 860px);
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: popIn .2s ease;
        gap: 0;
      }
      @keyframes popIn {
        from { transform: scale(.92); opacity: 0; }
        to   { transform: scale(1);   opacity: 1; }
      }
      .modal-close {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 2;
        background: rgba(0,0,0,.45);
        border: none;
        border-radius: 50%;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: #fff;
        transition: background .15s;
      }
      .modal-close:hover { background: rgba(0,0,0,.7); }
      .modal-close svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }
      .modal-video-wrap {
        background: var(--card-background-color, #fff);
        font-size: 0;
        overflow: hidden;
        border-radius: 12px 12px 0 0;
      }
      .modal-video-wrap.has-stream {
        padding-top: 0;
      }
      .modal-video-wrap.has-stream .mjpeg-stream {
        position: static;
        width: 100%;
        height: auto;
        display: block;
      }
      .modal-video-wrap.has-stream-video {
        background: #000;
      }
      .modal-video-wrap.has-stream-video .modal-video {
        width: 100%;
        height: auto;
        display: block;
      }
      .modal-video-wrap.has-stream-iframe {
        position: relative;
        width: 100%;
        padding-top: var(--thumb-ar, 56.25%);
        background: #000;
      }
      .stream-iframe {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
      }
      .modal-video {
        width: 100%;
        height: auto;
        display: block;
        vertical-align: top;
      }
      .mjpeg-stream {
        width: 100%;
        display: block;
        object-fit: contain;
        background: var(--card-background-color, #fff);
        vertical-align: top;
      }
      .modal-meta {
        padding: 14px 18px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px 20px;
        align-items: center;
      }
      .meta-row {
        display: flex;
        gap: 6px;
        align-items: center;
        font-size: .875rem;
        color: var(--primary-text-color);
      }
      .meta-label {
        color: var(--secondary-text-color, #727272);
        font-size: .75rem;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: .04em;
      }
      .download-btn {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
        background: var(--accent-color, #6200ee);
        color: var(--text-accent-color, #fff);
        text-decoration: none;
        border-radius: 6px;
        padding: 7px 14px;
        font-size: .8rem;
        font-weight: 500;
        transition: opacity .15s;
      }
      .download-btn:hover { opacity: .85; }
      .download-btn svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }
      .audio-btn {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 6px;
        background: var(--secondary-background-color, rgba(128,128,128,.15));
        color: var(--primary-text-color);
        border: 1px solid var(--divider-color, rgba(0,0,0,.15));
        border-radius: 6px;
        padding: 7px 14px;
        font-size: .8rem;
        font-weight: 500;
        cursor: pointer;
        transition: all .15s;
      }
      .audio-btn:hover { border-color: var(--primary-color, var(--accent-color, #03a9f4)); }
      .audio-btn.active {
        background: var(--primary-color, var(--accent-color, #03a9f4));
        color: var(--text-primary-color, #fff);
        border-color: transparent;
      }
      .audio-btn svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }
    `;
  }

  getCardSize() {
    return 6;
  }
}

// --- Übersetzungen (weitere Sprachen einfach als neuen Block ergänzen) ---
AgentDvrCard.TRANSLATIONS = {
  de: {
    defaultTitle: 'AgentDVR Aufnahmen',
    connectionFailed: 'Verbindung fehlgeschlagen',
    recordings: 'Aufnahmen',
    updated: 'Aktualisiert',
    loading: 'Lade Aufnahmen…',
    loadingShort: 'Lade…',
    justNow: 'gerade eben',
    minAgo: 'vor {n} Min.',
    hAgo: 'vor {n} Std.',
    today: 'Heute',
    yesterday: 'Gestern',
    noResults: 'Keine Treffer',
    of: 'von',
    live: 'Live',
    offline: 'Offline',
    rec: 'REC',
    camera: 'Kamera',
    now: 'jetzt',
    soundOff: 'Ton aus',
    soundOn: 'Ton an',
    searchPlaceholder: 'Suchen (Tag, Datum, Uhrzeit)…',
    all: 'Alle',
    download: 'Download',
    date: 'Datum',
    duration: 'Dauer',
    size: 'Größe',
    tag: 'Tag',
  },
  en: {
    defaultTitle: 'AgentDVR Recordings',
    connectionFailed: 'Connection failed',
    recordings: 'recordings',
    updated: 'Updated',
    loading: 'Loading recordings…',
    loadingShort: 'Loading…',
    justNow: 'just now',
    minAgo: '{n} min ago',
    hAgo: '{n} h ago',
    today: 'Today',
    yesterday: 'Yesterday',
    noResults: 'No results',
    of: 'of',
    live: 'Live',
    offline: 'Offline',
    rec: 'REC',
    camera: 'Camera',
    now: 'now',
    soundOff: 'Sound off',
    soundOn: 'Sound on',
    searchPlaceholder: 'Search (tag, date, time)…',
    all: 'All',
    download: 'Download',
    date: 'Date',
    duration: 'Duration',
    size: 'Size',
    tag: 'Tag',
  },
};

customElements.define('agentdvr-card', AgentDvrCard);


/* ============================================================
 *  GUI Editor – erscheint im Dashboard beim Anlegen/Bearbeiten
 * ============================================================ */
class AgentDvrCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = {};
    this._rendered = false;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    const firstHass = !this._hass;
    this._hass = hass;
    if (firstHass && this._rendered) {
      // Sprache jetzt bekannt → Editor neu aufbauen
      this._rendered = false;
      this._render();
    }
  }

  _lang() {
    const l = this._hass?.locale?.language || this._hass?.language || navigator.language || 'en';
    const code = l.slice(0, 2).toLowerCase();
    return AgentDvrCardEditor.T[code] ? code : 'en';
  }

  _t(key) {
    const lang = this._lang();
    return AgentDvrCardEditor.T[lang]?.[key] ?? AgentDvrCardEditor.T.en[key] ?? key;
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: this._config },
      bubbles: true,
      composed: true,
    }));
  }

  _update(key, value) {
    if (value === '' || value === null || value === undefined) {
      delete this._config[key];
    } else {
      this._config[key] = value;
    }
    this._emit();
  }

  _render() {
    const c = this._config;
    if (!this._rendered) {
      this.shadowRoot.innerHTML = `
        <style>
          .form {
            display: flex;
            flex-direction: column;
            gap: 14px;
            padding: 4px 2px;
          }
          .row {
            display: flex;
            gap: 12px;
          }
          .row > .field { flex: 1; }
          .field {
            display: flex;
            flex-direction: column;
            gap: 5px;
          }
          label {
            font-size: .8rem;
            color: var(--secondary-text-color, #727272);
            font-weight: 500;
          }
          input, select {
            background: var(--card-background-color, #fff);
            color: var(--primary-text-color, #212121);
            border: 1px solid var(--divider-color, rgba(0,0,0,.25));
            border-radius: 6px;
            padding: 9px 10px;
            font-size: .9rem;
            outline: none;
            transition: border-color .15s;
            box-sizing: border-box;
            width: 100%;
          }
          input:focus, select:focus {
            border-color: var(--primary-color, var(--accent-color, #03a9f4));
          }
          .switch-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 4px 0;
          }
          .switch-row label { font-size: .9rem; color: var(--primary-text-color); }
          input[type=checkbox] {
            width: 20px; height: 20px;
            accent-color: var(--primary-color, var(--accent-color, #03a9f4));
            cursor: pointer;
          }
          .hint {
            font-size: .72rem;
            color: var(--secondary-text-color, #999);
            margin-top: -2px;
          }
          .label-with-help {
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .help-btn {
            width: 18px;
            height: 18px;
            border-radius: 50%;
            border: 1px solid var(--secondary-text-color, #999);
            background: transparent;
            color: var(--secondary-text-color, #999);
            font-size: .72rem;
            font-weight: 700;
            line-height: 1;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            flex-shrink: 0;
            transition: all .15s;
          }
          .help-btn:hover, .help-btn.active {
            background: var(--primary-color, var(--accent-color, #03a9f4));
            color: var(--text-primary-color, #fff);
            border-color: transparent;
          }
          .help-box {
            margin-top: 8px;
            padding: 12px 14px;
            background: var(--secondary-background-color, rgba(128,128,128,.12));
            border-radius: 8px;
            font-size: .78rem;
            line-height: 1.5;
            color: var(--primary-text-color);
          }
          .help-box.hidden { display: none; }
          .help-box strong { color: var(--primary-text-color); }
        </style>
        <div class="form">
          <div class="field">
            <label>${this._t('title')}</label>
            <input id="title" type="text" placeholder="AgentDVR">
          </div>
          <div class="row">
            <div class="field">
              <label>${this._t('ip')}</label>
              <input id="ip_agentdvr" type="text" placeholder="192.168.99.5">
            </div>
            <div class="field">
              <label>${this._t('oid')}</label>
              <input id="oid" type="text" placeholder="1">
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label>${this._t('count')}</label>
              <input id="anzahl" type="number" min="1" max="500" placeholder="50">
            </div>
            <div class="field">
              <label>${this._t('refresh')}</label>
              <input id="refresh_interval" type="number" min="0" placeholder="30">
            </div>
          </div>
          <div class="hint">${this._t('refreshHint')}</div>
          <div class="row">
            <div class="field">
              <label>${this._t('thumbSize')}</label>
              <select id="groesse">
                <option value="klein">${this._t('sizeSmall')}</option>
                <option value="mittel">${this._t('sizeMedium')}</option>
                <option value="gross">${this._t('sizeLarge')}</option>
              </select>
            </div>
            <div class="field">
              <label>${this._t('tagPosition')}</label>
              <select id="tag_position">
                <option value="top-left">${this._t('topLeft')}</option>
                <option value="top-right">${this._t('topRight')}</option>
                <option value="bottom-left">${this._t('bottomLeft')}</option>
                <option value="bottom-right">${this._t('bottomRight')}</option>
              </select>
            </div>
          </div>
          <div class="switch-row">
            <label for="show_live">${this._t('showLive')}</label>
            <input id="show_live" type="checkbox">
          </div>
          <div class="field">
            <label class="label-with-help">
              ${this._t('altStream')}
              <button type="button" class="help-btn" title="${this._t('formatInfo')}">?</button>
            </label>
            <input id="live_stream_url" type="text" placeholder="${this._t('altStreamPlaceholder')}">
            <div class="help-box hidden">
              <strong>${this._t('helpDirectTitle')}</strong> ${this._t('helpDirectText')}<br>
              .webm, .mp4, .m3u8, .mov, .ogg, .ogv<br><br>
              <strong>${this._t('helpEmbedTitle')}</strong> ${this._t('helpEmbedText')}<br><br>
              <strong>${this._t('helpNotPossibleTitle')}</strong> ${this._t('helpNotPossibleText')}
            </div>
          </div>
          <div class="hint">${this._t('altStreamHint')}</div>
          <div class="switch-row">
            <label for="show_tags">${this._t('showTags')}</label>
            <input id="show_tags" type="checkbox">
          </div>
        </div>
      `;

      // Event-Listener (einmalig)
      const bindText = (id) => {
        const el = this.shadowRoot.getElementById(id);
        el.addEventListener('input', () => this._update(id, el.value));
      };
      const bindNum = (id) => {
        const el = this.shadowRoot.getElementById(id);
        el.addEventListener('input', () => {
          this._update(id, el.value === '' ? '' : Number(el.value));
        });
      };
      const bindSel = (id) => {
        const el = this.shadowRoot.getElementById(id);
        el.addEventListener('change', () => this._update(id, el.value));
      };

      bindText('title');
      bindText('ip_agentdvr');
      bindText('oid');
      bindText('live_stream_url');

      // Hilfe-Box ein/ausklappen
      const helpBtn = this.shadowRoot.querySelector('.help-btn');
      const helpBox = this.shadowRoot.querySelector('.help-box');
      if (helpBtn && helpBox) {
        helpBtn.addEventListener('click', () => {
          helpBox.classList.toggle('hidden');
          helpBtn.classList.toggle('active');
        });
      }
      bindNum('anzahl');
      bindNum('refresh_interval');
      bindSel('groesse');
      bindSel('tag_position');

      const live = this.shadowRoot.getElementById('show_live');
      live.addEventListener('change', () => this._update('show_live', live.checked));
      const tags = this.shadowRoot.getElementById('show_tags');
      tags.addEventListener('change', () => this._update('show_tags', tags.checked));

      this._rendered = true;
    }

    // Werte setzen
    const set = (id, val) => { const el = this.shadowRoot.getElementById(id); if (el) el.value = val ?? ''; };
    set('title', c.title);
    set('ip_agentdvr', c.ip_agentdvr);
    set('oid', c.oid);
    set('live_stream_url', c.live_stream_url);
    set('anzahl', c.anzahl);
    set('refresh_interval', c.refresh_interval);
    set('groesse', c.groesse || 'mittel');
    set('tag_position', c.tag_position || 'bottom-left');
    this.shadowRoot.getElementById('show_live').checked = c.show_live !== false;
    this.shadowRoot.getElementById('show_tags').checked = c.show_tags !== false;
  }
}

AgentDvrCardEditor.T = {
  de: {
    title: 'Titel',
    ip: 'IP AgentDVR',
    oid: 'OID (Kamera)',
    count: 'Anzahl Einträge',
    refresh: 'Refresh (Sek.)',
    refreshHint: 'Refresh = 0 deaktiviert das automatische Aktualisieren.',
    thumbSize: 'Thumbnail-Größe',
    sizeSmall: 'Klein (75px)',
    sizeMedium: 'Mittel (100px)',
    sizeLarge: 'Groß (150px)',
    tagPosition: 'Tag-Position',
    topLeft: 'Oben links',
    topRight: 'Oben rechts',
    bottomLeft: 'Unten links',
    bottomRight: 'Unten rechts',
    showLive: 'Live-Kamerabild anzeigen',
    altStream: 'Alternativer Livestream (optional)',
    altStreamPlaceholder: 'z.B. http://ip:1984/stream.html?src=Kamera',
    altStreamHint: 'Leer lassen für den AgentDVR-Stream.',
    formatInfo: 'Infos zu unterstützten Formaten',
    helpDirectTitle: 'Direkte Video-Dateien',
    helpDirectText: '(werden im Player abgespielt):',
    helpEmbedTitle: 'Player-Webseiten',
    helpEmbedText: '(werden eingebettet): z.B. go2rtc oder RTSPtoWeb (…/stream.html?src=…). Die Seite kümmert sich selbst um das Format.',
    helpNotPossibleTitle: 'Nicht möglich:',
    helpNotPossibleText: 'rohe RTSP-, AVI-, MKV- oder FLV-URLs – der Browser kann diese nicht direkt anzeigen. Dafür einen Dienst wie go2rtc nutzen und dessen Player-URL eintragen.',
    showTags: 'Tags anzeigen',
  },
  en: {
    title: 'Title',
    ip: 'AgentDVR IP',
    oid: 'OID (camera)',
    count: 'Number of entries',
    refresh: 'Refresh (sec.)',
    refreshHint: 'Refresh = 0 disables automatic updating.',
    thumbSize: 'Thumbnail size',
    sizeSmall: 'Small (75px)',
    sizeMedium: 'Medium (100px)',
    sizeLarge: 'Large (150px)',
    tagPosition: 'Tag position',
    topLeft: 'Top left',
    topRight: 'Top right',
    bottomLeft: 'Bottom left',
    bottomRight: 'Bottom right',
    showLive: 'Show live camera view',
    altStream: 'Alternative live stream (optional)',
    altStreamPlaceholder: 'e.g. http://ip:1984/stream.html?src=Camera',
    altStreamHint: 'Leave empty for the AgentDVR stream.',
    formatInfo: 'Info about supported formats',
    helpDirectTitle: 'Direct video files',
    helpDirectText: '(played in the player):',
    helpEmbedTitle: 'Player web pages',
    helpEmbedText: '(embedded): e.g. go2rtc or RTSPtoWeb (…/stream.html?src=…). The page handles the format itself.',
    helpNotPossibleTitle: 'Not possible:',
    helpNotPossibleText: 'raw RTSP, AVI, MKV or FLV URLs – the browser cannot display these directly. Use a service like go2rtc and enter its player URL instead.',
    showTags: 'Show tags',
  },
};

customElements.define('agentdvr-card-editor', AgentDvrCardEditor);


/* In der Karten-Auswahl ("Karte hinzufügen") sichtbar machen */
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'agentdvr-card',
  name: 'AgentDVR Gallery',
  description: 'Galerie der AgentDVR-Aufnahmen mit Lightbox-Player.',
  preview: false,
});
