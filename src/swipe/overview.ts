// The period picker: a year x month grid plus a calendar of weeks and days
// for the selected month. Each cell shows whether it has been sorted, how
// far through it you are, and (once the library has been counted) how many
// photos it holds. Built with createElement so it is Trusted Types safe.

import type SwipeDb from './db';
import { isoWeek, periodContaining, periodKey, periodLabel, shiftPeriod, type Period } from './period';
import { countIn, isSorted, oldestYear, type DoneMap, type LibraryCounts } from './status';

export interface OverviewHost {
  db: SwipeDb;
  done(): DoneMap;
  counts(): LibraryCounts | null;
  current(): Period;
  open(period: Period): void;
  toggleSorted(period: Period): void;
}

type CellState = 'sorted' | 'reviewed' | 'progress' | 'todo' | 'empty';

interface Cell {
  el: HTMLElement;
  sub: HTMLElement;
  period: Period;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DEFAULT_YEARS = 15;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function compact(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export default class Overview {
  private extraYears = 0;
  private selected: Period;
  private tickMode = false;
  private renderToken = 0;

  constructor(
    private root: HTMLElement,
    private host: OverviewHost
  ) {
    this.selected = periodContaining('month', Date.now());
    const tick = root.querySelector<HTMLInputElement>('#gs-ov-tick');
    tick?.addEventListener('change', () => {
      this.tickMode = tick.checked;
      root.classList.toggle('gs-ov-ticking', this.tickMode);
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    const current = this.host.current();
    if (Number.isFinite(current.start)) {
      this.selected = current.granularity === 'year' ? current : periodContaining('month', current.start);
    }
    this.root.hidden = false;
    this.render();
  }

  hide(): void {
    this.root.hidden = true;
  }

  render(): void {
    const token = ++this.renderToken;
    const cells: Cell[] = [];
    this.renderYears(cells);
    this.renderDetail(cells);
    void this.fillCounts(cells, token);
  }

  // ─── year x month grid ───────────────────────────────────────────────

  private renderYears(cells: Cell[]): void {
    const container = this.root.querySelector<HTMLElement>('#gs-ov-years');
    if (!container) return;
    container.replaceChildren();

    const newest = new Date().getFullYear();
    const scanned = oldestYear(this.host.counts());
    const oldest = (scanned ?? newest - DEFAULT_YEARS + 1) - this.extraYears;

    const head = el('div', 'gs-ov-row gs-ov-row-head');
    head.appendChild(el('span'));
    for (const m of MONTHS) head.appendChild(el('span', 'gs-ov-colhead', m));
    container.appendChild(head);

    for (let year = newest; year >= oldest; year--) {
      const row = el('div', 'gs-ov-row');
      const yearPeriod = periodContaining('year', new Date(year, 0, 1));
      row.appendChild(this.cell(yearPeriod, String(year), cells, 'gs-ov-year', true));
      for (let m = 0; m < 12; m++) {
        const month = periodContaining('month', new Date(year, m, 1));
        row.appendChild(this.cell(month, MONTHS[m], cells, 'gs-ov-month', true));
      }
      container.appendChild(row);
    }

    const more = el('button', 'gs-text-btn gs-ov-more', scanned === null ? 'Show older years' : 'Show years before the oldest photo');
    more.addEventListener('click', () => {
      this.extraYears += 10;
      this.render();
    });
    container.appendChild(more);
  }

  // ─── selected month (or year) ────────────────────────────────────────

  private renderDetail(cells: Cell[]): void {
    const container = this.root.querySelector<HTMLElement>('#gs-ov-detail');
    if (!container) return;
    container.replaceChildren();
    const period = this.selected;

    const title = el('h4', 'gs-ov-title', periodLabel(period));
    const actions = el('div', 'gs-ov-actions');
    const review = el('button', 'gs-text-btn gs-ov-primary', `Review ${periodLabel(period)}`);
    review.addEventListener('click', () => this.host.open(period));
    const sorted = isSorted(period, this.host.done());
    const mark = el('button', 'gs-text-btn', sorted ? 'Unmark sorted' : 'Mark sorted');
    mark.addEventListener('click', () => {
      this.host.toggleSorted(period);
      this.render();
    });
    actions.append(review, mark);
    container.append(title, actions);

    if (period.granularity !== 'month') {
      container.appendChild(el('p', 'gs-muted', 'Pick a month on the left to see its weeks and days.'));
      return;
    }

    const grid = el('div', 'gs-ov-cal');
    grid.appendChild(el('span', 'gs-ov-colhead', 'Week'));
    for (const d of WEEKDAYS) grid.appendChild(el('span', 'gs-ov-colhead', d));

    for (let week = periodContaining('week', period.start); week.start < period.end; week = shiftPeriod(week, 1)) {
      grid.appendChild(this.cell(week, `W${isoWeek(week.start)}`, cells, 'gs-ov-week', false));
      for (let day = periodContaining('day', week.start); day.start < week.end; day = shiftPeriod(day, 1)) {
        const inMonth = day.start >= period.start && day.start < period.end;
        const cell = this.cell(day, String(new Date(day.start).getDate()), cells, inMonth ? 'gs-ov-day' : 'gs-ov-day gs-ov-outside', false);
        grid.appendChild(cell);
      }
    }
    container.appendChild(grid);
  }

  // ─── cells ───────────────────────────────────────────────────────────

  /**
   * Months and years select on click (open on double click) so their weeks
   * and days can be shown; weeks and days open straight away. In tick-off
   * mode every click toggles sorted instead.
   */
  private cell(period: Period, label: string, cells: Cell[], className: string, selectable: boolean): HTMLElement {
    const button = el('button', `gs-ov-cell ${className}`);
    button.title = periodLabel(period);
    const main = el('span', 'gs-ov-label', label);
    const sub = el('span', 'gs-ov-sub');
    button.append(main, sub);

    const current = this.host.current();
    if (periodKey(current) === periodKey(period)) button.classList.add('gs-ov-current');
    if (selectable && periodKey(this.selected) === periodKey(period)) button.classList.add('gs-ov-selected');

    button.addEventListener('click', () => {
      if (this.tickMode) {
        this.host.toggleSorted(period);
        if (selectable) this.selected = period;
        this.render();
      } else if (selectable) {
        this.selected = period;
        this.render();
      } else {
        this.host.open(period);
      }
    });
    if (selectable) button.addEventListener('dblclick', () => this.host.open(period));

    cells.push({ el: button, sub, period });
    return button;
  }

  private async fillCounts(cells: Cell[], token: number): Promise<void> {
    const done = this.host.done();
    const counts = this.host.counts();
    const reviewed = await this.host.db.countReviewedRanges(cells.map((c) => [c.period.start, c.period.end]));
    if (token !== this.renderToken) return;

    cells.forEach((cell, i) => {
      const total = countIn(cell.period, counts);
      const seen = reviewed[i];
      let state: CellState;
      if (isSorted(cell.period, done)) state = 'sorted';
      else if (total === 0) state = 'empty';
      else if (seen > 0 && total !== null && seen >= total) state = 'reviewed';
      else if (seen > 0) state = 'progress';
      else state = 'todo';
      cell.el.dataset.state = state;

      let sub = '';
      if (total !== null && total > 0) sub = seen > 0 ? `${compact(seen)}/${compact(total)}` : compact(total);
      else if (total === null && seen > 0) sub = `${compact(seen)} seen`;
      cell.sub.textContent = state === 'sorted' ? `✓ ${sub}`.trim() : sub;

      const parts = [periodLabel(cell.period)];
      if (state === 'sorted') parts.push('sorted');
      if (total !== null) parts.push(`${total.toLocaleString('en-GB')} photos`);
      if (seen > 0) parts.push(`${seen.toLocaleString('en-GB')} reviewed`);
      cell.el.title = parts.join(' · ');
    });
  }
}
