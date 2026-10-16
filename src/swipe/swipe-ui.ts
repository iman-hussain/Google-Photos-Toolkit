import Api from '../api/api';
import log from '../ui/logic/log';
import { windowGlobalData } from '../windowGlobalData';
import swipeTemplate from '../ui/markup/swipe-template.html';
import swipeButtonHtml from '../ui/markup/swipe-button.html';
import swipeCss from '../ui/markup/swipe.css';
import SwipeDb from './db';
import TimelineFeed, { type SwipeItem } from './feed';
import SwipeActions, { type ActionRecord } from './actions';
import { ACTION_LABELS, type SwipeAction } from './history-format';
import { exportLog, planFile, planLocal, summariseFile, summariseLocal, type LogSummary, type RevertFilter } from './history';
import { getSettings, saveSettings, type DeleteMode } from './settings';
import {
  fromDateInputValue,
  periodContaining,
  periodKey,
  periodLabel,
  periodProgress,
  shiftPeriod,
  toDateInputValue,
  type Granularity,
  type Period,
} from './period';

type Decision = 'delete' | 'keep' | 'favourite' | 'later';

const PRELOAD = 3;
const UNDO_LIMIT = 100;
const DRAG_THRESHOLD = 110;
const CURSOR_SAVE_EVERY = 10;

const DIRECTIONS = { delete: 'left', keep: 'right', favourite: 'up', later: 'down' } as const;

const DELETE_LABELS: Record<DeleteMode, string> = { bin: 'Bin', album: 'To delete', archive: 'Archive' };

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Swipe UI element #${id} missing`);
  return el;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

