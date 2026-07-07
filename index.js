// @ts-nocheck
/*
 * Proxy Key Quota — a SillyTavern extension.
 * Copyright (C) 2026 Mroffza
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    main_api,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings, selected_proxy, getChatCompletionModel } from '../../../openai.js';
import { resolveSecretKey, secret_state } from '../../../secrets.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';

const MODULE = 'proxy_key_quota';

/**
 * @typedef {Object} QuotaEntry
 * @property {string} name    Display name (secret label / preset / url)
 * @property {string} url     Reverse proxy URL (if any)
 * @property {number} count   How many messages this key has received
 * @property {number} last    Timestamp (ms) of the last counted message
 * @property {Object<string, number>} models  Per-model message counts
 * @property {string} lastModel  Model used for the most recent counted message
 * @property {{t: number, model: string}[]} log  Timestamped history (newest last), capped at LOG_CAP
 */

// Hard cap on how many log entries we keep stored per key.
const LOG_CAP = 1000;

const defaultSettings = {
    enabled: true,
    // Count background/quiet generations by default — they still consume the
    // key's quota (summarize, auto-title, impersonate, etc.), so the total
    // reflects real API usage of the key.
    countQuiet: true,
    showWidget: true,
    // Widget position (px). null => default top-right.
    widgetX: null,
    widgetY: null,
    // How many log rows to show in the "view all keys" card (default 10, max LOG_CAP).
    logRows: 10,
    /** @type {Object<string, QuotaEntry>} */
    keys: {},
};

// Per-generation state. Armed on a real (non-dry) GENERATION_STARTED,
// consumed exactly once by whichever end-signal fires first
// (GENERATION_ENDED for streaming, or MESSAGE_RECEIVED for non-streaming).
let armed = false;
let countedThisGen = false;
let lastGenType = null;

function getSettings() {
    if (extension_settings[MODULE] === undefined) {
        extension_settings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key in defaultSettings) {
        if (extension_settings[MODULE][key] === undefined) {
            extension_settings[MODULE][key] = structuredClone(defaultSettings[key]);
        }
    }
    return extension_settings[MODULE];
}

/** Simple non-reversible 32-bit hash (base36). Fallback identity only. */
function shortHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

/**
 * Identify the API key currently in use.
 * Priority:
 *   1. Active saved secret (stable id + label) — the "Custom API Key" selected.
 *   2. Reverse-proxy password (hashed).
 *   3. Proxy preset name, then proxy url.
 * @returns {{id: string, name: string, url: string} | null}
 */
function getCurrentKey() {
    const url = oai_settings?.reverse_proxy || '';

    try {
        const secretKey = resolveSecretKey();
        if (secretKey && Array.isArray(secret_state[secretKey])) {
            const active = secret_state[secretKey].find(s => s.active);
            if (active) {
                const label = active.label || active.value || active.id;
                return { id: 'secret:' + secretKey + ':' + active.id, name: label, url };
            }
        }
    } catch { /* secrets not ready yet */ }

    const password = oai_settings?.proxy_password || '';
    if (password) {
        const presetName = selected_proxy?.name;
        const nm = (presetName && presetName !== 'None') ? presetName : (url || 'proxy');
        return { id: 'pw:' + shortHash(password), name: nm, url };
    }

    const presetName = selected_proxy?.name || '';
    if (presetName && presetName !== 'None') {
        return { id: 'name:' + presetName, name: presetName, url };
    }
    if (url) {
        return { id: 'url:' + url, name: url, url };
    }
    return null;
}

/** Current chat-completion model name, or '' if unknown. */
function getCurrentModel() {
    try {
        return getChatCompletionModel() || '';
    } catch {
        return '';
    }
}

function countMessage() {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (main_api !== 'openai') return;

    const key = getCurrentKey();
    if (!key) return;

    if (!settings.keys[key.id]) {
        settings.keys[key.id] = { name: key.name, url: key.url, count: 0, last: 0, models: {}, lastModel: '', log: [] };
    }
    const entry = settings.keys[key.id];
    if (!entry.models) entry.models = {};   // migrate older entries
    if (!Array.isArray(entry.log)) entry.log = [];
    entry.name = key.name;
    entry.url = key.url;
    entry.count += 1;
    const now = Date.now();
    entry.last = now;

    const model = getCurrentModel();
    if (model) {
        entry.models[model] = (entry.models[model] || 0) + 1;
        entry.lastModel = model;
    }

    // Append to timestamped log, keep newest LOG_CAP entries.
    entry.log.push({ t: now, model: model || '' });
    if (entry.log.length > LOG_CAP) {
        entry.log.splice(0, entry.log.length - LOG_CAP);
    }

    saveSettingsDebounced();
    refreshUI();
}

