export {};

declare global {
  interface Window {
    adeDesktop?: {
      customTitleBar: boolean;
      setTheme: (theme: 'dark' | 'light') => Promise<void>;
      updateStatus: () => Promise<import('../../shared/contracts').DesktopUpdateStatus>;
      checkForUpdates: () => Promise<import('../../shared/contracts').DesktopUpdateStatus>;
      updateAndRestart: () => Promise<import('../../shared/contracts').DesktopUpdateStatus>;
      onUpdateStatus: (callback: (status: import('../../shared/contracts').DesktopUpdateStatus) => void) => () => void;
      chooseFolder: () => Promise<string | null>;
      setNotifications: (settings: { enabled: boolean; sound: boolean }) => Promise<void>;
      onAgentNotification: (callback: (event: { item: import('../../shared/contracts').InboxItem; open: boolean }) => void) => () => void;
    };
  }
}