function imageUrl(thumb: string, width: number, height: number): string {
  // See parser.ts notes: size params on the thumb URL give any resolution
  return `${thumb}=w${width}-h${height}-k-no`;
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

class SwipeController {
  private api = new Api();
  private db = new SwipeDb(windowGlobalData.account);
  private actions = new SwipeActions(this.api, this.db, getSettings, saveSettings);
  private root!: HTMLElement;
  private card!: HTMLElement;
  private img!: HTMLImageElement;
  private video!: HTMLVideoElement;

  private period: Period = periodContaining('month', Date.now());
  private feed: TimelineFeed | null = null;
  private current: SwipeItem | null = null;
  private undoStack: ActionRecord[] = [];
  private preloaded = new Map<string, HTMLImageElement>();
  private busy = false;
  private loadToken = 0;
  private swipesSinceCursorSave = 0;
  private counts: Partial<Record<SwipeAction, number>> = {};
  private toastTimer = 0;
  private revertFile: File | null = null;

  mount(): void {
    document.body.insertAdjacentHTML('beforeend', swipeTemplate);
    const style = document.createElement('style');
    style.textContent = swipeCss;
    document.head.appendChild(style);

    this.root = $('gptk-swipe');
    this.card = $('gs-card');
    this.img = $('gs-img') as HTMLImageElement;
    this.video = $('gs-video') as HTMLVideoElement;

    this.insertHeaderButton();
    this.bindControls();
    this.bindDrag();
    this.bindSettings();
    this.bindHistory();
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    window.addEventListener('beforeunload', (e) => {
      this.saveCursor();
      if (this.actions.pending > 0) e.preventDefault();
    });
    // GPTK listens for every change event on the document; keep ours to ourselves
    this.root.addEventListener('change', (e) => e.stopPropagation());
    this.actions.onChange = (): void => this.renderStats();
  }

  private insertHeaderButton(): void {
    let location = '.J3TAe';
    if (window.location.href.includes('lockedfolder')) location = '.c9yG5b';
    document.querySelector(location)?.insertAdjacentHTML('afterbegin', swipeButtonHtml);
    document.getElementById('gptk-swipe-button')?.addEventListener('click', () => this.open());
  }

  // ─── open / close ────────────────────────────────────────────────────

  open(): void {
    if (!this.root.hidden) return;
    this.root.hidden = false;
    document.body.style.overflow = 'hidden';
    const settings = getSettings();
    input('gs-granularity').value = settings.granularity;
    this.syncSettingsForm();
    this.startPeriod(periodContaining(settings.granularity, settings.anchor ?? Date.now()));
  }

  close(): void {
    this.saveCursor();
    this.root.hidden = true;
    document.body.style.overflow = '';
    this.video.pause();
    this.video.removeAttribute('src');
    this.img.removeAttribute('src');
    this.preloaded.clear();
    this.feed = null;
    this.current = null;
    if (this.actions.pending > 0) this.toast(`${this.actions.pending} changes still saving in the background`);
  }

  // ─── period / feed ───────────────────────────────────────────────────

  private startPeriod(period: Period, resume = true): void {
    this.saveCursor();
    this.period = period;
    this.undoStack = [];
    this.preloaded.clear();
    const settings = getSettings();
    saveSettings({ granularity: period.granularity, anchor: Number.isFinite(period.start) ? period.start : null });

    input('gs-date').value = toDateInputValue(Number.isFinite(period.start) ? period.start : Date.now());
    input('gs-date').disabled = period.granularity === 'all';
    $('gs-period-label').textContent = periodLabel(period);

    this.feed = new TimelineFeed(this.api, period, {
      includeArchived: settings.includeArchived,
      skipReviewed: settings.skipReviewed,
      filterReviewed: (keys) => this.db.filterReviewed(keys),
      startAt: resume ? settings.cursors[periodKey(period)] : undefined,
    });
    void this.advance();
  }

  private async advance(): Promise<void> {
    const feed = this.feed;
    if (!feed) return;
    const token = ++this.loadToken;
    this.showLoading();
    try {
      const item = await feed.next();
      if (token !== this.loadToken || feed !== this.feed) return;
      this.show(item);
    } catch (error) {
      if (token !== this.loadToken) return;
      const message = error instanceof Error ? error.message : String(error);
      log(`Swipe: failed to load timeline: ${message}`, 'error');
      this.showEmpty(`Couldn't load photos: ${message}`, true);
    }
  }

  private show(item: SwipeItem | null): void {
    this.current = item;
    this.resetCard();
    this.video.pause();
    this.video.hidden = true;
    this.video.removeAttribute('src');

    if (!item) {
      const cursors = { ...getSettings().cursors, [periodKey(this.period)]: this.period.start - 1 };
      if (Number.isFinite(this.period.start)) saveSettings({ cursors });
      this.showEmpty(`Nothing left to review in ${periodLabel(this.period)}.`, false);
      this.renderStats();
      return;
    }

    $('gs-empty').hidden = true;
    this.card.hidden = false;
    this.img.hidden = false;
    const preloaded = this.preloaded.get(item.mediaKey);
    this.img.src = preloaded?.src ?? this.urlFor(item);
    this.renderMeta(item);
    this.renderStats();
    this.preloadAhead();
    this.swipesSinceCursorSave++;
    if (this.swipesSinceCursorSave >= CURSOR_SAVE_EVERY) this.saveCursor();
  }

  private urlFor(item: SwipeItem): string {
    const stage = this.card.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.min(2560, Math.round((stage.width || window.innerWidth) * dpr));
    const height = Math.min(2560, Math.round((stage.height || window.innerHeight) * dpr));
    return imageUrl(item.thumb, width, height);
  }

  /** Keep the next few images warm and drop anything else. */
  private preloadAhead(): void {
    if (!this.feed) return;
    const upcoming = this.feed.peek(PRELOAD);
    const wanted = new Set(upcoming.map((i) => i.mediaKey));
    for (const key of this.preloaded.keys()) if (!wanted.has(key)) this.preloaded.delete(key);
    for (const item of upcoming) {
      if (this.preloaded.has(item.mediaKey)) continue;
      const image = new Image();
      image.decoding = 'async';
      image.src = this.urlFor(item);
      this.preloaded.set(item.mediaKey, image);
    }
  }

  private saveCursor(): void {
    this.swipesSinceCursorSave = 0;
    if (!this.current || !this.feed) return;
    saveSettings({ cursors: { ...getSettings().cursors, [periodKey(this.period)]: this.current.timestamp } });
  }

  // ─── decisions ───────────────────────────────────────────────────────

  private async decide(decision: Decision): Promise<void> {
    const item = this.current;
    if (!item || this.busy) return;
    this.busy = true;
    const action: SwipeAction = decision === 'delete' ? this.actions.deleteAction() : decision;

    try {
      const flyOut = this.flyOut(DIRECTIONS[decision]);
      const record = await this.actions.perform(item, action);
      this.undoStack.push(record);
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.counts[action] = (this.counts[action] ?? 0) + 1;
      await flyOut;
      await this.advance();
    } catch (error) {
      this.resetCard();
      this.toast(`Couldn't record that: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  private async undo(): Promise<void> {
    if (this.busy) return;
    const record = this.undoStack.pop();
    if (!record) {
      this.toast('Nothing to undo');
      return;
    }
    this.busy = true;
    this.toast(`Undoing: ${ACTION_LABELS[record.entry.action]}…`);
    try {
      await this.actions.undo(record);
      this.counts[record.entry.action] = Math.max(0, (this.counts[record.entry.action] ?? 1) - 1);
      if (this.current && this.feed) this.feed.unshift(this.current);
      this.loadToken++;
      this.show(record.item);
      this.toast(`Undone: ${ACTION_LABELS[record.entry.action]}`);
    } catch (error) {
      this.undoStack.push(record);
      this.toast(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
    }
  }

  // ─── rendering ───────────────────────────────────────────────────────

  private showLoading(): void {
    $('gs-meta').textContent = 'Loading…';
  }

  private showEmpty(text: string, canRetry: boolean): void {
    this.card.hidden = true;
    this.img.removeAttribute('src');
    $('gs-empty').hidden = false;
    $('gs-empty-text').textContent = text;
    $('gs-empty-retry').hidden = !canRetry;
    $('gs-empty-older').hidden = this.period.granularity === 'all';
    $('gs-meta').textContent = '';
  }

  private renderMeta(item: SwipeItem): void {
    const meta = $('gs-meta');
    meta.replaceChildren();
    const add = (text: string, className?: string): void => {
      const span = document.createElement('span');
      span.textContent = text;
      if (className) span.className = className;
      meta.appendChild(span);
    };
    add(new Date(item.timestamp).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    if (item.location) add(item.location);
    if (item.width && item.height) add(`${item.width}×${item.height}`);
    if (item.duration) add(`Video ${formatDuration(item.duration)} (V to play)`, 'gs-badge');
    if (item.isLivePhoto) add('Live', 'gs-badge');
    if (item.isFavorite) add('★ Favourite', 'gs-badge gs-badge-fav');
    if (item.isArchived) add('Archived', 'gs-badge');
    const link = document.createElement('a');
    link.href = `https://photos.google.com/photo/${item.mediaKey}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Open (O)';
    meta.appendChild(link);
  }

  private renderStats(): void {
    const parts: string[] = [];
    const c = this.counts;
    const deleted = (c.trash ?? 0) + (c['mark-delete'] ?? 0) + (c.archive ?? 0);
    parts.push(`Deleted ${deleted}`, `Kept ${c.keep ?? 0}`, `★ ${c.favourite ?? 0}`, `Later ${c.later ?? 0}`);
    if (this.feed?.skippedReviewed) parts.push(`skipped ${this.feed.skippedReviewed} reviewed`);
    if (this.actions.pending) parts.push(`saving ${this.actions.pending}…`);
    if (this.actions.failures) parts.push(`${this.actions.failures} failed (see History)`);
    $('gs-stats').textContent = parts.join(' · ');

    const progress = this.current && this.feed ? periodProgress(this.period, this.current.timestamp, this.feed.newestSeen) : this.current ? 0 : 1;
    $('gs-progress-fill').style.width = `${(progress * 100).toFixed(1)}%`;
  }

  private toast(message: string): void {
    const el = $('gs-toast');
    el.textContent = message;
    el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (el.hidden = true), 2500);
  }

  // ─── card motion ─────────────────────────────────────────────────────

  private resetCard(): void {
    this.card.classList.remove('gs-animating', 'gs-out-left', 'gs-out-right', 'gs-out-up', 'gs-out-down', 'gs-dragging');
    this.card.style.transform = '';
    this.card.style.opacity = '';
    this.setStamps(0, 0);
  }

  private flyOut(direction: 'left' | 'right' | 'up' | 'down'): Promise<void> {
    this.card.style.transform = '';
    this.card.classList.add('gs-animating', `gs-out-${direction}`);
    return new Promise((resolve) => window.setTimeout(resolve, 180));
  }

  private setStamps(dx: number, dy: number): void {
    const stamps = this.card.querySelectorAll<HTMLElement>('.gs-stamp');
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const strength = (v: number): string => String(Math.min(1, Math.abs(v) / DRAG_THRESHOLD));
    stamps[0].style.opacity = horizontal && dx < 0 ? strength(dx) : '0';
    stamps[1].style.opacity = horizontal && dx > 0 ? strength(dx) : '0';
    stamps[2].style.opacity = !horizontal && dy < 0 ? strength(dy) : '0';
    stamps[3].style.opacity = !horizontal && dy > 0 ? strength(dy) : '0';
  }

  private bindDrag(): void {
    let startX = 0;
    let startY = 0;
    let dragging = false;

    this.card.addEventListener('pointerdown', (e) => {
      if (!this.current || this.busy || e.button !== 0 || e.target === this.video) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      this.card.setPointerCapture(e.pointerId);
      this.card.classList.add('gs-dragging');
    });
    this.card.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      this.card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 20}deg)`;
      this.setStamps(dx, dy);
    });
    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      this.card.classList.remove('gs-dragging');
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > DRAG_THRESHOLD && Math.abs(dx) > Math.abs(dy)) void this.decide(dx < 0 ? 'delete' : 'keep');
      else if (Math.abs(dy) > DRAG_THRESHOLD) void this.decide(dy < 0 ? 'favourite' : 'later');
      else {
        this.card.classList.add('gs-animating');
        this.resetCard();
      }
    };
    this.card.addEventListener('pointerup', end);
    this.card.addEventListener('pointercancel', end);
  }

  // ─── input ───────────────────────────────────────────────────────────

  private bindControls(): void {
    this.root.querySelectorAll<HTMLButtonElement>('.gs-btn').forEach((button) => {
      button.addEventListener('click', () => {
        const act = button.dataset.act;
        if (act === 'undo') void this.undo();
        else if (act) void this.decide(act as Decision);
      });
    });
    $('gs-close').addEventListener('click', () => this.close());
    $('gs-prev').addEventListener('click', () => this.startPeriod(shiftPeriod(this.period, -1)));
    $('gs-next').addEventListener('click', () => this.startPeriod(shiftPeriod(this.period, 1)));
    $('gs-empty-older').addEventListener('click', () => this.startPeriod(shiftPeriod(this.period, -1)));
    $('gs-empty-retry').addEventListener('click', () => this.startPeriod(this.period));
    $('gs-empty-restart').addEventListener('click', () => this.restartPeriod());
    $('gs-granularity').addEventListener('change', () => {
      const granularity = input('gs-granularity').value as Granularity;
      const anchor = Number.isFinite(this.period.start) ? this.period.start : Date.now();
      this.startPeriod(periodContaining(granularity, anchor));
    });
    $('gs-date').addEventListener('change', () => {
      const ms = fromDateInputValue(input('gs-date').value);
      if (ms !== null) this.startPeriod(periodContaining(this.period.granularity, ms));
    });
    $('gs-settings-toggle').addEventListener('click', () => this.togglePanel('gs-settings'));
    $('gs-history-toggle').addEventListener('click', () => this.togglePanel('gs-history'));
  }

  /** Clear the resume point and reviewed marks for this period only. */
  private restartPeriod(): void {
    const cursors = { ...getSettings().cursors };
    delete cursors[periodKey(this.period)];
    saveSettings({ cursors });
    this.current = null;
    if (!getSettings().skipReviewed) {
      this.startPeriod(this.period, false);
      return;
    }
    // Reviewed marks are per item, so walk the period once without skipping
    const feed = new TimelineFeed(this.api, this.period, {
      includeArchived: getSettings().includeArchived,
      skipReviewed: false,
      filterReviewed: () => Promise.resolve(new Set()),
    });
    this.toast('Clearing reviewed marks for this period…');
    void (async (): Promise<void> => {
      let batch: string[] = [];
      for (let item = await feed.next(); item; item = await feed.next()) {
        batch.push(item.mediaKey);
        if (batch.length >= 500) {
          await this.db.unmarkReviewed(batch);
          batch = [];
        }
      }
      await this.db.unmarkReviewed(batch);
      this.startPeriod(this.period, false);
    })().catch((error: unknown) => this.toast(`Couldn't restart: ${String(error)}`));
  }

  private togglePanel(id: string): void {
    const panel = $(id);
    const show = panel.hidden;
    $('gs-settings').hidden = true;
    $('gs-history').hidden = true;
    panel.hidden = !show;
    if (show && id === 'gs-settings') void this.refreshReviewedCount();
    if (show && id === 'gs-history') void this.refreshLocalSummary();
  }

  private onKey(e: KeyboardEvent): void {
    if (this.root.hidden) return;
    const target = e.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!$('gs-settings').hidden || !$('gs-history').hidden) {
        $('gs-settings').hidden = true;
        $('gs-history').hidden = true;
      } else {
        this.close();
      }
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

    const press = (act: string): void => {
      const button = this.root.querySelector<HTMLElement>(`.gs-btn[data-act="${act}"]`);
      button?.classList.add('gs-pressed');
      window.setTimeout(() => button?.classList.remove('gs-pressed'), 120);
    };

    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': case 'a': case 'A':
        press('delete'); void this.decide('delete'); break;
      case 'ArrowRight': case 'd': case 'D':
        press('keep'); void this.decide('keep'); break;
      case 'ArrowUp': case 'w': case 'W':
        press('favourite'); void this.decide('favourite'); break;
      case 'ArrowDown': case 's': case 'S':
        press('later'); void this.decide('later'); break;
      case 'z': case 'Z': case 'Backspace':
        press('undo'); void this.undo(); break;
      case '[':
        this.startPeriod(shiftPeriod(this.period, -1)); break;
      case ']':
        this.startPeriod(shiftPeriod(this.period, 1)); break;
      case 'v': case 'V':
        this.playVideo(); break;
      case 'o': case 'O':
        if (this.current) window.open(`https://photos.google.com/photo/${this.current.mediaKey}`, '_blank', 'noopener');
        break;
      default:
        handled = false;
    }
    // Stop Google Photos' own shortcuts firing underneath the overlay
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private playVideo(): void {
    const item = this.current;
    if (!item?.duration) return;
    this.video.hidden = false;
    this.img.hidden = true;
    this.video.poster = this.img.src;
    this.video.src = `${item.thumb}=dv`;
    this.video.onerror = (): void => {
      this.video.hidden = true;
      this.img.hidden = false;
      this.toast('Video playback failed here, press O to open it in Google Photos');
    };
    void this.video.play().catch(() => undefined);
  }

  // ─── settings panel ──────────────────────────────────────────────────

  private syncSettingsForm(): void {
    const s = getSettings();
    this.root.querySelectorAll<HTMLInputElement>('input[name="gs-delete-mode"]').forEach((r) => (r.checked = r.value === s.deleteMode));
    input('gs-delete-album').value = s.deleteAlbum;
    input('gs-later-album').value = s.laterAlbum;
    input('gs-include-archived').checked = s.includeArchived;
    input('gs-skip-reviewed').checked = s.skipReviewed;
    $('gs-delete-label').textContent = DELETE_LABELS[s.deleteMode];
  }

  private bindSettings(): void {
    this.root.querySelectorAll<HTMLInputElement>('input[name="gs-delete-mode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        saveSettings({ deleteMode: radio.value as DeleteMode });
        this.syncSettingsForm();
      });
    });
    const albumName = (id: string, key: 'deleteAlbum' | 'laterAlbum'): void => {
      $(id).addEventListener('change', () => {
        const value = input(id).value.trim();
        if (value) saveSettings({ [key]: value });
        this.syncSettingsForm();
      });
    };
    albumName('gs-delete-album', 'deleteAlbum');
    albumName('gs-later-album', 'laterAlbum');
    $('gs-include-archived').addEventListener('change', () => {
      saveSettings({ includeArchived: input('gs-include-archived').checked });
      this.startPeriod(this.period);
    });
    $('gs-skip-reviewed').addEventListener('change', () => {
      saveSettings({ skipReviewed: input('gs-skip-reviewed').checked });
      this.startPeriod(this.period);
    });
    $('gs-forget-reviewed').addEventListener('click', () => {
      if (!window.confirm('Forget every reviewed mark? Everything will show up for review again. Your history log is kept.')) return;
      void this.db.clearReviewed().then(() => {
        saveSettings({ cursors: {} });
        void this.refreshReviewedCount();
        this.startPeriod(this.period, false);
      });
    });
  }

  private async refreshReviewedCount(): Promise<void> {
    $('gs-reviewed-count').textContent = `${(await this.db.countReviewed()).toLocaleString('en-GB')} items reviewed`;
  }

  // ─── history panel ───────────────────────────────────────────────────

  private bindHistory(): void {
    $('gs-export-ndjson').addEventListener('click', () => void this.export('ndjson'));
    $('gs-export-csv').addEventListener('click', () => void this.export('csv'));

    const fileInput = input('gs-revert-file');
    this.root.querySelectorAll<HTMLInputElement>('input[name="gs-revert-source"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const fromFile = radio.value === 'file' && radio.checked;
        fileInput.hidden = !fromFile;
        if (fromFile) {
          if (this.revertFile) void this.refreshFileSummary();
          else fileInput.click();
        } else {
          void this.refreshLocalSummary();
        }
      });
    });
    fileInput.addEventListener('change', () => {
      this.revertFile = fileInput.files?.[0] ?? null;
      void this.refreshFileSummary();
    });
    $('gs-revert-run').addEventListener('click', () => void this.runRevert());
  }

  private revertSource(): 'local' | 'file' {
    return this.root.querySelector<HTMLInputElement>('input[name="gs-revert-source"]:checked')?.value === 'file' ? 'file' : 'local';
  }

  private async export(format: 'ndjson' | 'csv'): Promise<void> {
    const status = $('gs-revert-status');
    status.textContent = 'Exporting…';
    const count = await exportLog(this.db, windowGlobalData.account, format);
    status.textContent = `Exported ${count.toLocaleString('en-GB')} entries`;
  }

  private async refreshLocalSummary(): Promise<void> {
    $('gs-log-count').textContent = `${(await this.db.countLog()).toLocaleString('en-GB')} entries in this browser's log`;
    if (this.revertSource() === 'local') this.renderSummary(await summariseLocal(this.db));
  }

  private async refreshFileSummary(): Promise<void> {
    if (!this.revertFile) return;
    const status = $('gs-revert-status');
    status.textContent = `Reading ${this.revertFile.name}…`;
    const summary = await summariseFile(this.revertFile);
    this.renderSummary(summary);
    const other = summary.header && summary.header.account !== windowGlobalData.account;
    status.textContent = `${this.revertFile.name} loaded${other ? '. Warning: it was exported from a different Google account' : ''}`;
  }

  private renderSummary(summary: LogSummary): void {
    this.root.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
      const count = summary.counts[el.dataset.count as SwipeAction] ?? 0;
      el.textContent = `(${count.toLocaleString('en-GB')})`;
    });
    const select = $('gs-revert-session') as HTMLSelectElement;
    const previous = select.value;
    select.replaceChildren(new Option('All sessions', ''));
    const sessions = [...summary.sessions.entries()].sort((a, b) => b[1].last - a[1].last);
    for (const [id, s] of sessions) {
      const when = new Date(s.first).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      select.add(new Option(`${when} (${s.count} actions)`, id));
    }
    select.value = sessions.some(([id]) => id === previous) ? previous : '';
  }

  private async runRevert(): Promise<void> {
    const status = $('gs-revert-status');
    const actions = new Set<SwipeAction>();
    $('gs-revert-actions').querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => {
      if (box.checked) actions.add(box.value as SwipeAction);
    });
    const since = input('gs-revert-since').value;
    const filter: RevertFilter = {
      actions,
      sinceMs: since ? new Date(since).getTime() : -Infinity,
      session: ($('gs-revert-session') as HTMLSelectElement).value || undefined,
    };
    const source = this.revertSource();
    const file = this.revertFile;
    if (source === 'file' && !file) {
      status.textContent = 'Choose a file first';
      return;
    }

    status.textContent = 'Working out what to revert…';
    await this.actions.flush();
    const plan = source === 'file' && file ? await planFile(file, filter) : await planLocal(this.db, filter);
    if (plan.total === 0) {
      status.textContent = 'Nothing matches those filters';
      return;
    }
    if (!window.confirm(`Revert ${plan.total.toLocaleString('en-GB')} actions? This talks to Google Photos and can take a while for large logs.`)) {
      status.textContent = '';
      return;
    }
    const button = $('gs-revert-run') as HTMLButtonElement;
    button.disabled = true;
    try {
      await this.actions.revert(plan, (message) => (status.textContent = message));
      log(`Swipe: reverted ${plan.total} actions`);
      this.undoStack = [];
      if (source === 'local') void this.refreshLocalSummary();
    } catch (error) {
      status.textContent = `Revert stopped: ${error instanceof Error ? error.message : String(error)}. Running it again is safe.`;
    } finally {
      button.disabled = false;
    }
  }
}

let controller: SwipeController | null = null;

export function openSwipe(): void {
  controller?.open();
}

export default function initSwipe(): void {
  controller = new SwipeController();
  controller.mount();
  GM_registerMenuCommand('Open Swipe mode', openSwipe);
  // The browser extension's toolbar button asks for this from its isolated world
  window.addEventListener('message', (e: MessageEvent<unknown>) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    if ((e.data as { gptkSwipe?: string }).gptkSwipe === 'open') openSwipe();
  });
}