// ---- Event hooks --------------------------------------------------------

function onGenerationStarted(type, _options, dryRun) {
    if (dryRun) return; // dry runs only assemble the prompt
    lastGenType = type || 'normal';
    armed = true;
    countedThisGen = false;
}

// Count exactly once per armed generation. Whichever end-signal fires first
// wins; the flag prevents streaming (both events fire) from double-counting.
function tryCount() {
    if (!armed || countedThisGen) return;
    const settings = getSettings();
    if (!settings.countQuiet && lastGenType === 'quiet') {
        armed = false;
        return;
    }
    countedThisGen = true;
    armed = false;
    countMessage();
}

function onGenerationEnded() { tryCount(); }
function onMessageReceived() { tryCount(); }

// ---- UI helpers ---------------------------------------------------------

function fmtTime(ts) {
    if (!ts) return '-';
    try {
        // 24-hour clock, no AM/PM.
        return new Date(ts).toLocaleString(undefined, { hour12: false });
    } catch {
        return '-';
    }
}

function getCurrentStat() {
    const key = getCurrentKey();
    if (!key) return null;
    const settings = getSettings();
    const entry = settings.keys[key.id];
    return {
        id: key.id,
        name: key.name,
        url: key.url,
        count: entry ? entry.count : 0,
        last: entry ? entry.last : 0,
        models: entry ? (entry.models || {}) : {},
        lastModel: entry ? (entry.lastModel || '') : '',
    };
}

// ---- Floating draggable widget (shows ONLY the current key) -------------

let dragState = null;

function clampWidget(widget) {
    const rect = widget.getBoundingClientRect();
    const maxX = Math.max(0, window.innerWidth - rect.width);
    const maxY = Math.max(0, window.innerHeight - rect.height);
    const settings = getSettings();
    if (settings.widgetX !== null) settings.widgetX = Math.min(Math.max(0, settings.widgetX), maxX);
    if (settings.widgetY !== null) settings.widgetY = Math.min(Math.max(0, settings.widgetY), maxY);
}

function applyWidgetPosition(widget) {
    const settings = getSettings();
    if (settings.widgetX !== null && settings.widgetY !== null) {
        clampWidget(widget);
        widget.style.left = settings.widgetX + 'px';
        widget.style.top = settings.widgetY + 'px';
        widget.style.right = 'auto';
    } else {
        widget.style.left = 'auto';
        widget.style.top = '6px';
        widget.style.right = '10px';
    }
}

function ensureWidget() {
    let widget = document.getElementById('pkq_widget');
    if (widget) return widget;

    widget = document.createElement('div');
    widget.id = 'pkq_widget';
    widget.innerHTML = `
        <span class="pkq_w_grip fa-solid fa-grip-vertical" title="ลากเพื่อย้าย"></span>
        <span class="pkq_w_icon fa-solid fa-key"></span>
        <span class="pkq_w_name" id="pkq_w_name">-</span>
        <span class="pkq_w_count" id="pkq_w_count">0</span>
    `;
    document.body.appendChild(widget);

    const onPointerDown = (e) => {
        const rect = widget.getBoundingClientRect();
        dragState = { startX: e.clientX, startY: e.clientY, baseX: rect.left, baseY: rect.top, moved: false };
        widget.setPointerCapture?.(e.pointerId);
        widget.classList.add('pkq_dragging');
        e.preventDefault();
    };
    const onPointerMove = (e) => {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
        const settings = getSettings();
        settings.widgetX = dragState.baseX + dx;
        settings.widgetY = dragState.baseY + dy;
        applyWidgetPosition(widget);
    };
    const onPointerUp = (e) => {
        if (!dragState) return;
        const moved = dragState.moved;
        widget.classList.remove('pkq_dragging');
        widget.releasePointerCapture?.(e.pointerId);
        dragState = null;
        if (moved) saveSettingsDebounced();
    };

    widget.addEventListener('pointerdown', onPointerDown);
    widget.addEventListener('pointermove', onPointerMove);
    widget.addEventListener('pointerup', onPointerUp);
    widget.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('resize', () => applyWidgetPosition(widget));

    applyWidgetPosition(widget);
    return widget;
}

