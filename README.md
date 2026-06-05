# AgentDVR Gallery Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![GitHub release](https://img.shields.io/github/v/release/ipod86/lovelace-agentdvr-card)](https://github.com/ipod86/lovelace-agentdvr-card/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Lovelace custom card for **Home Assistant** and **ioBroker** (Lovelace adapter) that displays [AgentDVR](https://www.ispyconnect.com/) recordings as a responsive thumbnail gallery with a built-in lightbox video player.

## Features

- **Thumbnail gallery** with configurable tile size (small / medium / large)
- **Date grouping** — Today / Yesterday / weekday name / full date
- **Relative time display** — *just now*, *5 min ago*, *2 h ago*
- **Lightbox player** with prev/next navigation and full keyboard control (`←` `→` `Esc`)
- **Live camera tile** with animated status badge (Live / REC / Offline) and optional live stream
- **Search & tag filter** — collapsible bar, filter by tag chips
- **Smart auto-refresh** — diff detection, no unnecessary DOM rebuilds; modal stays open during refresh
- **Graphical editor** in the Lovelace dashboard (no YAML required)
- **Multi-language** — German and English, auto-detected from HA locale
- **Theme-aware** — all colors from your active Lovelace theme

## Requirements

- [AgentDVR](https://www.ispyconnect.com/) reachable on the local network (port 8090 by default)
- Home Assistant **2021.6+** or ioBroker with the Lovelace adapter

## Installation

### Via HACS (recommended)

1. Open HACS → Frontend → **+ Explore & Download Repositories**
2. Search for **AgentDVR Gallery Card** and install it
3. Reload your browser

### Manual

1. Download `agentdvr-card.js` from the [latest release](https://github.com/ipod86/lovelace-agentdvr-card/releases/latest)
2. Copy it to `/config/www/agentdvr-card.js`
3. In Home Assistant go to **Settings → Dashboards → Resources** and add:
   - URL: `/local/agentdvr-card.js`
   - Type: **JavaScript module**
4. Reload the browser

### ioBroker

1. Copy `agentdvr-card.js` to `/cards/agentdvr-card.js` (ioBroker Lovelace adapter cards folder)
2. Register as resource:
   - URL: `/cards/agentdvr-card.js`
   - Type: **module**

## Configuration

Add the card via the graphical editor or manually in YAML:

```yaml
type: custom:agentdvr-card
ip_agentdvr: "192.168.99.5"
oid: "8"
```

### Full configuration reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `ip_agentdvr` | string | `192.168.99.5` | IP address of your AgentDVR instance |
| `oid` | string | `1` | Camera OID in AgentDVR |
| `title` | string | `AgentDVR Aufnahmen` | Card title |
| `anzahl` | number | `50` | Maximum number of recordings to fetch |
| `groesse` | string | `mittel` | Thumbnail size: `klein` (75px) · `mittel` (100px) · `gross` (150px) |
| `show_live` | boolean | `true` | Show live camera tile as first thumbnail |
| `live_stream_url` | string | _(empty)_ | Optional alternative stream URL (go2rtc, etc.) — see below |
| `show_tags` | boolean | `true` | Show tag labels on thumbnails |
| `tag_position` | string | `bottom-left` | Tag label position: `top-left` · `top-right` · `bottom-left` · `bottom-right` |
| `refresh_interval` | number | `30` | Auto-refresh interval in seconds. `0` = disabled |

### Live stream URL

- **Empty** → uses the AgentDVR native WebM stream
- **Direct video file** (`.webm`, `.mp4`, `.m3u8`, `.mov`, `.ogg`, `.ogv`) → played in the built-in player
- **Player webpage** (e.g. go2rtc `…/stream.html?src=…`) → embedded in an iframe

> RTSP, AVI, MKV or FLV URLs cannot be played directly in the browser. Use a relay service like [go2rtc](https://github.com/AlexxIT/go2rtc).

### Example

```yaml
type: custom:agentdvr-card
ip_agentdvr: "192.168.1.10"
oid: "3"
title: "Driveway Camera"
anzahl: 100
groesse: "gross"
show_live: true
live_stream_url: "http://192.168.1.10:1984/stream.html?src=driveway"
show_tags: true
tag_position: "bottom-left"
refresh_interval: 30
```

## Keyboard shortcuts

When the lightbox player is open:

| Key | Action |
|-----|--------|
| `←` | Previous recording |
| `→` | Next recording |
| `Esc` | Close player |

## Changelog

### 0.1.0 (2026-06-05)
- Initial release

## License

MIT © 2026 ipod86
