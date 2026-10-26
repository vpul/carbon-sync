import type { SyncStatus } from '@carbon-sync/engine';

const LABELS: Record<SyncStatus, string> = {
  offline: '○ offline',
  connecting: '↻ syncing',
  syncing: '↻ syncing',
  idle: '● synced',
};

const CLASSES: Record<SyncStatus, string> = {
  offline: 'is-offline',
  connecting: 'is-syncing',
  syncing: 'is-syncing',
  idle: 'is-synced',
};

/** Status bar text; clicking forces a sync. */
export class StatusBar {
  constructor(
    private readonly el: HTMLElement,
    onSyncNow: () => void,
  ) {
    el.addClass('carbon-sync-status');
    el.addEventListener('click', onSyncNow);
    this.set('offline');
  }

  set(status: SyncStatus): void {
    this.el.removeClass('is-synced', 'is-syncing', 'is-offline');
    this.el.addClass(CLASSES[status]);
    this.el.setText(LABELS[status]);
    this.el.setAttribute('aria-label', `Carbon Sync: ${status}`);
  }
}