function refreshWidget() {
    const settings = getSettings();
    const widget = ensureWidget();
    const nameEl = document.getElementById('pkq_w_name');
    const countEl = document.getElementById('pkq_w_count');

    const show = settings.enabled && settings.showWidget;
    widget.style.display = show ? 'flex' : 'none';
    if (!show) return;

    applyWidgetPosition(widget);

    const stat = getCurrentStat();
    if (!stat) {
        if (nameEl) nameEl.textContent = 'ไม่มีคีย์';
        if (countEl) countEl.textContent = '-';
        widget.title = 'ยังไม่ได้เลือกคีย์';
        return;
    }
    if (nameEl) nameEl.textContent = stat.name;
    if (countEl) countEl.textContent = String(stat.count);

    const modelLines = Object.keys(stat.models).length
        ? '\n' + Object.entries(stat.models)
            .sort((a, b) => b[1] - a[1])
            .map(([m, c]) => `  • ${m}: ${c}`).join('\n')
        : '';
    widget.title = `${stat.name}\nนับได้: ${stat.count}\nล่าสุด: ${fmtTime(stat.last)}${stat.lastModel ? '\nโมเดลล่าสุด: ' + stat.lastModel : ''}${modelLines ? '\n\nแยกตามโมเดล:' + modelLines : ''}`;
}

// ---- "View all keys" popup ---------------------------------------------

function buildAllKeysContent() {
    const wrap = document.createElement('div');
    wrap.classList.add('pkq_popup');

    const heading = document.createElement('h3');
    heading.textContent = 'คีย์ทั้งหมด';
    heading.style.marginTop = '0';

    // --- Key switcher: dropdown + prev/next arrows ---
    const nav = document.createElement('div');
    nav.classList.add('pkq_nav');

    const prevBtn = document.createElement('div');
    prevBtn.classList.add('menu_button');
    prevBtn.innerHTML = '<span class="fa-solid fa-chevron-left"></span>';
    prevBtn.title = 'คีย์ก่อนหน้า';

    const select = document.createElement('select');
    select.classList.add('text_pole', 'pkq_key_select');

    const nextBtn = document.createElement('div');
    nextBtn.classList.add('menu_button');
    nextBtn.innerHTML = '<span class="fa-solid fa-chevron-right"></span>';
    nextBtn.title = 'คีย์ถัดไป';

    nav.append(prevBtn, select, nextBtn);

    // --- Detail card for the selected key ---
    const card = document.createElement('div');
    card.classList.add('pkq_card');

    // --- Action buttons ---
    const btnRow = document.createElement('div');
    btnRow.classList.add('pkq_btnrow');

    const delBtn = document.createElement('div');
    delBtn.classList.add('menu_button');
    delBtn.innerHTML = '<span class="fa-solid fa-trash"></span> ลบคีย์นี้';

    const resetBtn = document.createElement('div');
    resetBtn.classList.add('menu_button');
    resetBtn.textContent = 'รีเซ็ตทั้งหมด';

    const exportBtn = document.createElement('div');
    exportBtn.classList.add('menu_button');
    exportBtn.textContent = 'Export JSON';

    btnRow.append(delBtn, resetBtn, exportBtn);

    // Currently-shown key id (defaults to the active key).
    let shownId = null;

    const sortedIds = () => {
        const settings = getSettings();
        return Object.keys(settings.keys)
            .sort((a, b) => settings.keys[b].count - settings.keys[a].count);
    };

    const renderCard = () => {
        const settings = getSettings();
        const ids = sortedIds();

        // Rebuild the dropdown.
        select.innerHTML = '';
        if (ids.length === 0) {
            card.innerHTML = '<div class="pkq_empty">ยังไม่มีข้อมูล — ส่งข้อความสักครั้งก่อน</div>';
            select.disabled = true;
            prevBtn.classList.add('disabled');
            nextBtn.classList.add('disabled');
            delBtn.classList.add('disabled');
            return;
        }
        select.disabled = false;
        prevBtn.classList.remove('disabled');
        nextBtn.classList.remove('disabled');
        delBtn.classList.remove('disabled');

        const current = getCurrentKey();
        const currentId = current ? current.id : null;

        // Pick which key to show: keep shownId if still valid, else current, else first.
        if (!shownId || !settings.keys[shownId]) {
            shownId = (currentId && settings.keys[currentId]) ? currentId : ids[0];
        }

        for (const id of ids) {
            const entry = settings.keys[id];
            const opt = document.createElement('option');
            opt.value = id;
            const marker = id === currentId ? '● ' : '';
            opt.textContent = `${marker}${entry.name || '(unknown)'} (${entry.count})`;
            if (id === shownId) opt.selected = true;
            select.append(opt);
        }

        // Render the detail card for shownId.
        const entry = settings.keys[shownId];
        const isCurrent = shownId === currentId;
        const models = entry.models || {};
        const modelEntries = Object.entries(models).sort((a, b) => b[1] - a[1]);

        const modelRows = modelEntries.length
            ? modelEntries.map(([m, c]) => `
                <tr>
                    <td style="word-break:break-all;">${escapeHtml(m)}</td>
                    <td style="text-align:right;">${c}</td>
                </tr>`).join('')
            : '<tr><td colspan="2" style="opacity:0.6;text-align:center;">ยังไม่มีข้อมูลโมเดล</td></tr>';

        // Build the timestamped log (newest first), limited to logRows.
        const log = Array.isArray(entry.log) ? entry.log : [];
        const totalLog = log.length;
        const rowLimit = Math.min(Math.max(1, settings.logRows || 10), LOG_CAP);
        const shownLog = log.slice(-rowLimit).reverse();

        const logRowsHtml = shownLog.length
            ? shownLog.map((e, i) => `
                <tr>
                    <td style="text-align:right;opacity:0.6;">${totalLog - i}</td>
                    <td>${fmtTime(e.t)}</td>
                    <td style="word-break:break-all;">${escapeHtml(e.model || '-')}</td>
                </tr>`).join('')
            : '<tr><td colspan="3" style="opacity:0.6;text-align:center;">ยังไม่มีประวัติ</td></tr>';

        card.innerHTML = `
            <div class="pkq_card_head">
                ${isCurrent ? '<span class="pkq_dot"></span>' : ''}
                <span class="pkq_card_name">${escapeHtml(entry.name || '(unknown)')}</span>
                ${isCurrent ? '<span class="pkq_badge_now">ใช้อยู่</span>' : ''}
            </div>
            <div class="pkq_card_stats">
                <div><span class="pkq_lbl">นับได้รวม</span><span class="pkq_val">${entry.count}</span></div>
                <div><span class="pkq_lbl">ล่าสุด</span><span class="pkq_val">${fmtTime(entry.last)}</span></div>
                <div><span class="pkq_lbl">โมเดลล่าสุด</span><span class="pkq_val">${escapeHtml(entry.lastModel || '-')}</span></div>
            </div>
            <div class="pkq_card_models_title">แยกตามโมเดล</div>
            <table class="pkq_table pkq_models_table">
                <thead><tr><th style="text-align:left;">Model</th><th style="text-align:right;">นับได้</th></tr></thead>
                <tbody>${modelRows}</tbody>
            </table>
            <div class="pkq_log_head">
                <span class="pkq_card_models_title" style="margin:0;">ประวัติ (log)</span>
                <span class="pkq_log_ctrl">
                    <label>แสดง</label>
                    <input type="number" min="1" max="${LOG_CAP}" step="1" value="${rowLimit}" class="text_pole pkq_logrows_input" title="จำนวน log ที่แสดง (1-${LOG_CAP})">
                    <span class="pkq_log_total">/ ${totalLog}</span>
                </span>
            </div>
            <table class="pkq_table pkq_log_table">
                <thead><tr><th style="text-align:right;">#</th><th style="text-align:left;">เวลา</th><th style="text-align:left;">Model</th></tr></thead>
                <tbody>${logRowsHtml}</tbody>
            </table>
        `;

        // Wire the "rows to show" input.
        const rowsInput = card.querySelector('.pkq_logrows_input');
        if (rowsInput) {
            const commit = () => {
                let v = parseInt(rowsInput.value, 10);
                if (isNaN(v)) v = 10;
                v = Math.min(Math.max(1, v), LOG_CAP);
                getSettings().logRows = v;
                saveSettingsDebounced();
                renderCard();
            };
            rowsInput.addEventListener('change', commit);
            rowsInput.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            });
        }
    };

    const moveSelection = (delta) => {
        const ids = sortedIds();
        if (ids.length === 0) return;
        let idx = ids.indexOf(shownId);
        if (idx < 0) idx = 0;
        idx = (idx + delta + ids.length) % ids.length;
        shownId = ids[idx];
        renderCard();
    };

    select.addEventListener('change', () => { shownId = select.value; renderCard(); });
    prevBtn.addEventListener('click', () => moveSelection(-1));
    nextBtn.addEventListener('click', () => moveSelection(1));

    delBtn.addEventListener('click', () => {
        const settings = getSettings();
        if (!shownId || !settings.keys[shownId]) return;
        const nm = settings.keys[shownId].name || shownId;
        if (confirm(`ลบคีย์ "${nm}" ออกจากตัวนับ?`)) {
            delete settings.keys[shownId];
            shownId = null;
            saveSettingsDebounced();
            renderCard();
            refreshUI();
        }
    });

    resetBtn.addEventListener('click', () => {
        if (confirm('ล้างตัวนับทั้งหมด?')) {
            getSettings().keys = {};
            shownId = null;
            saveSettingsDebounced();
            renderCard();
            refreshUI();
        }
    });

    exportBtn.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(getSettings().keys, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'proxy-key-quota.json';
        a.click();
        URL.revokeObjectURL(a.href);
    });

    wrap.append(heading, nav, card, btnRow);
    renderCard();
    return wrap;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function showAllKeysPopup() {
    const content = buildAllKeysContent();
    callGenericPopup(content, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
}

// ---- Settings panel (only current key summary here) --------------------

function refreshUI() {
    const curBox = document.getElementById('pkq_current_box');
    if (curBox) {
        const stat = getCurrentStat();
        curBox.textContent = stat
            ? `คีย์ที่เลือกอยู่: ${stat.name} — นับได้ ${stat.count}`
            : 'ยังไม่ได้เลือกคีย์';
    }
    refreshWidget();
    syncToggleButton();
}

// ---- Master enable toggle (checkbox + wand-menu button) ----------------

function setEnabled(value) {
    const settings = getSettings();
    settings.enabled = !!value;
    saveSettingsDebounced();
    const cb = document.getElementById('pkq_enabled_cb');
    if (cb) cb.checked = settings.enabled;
    refreshUI();
    if (typeof toastr !== 'undefined') {
        toastr.info(settings.enabled ? 'Proxy Key Quota: เปิดการนับแล้ว' : 'Proxy Key Quota: ปิดการนับแล้ว');
    }
}

function syncToggleButton() {
    const settings = getSettings();
    const btn = document.getElementById('pkq_wand_btn');
    if (!btn) return;
    const icon = btn.querySelector('.pkq_wand_icon');
    const label = btn.querySelector('.pkq_wand_label');
    if (icon) {
        icon.classList.toggle('fa-toggle-on', settings.enabled);
        icon.classList.toggle('fa-toggle-off', !settings.enabled);
    }
    if (label) label.textContent = settings.enabled ? 'Proxy Quota: เปิด' : 'Proxy Quota: ปิด';
}

function addWandMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    if (document.getElementById('pkq_wand_btn')) return;

    const btn = document.createElement('div');
    btn.id = 'pkq_wand_btn';
    btn.className = 'list-group-item flex-container flexGap5 interactable';
    btn.tabIndex = 0;
    btn.innerHTML = `
        <div class="pkq_wand_icon fa-solid fa-toggle-on extensionsMenuExtensionButton"></div>
        <span class="pkq_wand_label">Proxy Quota</span>
    `;
    btn.addEventListener('click', () => setEnabled(!getSettings().enabled));
    menu.appendChild(btn);
    syncToggleButton();
}

// ---- Settings panel -----------------------------------------------------

function addSettingsPanel() {
    const container = document.getElementById('extensions_settings2')
        ?? document.getElementById('extensions_settings');
    if (!container) return;

    const settings = getSettings();

    const drawer = document.createElement('div');
    drawer.classList.add('inline-drawer');

    const toggle = document.createElement('div');
    toggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');
    const title = document.createElement('b');
    title.textContent = 'Proxy Key Quota';
    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    toggle.append(title, icon);

    const content = document.createElement('div');
    content.classList.add('inline-drawer-content');

    const curBox = document.createElement('div');
    curBox.id = 'pkq_current_box';
    curBox.classList.add('pkq_current_box');

    const mkCheck = (checked, text, onChange, id) => {
        const label = document.createElement('label');
        label.classList.add('checkbox_label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        if (id) cb.id = id;
        cb.addEventListener('change', () => onChange(cb.checked));
        const span = document.createElement('span');
        span.textContent = text;
        label.append(cb, span);
        return label;
    };

    const enabledLabel = mkCheck(settings.enabled, 'เปิดการนับ', (v) => setEnabled(v), 'pkq_enabled_cb');
    const widgetLabel = mkCheck(settings.showWidget, 'แสดงตัวนับบนหน้าจอหลัก', (v) => {
        settings.showWidget = v; saveSettingsDebounced(); refreshWidget();
    });
    const quietLabel = mkCheck(settings.countQuiet, 'นับ background/quiet generation ด้วย (แนะนำ)', (v) => {
        settings.countQuiet = v; saveSettingsDebounced();
    });
    quietLabel.title = 'งานเบื้องหลัง เช่น สรุปเรื่อง (summarize), ตั้งชื่อแชทอัตโนมัติ, impersonate ก็ยิง request กินโควต้าคีย์เหมือนกัน — เปิดไว้เพื่อให้ยอดตรงกับการใช้งานจริงของคีย์';

    const btnRow = document.createElement('div');
    btnRow.classList.add('pkq_btnrow');

    const viewAllBtn = document.createElement('div');
    viewAllBtn.classList.add('menu_button');
    viewAllBtn.innerHTML = '<span class="fa-solid fa-list"></span> ดูคีย์ทั้งหมด';
    viewAllBtn.addEventListener('click', showAllKeysPopup);

    const resetPosBtn = document.createElement('div');
    resetPosBtn.classList.add('menu_button');
    resetPosBtn.textContent = 'รีเซ็ตตำแหน่ง widget';
    resetPosBtn.addEventListener('click', () => {
        settings.widgetX = null;
        settings.widgetY = null;
        saveSettingsDebounced();
        refreshWidget();
    });

    btnRow.append(viewAllBtn, resetPosBtn);

    const hint = document.createElement('div');
    hint.classList.add('pkq_hint');
    const hintLines = [
        'นับ 1 ครั้งทุกครั้งที่ได้รับข้อความ (ทั้ง streaming และไม่ streaming รวมถึงข้อความว่าง) พร้อมเก็บชื่อโมเดลที่ใช้',
        'ตัวนับบนหน้าจอแสดงเฉพาะคีย์ที่เลือกอยู่ สลับคีย์แล้วตัวเลขเปลี่ยนตาม',
        'กด "ดูคีย์ทั้งหมด" เพื่อเปิดหน้าคีย์ (เริ่มที่คีย์ที่ใช้อยู่) แล้วใช้ลูกศร/dropdown สลับดูคีย์อื่น พร้อมยอดแยกตามโมเดลและปุ่มลบ',
        'แต่ละคีย์เก็บประวัติ (log) เวลาและโมเดลทุกครั้ง แสดงเริ่มต้น 10 รายการ ปรับได้ถึง 1000',
        'นับงานเบื้องหลัง (summarize, ตั้งชื่อแชทอัตโนมัติ ฯลฯ) ด้วยโดยค่าเริ่มต้น เพราะมันก็กินโควต้าคีย์จริง — ปิดได้ถ้าอยากนับเฉพาะข้อความที่คุยเอง',
        'ตัวนับลากย้ายได้ทั้ง desktop และมือถือ',
        'เปิด/ปิดจากปุ่มในเมนู extensions (ไอคอนไม้กายสิทธิ์)',
    ];
    for (const line of hintLines) {
        const p = document.createElement('p');
        p.textContent = line;
        hint.append(p);
    }

    content.append(curBox, enabledLabel, widgetLabel, quietLabel, btnRow, hint);
    drawer.append(toggle, content);
    container.append(drawer);

    refreshUI();
}

// ---- Init ---------------------------------------------------------------

(function init() {
    getSettings();
    addSettingsPanel();
    addWandMenuButton();
    ensureWidget();
    refreshUI();

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    eventSource.on(event_types.SETTINGS_UPDATED, refreshUI);
    eventSource.on(event_types.CHAT_CHANGED, refreshWidget);
    eventSource.on(event_types.CHATCOMPLETION_SOURCE_CHANGED, refreshUI);
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, refreshWidget);
    eventSource.on(event_types.SECRET_WRITTEN, refreshUI);
    eventSource.on(event_types.SECRET_DELETED, refreshUI);
    eventSource.on(event_types.SECRET_ROTATED, refreshUI);

    let tries = 0;
    const iv = setInterval(() => {
        addWandMenuButton();
        if (document.getElementById('pkq_wand_btn') || ++tries > 20) clearInterval(iv);
    }, 500);

    console.log('[proxy-key-quota] loaded');
})();
